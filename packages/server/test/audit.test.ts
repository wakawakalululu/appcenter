import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { CatalogDb, createApi, seedDemo } from "../src/server.ts";
import { recordAudit } from "../src/auth.ts";

const TOKEN = "audit-token";
const packageRoot = await mkdtemp(path.join(tmpdir(), "audit-pkgs-"));
const db = CatalogDb.memory("audit-secret");
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

const get = (p: string, token?: string): Promise<Response> =>
  fetch(base + p, { headers: token ? { authorization: "Bearer " + token } : {} });

const insertAudit = (actor: string, action: string, n = 1): void => {
  for (let i = 0; i < n; i++) recordAudit(db.raw(), actor, action, "t" + i, "d" + i);
};

test("无 token 访问审计端点返回 403", async () => {
  const res = await get("/api/admin/audit");
  assert.equal(res.status, 403);
  const exp = await get("/api/admin/audit/export?format=csv");
  assert.equal(exp.status, 403);
});

test("带 token 可列出审计；seedDemo 不写审计故初始为空", async () => {
  const res = await get("/api/admin/audit", TOKEN);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { total: number; rows: unknown[] };
  assert.equal(body.total, 0);
  assert.equal(body.rows.length, 0);
});

test("审计写入后可按 action / actor 过滤并分页", async () => {
  insertAudit("alice", "app.delete", 3);
  insertAudit("bob", "category.upsert", 2);

  const all = await (await get("/api/admin/audit?pageSize=10", TOKEN)).json() as { total: number; rows: { actor: string }[] };
  assert.equal(all.total, 5);
  assert.equal(all.rows.length, 5);

  const filtered = await (await get("/api/admin/audit?action=app.delete", TOKEN)).json() as { total: number; rows: { actor: string }[] };
  assert.equal(filtered.total, 3);
  assert.ok(filtered.rows.every((r) => r.actor === "alice"));

  const byActor = await (await get("/api/admin/audit?actor=bob", TOKEN)).json() as { total: number };
  assert.equal(byActor.total, 2);

  const paged = await (await get("/api/admin/audit?pageSize=2&page=1", TOKEN)).json() as { pageSize: number; rows: unknown[] };
  assert.equal(paged.pageSize, 2);
  assert.equal(paged.rows.length, 2);
});

test("CSV 导出是附件、带表头、对逗号/引号正确转义", async () => {
  recordAudit(db.raw(), "admin", "self_update.publish", "v1", "a,b\"c");
  const res = await get("/api/admin/audit/export?format=csv", TOKEN);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment/);
  const text = await res.text();
  assert.match(text, /id,actor,action,target,detail,created_at/);
  assert.match(text, /"a,b""c"/);
});

test("JSON 导出返回数组", async () => {
  const res = await get("/api/admin/audit/export?format=json", TOKEN);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const arr = await res.json();
  assert.ok(Array.isArray(arr));
});

test("banners/bundles 写入被审计（不漏记）", async () => {
  const banner = await fetch(base + "/api/admin/banners", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
    body: JSON.stringify({ id: "b1", title: "运营位" }),
  });
  assert.equal(banner.status, 201);
  const bundle = await fetch(base + "/api/admin/bundles", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
    body: JSON.stringify({ id: "bundle1", title: "套装", appIds: ["wps-office"] }),
  });
  assert.equal(bundle.status, 201);

  const audit = await (await get("/api/admin/audit?action=banner.upsert", TOKEN)).json() as { total: number };
  assert.equal(audit.total, 1);
  const audit2 = await (await get("/api/admin/audit?action=bundle.upsert", TOKEN)).json() as { total: number };
  assert.equal(audit2.total, 1);
});
