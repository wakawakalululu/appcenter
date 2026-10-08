import { test } from "node:test";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import assert from "node:assert/strict";

import path from "node:path";
import type { AddressInfo } from "node:net";
import { CatalogDb, createApi, seedDemo } from "../src/server.ts";
import { createUser, issueToken } from "../src/auth.ts";
import { makeTrackedTmp } from "../../core/test/util/tmp-dirs.ts";

const adminToken = "apr-admin";

async function start(): Promise<{ base: string; db: CatalogDb; close: () => Promise<void> }> {
  const db = CatalogDb.memory("apr-secret");
  seedDemo(db);
  const api = createApi({ db, packageRoot: await makeTrackedTmp("apr-pkgs-"), adminToken });
  const port = await new Promise<number>((resolve) => api.listen(0, "127.0.0.1", () => resolve((api.address() as AddressInfo).port)));
  return {
    base: "http://127.0.0.1:" + String(port),
    db,
    close: async () => {
      api.closeAllConnections();
      await new Promise<void>((resolve, reject) => api.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

async function call(base: string, pathname: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(base + pathname, init);
  const text = await response.text();
  try {
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: response.status, body: text };
  }
}

const post = (body: unknown, token?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
  body: JSON.stringify(body),
});

const get = (token?: string): RequestInit => ({ headers: token ? { authorization: "Bearer " + token } : {} });

/** 走真实流程造一张「已批准」的单：匿名创建 + 管理员批复（这两步本身是本文件的被测对象之外）。 */
async function approvedRequestAs(base: string, applicant: string): Promise<string> {
  const created = await call(base, "/api/approvals", post({ appId: "vpn-client", appVersion: "5.0.1", applicant, reason: "需要接入" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = String(created.body.requestId);
  const decided = await call(base, `/api/approvals/${id}/decide`, post({ decision: "approved", decidedBy: "boss" }, adminToken));
  assert.equal(decided.status, 200);
  return id;
}

test("铸凭证端点必须鉴权：别人的批准单换不出安装凭证", async () => {
  const { base, db, close } = await start();
  try {
    createUser(db.raw(), "carol", "Carol");
    const carolTok = issueToken(db.raw(), "carol", "user");
    const aliceReq = await approvedRequestAs(base, "alice");

    // 顺序有讲究：issueGrant 会把单子从 approved 改成 granted，所以先验越权（不改状态），
    // 再验 admin 正常签发，匿名那条另开一张单，避免互相把状态吃掉后误判成 409。
    const asCarol = await call(base, `/api/approvals/${aliceReq}/grant`, post({}, carolTok));
    assert.equal(asCarol.status, 403, "carol 拿自己的令牌也铸不出 alice 的单");
    assert.ok(!JSON.stringify(asCarol.body).includes("token"), "被拒的响应里不得带凭证：" + JSON.stringify(asCarol.body).slice(0, 140));

    const asAdmin = await call(base, `/api/approvals/${aliceReq}/grant`, post({}, adminToken));
    assert.equal(asAdmin.status, 200, "admin 应能签发");
    assert.ok(asAdmin.body?.token, "响应里应有 token");

    // 匿名铸凭证在「整套部署没有身份」时仍放行——本仓库一致的既有语义（见最后的特征测试）。
    // 没有身份就无从收口；收紧它属于部署决策，不是这条路由的 bug。
    const frankReq = await approvedRequestAs(base, "frank");
    const anon = await call(base, `/api/approvals/${frankReq}/grant`, post({}));
    assert.equal(anon.status, 200, "匿名维持旧行为（无身份部署），真正的收口是上面那条 403");
  } finally {
    await close();
  }
});

test("审批列表同样按申请人收口（#31 漏掉的那条路由）", async () => {
  const { base, db, close } = await start();
  try {
    createUser(db.raw(), "bob", "Bob");
    const bobTok = issueToken(db.raw(), "bob", "user");
    const aliceReq = await approvedRequestAs(base, "alice");
    await approvedRequestAs(base, "bob");

    const peek = await call(base, "/api/approvals?applicant=alice", get(bobTok));
    assert.equal(peek.status, 403, "bob 点名看 alice 的审批必须被拒（实际 " + String(peek.status) + "）");
    assert.ok(!JSON.stringify(peek.body).includes(aliceReq), "被拒响应不得带出 alice 的单号");

    const mine = await call(base, "/api/approvals", get(bobTok));
    assert.equal(mine.status, 200);
    assert.equal(Array.isArray(mine.body) ? mine.body.length : -1, 1, "bob 不带参数时只该看到自己那一条");

    const asAdmin = await call(base, "/api/approvals?applicant=alice", get(adminToken));
    assert.equal(asAdmin.status, 200, "admin 按申请人查看是正当能力");
    assert.ok(JSON.stringify(asAdmin.body).includes(aliceReq));
  } finally {
    await close();
  }
});

test("创建审批不得冒名：带令牌时 applicant 一律收口到自己", async () => {
  const { base, db, close } = await start();
  try {
    createUser(db.raw(), "dave", "Dave");
    const daveTok = issueToken(db.raw(), "dave", "user");

    const spoof = await call(base, "/api/approvals", post({ appId: "vpn-client", appVersion: "5.0.1", applicant: "alice", reason: "冒名" }, daveTok));
    assert.equal(spoof.status, 403, "声明成别人必须被拒（实际 " + String(spoof.status) + "）");

    const implicit = await call(base, "/api/approvals", post({ appId: "vpn-client", appVersion: "5.0.1", reason: "没写申请人" }, daveTok));
    assert.equal(implicit.status, 201, "不写 applicant 时应落到调用者自己身上");
    const rows = db.approvalsOf("dave");
    assert.equal(rows.length, 1, "dave 名下应有 1 条：" + JSON.stringify(rows.map((r) => r.id)));
    assert.equal(db.approvalsOf("alice").length, 0, "alice 名下不该多出条目");
  } finally {
    await close();
  }
});

test("特征测试：无身份部署下这三条维持旧行为", async () => {
  const { base, close } = await start();
  try {
    const id = await approvedRequestAs(base, "erin");
    const grant = await call(base, `/api/approvals/${id}/grant`, post({}));
    assert.equal(grant.status, 200, "匿名铸凭证在「整个部署没有身份」时仍放行——与 #31/#37 的空密钥处理一致，是文档化模式而非本次修复范围");
    const list = await call(base, "/api/approvals?applicant=erin");
    assert.equal(list.status, 200);
    assert.ok(JSON.stringify(list.body).includes(id));
    const create = await call(base, "/api/approvals", post({ appId: "vpn-client", appVersion: "5.0.1", applicant: "erin", reason: "匿名创建" }));
    assert.equal(create.status, 201);
  } finally {
    await close();
  }
});
