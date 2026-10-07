import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { CatalogDb, createApi, seedDemo } from "../src/server.ts";
import { createUser, issueToken } from "../src/auth.ts";

const adminToken = "idor-admin";

async function start(): Promise<{ base: string; db: CatalogDb; close: () => Promise<void> }> {
  const db = CatalogDb.memory("idor-secret");
  seedDemo(db);
  const api = createApi({ db, packageRoot: await mkdtemp(path.join(tmpdir(), "idor-pkgs-")), adminToken });
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

async function makeApproval(base: string, applicant: string): Promise<string> {
  const created = await call(base, "/api/approvals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId: "vpn-client", appVersion: "5.0.1", applicant, reason: "需要接入 " + applicant }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return String(created.body.requestId ?? created.body.id);
}

test("带用户令牌只能读自己的通知，点名他人一律拒绝", async () => {
  const { base, db, close } = await start();
  try {
    createUser(db.raw(), "alice", "Alice");
    createUser(db.raw(), "bob", "Bob");
    const aliceTok = issueToken(db.raw(), "alice", "user");
    const bobTok = issueToken(db.raw(), "bob", "user");
    const aliceReq = await makeApproval(base, "alice");
    await makeApproval(base, "bob");

    // bob 带着自己的令牌去点名 alice：必须拒。
    const peek = await call(base, "/api/notifications?applicant=alice", { headers: { authorization: "Bearer " + bobTok } });
    assert.equal(peek.status, 403, "跨申请人读取必须被拒（实际 " + String(peek.status) + " / " + JSON.stringify(peek.body).slice(0, 160) + "）");
    assert.ok(!JSON.stringify(peek.body).includes(aliceReq), "被拒的响应里不能带上 alice 的申请 id");

    // 不带 applicant 时，只回自己的那一条。
    const mine = await call(base, "/api/notifications", { headers: { authorization: "Bearer " + bobTok } });
    assert.equal(mine.status, 200);
    assert.ok(Array.isArray(mine.body) && mine.body.length === 1, "bob 只该看到自己的一条：" + JSON.stringify(mine.body).slice(0, 200));
    const aliceView = await call(base, "/api/notifications", { headers: { authorization: "Bearer " + aliceTok } });
    assert.equal(aliceView.body[0]?.reason ?? "", "需要接入 alice");
  } finally {
    await close();
  }
});

test("通知回执不能替别人销账", async () => {
  const { base, db, close } = await start();
  try {
    createUser(db.raw(), "carol", "Carol");
    const carolTok = issueToken(db.raw(), "carol", "user");
    const daveReq = await makeApproval(base, "dave");

    const steal = await call(base, `/api/notifications/${daveReq}/done`, { method: "POST", headers: { authorization: "Bearer " + carolTok } });
    assert.equal(steal.status, 403, "非本人不得把别人的通知标记为已读（实际 " + String(steal.status) + "）");
    const stillOpen = db.raw().prepare("SELECT notified_done FROM approvals WHERE id = ?").get(daveReq) as { notified_done: number } | undefined;
    assert.equal(Number(stillOpen?.notified_done ?? 1), 0, "被拒之后 notified_done 必须仍是 0");

    // 管理端令牌可以代为关闭。
    const asAdmin = await call(base, `/api/notifications/${daveReq}/done`, { method: "POST", headers: { authorization: "Bearer " + adminToken } });
    assert.equal(asAdmin.status, 200, "admin 应能关闭任意回执");
  } finally {
    await close();
  }
});

test("管理端令牌可以按申请人查看", async () => {
  const { base, close } = await start();
  try {
    const aliceReq = await makeApproval(base, "alice");
    const view = await call(base, "/api/notifications?applicant=alice", { headers: { authorization: "Bearer " + adminToken } });
    assert.equal(view.status, 200);
    assert.ok(JSON.stringify(view.body).includes(aliceReq), "admin 按申请人查看是它的正当能力");
  } finally {
    await close();
  }
});

test("特征测试：未配置身份的匿名调用维持旧行为（部署方必须自己收紧）", async () => {
  const { base, close } = await start();
  try {
    const aliceReq = await makeApproval(base, "alice");
    const anon = await call(base, "/api/notifications?applicant=alice");
    assert.equal(anon.status, 200, "匿名读在「整个部署没有身份」时仍放行——这是文档化的演示模式，不是漏洞修复的一部分");
    assert.ok(JSON.stringify(anon.body).includes(aliceReq));
    const anonDone = await call(base, `/api/notifications/${aliceReq}/done`, { method: "POST" });
    assert.equal(anonDone.status, 200, "匿名回执同样维持旧行为");
  } finally {
    await close();
  }
});

test("未设 ADMIN_TOKEN 时管理端点不得默认放行", async () => {
  const db = CatalogDb.memory("idor-open-secret");
  seedDemo(db);
  const api = createApi({ db, packageRoot: await mkdtemp(path.join(tmpdir(), "idor-open-pkgs-")) });
  const port = await new Promise<number>((resolve) => api.listen(0, "127.0.0.1", () => resolve((api.address() as AddressInfo).port)));
  const base = "http://127.0.0.1:" + String(port);
  try {
    const banner = await call(base, "/api/admin/banners", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "未鉴权写入" }) });
    assert.equal(banner.status, 403, "adminToken 未配置时必须 fail-closed（实际 " + String(banner.status) + " / " + JSON.stringify(banner.body).slice(0, 160) + "）");
    const fleet = await call(base, "/api/admin/fleet");
    assert.equal(fleet.status, 403, "机群视图同样不得默认放行");
  } finally {
    api.closeAllConnections();
    await new Promise<void>((resolve, reject) => api.close((err) => (err ? reject(err) : resolve())));
  }
});
