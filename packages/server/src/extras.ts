import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";

/**
 * 应用中心的服务端补充能力，对应服务端架构设计 §5/§6：
 * 安装回执（分发是否真的装上了）、运营位 banner、审批通知与 done 回执。
 */
const TABLES: string[] = [
  "CREATE TABLE IF NOT EXISTS receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, version TEXT NOT NULL, result TEXT NOT NULL, exit_code INTEGER, duration_ms INTEGER, error TEXT NOT NULL DEFAULT '', machine TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS banners (id TEXT PRIMARY KEY, title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, starts_at TEXT, ends_at TEXT, active INTEGER NOT NULL DEFAULT 1)",
  // 捆绑包（装机套装）：一组应用按顺序整体下发。
  "CREATE TABLE IF NOT EXISTS bundles (id TEXT PRIMARY KEY, title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '', app_ids TEXT NOT NULL DEFAULT '[]', sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)",
];

export interface Bundle {
  id: string;
  title: string;
  subtitle: string;
  appIds: string[];
  sortOrder: number;
  active: boolean;
}

export interface Banner {
  id: string;
  title: string;
  subtitle: string;
  imageUrl: string;
  link: string;
  sortOrder: number;
  startsAt: string | null;
  endsAt: string | null;
  active: boolean;
}

function ensure(db: DatabaseSync): void {
  for (const statement of TABLES) db.exec(statement);
  try {
    db.exec("ALTER TABLE approvals ADD COLUMN notified_done INTEGER NOT NULL DEFAULT 0");
  } catch {
    // 列已存在
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(payload)) });
  res.end(payload);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface ExtrasContext {
  db: DatabaseSync;
  requireAdmin: (req: IncomingMessage) => boolean;
}

export async function handleExtras(ctx: ExtrasContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  ensure(ctx.db);
  const method = req.method ?? "GET";
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments[0] === "api" && segments[1] === "banners" && method === "GET") {
    const now = new Date().toISOString();
    const rows = ctx.db.prepare("SELECT * FROM banners WHERE active = 1 AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at >= ?) ORDER BY sort_order, id").all(now, now) as Record<string, unknown>[];
    send(res, 200, rows.map(toBanner));
    return true;
  }
  if (segments[0] === "api" && segments[1] === "admin" && segments[2] === "banners" && method === "POST") {
    if (!ctx.requireAdmin(req)) return send(res, 403, { error: "admin token required" }), true;
    const input = await body(req);
    const id = String(input.id ?? "banner_" + createHash("sha1").update(String(input.title ?? "") + Date.now()).digest("hex").slice(0, 8));
    ctx.db
      .prepare("INSERT INTO banners (id, title, subtitle, image_url, link, sort_order, starts_at, ends_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, subtitle=excluded.subtitle, image_url=excluded.image_url, link=excluded.link, sort_order=excluded.sort_order, starts_at=excluded.starts_at, ends_at=excluded.ends_at, active=excluded.active")
      .run(id, String(input.title ?? ""), String(input.subtitle ?? ""), String(input.imageUrl ?? ""), String(input.link ?? ""), Number(input.sortOrder ?? 0), input.startsAt ? String(input.startsAt) : null, input.endsAt ? String(input.endsAt) : null, input.active === false ? 0 : 1);
    send(res, 201, { id });
    return true;
  }

  if (segments[0] === "api" && segments[1] === "bundles" && segments.length === 2 && method === "GET") {
    const rows = ctx.db.prepare("SELECT * FROM bundles WHERE active = 1 ORDER BY sort_order, id").all() as Record<string, unknown>[];
    send(res, 200, rows.map(toBundle));
    return true;
  }
  if (segments[0] === "api" && segments[1] === "bundles" && segments[2] && method === "GET") {
    const row = ctx.db.prepare("SELECT * FROM bundles WHERE id = ? AND active = 1").get(decodeURIComponent(segments[2])) as Record<string, unknown> | undefined;
    if (!row) return send(res, 404, { error: "no such bundle" }), true;
    send(res, 200, toBundle(row));
    return true;
  }
  if (segments[0] === "api" && segments[1] === "admin" && segments[2] === "bundles" && method === "POST") {
    if (!ctx.requireAdmin(req)) return send(res, 403, { error: "admin token required" }), true;
    const input = await body(req);
    const id = String(input.id ?? "bundle_" + createHash("sha1").update(String(input.title ?? "") + Date.now()).digest("hex").slice(0, 8));
    const appIds = Array.isArray(input.appIds) ? input.appIds.map((v) => String(v)) : [];
    if (appIds.length === 0) return send(res, 400, { error: "appIds must not be empty" }), true;
    ctx.db
      .prepare("INSERT INTO bundles (id, title, subtitle, app_ids, sort_order, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, subtitle=excluded.subtitle, app_ids=excluded.app_ids, sort_order=excluded.sort_order, active=excluded.active")
      .run(id, String(input.title ?? ""), String(input.subtitle ?? ""), JSON.stringify(appIds), Number(input.sortOrder ?? 0), input.active === false ? 0 : 1, new Date().toISOString());
    send(res, 201, { id, appIds });
    return true;
  }

  if (segments[0] === "api" && segments[1] === "apps" && segments[3] === "receipt") {
    const appId = decodeURIComponent(segments[2] ?? "");
    const input = await body(req);
    const result = input.result === "failed" ? "failed" : "success";
    ctx.db
      .prepare("INSERT INTO receipts (app_id, version, result, exit_code, duration_ms, error, machine, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(appId, String(input.version ?? ""), result, input.exitCode === undefined ? null : Number(input.exitCode), input.durationMs === undefined ? null : Number(input.durationMs), String(input.error ?? ""), String(input.machine ?? ""), new Date().toISOString());
    send(res, 201, { ok: true });
    return true;
  }
  if (segments[0] === "api" && segments[1] === "apps" && segments[3] === "receipts" && method === "GET") {
    const appId = decodeURIComponent(segments[2] ?? "");
    const rows = ctx.db.prepare("SELECT * FROM receipts WHERE app_id = ? ORDER BY created_at DESC LIMIT 20").all(appId) as Record<string, unknown>[];
    send(res, 200, rows.map((r) => ({ version: String(r.version), result: String(r.result), exitCode: r.exit_code === null ? null : Number(r.exit_code), durationMs: r.duration_ms === null ? null : Number(r.duration_ms), error: String(r.error), createdAt: String(r.created_at) })));
    return true;
  }

  if (segments[0] === "api" && segments[1] === "notifications" && method === "GET") {
    const applicant = url.searchParams.get("applicant") ?? "";
    const rows = ctx.db.prepare("SELECT id, app_id, app_version, status, reason, created_at, notified_done FROM approvals WHERE applicant = ? AND status IN ('pending','approved','granted','rejected') ORDER BY created_at DESC").all(applicant) as Record<string, unknown>[];
    send(res, 200, rows.map((r) => ({ id: String(r.id), appId: String(r.app_id), appVersion: String(r.app_version), status: String(r.status), reason: String(r.reason), createdAt: String(r.created_at), done: Number(r.notified_done) === 1 })));
    return true;
  }
  if (segments[0] === "api" && segments[1] === "notifications" && segments[3] === "done" && method === "POST") {
    const id = decodeURIComponent(segments[2] ?? "");
    const result = ctx.db.prepare("UPDATE approvals SET notified_done = 1 WHERE id = ?").run(id);
    send(res, Number(result.changes ?? 0) > 0 ? 200 : 404, { ok: Number(result.changes ?? 0) > 0 });
    return true;
  }
  return false;
}

function toBundle(row: Record<string, unknown>): Bundle {
  let appIds: string[] = [];
  try {
    const parsed = JSON.parse(String(row.app_ids ?? "[]")) as unknown;
    if (Array.isArray(parsed)) appIds = parsed.map((v) => String(v));
  } catch {
    appIds = [];
  }
  return {
    id: String(row.id),
    title: String(row.title),
    subtitle: String(row.subtitle),
    appIds,
    sortOrder: Number(row.sort_order),
    active: Number(row.active) === 1,
  };
}

function toBanner(row: Record<string, unknown>): Banner {
  return {
    id: String(row.id),
    title: String(row.title),
    subtitle: String(row.subtitle),
    imageUrl: String(row.image_url),
    link: String(row.link),
    sortOrder: Number(row.sort_order),
    startsAt: row.starts_at ? String(row.starts_at) : null,
    endsAt: row.ends_at ? String(row.ends_at) : null,
    active: Number(row.active) === 1,
  };
}
