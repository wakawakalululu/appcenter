import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { CatalogDb, createApi, seedDemo } from "../src/server.ts";

const packageRoot = await mkdtemp(path.join(tmpdir(), "cap-pkgs-"));
const db = CatalogDb.memory("cap-secret");
const server = createApi({ db, packageRoot, adminToken: "cap-admin-token" });
let base = "";
let port = 0;

before(async () => {
  seedDemo(db);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  base = "http://127.0.0.1:" + String(port);
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await rm(packageRoot, { recursive: true, force: true });
});

const MIB = 1024 * 1024;

async function postHeartbeat(machineId: string, payload: string): Promise<number> {
  const res = await fetch(base + "/api/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer cap-admin-token" },
    body: payload,
  });
  await res.text();
  return res.status;
}

const heartbeatsFor = (machineId: string): number => {
  const row = db.raw().prepare("SELECT COUNT(*) AS c FROM heartbeats WHERE machine_id = ?").get(machineId) as { c: number };
  return Number(row.c);
};

test("超大请求体在传输层就被拒（不是读进内存之后才判业务上限）", async () => {
  // 3 MiB，但每个数组都合规、只有一个字符串字段巨大——旧写法会先整个 buffer 进内存、
  // 通过 MAX_LIST_ITEMS 检查、再静默截断 appVersion 并返回 201。所以这条只有传输层上限能挡住。
  const payload = JSON.stringify({ machineId: "cap-huge", appVersion: "v".repeat(3 * MIB), installed: [], needsApproval: [] });
  const status = await postHeartbeat("cap-huge", payload);
  assert.equal(status, 413, "超限必须是 413");
  assert.equal(heartbeatsFor("cap-huge"), 0, "被拒的上报绝不能落库");
});

test("边界之内照常受理（上限不能把真实心跳挡掉）", async () => {
  // 数组保持在业务上限之内（那是另一条判据：MAX_LIST_ITEMS），用一个大字符串字段把请求体推到几百 KB——
  // 这正是"合法但大"的真实形状，旧代码会把 appVersion 截到 120 字符后正常受理。
  const installed = Array.from({ length: 50 }, (_, i) => ({ appId: "app_" + String(i), name: "应用" + String(i), upgradable: i % 3 === 0 }));
  const payload = JSON.stringify({ machineId: "cap-ok", appVersion: "v".repeat(500_000), installed, needsApproval: ["a"], counts: { pendingApprovals: 1 } });
  assert.ok(payload.length > 400_000 && payload.length < MIB, "用例本身要先证明它落在「大但合法」这一段：" + String(payload.length));
  const status = await postHeartbeat("cap-ok", payload);
  assert.equal(status, 201, "合法大心跳必须被受理：" + String(status));
  assert.equal(heartbeatsFor("cap-ok"), 1);
  const stored = db.raw().prepare("SELECT app_version FROM heartbeats WHERE machine_id = ?").get("cap-ok") as { app_version: string };
  assert.equal(stored.app_version.length, 120, "落库前该截断的仍要截断");
});

test("非法 JSON 仍然按旧行为当空体处理，不是被误判成超限", async () => {
  // 这条防的是"加了上限就把解析失败也一起拒掉"：那种改法会改变既有契约，且把 400 的原因说成 413。
  const status = await postHeartbeat("cap-bad-json", "{ not json at all");
  assert.equal(status, 400, "缺 machineId 应当是 400（空体），不能变成 413");
});

test("Content-Length 就声明超限：立刻拒绝，不等待请求体", async () => {
  const code = await new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/heartbeat", method: "POST", headers: { "content-type": "application/json", authorization: "Bearer cap-admin-token", "content-length": String(5 * MIB) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    // 故意一个字节都不写：只要服务端靠声明长度就能拒绝，这条就有意义。
    req.flushHeaders();
    setTimeout(() => { if (!req.destroyed) req.destroy(); }, 1500);
  });
  assert.equal(code, 413);
});
