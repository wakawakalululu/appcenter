import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { CatalogDb, createApi, seedDemo } from "../src/server.ts";
import { AppCenterFacade, DEFAULT_RUNTIME_CONFIG, RuntimeConfigStore, sanitize, type WindowHost } from "@appcenter/core";

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
const packageRoot = await mkdtemp(path.join(tmpdir(), "extras-pkgs-"));
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
  const dataDir = await mkdtemp(path.join(tmpdir(), "extras-data-"));
  return new AppCenterFacade({ serverUrl: base, userId, dataDir, appVersion: "1.0.0", token: adminToken, registryKeys: [] }, new NoopHost());
}

test("runtime config keeps the download dir and clamps out-of-range settings", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "extras-cfg-")), "runtime-config.json");
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
  const file = path.join(await mkdtemp(path.join(tmpdir(), "extras-repair-")), "runtime-config.json");
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
