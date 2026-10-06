import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { CatalogDb, createApi } from "../src/server.ts";

let base = "";
let server: ReturnType<typeof createApi>;
let db: CatalogDb;

const textOf = (response: Response): Promise<string> => response.text();

before(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "extras-"));
  db = CatalogDb.open(path.join(dir, "t.db"));
  server = createApi({ db, packageRoot: dir, adminToken: "admin" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + String((server.address() as AddressInfo).port);
});

after(() => {
  server.close();
});

const post = (p: string, body: unknown, token = "admin") =>
  fetch(base + p, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });

test("回执写入路由不再接受 GET：一个 <img> 就能伪造回执的口子已封", async () => {
  const beforeRows = (await fetch(base + "/api/apps/wps-office/receipts", { headers: { authorization: "Bearer admin" } }).then((r) => r.json())) as unknown[];
  const getAttempt = await fetch(base + "/api/apps/wps-office/receipt", { headers: { authorization: "Bearer admin" } });
  assert.equal(getAttempt.status, 404, "旧实现在这里没有校验方法，GET 也会插一行回执");
  const afterRows = (await fetch(base + "/api/apps/wps-office/receipts", { headers: { authorization: "Bearer admin" } }).then((r) => r.json())) as unknown[];
  assert.equal(afterRows.length, beforeRows.length);

  const ok = await post("/api/apps/wps-office/receipt", { version: "1.0.0", result: "success" });
  assert.equal(ok.status, 201);
  const rows = (await fetch(base + "/api/apps/wps-office/receipts", { headers: { authorization: "Bearer admin" } }).then((r) => r.json())) as unknown[];
  assert.equal(rows.length, 1);
});

test("回执里的垃圾数值不再把请求打成 500", async () => {
  const weird = await post("/api/apps/weird-app/receipt", { version: "1", result: "failed", exitCode: {}, durationMs: "abc", error: "x".repeat(5000), machine: "m" });
  assert.equal(weird.status, 201, "旧写法 Number({}) 得到 NaN 写进 NOT NULL 列会 500");
  const rows = (await fetch(base + "/api/apps/weird-app/receipts", { headers: { authorization: "Bearer admin" } }).then((r) => r.json())) as { exitCode: number | null; durationMs: number | null; error: string }[];
  assert.equal(rows[0]?.exitCode, 0);
  assert.equal(rows[0]?.durationMs, 0);
  assert.ok((rows[0]?.error.length ?? 0) <= 2000, "错误文本要有界");
});

test("心跳的垃圾计数与越界负载：能收的收、该拒的拒，不返回 500", async () => {
  const garbageCounts = await post("/api/heartbeat", {
    machineId: "machine-a",
    installed: [{ id: "a", upgradable: true }],
    needsApproval: [],
    counts: { installed: {}, upgradable: "NaN-ish", needsApproval: [1], pendingApprovals: undefined },
  });
  assert.equal(garbageCounts.status, 201, "计数取自客户端，绝不能因 NaN 撞 NOT NULL 而 500");
  const fleet = (await fetch(base + "/api/admin/fleet", { headers: { authorization: "Bearer admin" } }).then((r) => r.json())) as {
    agents: { machineId: string; counts: { installed: number; upgradable: number; needsApproval: number } }[];
  };
  const machine = fleet.agents.find((m) => m.machineId === "machine-a");
  assert.ok(machine, "心跳应落库");
  assert.equal(machine?.counts.installed, 1, "非法计数退回按数组长度算，而不是 NaN");
  assert.equal(machine?.counts.upgradable, 1);
  assert.equal(machine?.counts.needsApproval, 0);

  const tooLong = await post("/api/heartbeat", { machineId: "x".repeat(5000) });
  assert.equal(tooLong.status, 400);
  const huge = await post("/api/heartbeat", { machineId: "machine-b", installed: new Array(6000).fill({ id: "z" }) });
  assert.equal(huge.status, 413);
});

test("运营位时间窗按真实时刻判定，不再拿带偏移的文本做字符串比较", async () => {
  // 真实结束时刻 = 一小时之前（已过期），但写成 +08:00 后其文本比现在的 Z 文本更大。
  const expiredButLooksFuture = new Date(Date.now() - 3600_000 + 8 * 3600_000).toISOString().slice(0, 19) + "+08:00";
  const created = await post("/api/admin/banners", { id: "b-stale", title: "已过期", subtitle: "", link: "app:x", sortOrder: 1, endsAt: expiredButLooksFuture });
  assert.equal(created.status, 201);
  const live = (await fetch(base + "/api/banners").then((r) => r.json())) as { id: string }[];
  assert.deepEqual(
    live.map((b) => b.id),
    [],
    "旧实现用字符串比较会把这个已经过期一小时的运营位继续外露：" + JSON.stringify(expiredButLooksFuture),
  );
});

test("畸形百分号编码不再冒 500", async () => {
  const response = await fetch(base + "/api/apps/%zz-not-valid/receipts", { headers: { authorization: "Bearer admin" } });
  assert.ok(response.status === 200 || response.status === 404, "状态应为可读错误而非 500，实际 " + String(response.status));
  assert.doesNotMatch(await textOf(response), /URI malformed/);
});
