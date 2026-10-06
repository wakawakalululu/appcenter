import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage } from "node:http";

export type Role = "admin" | "user";

export interface Principal {
  userId: string;
  role: Role;
}

/**
 * P4 服务端治理：把单一静态 ADMIN_TOKEN 升级为「用户/角色令牌」模型。
 * 兼容旧的静态管理员令牌（传了 adminToken 时仍是管理员），并新增可下发的用户令牌。
 */
export function ensureAuthSchema(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', department_id TEXT, created_at TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS api_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS departments (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS app_department_access (app_id TEXT NOT NULL, department_id TEXT NOT NULL, PRIMARY KEY (app_id, department_id))");
  db.exec("CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)");
}

export function createUser(db: DatabaseSync, id: string, name: string, role: Role = "user", departmentId: string | null = null): void {
  db.prepare(
    "INSERT INTO users (id, name, role, department_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role, department_id=excluded.department_id",
  ).run(id, name, role, departmentId, new Date().toISOString());
}

/** 下发不记名令牌：明文只给一次，库里只存 sha256，避免令牌泄露即撞库。 */
export function issueToken(db: DatabaseSync, userId: string, role: Role, ttlMs = 12 * 3600_000): string {
  const token = randomBytes(24).toString("hex");
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare("INSERT INTO api_tokens (token_hash, user_id, role, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(
    createHash("sha256").update(token).digest("hex"),
    userId,
    role,
    issuedAt,
    expiresAt,
  );
  return token;
}

/** 校验请求中的 Bearer 令牌，返回主体；无/无效则返回 null。 */
export function authorize(
  req: IncomingMessage,
  opts: { db: DatabaseSync; adminToken?: string; requiredRole?: Role },
): Principal | null {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return null;
  const raw = (match[1] ?? "").trim();
  if (opts.adminToken && raw === opts.adminToken) return { userId: "admin", role: "admin" };
  const row = opts.db
    .prepare("SELECT user_id, role, expires_at FROM api_tokens WHERE token_hash = ?")
    .get(createHash("sha256").update(raw).digest("hex")) as { user_id: string; role: Role; expires_at: string } | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  const principal: Principal = { userId: row.user_id, role: row.role };
  if (opts.requiredRole && principal.role !== opts.requiredRole && principal.role !== "admin") return null;
  return principal;
}

export function recordAudit(db: DatabaseSync, actor: string, action: string, target = "", detail = ""): void {
  db.prepare("INSERT INTO audit_log (actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)").run(
    actor,
    action,
    target,
    detail,
    new Date().toISOString(),
  );
}

/** 按部门过滤可见应用：返回 null 表示全部可见（缺省行为不变）。 */
export function visibleAppIds(db: DatabaseSync, departmentId: string | null): Set<string> | null {
  if (!departmentId) return null;
  const rows = db.prepare("SELECT app_id FROM app_department_access WHERE department_id = ?").all(departmentId) as { app_id: string }[];
  return new Set(rows.map((r) => r.app_id));
}
