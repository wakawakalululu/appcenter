import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { CatalogDb, createApi, seedDemo } from "../src/server.ts";

const packageRoot = await mkdtemp(path.join(tmpdir(), "auth-pkgs-"));
const db = CatalogDb.memory("auth-secret");
const adminToken = "static-admin";
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

let adminUserToken = "";

async function api<T>(pathname: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(base + pathname, init);
  const body = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, body };
}

test("login mints a role-bound token for a user and an admin", async () => {
  const user = await api<{ token: string; role: string }>("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "alice", name: "Alice", role: "user" }),
  });
  assert.equal(user.status, 200);
  assert.equal(user.body.role, "user");
  assert.ok(user.body.token.length >= 16);

  const admin = await api<{ token: string; role: string }>("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "boss", role: "admin" }),
  });
  assert.equal(admin.body.role, "admin");
  adminUserToken = admin.body.token;
});

test("public catalog is open but admin routes require a token with the right role", async () => {
  const apps = await api<unknown[]>("/api/apps");
  assert.equal(apps.status, 200, "公开目录无需鉴权");

  const noAuth = await api("/api/admin/categories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ category: { id: "x", name: "X", parentId: null, sortOrder: 1 } }),
  });
  assert.equal(noAuth.status, 403, "无令牌的 admin 路由被拒");

  const withStatic = await api("/api/admin/categories", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + adminToken },
    body: JSON.stringify({ category: { id: "y", name: "Y", parentId: null, sortOrder: 1 } }),
  });
  assert.equal(withStatic.status, 201, "静态管理员令牌放行");

  const userTok = (await api<{ token: string }>("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "carol", role: "user" }),
  })).body.token;
  const withUser = await api("/api/admin/categories", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + userTok },
    body: JSON.stringify({ category: { id: "z", name: "Z", parentId: null, sortOrder: 1 } }),
  });
  assert.equal(withUser.status, 403, "普通用户令牌不能做管理操作");

  const adminTok = adminUserToken;
  const withAdminUser = await api("/api/admin/categories", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + adminTok },
    body: JSON.stringify({ category: { id: "w", name: "W", parentId: null, sortOrder: 1 } }),
  });
  assert.equal(withAdminUser.status, 201, "用户令牌(role=admin)放行");
});

test("a rejected approval surfaces in the applicant's notifications", async () => {
  const created = await api<{ requestId: string }>("/api/approvals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId: "vpn-client", appVersion: "5.0.1", applicant: "dave", reason: "需要接入" }),
  });
  assert.equal(created.status, 201);

  const decided = await api(`/api/approvals/${created.body.requestId}/decide`, {
    method: "POST",
    headers: { authorization: "Bearer " + adminToken },
    body: JSON.stringify({ decision: "rejected", decidedBy: "boss", note: "风险过高" }),
  });
  assert.equal(decided.status, 200);

  const notes = await api<{ id: string; status: string }[]>("/api/notifications?applicant=dave");
  assert.equal(notes.status, 200);
  const mine = notes.body.find((n) => n.id === created.body.requestId);
  assert.ok(mine, "驳回结果会出现在申请人通知里");
  assert.equal(mine?.status, "rejected");
});

test("catalog honors department scoping", async () => {
  db.raw()
    .prepare("INSERT INTO app_department_access (app_id, department_id) VALUES (?, ?)")
    .run("wps-office", "dept-eng");
  const all = await api<{ id: string }[]>("/api/apps");
  assert.equal(all.body.length, 21, "默认不过滤（seedDemo 含 11 个补足分类密度的 extraApps）");
  const scoped = await api<{ id: string }[]>("/api/apps?department=dept-eng");
  assert.equal(scoped.body.length, 1);
  assert.equal(scoped.body[0]?.id, "wps-office");
});
