import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { CatalogDb, createApi, seedDemo } from "../src/server.ts";

const TOKEN = "admin-token";
const packageRoot = await mkdtemp(path.join(tmpdir(), "appr-pkgs-"));
const db = CatalogDb.memory("appr-secret");
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

const post = (p: string, body: unknown, token?: string): Promise<Response> =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) });
const get = (p: string, token?: string): Promise<Response> =>
  fetch(base + p, { headers: token ? { authorization: "Bearer " + token } : {} });

const create = async (applicant: string): Promise<string> => {
  const res = await post("/api/approvals", { appId: "vpn-client", appVersion: "5.0.1", applicant, reason: "需要远程接入" });
  assert.equal(res.status, 201);
  return ((await res.json()) as { requestId: string }).requestId;
};

test("管理员查全量工单：含他人申请，且投影字段完整", async () => {
  const id = await create("user1");
  const res = await get("/api/approvals", TOKEN);
  assert.equal(res.status, 200);
  const list = (await res.json()) as { requestId: string; appId: string; appVersion: string; applicant: string; status: string }[];
  const item = list.find((r) => r.requestId === id);
  assert.ok(item, "管理员应能看到全部工单");
  assert.equal(item!.appId, "vpn-client");
  assert.equal(item!.appVersion, "5.0.1");
  assert.equal(item!.applicant, "user1");
  assert.equal(item!.status, "pending");
});

test("匿名不带 applicant 只看到空列表（不越权泄露他人流水）", async () => {
  await create("user2");
  const res = await get("/api/approvals");
  assert.equal(res.status, 200);
  const list = (await res.json()) as { requestId: string }[];
  assert.equal(list.length, 0, "匿名查询绝不能返回他人工单");
});

test("普通用户令牌：查自己放行，读他人流水被拒（越权拦截）", async () => {
  await create("user2b");
  const login = await post("/api/login", { userId: "bob", role: "user" });
  assert.equal(login.status, 200);
  const token = ((await login.json()) as { token: string }).token;
  // 不带 applicant：默认查自己，200
  const own = await get("/api/approvals", token);
  assert.equal(own.status, 200);
  // 试图读他人流水：403
  const other = await get("/api/approvals?applicant=user2b", token);
  assert.equal(other.status, 403, "普通用户不得读他人流水");
});

test("管理员审批闭环：受理 → 全量可见 approved → 吊销 → revoked", async () => {
  const id = await create("user3");
  const decide = await post("/api/approvals/" + id + "/decide", { decision: "approved", decidedBy: "admin", note: "同意" }, TOKEN);
  assert.equal(decide.status, 200);

  let all = (await (await get("/api/approvals", TOKEN)).json()) as { requestId: string; status: string; decidedBy: string }[];
  let it = all.find((r) => r.requestId === id)!;
  assert.equal(it.status, "approved");
  assert.equal(it.decidedBy, "admin");

  const revoke = await post("/api/approvals/" + id + "/revoke", {}, TOKEN);
  assert.equal(revoke.status, 200);
  assert.equal(((await revoke.json()) as { ok: boolean }).ok, true);

  all = (await (await get("/api/approvals", TOKEN)).json()) as { requestId: string; status: string; decidedBy: string }[];
  it = all.find((r) => r.requestId === id)!;
  assert.equal(it.status, "revoked");
});

test("吊销需要管理员令牌，缺令牌即 403", async () => {
  const id = await create("user4");
  const noToken = await post("/api/approvals/" + id + "/revoke", {});
  assert.equal(noToken.status, 403);
  const badToken = await post("/api/approvals/" + id + "/revoke", {}, "not-real");
  assert.equal(badToken.status, 403);
});
