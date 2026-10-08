import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_STALE_AFTER_MS, stalenessOf, type AssetApp, type FleetAgent, type FleetHistoryPoint } from "@appcenter/core";
import { recordAudit } from "./auth.ts";

/** 每台机器保留的历史心跳条数上限，超出即剪掉最旧的，避免时序表无限膨胀。 */
const HISTORY_LIMIT = 100;

/** machineId 与列表长度的硬上限：这两个字段完全由客户端给，不设界就等于任人塞任意大的行。 */
const MAX_MACHINE_ID_LENGTH = 200;
const MAX_LIST_ITEMS = 5000;

/** `decodeURIComponent("%zz")` 这类畸形转义会抛异常，过去一路冒到 500。 */
export function decodeSegment(value: string | undefined): string {
  try {
    return decodeURIComponent(value ?? "");
  } catch {
    return value ?? "";
  }
}

/**
 * 计数列都是 NOT NULL：`Number({})`、`Number("abc")` 得到 NaN 会让整条写入炸成 500，这里统一收口。
 * 只认真数字或纯数字字符串——`Number([1])` 是 1、`Number(true)` 是 1，数组与布尔都不该当成计数。
 */
export function intOf(value: unknown, fallback: number): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Math.max(0, Number(value.trim()));
  return fallback;
}

/**
 * 运营位时间窗判断。库里的 starts_at/ends_at 可能是 `2026-09-01T00:00:00+08:00`
 * 这种带偏移的写法，与 `new Date().toISOString()` 的 Z 文本做字符串比较会错位
 * （`"+08:00" > "Z"`），所以一律按 epoch 比较。
 */
export function withinBannerWindow(startsAt: unknown, endsAt: unknown, nowMs: number): boolean {
  const at = (value: unknown): number | null => {
    const text = String(value ?? "").trim();
    if (!text) return null;
    const time = Date.parse(text);
    return Number.isFinite(time) ? time : null;
  };
  const start = at(startsAt);
  const end = at(endsAt);
  return (start === null || start <= nowMs) && (end === null || end >= nowMs);
}

/**
 * 应用中心的服务端补充能力，对应服务端架构设计 §5/§6：
 * 安装回执（分发是否真的装上了）、运营位 banner、审批通知与 done 回执。
 */
const TABLES: string[] = [
  "CREATE TABLE IF NOT EXISTS receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, version TEXT NOT NULL, result TEXT NOT NULL, exit_code INTEGER, duration_ms INTEGER, error TEXT NOT NULL DEFAULT '', machine TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS banners (id TEXT PRIMARY KEY, title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, starts_at TEXT, ends_at TEXT, active INTEGER NOT NULL DEFAULT 1)",
  // 捆绑包（装机套装）：一组应用按顺序整体下发。
  "CREATE TABLE IF NOT EXISTS bundles (id TEXT PRIMARY KEY, title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '', app_ids TEXT NOT NULL DEFAULT '[]', sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)",
  // 机群资产心跳：每台机器一行，只存目录内应用安装态摘要与计数（无终端行为数据）。
  "CREATE TABLE IF NOT EXISTS heartbeats (machine_id TEXT PRIMARY KEY, app_version TEXT NOT NULL DEFAULT '', installed_count INTEGER NOT NULL DEFAULT 0, upgradable_count INTEGER NOT NULL DEFAULT 0, needs_approval_count INTEGER NOT NULL DEFAULT 0, pending_approvals INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL DEFAULT '{}', first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)",
  // 心跳时序：每次上报追加一行计数快照，按机器保留最近 HISTORY_LIMIT 条。
  "CREATE TABLE IF NOT EXISTS heartbeat_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL, installed_count INTEGER NOT NULL DEFAULT 0, upgradable_count INTEGER NOT NULL DEFAULT 0, needs_approval_count INTEGER NOT NULL DEFAULT 0, reported_at TEXT NOT NULL)",
  // 机群视图与剪枝都按 machine_id 过滤；没索引时每条心跳的 DELETE...NOT IN 会全表扫历史。
  "CREATE INDEX IF NOT EXISTS idx_heartbeat_history_machine ON heartbeat_history (machine_id, seq)",
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

/**
 * 单次请求体的硬上限。`body()` 是把整个请求体读进内存再 parse 的，不设上限就等于让客户端决定服务端占用多少；
 * 心跳会带安装清单，正常量级几十 KB，1 MiB 已在真实需求之上两个数量级。
 * 超限返回 null 而不是 `{}`：静默当成空体会让这条上报以「零应用、零待审」落库，那是把攻击变成脏数据。
 */
const MAX_BODY_BYTES = 1024 * 1024;

function rejectTooLarge(req: IncomingMessage, res: ServerResponse): Promise<null> {
  const payload = JSON.stringify({ error: "payload too large" });
  // 两条承诺要同时成立：
  // ① 「不等待请求体」——状态与头立刻写出（`Content-Length 声明超限就该马上拒`那条用例一个字节都不发，靠的就是这个）；
  // ② 客户端必须真的收到 413，而不是连接被重置。
  // 旧写法在这里 writeHead+res.end() 并带 `connection: close`：Node 在响应结束时就销毁 socket，
  // 而 3 MiB 还在上传，客户端拿到的是 fetch failed / ECONNRESET（隔离重跑 6 轮红 2 轮实测到的就是这个）。
  // 只加 req.resume() 不够（同样 2/6 红，已被测量否掉），因为销毁 socket 的是 connection: close 那条决定。
  // 现在：头先出、把还在飞的字节读完丢弃、等请求结束（或有界 250ms 兜底，客户端 dribble 也不能让我们永挂）之后再结束响应。
  res.writeHead(413, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
  });
  req.resume();
  return new Promise<null>((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (!res.writableEnded) res.end(payload);
      resolve(null);
    };
    req.on("end", finish);
    req.on("close", finish);
    req.on("aborted", finish);
    setTimeout(finish, 250).unref();
  });
}

async function body(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return rejectTooLarge(req, res);
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      oversized = true;
      // 超限后仍把剩下的字节读完但**丢弃**：立刻回 413 会在客户端还在上传的中途把连接打断，
      // 实测 fetch 拿到的是 ECONNRESET 而不是我们的状态码——上限该限的是内存，不该限掉可诊断的响应。
      chunks.length = 0;
      continue;
    }
    if (!oversized) chunks.push(chunk as Buffer);
  }
  if (oversized) return rejectTooLarge(req, res);
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
  /** 调用者身份；null 表示匿名（无凭据部署，维持旧行为）。 */
  principal: (req: IncomingMessage) => { userId: string; role: string } | null;
}

/**
 * 通知按申请人取，但 applicant 一直是客户端自报的——任何人都能点名读别人的审批流水
 * （里面带 reason 文本）。带令牌的调用者一律收口到「只能看自己」，admin 例外；
 * 匿名调用维持原样，因为整套部署没配身份时没有更弱的假设可退。
 * 导出来给 server.ts 的 /api/approvals 复用：同一条规则不该有两份实现。
 */
export function scopedApplicant(who: { userId: string; role: string } | null, requested: string): { applicant: string } | { denied: string } {
  if (!who || who.role === "admin") return { applicant: requested };
  if (requested && requested !== who.userId) return { denied: "applicant mismatch" };
  return { applicant: who.userId };
}

export async function handleExtras(ctx: ExtrasContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  ensure(ctx.db);
  const method = req.method ?? "GET";
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments[0] === "api" && segments[1] === "banners" && method === "GET") {
    // 时间窗不能交给 SQL 做字符串比较：starts_at 可能是 `...+08:00` 带偏移的写法，
    // 与 toISOString() 的 Z 文本比较会错位（"+" 的字符码大于 "Z"），于是过期的运营位仍在外露。
    const nowMs = Date.now();
    const rows = ctx.db.prepare("SELECT * FROM banners WHERE active = 1 ORDER BY sort_order, id").all() as Record<string, unknown>[];
    send(res, 200, rows.filter((row) => withinBannerWindow(row.starts_at, row.ends_at, nowMs)).map(toBanner));
    return true;
  }
  if (segments[0] === "api" && segments[1] === "admin" && segments[2] === "banners" && method === "POST") {
    if (!ctx.requireAdmin(req)) return send(res, 403, { error: "admin token required" }), true;
    const input = await body(req, res);
    if (input === null) return true;
    const id = String(input.id ?? "banner_" + createHash("sha1").update(String(input.title ?? "") + Date.now()).digest("hex").slice(0, 8));
    ctx.db
      .prepare("INSERT INTO banners (id, title, subtitle, image_url, link, sort_order, starts_at, ends_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, subtitle=excluded.subtitle, image_url=excluded.image_url, link=excluded.link, sort_order=excluded.sort_order, starts_at=excluded.starts_at, ends_at=excluded.ends_at, active=excluded.active")
      .run(id, String(input.title ?? ""), String(input.subtitle ?? ""), String(input.imageUrl ?? ""), String(input.link ?? ""), Number(input.sortOrder ?? 0), input.startsAt ? String(input.startsAt) : null, input.endsAt ? String(input.endsAt) : null, input.active === false ? 0 : 1);
    recordAudit(ctx.db, "admin", "banner.upsert", id);
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
    const input = await body(req, res);
    if (input === null) return true;
    const id = String(input.id ?? "bundle_" + createHash("sha1").update(String(input.title ?? "") + Date.now()).digest("hex").slice(0, 8));
    const appIds = Array.isArray(input.appIds) ? input.appIds.map((v) => String(v)) : [];
    if (appIds.length === 0) return send(res, 400, { error: "appIds must not be empty" }), true;
    ctx.db
      .prepare("INSERT INTO bundles (id, title, subtitle, app_ids, sort_order, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, subtitle=excluded.subtitle, app_ids=excluded.app_ids, sort_order=excluded.sort_order, active=excluded.active")
      .run(id, String(input.title ?? ""), String(input.subtitle ?? ""), JSON.stringify(appIds), Number(input.sortOrder ?? 0), input.active === false ? 0 : 1, new Date().toISOString());
    recordAudit(ctx.db, "admin", "bundle.upsert", id);
    send(res, 201, { id, appIds });
    return true;
  }

  if (segments[0] === "api" && segments[1] === "apps" && segments[3] === "receipt" && method === "POST") {
    // 过去这条写路由不校验方法：GET /api/apps/<id>/receipt 也会插一行，
    // 等于任何页面用一个 <img src> 就能伪造回执（CSRF）。
    const appId = decodeSegment(segments[2]);
    // 回执同样是写路由：CSRF 已收口成「只认 POST」，但匿名 POST 依然能凭空造装机结果（版本、成败、退出码、错误文本）。
    // 与心跳用同一条规则：先验身份，再读体。
    if (!ctx.principal(req)) return send(res, 401, { error: "bearer token required" }), true;
    const input = await body(req, res);
    if (input === null) return true;
    const result = input.result === "failed" ? "failed" : "success";
    const exitCode = input.exitCode === undefined || input.exitCode === null ? null : intOf(input.exitCode, 0);
    const durationMs = input.durationMs === undefined || input.durationMs === null ? null : intOf(input.durationMs, 0);
    ctx.db
      .prepare("INSERT INTO receipts (app_id, version, result, exit_code, duration_ms, error, machine, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(appId, String(input.version ?? "").slice(0, 120), result, exitCode, durationMs, String(input.error ?? "").slice(0, 2000), String(input.machine ?? "").slice(0, MAX_MACHINE_ID_LENGTH), new Date().toISOString());
    send(res, 201, { ok: true });
    return true;
  }
  if (segments[0] === "api" && segments[1] === "apps" && segments[3] === "receipts" && method === "GET") {
    const appId = decodeSegment(segments[2]);
    const rows = ctx.db.prepare("SELECT * FROM receipts WHERE app_id = ? ORDER BY created_at DESC LIMIT 20").all(appId) as Record<string, unknown>[];
    send(res, 200, rows.map((r) => ({ version: String(r.version), result: String(r.result), exitCode: r.exit_code === null ? null : Number(r.exit_code), durationMs: r.duration_ms === null ? null : Number(r.duration_ms), error: String(r.error), createdAt: String(r.created_at) })));
    return true;
  }

  if (segments[0] === "api" && segments[1] === "notifications" && method === "GET") {
    const scoped = scopedApplicant(ctx.principal(req), url.searchParams.get("applicant") ?? "");
    if ("denied" in scoped) return send(res, 403, { error: scoped.denied }), true;
    const rows = ctx.db.prepare("SELECT id, app_id, app_version, status, reason, created_at, notified_done FROM approvals WHERE applicant = ? AND status IN ('pending','approved','granted','rejected') ORDER BY created_at DESC").all(scoped.applicant) as Record<string, unknown>[];
    send(res, 200, rows.map((r) => ({ id: String(r.id), appId: String(r.app_id), appVersion: String(r.app_version), status: String(r.status), reason: String(r.reason), createdAt: String(r.created_at), done: Number(r.notified_done) === 1 })));
    return true;
  }
  if (segments[0] === "api" && segments[1] === "notifications" && segments[3] === "done" && method === "POST") {
    const id = decodeSegment(segments[2]);
    const who = ctx.principal(req);
    if (who && who.role !== "admin") {
      const owner = ctx.db.prepare("SELECT applicant FROM approvals WHERE id = ?").get(id) as { applicant: string } | undefined;
      if (!owner) return send(res, 404, { error: "no such notification" }), true;
      if (owner.applicant !== who.userId) return send(res, 403, { error: "not your notification" }), true;
    }
    const result = ctx.db.prepare("UPDATE approvals SET notified_done = 1 WHERE id = ?").run(id);
    send(res, Number(result.changes ?? 0) > 0 ? 200 : 404, { ok: Number(result.changes ?? 0) > 0 });
    return true;
  }

  // 机群资产心跳：客户端周期性上报，服务端按 machineId 幂等 upsert 最近一次，并追加一条时序快照。
  if (segments[0] === "api" && segments[1] === "heartbeat" && segments.length === 2 && method === "POST") {
    // 身份先行，再读请求体：反过来就等于让未认证客户端决定服务端要 buffer 多少内存、写进机群表的是什么。
    // 之前这里既不过 requireAdmin 也不看 principal，任何能连上端口（HOST 允许跨主机时就是局域网）的人
    // 都能凭空造 installed/upgradable/needsApproval 计数与机器行，并喂脏 heartbeat_history 趋势。
    // 刻意不开新的逃生口：没配 ADMIN_TOKEN 的部署里 principal 恒为 null，那就报不了心跳（fail-closed，
    // 与 /api/admin/* 同一条规则）；main.ts 已有的启动警告会把这件事说给运维听。
    if (!ctx.principal(req)) return send(res, 401, { error: "bearer token required" }), true;
    const input = await body(req, res);
    if (input === null) return true;
    const machineId = String(input.machineId ?? "");
    if (!machineId) return send(res, 400, { error: "machineId required" }), true;
    if (machineId.length > MAX_MACHINE_ID_LENGTH) return send(res, 400, { error: "machineId too long" }), true;
    const installed = Array.isArray(input.installed) ? (input.installed as AssetApp[]) : [];
    const needsApproval = Array.isArray(input.needsApproval) ? input.needsApproval.map(String) : [];
    if (installed.length > MAX_LIST_ITEMS || needsApproval.length > MAX_LIST_ITEMS) {
      return send(res, 413, { error: "heartbeat payload too large" }), true;
    }
    const counts = (input.counts ?? {}) as Record<string, unknown>;
    // 这几列都是 NOT NULL：客户端给个对象或字符串就会得到 NaN，整条上报炸成 500。
    const installedCount = intOf(counts.installed, installed.length);
    const upgradableCount = intOf(counts.upgradable, installed.filter((app) => app?.upgradable === true).length);
    const needsApprovalCount = intOf(counts.needsApproval, needsApproval.length);
    const pendingApprovals = intOf(counts.pendingApprovals, 0);
    const now = new Date().toISOString();
    const existing = ctx.db.prepare("SELECT first_seen_at FROM heartbeats WHERE machine_id = ?").get(machineId) as Record<string, unknown> | undefined;
    const firstSeen = existing ? String(existing.first_seen_at) : now;
    ctx.db
      .prepare(
        "INSERT INTO heartbeats (machine_id, app_version, installed_count, upgradable_count, needs_approval_count, pending_approvals, payload, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(machine_id) DO UPDATE SET app_version=excluded.app_version, installed_count=excluded.installed_count, upgradable_count=excluded.upgradable_count, needs_approval_count=excluded.needs_approval_count, pending_approvals=excluded.pending_approvals, payload=excluded.payload, last_seen_at=excluded.last_seen_at",
      )
      .run(machineId, String(input.appVersion ?? "").slice(0, 120), installedCount, upgradableCount, needsApprovalCount, pendingApprovals, JSON.stringify({ installed, needsApproval }), firstSeen, now);
    // 时序快照只留计数；插入后按机器剪枝到最近 HISTORY_LIMIT 条。
    ctx.db.prepare("INSERT INTO heartbeat_history (machine_id, installed_count, upgradable_count, needs_approval_count, reported_at) VALUES (?, ?, ?, ?, ?)").run(machineId, installedCount, upgradableCount, needsApprovalCount, now);
    ctx.db
      .prepare("DELETE FROM heartbeat_history WHERE machine_id = ? AND seq NOT IN (SELECT seq FROM heartbeat_history WHERE machine_id = ? ORDER BY seq DESC LIMIT ?)")
      .run(machineId, machineId, HISTORY_LIMIT);
    send(res, 201, { ok: true, firstSeenAt: firstSeen, lastSeenAt: now });
    return true;
  }
  // 机群汇总（列表）：?staleAfterHours= 控制离线阈值，默认 24h。
  if (segments[0] === "api" && segments[1] === "admin" && segments[2] === "fleet" && segments.length === 3 && method === "GET") {
    if (!ctx.requireAdmin(req)) return send(res, 403, { error: "admin token required" }), true;
    const staleAfterMs = staleWindowMs(url);
    const now = Date.now();
    const rows = ctx.db.prepare("SELECT * FROM heartbeats ORDER BY last_seen_at DESC, machine_id").all() as Record<string, unknown>[];
    const agents = rows.map((row) => toFleetAgent(row, staleAfterMs, now));
    const totals = agents.reduce(
      (acc, a) => ({
        agents: acc.agents + 1,
        installed: acc.installed + a.counts.installed,
        upgradable: acc.upgradable + a.counts.upgradable,
        needsApproval: acc.needsApproval + a.counts.needsApproval,
        stale: acc.stale + (a.stale ? 1 : 0),
      }),
      { agents: 0, installed: 0, upgradable: 0, needsApproval: 0, stale: 0 },
    );
    send(res, 200, { agents, totals });
    return true;
  }
  // 单机详情：最近快照 + 时序历史（按上报时间倒序）。
  if (segments[0] === "api" && segments[1] === "admin" && segments[2] === "fleet" && segments[3] && method === "GET") {
    if (!ctx.requireAdmin(req)) return send(res, 403, { error: "admin token required" }), true;
    const machineId = decodeURIComponent(segments[3]);
    const row = ctx.db.prepare("SELECT * FROM heartbeats WHERE machine_id = ?").get(machineId) as Record<string, unknown> | undefined;
    if (!row) return send(res, 404, { error: "no such machine" }), true;
    const staleAfterMs = staleWindowMs(url);
    const agent = toFleetAgent(row, staleAfterMs, Date.now());
    const historyRows = ctx.db.prepare("SELECT installed_count, upgradable_count, needs_approval_count, reported_at FROM heartbeat_history WHERE machine_id = ? ORDER BY seq DESC LIMIT ?").all(machineId, HISTORY_LIMIT) as Record<string, unknown>[];
    const history: FleetHistoryPoint[] = historyRows.map((h) => ({
      reportedAt: String(h.reported_at),
      installed: Number(h.installed_count),
      upgradable: Number(h.upgradable_count),
      needsApproval: Number(h.needs_approval_count),
    }));
    send(res, 200, { agent, history });
    return true;
  }
  return false;
}

/** 离线阈值：?staleAfterHours= 覆盖默认 24h；非法值回落默认。 */
function staleWindowMs(url: URL): number {
  const raw = url.searchParams.get("staleAfterHours");
  if (raw === null) return DEFAULT_STALE_AFTER_MS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_STALE_AFTER_MS;
  return hours * 60 * 60 * 1000;
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

function toFleetAgent(row: Record<string, unknown>, staleAfterMs: number = DEFAULT_STALE_AFTER_MS, now: number = Date.now()): FleetAgent {
  let installed: AssetApp[] = [];
  let needsApproval: string[] = [];
  try {
    const payload = JSON.parse(String(row.payload ?? "{}")) as Record<string, unknown>;
    if (Array.isArray(payload.installed)) installed = payload.installed as AssetApp[];
    if (Array.isArray(payload.needsApproval)) needsApproval = payload.needsApproval.map(String);
  } catch {
    installed = [];
    needsApproval = [];
  }
  const lastSeenAt = String(row.last_seen_at);
  const { ageMs, stale } = stalenessOf(lastSeenAt, now, staleAfterMs);
  return {
    machineId: String(row.machine_id),
    appVersion: String(row.app_version),
    reportedAt: lastSeenAt,
    installed,
    needsApproval,
    counts: {
      installed: Number(row.installed_count),
      upgradable: Number(row.upgradable_count),
      needsApproval: Number(row.needs_approval_count),
      pendingApprovals: Number(row.pending_approvals),
    },
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt,
    lastSeenAgeMs: ageMs,
    stale,
  };
}
