import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { CatalogDb, createApi, seedDemo } from "../src/server.ts";
import { AppCenterFacade, DEFAULT_RUNTIME_CONFIG, RuntimeConfigStore, sanitize, type WindowHost } from "@appcenter/core";
import { makeTrackedTmp } from "../../core/test/util/tmp-dirs.ts";

class NoopHost implements WindowHost {
  async create(): Promise<string> {
    return "win-x";
  }
  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async close(): Promise<void> {}
  async focus(): Promise<void> {}
}

const adminToken = "admin-token";
const packageRoot = await makeTrackedTmp("extras-pkgs-");
const db = CatalogDb.memory("extras-secret");
const server = createApi({ db, packageRoot, adminToken });
let base = "";

before(async () => {
  seedDemo(db);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + String((server.address() as AddressInfo).port);
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function facadeFor(userId: string): Promise<AppCenterFacade> {
  const dataDir = await makeTrackedTmp("extras-data-");
  return new AppCenterFacade({ serverUrl: base, userId, dataDir, appVersion: "1.0.0", token: adminToken, registryKeys: [] }, new NoopHost());
}

test("runtime config keeps the download dir and clamps out-of-range settings", async () => {
  const file = path.join(await makeTrackedTmp("extras-cfg-"), "runtime-config.json");
  const store = new RuntimeConfigStore(file, { downloadDir: "C:\\cache" });
  assert.equal((await store.load()).downloadDir, "C:\\cache");
  assert.equal(await store.packageDir(), "C:\\cache");

  const saved = await store.save({ concurrency: 99, updateCheckIntervalMinutes: 0 });
  assert.equal(saved.config.concurrency, DEFAULT_RUNTIME_CONFIG.concurrency);
  assert.equal(saved.config.updateCheckIntervalMinutes, DEFAULT_RUNTIME_CONFIG.updateCheckIntervalMinutes);
  assert.deepEqual(saved.issues.map((issue) => issue.field).sort(), ["concurrency", "updateCheckIntervalMinutes"]);
  // 落盘的是同一个文件，另一个进程读到的就是同一份配置。
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).concurrency, DEFAULT_RUNTIME_CONFIG.concurrency);
  const other = new RuntimeConfigStore(file);
  assert.equal((await other.load()).concurrency, DEFAULT_RUNTIME_CONFIG.concurrency);

  const junk = sanitize({ downloadDir: "  D:\\dl  ", installerCleanup: "yes" as never });
  assert.equal(junk.config.downloadDir, "D:\\dl");
  assert.equal(junk.config.installerCleanup, DEFAULT_RUNTIME_CONFIG.installerCleanup);
});

test("shared runtime config file survives a partial write and is repaired on load", async () => {
  const file = path.join(await makeTrackedTmp("extras-repair-"), "runtime-config.json");
  await writeFile(file, "{ this is not json", "utf8");
  const store = new RuntimeConfigStore(file, { concurrency: 5 });
  const config = await store.load();
  assert.equal(config.concurrency, 5);
  assert.equal(config.installerCleanup, DEFAULT_RUNTIME_CONFIG.installerCleanup);
});

test("admin banners drive the home carousel and fall back to recommended apps", async () => {
  const facade = await facadeFor("banner-fan");
  const derived = await facade.homeView();
  assert.ok(derived.banners.length > 0);
  assert.ok(derived.banners[0]?.id.startsWith("derived:"));

  const published = await fetch(base + "/api/admin/banners", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + adminToken },
    body: JSON.stringify({ id: "spring-festival", title: "新春焕新季", subtitle: "办公套件集体上新", link: "app:code-ide", imageUrl: "/img/spring.png", sortOrder: 1 }),
  });
  assert.equal(published.status, 201);

  const boosted = await facade.homeView();
  assert.equal(boosted.banners[0]?.id, "spring-festival");
  assert.equal(boosted.banners[0]?.title, "新春焕新季");
  assert.equal(boosted.banners[0]?.entry?.app.id, "code-ide");

  // 过期的运营位不再下发
  const expired = await fetch(base + "/api/admin/banners", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + adminToken },
    body: JSON.stringify({ id: "old", title: "去年活动", link: "app:code-ide", sortOrder: 0, endsAt: "2020-01-01T00:00:00.000Z" }),
  });
  assert.equal(expired.status, 201);
  const stillFresh = await facade.homeView();
  assert.ok(!stillFresh.banners.some((slide) => slide.id === "old"));

  const denied = await fetch(base + "/api/admin/banners", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "越权" }) });
  assert.equal(denied.status, 403);
});

test("approval notifications close the loop with a done receipt", async () => {
  const facade = await facadeFor("approver");
  assert.equal((await facade.pollNotifications()).length, 0);

  const created = await fetch(base + "/api/approvals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId: "vpn-client", appVersion: "5.0.1", applicant: "approver", reason: "需要接入内网做验证" }),
  });
  assert.equal(created.status, 201);

  const unread = await facade.pollNotifications();
  assert.equal(unread.length, 1);
  assert.equal(unread[0]?.appId, "vpn-client");
  assert.equal(facade.scheduleState().unreadNotifications, 1);

  const acked = await facade.markNotificationDone(unread[0]?.id ?? "");
  assert.equal(acked.ok, true);
  assert.equal((await facade.pollNotifications()).length, 0);
  assert.equal(facade.scheduleState().unreadNotifications, 0);
  await assert.rejects(facade.markNotificationDone("missing-note"), /404/);
});

test("self update stages and swaps inside the declared app dir, never the host runtime", async () => {
  const facade = await facadeFor("updater");
  const payload = Buffer.from("new-client-bytes");
  await writeFile(path.join(packageRoot, "AppCenter.exe"), payload);
  const published = await fetch(base + "/api/admin/self-update", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + adminToken },
    body: JSON.stringify({
      version: "9.9.9",
      url: base + "/dl/AppCenter.exe",
      sha256: createHash("sha256").update(payload).digest("hex"),
      sizeBytes: payload.length,
      releaseNotes: "托盘图标修复",
      mandatory: true,
    }),
  });
  assert.equal(published.status, 201);

  const { manifest, result } = await facade.checkSelfUpdate();
  assert.equal(result.state, "available");
  assert.equal(result.mandatory, true, "强制升级标志要透传给 UI");

  const staged = await facade.stageSelfUpdate(manifest);
  assert.ok(staged.packagePath.startsWith(facade.dataDirectory()), "暂存包必须在数据目录内");

  const outcome = await facade.applySelfUpdate(staged);
  assert.equal(outcome.swapped, true, outcome.message);
  const target = path.join(facade.dataDirectory(), "selfupdate", "current", "AppCenter.exe");
  assert.equal((await readFile(target)).toString(), "new-client-bytes");
  // 未声明宿主目录时绝不往 process.execPath 所在目录写
  assert.ok(!path.dirname(process.execPath).includes("Program Files") || !(await exists(path.join(path.dirname(process.execPath), "AppCenter.exe"))));

  await facade.commitSelfUpdate();
  assert.equal(await facade.pendingSelfUpdate(), null);
});

async function exists(target: string): Promise<boolean> {
  try {
    await readFile(target);
    return true;
  } catch {
    return false;
  }
}

test("exclusive apps surface as their own list with install state attached", async () => {
  const facade = await facadeFor("exclusive-fan");
  const exclusive = await facade.exclusiveView();
  assert.ok(exclusive.length > 0, "演示目录里就配了专属应用");
  assert.ok(exclusive.every((entry) => entry.app.badge === "exclusive"));
  // 关键不是过滤，而是过滤后仍然带着联表算出来的安装状态与按钮语义。
  assert.ok(exclusive.every((entry) => Boolean(entry.installState && entry.action)));
  const home = await facade.homeView();
  assert.ok(home.sections.length > 0, "专属页不该抢走首页的分类分区");
});

test("scheduled checks run on demand, report state and stop cleanly", async () => {
  const facade = await facadeFor("ticker");
  assert.equal(facade.scheduleState().running, false);

  const started = await facade.startScheduledChecks({ immediate: true });
  assert.equal(started.running, true);
  assert.ok(started.lastCheckAt);
  assert.equal(started.lastCheckError, null);

  // 周期改了要能立刻重建定时器
  const updated = await facade.updateRuntimeConfig({ updateCheckIntervalMinutes: 30 });
  assert.equal(updated.config.updateCheckIntervalMinutes, 30);
  assert.equal(facade.scheduleState().running, true);

  const stopped = facade.stopScheduledChecks();
  assert.equal(stopped.running, false);
  assert.ok(stopped.lastCheckAt, "停掉调度器不该丢掉上次检查时间");
});

test("asset heartbeat upserts per machine and aggregates into the admin fleet view", async () => {
  const facadeA = await facadeFor("fleet-pc-01");
  // 同一台机器连报两次：按 machineId 幂等，机群里仍只有一行。
  const first = await facadeA.reportHeartbeat();
  assert.equal(first.machineId, "fleet-pc-01");
  assert.ok(first.reportedAt);
  await facadeA.reportHeartbeat();

  const facadeB = await facadeFor("fleet-pc-02");
  await facadeB.reportHeartbeat();

  const denied = await fetch(base + "/api/admin/fleet");
  assert.equal(denied.status, 403, "机群汇总必须管理员鉴权");

  const ok = await fetch(base + "/api/admin/fleet", { headers: { authorization: "Bearer " + adminToken } });
  assert.equal(ok.status, 200);
  const report = (await ok.json()) as { agents: { machineId: string; lastSeenAt: string; firstSeenAt: string }[]; totals: { agents: number } };
  const ids = report.agents.map((a) => a.machineId);
  assert.ok(ids.includes("fleet-pc-01") && ids.includes("fleet-pc-02"), "两台机器都应在册");
  assert.equal(ids.filter((id) => id === "fleet-pc-01").length, 1, "重复心跳不应产生第二行");
  assert.ok(report.totals.agents >= 2);
  const pc1 = report.agents.find((a) => a.machineId === "fleet-pc-01");
  assert.ok(pc1 && pc1.firstSeenAt <= pc1.lastSeenAt, "首次上报时间不晚于最近上报");
});

test("heartbeat endpoint rejects a payload without a machine id", async () => {
  const res = await fetch(base + "/api/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + adminToken },
    body: JSON.stringify({ appVersion: "1.0.0", installed: [], needsApproval: [], counts: {} }),
  });
  assert.equal(res.status, 400);
});

test("fleet detail accumulates heartbeat history newest-first", async () => {
  const facade = await facadeFor("hist-pc");
  await facade.reportHeartbeat();
  await facade.reportHeartbeat();
  await facade.reportHeartbeat();

  const res = await fetch(base + "/api/admin/fleet/hist-pc", { headers: { authorization: "Bearer " + adminToken } });
  assert.equal(res.status, 200);
  const detail = (await res.json()) as { agent: { machineId: string }; history: { reportedAt: string }[] };
  assert.equal(detail.agent.machineId, "hist-pc");
  assert.equal(detail.history.length, 3, "三次上报应留三条时序快照");
  const times = detail.history.map((h) => Date.parse(h.reportedAt));
  assert.ok(times.every((t, i) => i === 0 || t <= (times[i - 1] ?? t)), "历史按上报时间倒序（seq DESC）");

  const missing = await fetch(base + "/api/admin/fleet/nope-not-here", { headers: { authorization: "Bearer " + adminToken } });
  assert.equal(missing.status, 404, "未知机器返回 404");
  const denied = await fetch(base + "/api/admin/fleet/hist-pc");
  assert.equal(denied.status, 403, "单机详情同样需要管理员鉴权");
});

test("fleet marks machines that stopped reporting as stale", async () => {
  const old = new Date(Date.now() - 72 * 3600_000).toISOString(); // 3 天前
  db.raw()
    .prepare("INSERT INTO heartbeats (machine_id, app_version, installed_count, upgradable_count, needs_approval_count, pending_approvals, payload, first_seen_at, last_seen_at) VALUES ('ghost-pc','1.0.0',0,0,0,0,'{}',?,?) ON CONFLICT(machine_id) DO UPDATE SET last_seen_at=excluded.last_seen_at")
    .run(old, old);

  const report = (await (await fetch(base + "/api/admin/fleet", { headers: { authorization: "Bearer " + adminToken } })).json()) as {
    agents: { machineId: string; stale: boolean; lastSeenAgeMs: number }[];
    totals: { stale: number };
  };
  const ghost = report.agents.find((a) => a.machineId === "ghost-pc");
  assert.ok(ghost && ghost.stale === true, "3 天未上报应判离线");
  assert.ok(ghost!.lastSeenAgeMs > 0);
  assert.ok(report.totals.stale >= 1, "全局计数应统计离线机器");
  const fresh = report.agents.find((a) => a.machineId === "hist-pc");
  assert.ok(fresh && fresh.stale === false, "刚上报过的机器不离线");

  // 阈值放大到 240h，3 天前的机器重新算在线。
  const wide = (await (await fetch(base + "/api/admin/fleet?staleAfterHours=240", { headers: { authorization: "Bearer " + adminToken } })).json()) as {
    agents: { machineId: string; stale: boolean }[];
  };
  assert.equal(wide.agents.find((a) => a.machineId === "ghost-pc")?.stale, false);
});

test("heartbeat history is pruned to the retention limit per machine", async () => {
  const mid = "prune-pc";
  const insert = db.raw().prepare("INSERT INTO heartbeat_history (machine_id, installed_count, upgradable_count, needs_approval_count, reported_at) VALUES (?,0,0,0,?)");
  for (let i = 0; i < 150; i++) insert.run(mid, new Date(Date.now() - (150 - i) * 1000).toISOString());

  const facade = await facadeFor(mid);
  await facade.reportHeartbeat(); // 触发插入 + 剪枝

  const row = db.raw().prepare("SELECT COUNT(*) AS n FROM heartbeat_history WHERE machine_id = ?").get(mid) as { n: number };
  assert.equal(Number(row.n), 100, "历史应被剪到保留上限（HISTORY_LIMIT=100）");
});
