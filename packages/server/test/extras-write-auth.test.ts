import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { CatalogDb, createApi, seedDemo } from "../src/server.ts";

const TOKEN = "write-auth-token";
const packageRoot = await mkdtemp(path.join(tmpdir(), "wauth-pkgs-"));
const db = CatalogDb.memory("wauth-secret");
const server = createApi({ db, packageRoot, adminToken: TOKEN });
let base = "";

before(async () => {
  seedDemo(db);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + String((server.address() as AddressInfo).port);
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await rm(packageRoot, { recursive: true, force: true });
});

const post = (p: string, body: unknown, token?: string): Promise<number> =>
  fetch(base + p, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: JSON.stringify(body),
  }).then((r) => r.status);

const rows = (sql: string): number => Number(((db.raw().prepare(sql).get() ?? { c: 0 }) as { c: number }).c);

const heartbeat = (machineId: string): Record<string, unknown> => ({
  machineId,
  appVersion: "1.0.0",
  installed: [{ appId: "a", name: "A", upgradable: false }],
  needsApproval: [],
  counts: { installed: 1, upgradable: 0, needsApproval: 0, pendingApprovals: 0 },
});

test("匿名心跳必须 401，而且一行都不落", async () => {
  const status = await post("/api/heartbeat", heartbeat("anon-machine"));
  assert.equal(status, 401, "没有凭据的心跳不能进机群表");
  assert.equal(rows("SELECT COUNT(*) AS c FROM heartbeats WHERE machine_id = 'anon-machine'"), 0, "被拒的心跳绝不能留下机器行");
  assert.equal(rows("SELECT COUNT(*) AS c FROM heartbeat_history WHERE machine_id = 'anon-machine'"), 0);
});

test("带凭据的心跳照常受理（这条判据不能把正常 agent 挡死）", async () => {
  const status = await post("/api/heartbeat", heartbeat("auth-machine"), TOKEN);
  assert.equal(status, 201, String(status));
  assert.equal(rows("SELECT COUNT(*) AS c FROM heartbeats WHERE machine_id = 'auth-machine'"), 1);
});

test("错令牌与缺令牌一样被拒（不是「带了头就算过」）", async () => {
  assert.equal(await post("/api/heartbeat", heartbeat("wrong-token-machine"), "not-a-real-token"), 401);
  assert.equal(rows("SELECT COUNT(*) AS c FROM heartbeats WHERE machine_id = 'wrong-token-machine'"), 0);
});

test("匿名回执同样 401：CSRF 收成只认 POST 之后，剩下的口子就是匿名 POST", async () => {
  // 数增量而不是绝对值：seedDemo 本来就可能铺了回执行，绝对数会把"没新增"误读成"表是空的"。
  const before = rows("SELECT COUNT(*) AS c FROM receipts WHERE app_id = 'wps-office'");
  const status = await post("/api/apps/wps-office/receipt", { version: "1.0.0", result: "success", exitCode: 0 });
  assert.equal(status, 401, String(status));
  assert.equal(rows("SELECT COUNT(*) AS c FROM receipts WHERE app_id = 'wps-office'"), before, "被拒的回执绝不能插行");
  const ok = await post("/api/apps/wps-office/receipt", { version: "1.0.0", result: "success", exitCode: 0 }, TOKEN);
  assert.equal(ok, 201, String(ok));
  assert.equal(rows("SELECT COUNT(*) AS c FROM receipts WHERE app_id = 'wps-office'"), before + 1, "带凭据的回执要真的落库");
});

test("身份先于请求体：匿名的大体被拒是 401 而不是 413（不能让未认证者决定服务端 buffer 多少）", async () => {
  const huge = JSON.stringify({ machineId: "anon-huge", appVersion: "v".repeat(3 * 1024 * 1024), installed: [], needsApproval: [] });
  const status = await fetch(base + "/api/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: huge,
  }).then((r) => r.status);
  assert.equal(status, 401, " ordering：先验身份再读体");
  assert.equal(rows("SELECT COUNT(*) AS c FROM heartbeats WHERE machine_id = 'anon-huge'"), 0);
});
