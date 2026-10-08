import type { DatabaseSync } from "node:sqlite";

/**
 * 审计导出（roadmap P1-4）：服务端关键管理动作写入 `audit_log`（见 auth.ts 的 recordAudit），
 * 这里只负责**检索与导出**——查询、分页、CSV/JSON 序列化。写入面不在此处。
 */

export interface AuditRow {
  id: number;
  actor: string;
  action: string;
  target: string;
  detail: string;
  createdAt: string;
}

export interface ListAuditOptions {
  /** 起始时间（ISO 字符串），闭区间。 */
  from?: string;
  /** 结束时间（ISO 字符串），闭区间。 */
  to?: string;
  /** action 子串匹配（不区分前后缀，内部补 %）。 */
  action?: string;
  /** actor 精确匹配。 */
  actor?: string;
  page?: number;
  pageSize?: number;
  /** 单页硬上限，防止导出/分页把内存吃爆；默认 500。 */
  maxPageSize?: number;
}

function epochOf(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value.trim());
  return Number.isFinite(t) ? t : null;
}

export function listAudit(db: DatabaseSync, opts: ListAuditOptions = {}): { total: number; page: number; pageSize: number; rows: AuditRow[] } {
  const page = Math.max(1, Math.trunc(opts.page ?? 1) || 1);
  const maxPageSize = opts.maxPageSize ?? 500;
  const pageSize = Math.min(maxPageSize, Math.max(1, Math.trunc(opts.pageSize ?? 50) || 50));
  const from = epochOf(opts.from);
  const to = epochOf(opts.to);
  const actionLike = opts.action ? "%" + opts.action + "%" : null;
  const actor = opts.actor ?? null;

  const where: string[] = [];
  const args: (string | number)[] = [];
  if (from !== null) {
    where.push("created_at >= ?");
    args.push(new Date(from).toISOString());
  }
  if (to !== null) {
    where.push("created_at <= ?");
    args.push(new Date(to).toISOString());
  }
  if (actionLike) {
    where.push("action LIKE ?");
    args.push(actionLike);
  }
  if (actor) {
    where.push("actor = ?");
    args.push(actor);
  }
  const clause = where.length ? " WHERE " + where.join(" AND ") : "";

  const total = (db.prepare("SELECT COUNT(*) AS c FROM audit_log" + clause).get(...args) as { c: number }).c;
  const offset = (page - 1) * pageSize;
  const raw = db
    .prepare("SELECT id, actor, action, target, detail, created_at FROM audit_log" + clause + " ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .all(...args, pageSize, offset) as Record<string, unknown>[];
  const rows: AuditRow[] = raw.map((r) => ({
    id: Number(r.id),
    actor: String(r.actor),
    action: String(r.action),
    target: String(r.target),
    detail: String(r.detail),
    createdAt: String(r.created_at),
  }));
  return { total, page, pageSize, rows };
}

/** CSV 转义：字段含逗号/引号/换行时用双引号包裹，内部引号翻倍。detail 是 JSON 文本最易中招。 */
export function toCsv(rows: AuditRow[]): string {
  const escape = (v: string): string => (/[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  const header = ["id", "actor", "action", "target", "detail", "created_at"].join(",");
  const lines = [header];
  for (const r of rows) {
    lines.push([String(r.id), r.actor, r.action, r.target, r.detail, r.createdAt].map((v) => escape(String(v))).join(","));
  }
  return lines.join("\r\n");
}

export function toJson(rows: AuditRow[]): string {
  return JSON.stringify(rows);
}
