import { createHash, createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { AppDetail, AppSummary, AppVersion, Category, RatingInput, SilentSpec } from "@appcenter/core";
import { joinWithinRoot, safePathSegment, toDistribution } from "@appcenter/core";
import { handleExtras, scopedApplicant } from "./extras.ts";
import { authorize, createUser, ensureAuthSchema, issueToken, recordAudit, visibleAppIds, type Principal } from "./auth.ts";
import { listAudit, toCsv, toJson } from "./audit.ts";

const SCHEMA: string[] = [
  "CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, sort_order INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS apps (id TEXT PRIMARY KEY, name TEXT NOT NULL, search_keys TEXT NOT NULL DEFAULT '[]', publisher TEXT NOT NULL DEFAULT '', category_id TEXT NOT NULL, icon_url TEXT NOT NULL DEFAULT '', latest_version TEXT NOT NULL, download_count INTEGER NOT NULL DEFAULT 0, badge TEXT NOT NULL DEFAULT 'normal', tags TEXT NOT NULL DEFAULT '[]', requires_approval INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER NOT NULL DEFAULT 0, description TEXT NOT NULL DEFAULT '', screenshots TEXT NOT NULL DEFAULT '[]', install_mode TEXT NOT NULL DEFAULT 'silent')",
  "CREATE TABLE IF NOT EXISTS versions (app_id TEXT NOT NULL, version TEXT NOT NULL, released_at TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, download_url TEXT NOT NULL, release_notes TEXT NOT NULL DEFAULT '', silent TEXT NOT NULL, min_upgrade_from TEXT, PRIMARY KEY (app_id, version))",
  "CREATE TABLE IF NOT EXISTS ratings (app_id TEXT NOT NULL, user_id TEXT NOT NULL, stars INTEGER NOT NULL, verified INTEGER NOT NULL DEFAULT 0, comment TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, PRIMARY KEY (app_id, user_id))",
  "CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, app_version TEXT NOT NULL, applicant TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, note TEXT, expires_at TEXT, grant_token TEXT)",
  "CREATE TABLE IF NOT EXISTS self_update (id INTEGER PRIMARY KEY CHECK (id = 1), version TEXT NOT NULL, url TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, release_notes TEXT NOT NULL DEFAULT '', min_current_version TEXT, mandatory INTEGER NOT NULL DEFAULT 0, rollout_percent INTEGER NOT NULL DEFAULT 100)",
];

function signGrantPayload(payload: Omit<ImportedGrant, "signature">, secret: string): string {
  // 字段顺序必须与 core 的 ApprovalWorkflow.payloadOf 完全一致。
  // appVersion 也在载荷里：审批请求本来就是按版本建的，凭证不绑版本就等于批一次装任意版本。
  return createHmac("sha256", secret)
    .update([payload.appId, payload.userId, payload.appVersion, payload.issuedAt, payload.expiresAt, payload.token].join("|"))
    .digest("hex");
}

export interface ImportedGrant {
  token: string;
  appId: string;
  userId: string;
  appVersion: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}

export class CatalogDb {
  constructor(
    private readonly db: DatabaseSync,
    readonly secret = "dev-secret-change-me",
  ) {
    for (const stmt of SCHEMA) this.db.exec(stmt);
    try {
      this.db.exec("ALTER TABLE self_update ADD COLUMN rollout_percent INTEGER NOT NULL DEFAULT 100");
    } catch {
      // 已有该列，旧库升级用
    }
    try {
      this.db.exec("ALTER TABLE apps ADD COLUMN install_mode TEXT NOT NULL DEFAULT 'silent'");
    } catch {
      // 已有该列，旧库升级用
    }
  }

  static open(file: string): CatalogDb {
    return new CatalogDb(new DatabaseSync(file));
  }

  static memory(secret?: string): CatalogDb {
    return new CatalogDb(new DatabaseSync(":memory:"), secret);
  }

  upsertCategory(input: Category): void {
    this.db
      .prepare(
        "INSERT INTO categories (id, name, parent_id, sort_order) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, parent_id=excluded.parent_id, sort_order=excluded.sort_order",
      )
      .run(input.id, input.name, input.parentId, input.sortOrder);
  }

  upsertApp(app: AppDetail, versions: AppVersion[]): void {
    this.db
      .prepare(
        "INSERT INTO apps (id, name, search_keys, publisher, category_id, icon_url, latest_version, download_count, badge, tags, requires_approval, size_bytes, description, screenshots, install_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, search_keys=excluded.search_keys, publisher=excluded.publisher, category_id=excluded.category_id, icon_url=excluded.icon_url, latest_version=excluded.latest_version, badge=excluded.badge, tags=excluded.tags, requires_approval=excluded.requires_approval, size_bytes=excluded.size_bytes, description=excluded.description, screenshots=excluded.screenshots, install_mode=excluded.install_mode",
      )
      .run(
        app.id,
        app.name,
        JSON.stringify(app.searchKeys),
        app.publisher,
        app.categoryId,
        app.iconUrl,
        app.latestVersion,
        app.downloadCount,
        app.badge,
        JSON.stringify(app.tags),
        app.requiresApproval ? 1 : 0,
        app.sizeBytes,
        app.description,
        JSON.stringify(app.screenshots),
        app.installMode ?? "silent",
      );
    for (const version of versions) this.putVersion(app.id, version);
  }

  /** 运营位随目录一起灌，保证 demo 无需额外管理接口即可呈现。 */
  upsertBanner(input: { id: string; title: string; subtitle?: string; imageUrl?: string; link?: string; sortOrder?: number }): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS banners (id TEXT PRIMARY KEY, title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, starts_at TEXT, ends_at TEXT, active INTEGER NOT NULL DEFAULT 1)");
    this.db
      .prepare(
        "INSERT INTO banners (id, title, subtitle, image_url, link, sort_order, active) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET title=excluded.title, subtitle=excluded.subtitle, image_url=excluded.image_url, link=excluded.link, sort_order=excluded.sort_order, active=1",
      )
      .run(input.id, input.title, input.subtitle ?? "", input.imageUrl ?? "", input.link ?? "", input.sortOrder ?? 0);
  }

  putVersion(appId: string, v: AppVersion): void {
    this.db
      .prepare(
        "INSERT INTO versions (app_id, version, released_at, size_bytes, sha256, download_url, release_notes, silent, min_upgrade_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(app_id, version) DO UPDATE SET released_at=excluded.released_at, size_bytes=excluded.size_bytes, sha256=excluded.sha256, download_url=excluded.download_url, release_notes=excluded.release_notes, silent=excluded.silent, min_upgrade_from=excluded.min_upgrade_from",
      )
      .run(appId, v.version, v.releasedAt, v.sizeBytes, v.sha256, v.downloadUrl, v.releaseNotes, JSON.stringify(v.silent), v.minUpgradeFrom ?? null);
  }

  categories(): Category[] {
    const rows = this.db.prepare("SELECT id, name, parent_id, sort_order FROM categories ORDER BY sort_order").all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      parentId: r.parent_id ? String(r.parent_id) : null,
      sortOrder: Number(r.sort_order),
    }));
  }

  private rowToSummary(r: Record<string, unknown>): AppSummary {
    return {
      id: String(r.id),
      name: String(r.name),
      searchKeys: JSON.parse(String(r.search_keys)) as string[],
      publisher: String(r.publisher),
      categoryId: String(r.category_id),
      iconUrl: String(r.icon_url),
      latestVersion: String(r.latest_version),
      downloadCount: Number(r.download_count),
      badge: String(r.badge) as AppSummary["badge"],
      tags: JSON.parse(String(r.tags)) as string[],
      requiresApproval: Number(r.requires_approval) === 1,
      sizeBytes: Number(r.size_bytes),
      installMode: String(r.install_mode ?? "silent") === "manual" ? "manual" : "silent",
    };
  }

  summaries(): AppSummary[] {
    return (this.db.prepare("SELECT * FROM apps").all() as Record<string, unknown>[]).map((r) => this.rowToSummary(r));
  }

  detail(appId: string): AppDetail | null {
    const row = this.db.prepare("SELECT * FROM apps WHERE id = ?").get(appId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const versionRows = this.db.prepare("SELECT * FROM versions WHERE app_id = ? ORDER BY released_at DESC").all(appId) as Record<string, unknown>[];
    const versions: AppVersion[] = versionRows.map((v) => {
      const minUpgradeFrom = v.min_upgrade_from ? String(v.min_upgrade_from) : undefined;
      return {
        version: String(v.version),
        releasedAt: String(v.released_at),
        sizeBytes: Number(v.size_bytes),
        sha256: String(v.sha256),
        downloadUrl: String(v.download_url),
        releaseNotes: String(v.release_notes),
        silent: JSON.parse(String(v.silent)) as SilentSpec,
        ...(minUpgradeFrom ? { minUpgradeFrom } : {}),
      };
    });
    return {
      ...this.rowToSummary(row),
      description: String(row.description),
      screenshots: JSON.parse(String(row.screenshots)) as string[],
      versions,
    };
  }

  addRating(input: RatingInput): void {
    this.db
      .prepare(
        "INSERT INTO ratings (app_id, user_id, stars, verified, comment, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(app_id, user_id) DO UPDATE SET stars=excluded.stars, verified=excluded.verified, comment=excluded.comment, created_at=excluded.created_at",
      )
      .run(
        input.appId,
        input.userId,
        Math.min(5, Math.max(1, Math.round(input.stars))),
        input.verifiedInstall ? 1 : 0,
        input.comment ?? "",
        input.createdAt,
      );
  }

  ratings(appId: string): RatingInput[] {
    return (this.db.prepare("SELECT * FROM ratings WHERE app_id = ?").all(appId) as Record<string, unknown>[]).map((r) => ({
      appId: String(r.app_id),
      userId: String(r.user_id),
      stars: Number(r.stars),
      verifiedInstall: Number(r.verified) === 1,
      comment: String(r.comment),
      createdAt: String(r.created_at),
    }));
  }

  bumpDownload(appId: string): number {
    this.db.prepare("UPDATE apps SET download_count = download_count + 1 WHERE id = ?").run(appId);
    const row = this.db.prepare("SELECT download_count FROM apps WHERE id = ?").get(appId) as Record<string, unknown> | undefined;
    return Number(row?.download_count ?? 0);
  }

  recordSelfUpdate(v: {
    version: string;
    url: string;
    sha256: string;
    sizeBytes: number;
    releaseNotes: string;
    minCurrentVersion?: string;
    mandatory?: boolean;
    rolloutPercent?: number;
  }): void {
    this.db
      .prepare(
        "INSERT INTO self_update (id, version, url, sha256, size_bytes, release_notes, min_current_version, mandatory, rollout_percent) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, url=excluded.url, sha256=excluded.sha256, size_bytes=excluded.size_bytes, release_notes=excluded.release_notes, min_current_version=excluded.min_current_version, mandatory=excluded.mandatory, rollout_percent=excluded.rollout_percent",
      )
      .run(v.version, v.url, v.sha256, v.sizeBytes, v.releaseNotes, v.minCurrentVersion ?? null, v.mandatory ? 1 : 0, Math.max(0, Math.min(100, v.rolloutPercent ?? 100)));
  }

  selfUpdateRow(): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM self_update WHERE id = 1").get() as Record<string, unknown> | undefined;
  }

  createApproval(input: { appId: string; appVersion: string; applicant: string; reason: string }): string {
    const id = "req_" + createHash("sha1").update(input.appId + input.applicant + Date.now()).digest("hex").slice(0, 12);
    this.db
      .prepare("INSERT INTO approvals (id, app_id, app_version, applicant, reason, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)")
      .run(id, input.appId, input.appVersion, input.applicant, input.reason, new Date().toISOString(), new Date(Date.now() + 7 * 86400_000).toISOString());
    return id;
  }

  decideApproval(id: string, decision: "approved" | "rejected", decidedBy: string, note = ""): boolean {
    const result = this.db
      .prepare("UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ? AND status = 'pending'")
      .run(decision, new Date().toISOString(), decidedBy, note, id);
    return Number(result.changes ?? 0) > 0;
  }

  issueGrant(id: string): ImportedGrant | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row || String(row.status) !== "approved") return null;
    const expiresAt = String(row.expires_at ?? new Date(Date.now() + 86400_000).toISOString());
    if (new Date(expiresAt).getTime() <= Date.now()) return null;
    const unsigned = {
      token: createHash("sha256").update(id + Date.now()).digest("hex").slice(0, 32),
      appId: String(row.app_id),
      userId: String(row.applicant),
      appVersion: String(row.app_version),
      issuedAt: new Date().toISOString(),
      expiresAt,
    };
    const grant: ImportedGrant = { ...unsigned, signature: signGrantPayload(unsigned, this.secret) };
    this.db.prepare("UPDATE approvals SET grant_token = ?, status = 'granted' WHERE id = ?").run(JSON.stringify(grant), id);
    return grant;
  }

  raw(): DatabaseSync {
    return this.db;
  }

  approvalsOf(applicant: string): Record<string, unknown>[] {
    return this.db
      .prepare("SELECT id, app_id, app_version, applicant, status, reason, created_at, decided_at, decided_by, expires_at FROM approvals WHERE applicant = ? ORDER BY created_at DESC")
      .all(applicant) as Record<string, unknown>[];
  }

  /** 管理员全量视图：不按申请人过滤。 */
  listAllApprovals(): Record<string, unknown>[] {
    return this.db
      .prepare("SELECT id, app_id, app_version, applicant, status, reason, created_at, decided_at, decided_by, expires_at FROM approvals ORDER BY created_at DESC")
      .all() as Record<string, unknown>[];
  }

  revokeApproval(id: string): boolean {
    const result = this.db
      .prepare("UPDATE approvals SET status = 'revoked' WHERE id = ? AND status IN ('pending', 'approved', 'granted')")
      .run(id);
    return Number(result.changes ?? 0) > 0;
  }

  /** 连同版本一起删，避免孤儿记录残留在 versions 表里。 */
  deleteApp(id: string): boolean {
    const exists = this.db.prepare("SELECT 1 FROM apps WHERE id = ?").get(id);
    if (!exists) return false;
    this.db.prepare("DELETE FROM versions WHERE app_id = ?").run(id);
    this.db.prepare("DELETE FROM apps WHERE id = ?").run(id);
    return true;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 审批工单统一投影：申请人视图与管理员视图共用同一形状。 */
function approvalTicket(r: Record<string, unknown>): Record<string, string> {
  return {
    requestId: String(r.id),
    appId: String(r.app_id),
    appVersion: String(r.app_version ?? ""),
    applicant: String(r.applicant ?? ""),
    status: String(r.status),
    reason: String(r.reason),
    createdAt: String(r.created_at),
    decidedAt: r.decided_at ? String(r.decided_at) : "",
    decidedBy: r.decided_by ? String(r.decided_by) : "",
    expiresAt: r.expires_at ? String(r.expires_at) : "",
  };
}

/** Range 支持：客户端下载器据此续传。 */
async function serveFile(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  const info = await stat(file).catch(() => null);
  if (!info) {
    json(res, 404, { error: "not found" });
    return;
  }
  const range = req.headers.range;
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : info.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= info.size) {
      res.writeHead(416, { "content-range": "bytes */" + String(info.size) });
      res.end();
      return;
    }
    res.writeHead(206, {
      "content-type": "application/octet-stream",
      "content-length": String(end - start + 1),
      "content-range": "bytes " + String(start) + "-" + String(end) + "/" + String(info.size),
      "accept-ranges": "bytes",
    });
    const content = await readFile(file);
    res.end(content.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(info.size), "accept-ranges": "bytes" });
  res.end(await readFile(file));
}

export interface ServerOptions {
  db: CatalogDb;
  /** 安装包存放目录，/dl 路径从这里取文件。 */
  packageRoot: string;
  adminToken?: string;
  /**
   * 无 adminToken 时是否仍放开管理端点。默认否（fail-closed）。
   * 只给本地演示用；生产要么设 ADMIN_TOKEN，要么别开这个开关。
   */
  allowUnauthenticatedAdmin?: boolean;
}

export function createApi(options: ServerOptions) {
  const { db, packageRoot } = options;
  ensureAuthSchema(db.raw());
  const requireAdmin = (req: IncomingMessage): boolean => {
    // 过去这里是 `if (!options.adminToken) return true`：只要部署时忘了 ADMIN_TOKEN，
    // 运营位/捆绑/机群这些写路由就对任何能连上端口的人敞开，等于把「没配凭据」当成「谁都是管理员」。
    // 现在缺凭据就拒绝；确实要跑无鉴权演示的，显式传 allowUnauthenticatedAdmin。
    if (!options.adminToken) return options.allowUnauthenticatedAdmin === true;
    return authorize(req, { db: db.raw(), adminToken: options.adminToken, requiredRole: "admin" }) !== null;
  };
  /** 调用者身份：带了合法 Bearer 才有；null 表示匿名（旧演示模式）。 */
  const principalOf = (req: IncomingMessage): Principal | null =>
    options.adminToken ? authorize(req, { db: db.raw(), adminToken: options.adminToken }) : null;

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const segments = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/api/apps") {
        const visible = visibleAppIds(db.raw(), url.searchParams.get("department"));
        const summaries = db.summaries();
        return json(res, 200, visible ? summaries.filter((a) => visible.has(a.id)) : summaries);
      }
      if (method === "GET" && url.pathname === "/api/categories") return json(res, 200, db.categories());
      if (method === "GET" && url.pathname === "/api/ratings") return json(res, 200, Object.fromEntries(db.summaries().map((a) => [a.id, toDistribution(db.ratings(a.id))])));
      if (method === "GET" && url.pathname === "/api/self-update") {
        const row = db.selfUpdateRow();
        if (!row) return json(res, 404, { error: "no published client build" });
        return json(res, 200, {
          version: String(row.version),
          url: String(row.url),
          sha256: String(row.sha256),
          sizeBytes: Number(row.size_bytes),
          releaseNotes: String(row.release_notes),
          minCurrentVersion: row.min_current_version ? String(row.min_current_version) : undefined,
          mandatory: Number(row.mandatory) === 1,
          rolloutPercent: Number(row.rollout_percent ?? 100),
        });
      }
      if (url.pathname === "/api/login" && method === "POST") {
        const body = await readBody(req);
        const userId = String(body.userId ?? "");
        if (!userId) return json(res, 400, { error: "userId required" });
        const role = body.role === "admin" ? "admin" : "user";
        createUser(db.raw(), userId, String(body.name ?? userId), role, body.departmentId ? String(body.departmentId) : null);
        const token = issueToken(db.raw(), userId, role);
        recordAudit(db.raw(), userId, "login");
        return json(res, 200, { token, role });
      }
      if (method === "GET" && segments[0] === "dl") {
        return serveFile(req, res, path.join(packageRoot, path.basename(segments[1] ?? "")));
      }
      if (segments[0] === "api" && segments[1] === "apps" && segments[2] && !segments[3]) {
        const detail = db.detail(decodeURIComponent(segments[2]));
        return detail ? json(res, 200, detail) : json(res, 404, { error: "unknown app" });
      }
      if (segments[0] === "api" && segments[1] === "apps" && segments[3] === "downloaded" && method === "POST") {
        return json(res, 200, { downloadCount: db.bumpDownload(decodeURIComponent(segments[2] ?? "")) });
      }
      if (method === "POST" && url.pathname === "/api/ratings") {
        const body = await readBody(req);
        const input: RatingInput = {
          appId: String(body.appId ?? ""),
          userId: String(body.userId ?? ""),
          stars: Number(body.stars ?? 0),
          verifiedInstall: Boolean(body.verifiedInstall),
          comment: String(body.comment ?? ""),
          createdAt: String(body.createdAt ?? new Date().toISOString()),
        };
        if (!input.appId || !input.userId) return json(res, 400, { error: "appId and userId are required" });
        db.addRating(input);
        return json(res, 200, toDistribution(db.ratings(input.appId)));
      }      if (method === "GET" && /^\/api\/apps\/[^/]+\/rating$/.test(url.pathname)) {
        const appId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        return json(res, 200, toDistribution(db.ratings(appId)));
      }
      if (method === "POST" && /^\/api\/apps\/[^/]+\/rating$/.test(url.pathname)) {
        const appId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const body = await readBody(req);
        db.addRating({
          appId,
          userId: String(body.userId ?? ""),
          stars: Number(body.stars ?? 0),
          verifiedInstall: Boolean(body.verifiedInstall),
          comment: String(body.comment ?? ""),
          createdAt: new Date().toISOString(),
        });
        return json(res, 200, toDistribution(db.ratings(appId)));
      }
      if (url.pathname === "/api/approvals" && method === "POST") {
        const body = await readBody(req);
        // applicant 由客户端自报 ⇒ 带身份的调用者一律收口到自己，别让人替别人提申请。
        const who = principalOf(req);
        const declared = String(body.applicant ?? "");
        if (who && who.role !== "admin" && declared && declared !== who.userId) return json(res, 403, { error: "applicant mismatch" });
        const id = db.createApproval({
          appId: String(body.appId ?? ""),
          appVersion: String(body.appVersion ?? ""),
          applicant: who && who.role !== "admin" ? who.userId : declared,
          reason: String(body.reason ?? ""),
        });
        return json(res, 201, { requestId: id, status: "pending" });
      }
      if (url.pathname === "/api/approvals" && method === "GET") {
        const who = principalOf(req);
        const requested = url.searchParams.get("applicant") ?? "";
        // 管理员查全量：不带 applicant 即返回所有工单（含他人），供审批工作台用。
        if (who && who.role === "admin" && !requested) {
          return json(res, 200, db.listAllApprovals().map(approvalTicket));
        }
        const scoped = scopedApplicant(who, requested);
        if ("denied" in scoped) return json(res, 403, { error: scoped.denied });
        const rows = db.approvalsOf(scoped.applicant);
        return json(res, 200, rows.map(approvalTicket));
      }
      if (/^\/api\/approvals\/[^/]+\/decide$/.test(url.pathname) && method === "POST") {
        if (!requireAdmin(req)) return json(res, 403, { error: "admin token required" });
        const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const body = await readBody(req);
        const decision = body.decision === "rejected" ? "rejected" : "approved";
        const ok = db.decideApproval(id, decision, String(body.decidedBy ?? "admin"), String(body.note ?? ""));
        if (ok) recordAudit(db.raw(), String(body.decidedBy ?? "admin"), "approval." + decision, id, String(body.note ?? ""));
        return json(res, ok ? 200 : 409, { ok });
      }
      if (/^\/api\/approvals\/[^/]+\/grant$/.test(url.pathname) && method === "POST") {
        const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        // decide 要 admin，grant 却谁都能调：只要拿到一张已批准的单号，任何人都能替别人
        // 铸出安装凭证（grant.userId 取的是原申请人），等于把整个审批门禁绕开。
        const who = principalOf(req);
        if (who && who.role !== "admin") {
          const row = db.raw().prepare("SELECT applicant FROM approvals WHERE id = ?").get(id) as { applicant: string } | undefined;
          if (!row) return json(res, 404, { error: "no such request" });
          if (row.applicant !== who.userId) return json(res, 403, { error: "not your request" });
        }
        const grant = db.issueGrant(id);
        return grant ? json(res, 200, grant) : json(res, 409, { error: "grant unavailable, request is not approved" });
      }
      if (/^\/api\/approvals\/[^/]+\/revoke$/.test(url.pathname) && method === "POST") {
        if (!requireAdmin(req)) return json(res, 403, { error: "admin token required" });
        const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const ok = db.revokeApproval(id);
        if (ok) recordAudit(db.raw(), "admin", "approval.revoke", id);
        return json(res, ok ? 200 : 409, { ok });
      }
      if (/^\/api\/admin\/apps\/[^/]+$/.test(url.pathname) && method === "DELETE") {
        if (!requireAdmin(req)) return json(res, 403, { error: "admin token required" });
        const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
        const removed = db.deleteApp(id);
        if (removed) recordAudit(db.raw(), "admin", "app.delete", id);
        return json(res, removed ? 200 : 404, { ok: removed, id });
      }
      if (url.pathname === "/api/admin/apps" && method === "POST") {
        if (!requireAdmin(req)) return json(res, 403, { error: "admin token required" });
        const body = await readBody(req);
        const detail = body.detail as AppDetail;
        db.upsertApp(detail, (body.versions as AppVersion[]) ?? detail.versions);
        recordAudit(db.raw(), "admin", "app.upsert", detail.id);
        return json(res, 201, { id: detail.id });
      }
      if (url.pathname === "/api/admin/categories" && method === "POST") {
        if (!requireAdmin(req)) return json(res, 403, { error: "admin token required" });
        const body = await readBody(req);
        const category = body.category as Category;
        if (!category?.id) return json(res, 400, { error: "category.id required" });
        db.upsertCategory(category);
        recordAudit(db.raw(), "admin", "category.upsert", category.id);
        return json(res, 201, { id: category.id });
      }
      if (url.pathname === "/api/admin/self-update" && method === "POST") {
        if (!requireAdmin(req)) return json(res, 403, { error: "admin token required" });
        const body = await readBody(req);
        db.recordSelfUpdate({
          version: String(body.version ?? ""),
          url: String(body.url ?? ""),
          sha256: String(body.sha256 ?? ""),
          sizeBytes: Number(body.sizeBytes ?? 0),
          releaseNotes: String(body.releaseNotes ?? ""),
          minCurrentVersion: body.minCurrentVersion ? String(body.minCurrentVersion) : undefined,
          mandatory: Boolean(body.mandatory),
          rolloutPercent: body.rolloutPercent === undefined ? undefined : Number(body.rolloutPercent),
        });
        recordAudit(db.raw(), "admin", "self_update.publish", String(body.version ?? ""));
        return json(res, 201, { ok: true });
      }
      if (url.pathname === "/api/admin/audit" && method === "GET") {
        if (!requireAdmin(req)) return json(res, 403, { error: "admin token required" });
        const result = listAudit(db.raw(), {
          from: url.searchParams.get("from") ?? undefined,
          to: url.searchParams.get("to") ?? undefined,
          action: url.searchParams.get("action") ?? undefined,
          actor: url.searchParams.get("actor") ?? undefined,
          page: url.searchParams.get("page") ? Number(url.searchParams.get("page")) : undefined,
          pageSize: url.searchParams.get("pageSize") ? Number(url.searchParams.get("pageSize")) : undefined,
        });
        return json(res, 200, result);
      }
      if (url.pathname === "/api/admin/audit/export" && method === "GET") {
        if (!requireAdmin(req)) return json(res, 403, { error: "admin token required" });
        const format = url.searchParams.get("format") === "json" ? "json" : "csv";
        // 导出不分页，但受 maxPageSize 上限保护，避免一次性拼出超大规模内存体。
        const all = listAudit(db.raw(), {
          from: url.searchParams.get("from") ?? undefined,
          to: url.searchParams.get("to") ?? undefined,
          action: url.searchParams.get("action") ?? undefined,
          actor: url.searchParams.get("actor") ?? undefined,
          pageSize: 200000,
          maxPageSize: 200000,
        });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        if (format === "csv") {
          res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="audit-${stamp}.csv"` });
          return res.end(toCsv(all.rows));
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="audit-${stamp}.json"` });
        return res.end(toJson(all.rows));
      }
      if (await handleExtras({ db: db.raw(), requireAdmin, principal: principalOf }, req, res, url)) return undefined;
      return json(res, 404, { error: "no route " + method + " " + url.pathname });
    })().catch((err: unknown) => json(res, 500, { error: err instanceof Error ? err.message : String(err) }));
  });
}

export function seedDemo(db: CatalogDb): void {
  db.upsertCategory({ id: "office", name: "办公协同", parentId: null, sortOrder: 1 });
  db.upsertCategory({ id: "office-im", name: "即时通讯", parentId: "office", sortOrder: 1 });
  db.upsertCategory({ id: "office-doc", name: "文档", parentId: "office", sortOrder: 2 });
  db.upsertCategory({ id: "dev", name: "开发工具", parentId: null, sortOrder: 2 });
  db.upsertCategory({ id: "security", name: "安全", parentId: null, sortOrder: 3 });
  db.upsertCategory({ id: "media", name: "影音娱乐", parentId: null, sortOrder: 4 });
  db.upsertCategory({ id: "media-music", name: "音乐", parentId: "media", sortOrder: 1 });
  db.upsertCategory({ id: "media-video", name: "视频", parentId: "media", sortOrder: 2 });
  db.upsertCategory({ id: "other", name: "其他", parentId: null, sortOrder: 90 });

  const msi: SilentSpec = { kind: "msi", installArgs: ["/i", "{file}", "/qn", "/norestart"], uninstallArgs: ["/x", "{file}", "/qn", "/norestart"], requiresAdmin: true };
  const nsis: SilentSpec = { kind: "nsis", installArgs: ["/S", "/D={target}"], uninstallArgs: ["/S"], upgradeArgs: ["/S", "/D={target}"], extraSuccessExitCodes: [3010] };
  const inno: SilentSpec = { kind: "inno", installArgs: ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/DIR={target}"], uninstallArgs: ["/VERYSILENT"], extraSuccessExitCodes: [3010] };
  const gen = (id: string): string => "/icons/gen/" + id + ".svg";
  const mb = 1024 * 1024;

  // installMode: "manual" 的应用弹安装向导由用户完成，界面上是描边「手动安装」按钮。
  const apps: { detail: AppDetail; versions: AppVersion[] }[] = [
    {
      detail: {
        id: "music-player",
        name: "云音乐播放器",
        searchKeys: ["music", "yinyue", "player"],
        publisher: "声线网络",
        categoryId: "media-music",
        iconUrl: gen("music-player"),
        latestVersion: "8.2.4",
        downloadCount: 9600,
        badge: "recommend",
        tags: ["音乐", "电台"],
        requiresApproval: false,
        sizeBytes: 78 * mb,
        description: "一款专注于发现的音乐播放器，歌单、电台与本地曲库统一管理。",
        screenshots: [],
        versions: [],
      },
      versions: [
        { version: "8.2.4", releasedAt: "2026-09-25", sizeBytes: 78 * mb, sha256: "e".repeat(64), downloadUrl: "/dl/music-8.2.4.exe", releaseNotes: "修复电台缓存", silent: nsis },
        { version: "8.1.0", releasedAt: "2026-07-12", sizeBytes: 76 * mb, sha256: "f".repeat(64), downloadUrl: "/dl/music-8.1.0.exe", releaseNotes: "新增桌面歌词", silent: nsis },
      ],
    },
    {
      detail: {
        id: "wps-office",
        name: "WPS Office",
        searchKeys: ["wps", "wpsoffice", "wps office", "bangongruanjian"],
        publisher: "金山办公",
        categoryId: "office-doc",
        iconUrl: gen("wps-office"),
        latestVersion: "12.1.0",
        downloadCount: 4820,
        badge: "recommend",
        tags: ["文档", "表格", "演示"],
        requiresApproval: false,
        sizeBytes: 320 * mb,
        description: "办公套件，含文字、表格、演示。",
        screenshots: [],
        versions: [],
      },
      versions: [
        { version: "12.1.0", releasedAt: "2026-09-20", sizeBytes: 320 * mb, sha256: "a".repeat(64), downloadUrl: "/dl/wps-12.1.0.msi", releaseNotes: "修复表格卡顿", silent: msi },
        { version: "12.0.0", releasedAt: "2026-06-11", sizeBytes: 318 * mb, sha256: "b".repeat(64), downloadUrl: "/dl/wps-12.0.0.msi", releaseNotes: "首版上架", silent: msi },
      ],
    },
    {
      detail: {
        id: "video-player",
        name: "云视频播放器",
        searchKeys: ["video", "shipin", "player"],
        publisher: "映速传媒",
        categoryId: "media-video",
        iconUrl: gen("video-player"),
        latestVersion: "6.0.1",
        downloadCount: 7200,
        badge: "normal",
        tags: ["视频", "弹幕"],
        requiresApproval: false,
        sizeBytes: 96 * mb,
        description: "一款让你看得进去的视频播放器，支持弹幕与离线缓存。",
        screenshots: [],
        versions: [],
      },
      versions: [
        { version: "6.0.1", releasedAt: "2026-09-10", sizeBytes: 96 * mb, sha256: "7".repeat(64), downloadUrl: "/dl/video-6.0.1.exe", releaseNotes: "硬解兼容性修复", silent: nsis },
      ],
    },
    {
      detail: {
        id: "enterprise-im",
        name: "企业即时通讯",
        searchKeys: ["im", "chat", "tongxun"],
        publisher: "协通软件",
        categoryId: "office-im",
        iconUrl: gen("enterprise-im"),
        latestVersion: "4.4.0",
        downloadCount: 5400,
        badge: "normal",
        tags: ["沟通", "会议"],
        requiresApproval: false,
        installMode: "manual",
        sizeBytes: 210 * mb,
        description: "组织架构即插即用的沟通工具，安装向导里可选保留聊天记录。",
        screenshots: [],
        versions: [],
      },
      versions: [
        { version: "4.4.0", releasedAt: "2026-09-18", sizeBytes: 210 * mb, sha256: "6".repeat(64), downloadUrl: "/dl/im-4.4.0.exe", releaseNotes: "会议共享白板", silent: nsis },
      ],
    },
    {
      detail: {
        id: "code-ide",
        name: "代码编辑器",
        searchKeys: ["code", "editor", "ide"],
        publisher: "工具组",
        categoryId: "dev",
        iconUrl: gen("code-ide"),
        latestVersion: "3.4.2",
        downloadCount: 1290,
        badge: "exclusive",
        tags: ["开发"],
        requiresApproval: false,
        sizeBytes: 90 * mb,
        description: "轻量代码编辑器，专属版本内置公司代码规范插件。",
        screenshots: [],
        versions: [],
      },
      versions: [
        { version: "3.4.2", releasedAt: "2026-09-02", sizeBytes: 90 * mb, sha256: "c".repeat(64), downloadUrl: "/dl/code-3.4.2.exe", releaseNotes: "升级到 3.4.2", silent: nsis, minUpgradeFrom: "3.0.0" },
      ],
    },
    {
      detail: {
        id: "cloud-notes",
        name: "云笔记",
        searchKeys: ["notes", "biji", "notes app"],
        publisher: "轻记团队",
        categoryId: "office-doc",
        iconUrl: gen("cloud-notes"),
        latestVersion: "3.1.3",
        downloadCount: 3100,
        badge: "normal",
        tags: ["笔记", "同步"],
        requiresApproval: false,
        sizeBytes: 64 * mb,
        description: "多端同步的轻量笔记，模板库覆盖周报与会议纪要。",
        screenshots: [],
        versions: [],
      },
      versions: [
        { version: "3.1.3", releasedAt: "2026-08-29", sizeBytes: 64 * mb, sha256: "5".repeat(64), downloadUrl: "/dl/notes-3.1.3.msi", releaseNotes: "同步冲突提示", silent: msi },
      ],
    },
    {
      detail: {
        id: "endpoint-guard",
        name: "终端安全防护",
        searchKeys: ["guard", "security", "anquan"],
        publisher: "盾安科技",
        categoryId: "security",
        iconUrl: gen("endpoint-guard"),
        latestVersion: "9.0.2",
        downloadCount: 2600,
        badge: "normal",
        tags: ["安全", "防护"],
        requiresApproval: false,
        installMode: "manual",
        sizeBytes: 180 * mb,
        description: "病毒查杀与实时防护一体，向导式安装，装完即用。",
        screenshots: [],
        versions: [],
      },
      versions: [
        { version: "9.0.2", releasedAt: "2026-09-30", sizeBytes: 180 * mb, sha256: "4".repeat(64), downloadUrl: "/dl/guard-9.0.2.exe", releaseNotes: "病毒库与防护规则更新", silent: inno },
      ],
    },
    {
      detail: {
        id: "screen-capture",
        name: "截图录屏工具",
        searchKeys: ["capture", "record", "jieping"],
        publisher: "光影工坊",
        categoryId: "dev",
        iconUrl: gen("screen-capture"),
        latestVersion: "5.2.0",
        downloadCount: 1800,
        badge: "normal",
        tags: ["截图", "录屏"],
        requiresApproval: false,
        sizeBytes: 42 * mb,
        description: "区域截图、滚动长图与带标注的屏幕录制。",
        screenshots: [],
        versions: [],
      },
      versions: [
        { version: "5.2.0", releasedAt: "2026-08-20", sizeBytes: 42 * mb, sha256: "3".repeat(64), downloadUrl: "/dl/capture-5.2.0.msi", releaseNotes: "滚动截图重写", silent: msi },
      ],
    },
    {
      detail: {
        id: "vpn-client",
        name: "远程接入客户端",
        searchKeys: ["vpn", "remote", "jieru"],
        publisher: "安全部",
        categoryId: "security",
        iconUrl: gen("vpn-client"),
        latestVersion: "5.0.1",
        downloadCount: 640,
        badge: "normal",
        tags: ["网络", "受限"],
        requiresApproval: true,
        sizeBytes: 24 * mb,
        description: "需要审批的软件，安装前请先提交申请。",
        screenshots: [],
        versions: [],
      },
      versions: [
        { version: "5.0.1", releasedAt: "2026-08-15", sizeBytes: 24 * mb, sha256: "d".repeat(64), downloadUrl: "/dl/vpn-5.0.1.msi", releaseNotes: "凭证有效期延长", silent: msi },
      ],
    },
  ];
  for (const entry of apps) db.upsertApp(entry.detail, entry.versions);

  // 补足每类到 ≥3 个应用，让首页分类卡撑满 3 行，避免分类卡片高矮不齐。ui-demo 自带的 2 条 banner 已覆盖运营位。
  const extraApps: { detail: AppDetail; versions: AppVersion[] }[] = [
    { detail: { id: "pdf-tool", name: "云 PDF 工具", searchKeys: ["pdf", "pdftool"], publisher: "轻记团队", categoryId: "office-doc", iconUrl: gen("pdf-tool"), latestVersion: "2.2.0", downloadCount: 2600, badge: "normal", tags: ["PDF"], requiresApproval: false, sizeBytes: 58 * mb, description: "合并、拆分与 OCR 一体的 PDF 工具。", screenshots: [], versions: [] }, versions: [{ version: "2.2.0", releasedAt: "2026-08-10", sizeBytes: 58 * mb, sha256: "g".repeat(64), downloadUrl: "/dl/pdf-2.2.0.exe", releaseNotes: "OCR 提速", silent: nsis }] },
    { detail: { id: "terminal-plus", name: "终端增强", searchKeys: ["terminal", "cmd"], publisher: "工具组", categoryId: "dev", iconUrl: gen("terminal-plus"), latestVersion: "1.8.0", downloadCount: 1500, badge: "normal", tags: ["开发"], requiresApproval: false, sizeBytes: 36 * mb, description: "分屏、远程与脚本一体化的终端。", screenshots: [], versions: [] }, versions: [{ version: "1.8.0", releasedAt: "2026-08-12", sizeBytes: 36 * mb, sha256: "h".repeat(64), downloadUrl: "/dl/term-1.8.0.exe", releaseNotes: "分屏优化", silent: nsis }] },
    { detail: { id: "password-vault", name: "密码保险箱", searchKeys: ["vault", "password"], publisher: "盾安科技", categoryId: "security", iconUrl: gen("password-vault"), latestVersion: "4.3.0", downloadCount: 1100, badge: "normal", tags: ["安全"], requiresApproval: false, sizeBytes: 42 * mb, description: "团队密钥集中托管与自动填充。", screenshots: [], versions: [] }, versions: [{ version: "4.3.0", releasedAt: "2026-08-14", sizeBytes: 42 * mb, sha256: "i".repeat(64), downloadUrl: "/dl/vault-4.3.0.exe", releaseNotes: "自动填充", silent: nsis }] },
    { detail: { id: "mail-client", name: "企业邮箱", searchKeys: ["mail", "email"], publisher: "协通软件", categoryId: "office-im", iconUrl: gen("mail-client"), latestVersion: "3.0.1", downloadCount: 5000, badge: "normal", tags: ["邮件"], requiresApproval: false, sizeBytes: 120 * mb, description: "组织通讯录即插即用的邮件客户端。", screenshots: [], versions: [] }, versions: [{ version: "3.0.1", releasedAt: "2026-08-16", sizeBytes: 120 * mb, sha256: "j".repeat(64), downloadUrl: "/dl/mail-3.0.1.exe", releaseNotes: "通讯录同步", silent: nsis }] },
    { detail: { id: "calendar-sync", name: "日程同步", searchKeys: ["calendar", "schedule"], publisher: "协通软件", categoryId: "office-im", iconUrl: gen("calendar-sync"), latestVersion: "2.1.0", downloadCount: 4700, badge: "normal", tags: ["日程"], requiresApproval: false, sizeBytes: 64 * mb, description: "会议与日程跨端同步。", screenshots: [], versions: [] }, versions: [{ version: "2.1.0", releasedAt: "2026-08-18", sizeBytes: 64 * mb, sha256: "k".repeat(64), downloadUrl: "/dl/cal-2.1.0.exe", releaseNotes: "跨端同步", silent: nsis }] },
    { detail: { id: "podcast-app", name: "播客电台", searchKeys: ["podcast", "radio"], publisher: "声线网络", categoryId: "media-music", iconUrl: gen("podcast-app"), latestVersion: "5.4.0", downloadCount: 8000, badge: "normal", tags: ["播客"], requiresApproval: false, sizeBytes: 70 * mb, description: "订阅与离线收听的播客客户端。", screenshots: [], versions: [] }, versions: [{ version: "5.4.0", releasedAt: "2026-08-20", sizeBytes: 70 * mb, sha256: "l".repeat(64), downloadUrl: "/dl/podcast-5.4.0.exe", releaseNotes: "离线收听", silent: nsis }] },
    { detail: { id: "audio-editor", name: "音频剪辑", searchKeys: ["audio", "editor"], publisher: "光影工坊", categoryId: "media-music", iconUrl: gen("audio-editor"), latestVersion: "4.0.2", downloadCount: 6800, badge: "normal", tags: ["音频"], requiresApproval: false, sizeBytes: 88 * mb, description: "多轨录音与降噪剪辑。", screenshots: [], versions: [] }, versions: [{ version: "4.0.2", releasedAt: "2026-08-22", sizeBytes: 88 * mb, sha256: "m".repeat(64), downloadUrl: "/dl/audio-4.0.2.exe", releaseNotes: "降噪增强", silent: nsis }] },
    { detail: { id: "stream-rec", name: "直播录制", searchKeys: ["stream", "record"], publisher: "映速传媒", categoryId: "media-video", iconUrl: gen("stream-rec"), latestVersion: "3.3.0", downloadCount: 6500, badge: "normal", tags: ["直播"], requiresApproval: false, sizeBytes: 102 * mb, description: "一键抓取并剪辑直播回放。", screenshots: [], versions: [] }, versions: [{ version: "3.3.0", releasedAt: "2026-08-24", sizeBytes: 102 * mb, sha256: "n".repeat(64), downloadUrl: "/dl/stream-3.3.0.exe", releaseNotes: "画质提升", silent: nsis }] },
    { detail: { id: "video-convert", name: "视频转换", searchKeys: ["convert", "video"], publisher: "映速传媒", categoryId: "media-video", iconUrl: gen("video-convert"), latestVersion: "2.7.1", downloadCount: 5200, badge: "normal", tags: ["转换"], requiresApproval: false, sizeBytes: 94 * mb, description: "批量格式转换与压缩。", screenshots: [], versions: [] }, versions: [{ version: "2.7.1", releasedAt: "2026-08-26", sizeBytes: 94 * mb, sha256: "o".repeat(64), downloadUrl: "/dl/convert-2.7.1.exe", releaseNotes: "批量加速", silent: nsis }] },
  ];
  for (const entry of extraApps) db.upsertApp(entry.detail, entry.versions);

  const votes: [string, string, number, boolean, string, string][] = [
    ["wps-office", "u1", 5, true, "常用", "2026-09-21"],
    ["wps-office", "u2", 4, true, "还行", "2026-09-22"],
    ["wps-office", "u3", 2, false, "启动慢", "2026-09-23"],
    ["code-ide", "u4", 5, true, "够用", "2026-09-24"],
    ["music-player", "u1", 5, true, "曲库全", "2026-09-25"],
    ["music-player", "u2", 4, true, "推荐准", "2026-09-25"],
    ["music-player", "u3", 5, true, "桌面歌词好用", "2026-09-26"],
    ["music-player", "u4", 4, true, "占内存略高", "2026-09-26"],
    ["video-player", "u1", 4, true, "弹幕流畅", "2026-09-27"],
    ["video-player", "u2", 5, true, "缓存快", "2026-09-27"],
    ["cloud-notes", "u1", 4, true, "模板实用", "2026-09-29"],
    ["cloud-notes", "u2", 4, true, "同步稳", "2026-09-29"],
    ["endpoint-guard", "u1", 5, true, "安静不弹窗", "2026-09-30"],
    ["screen-capture", "u1", 5, true, "长图神器", "2026-09-30"],
    ["screen-capture", "u2", 4, true, "标注顺手", "2026-10-01"],
  ];
  for (const [appId, userId, stars, verified, comment, createdAt] of votes) {
    db.addRating({ appId, userId, stars, verifiedInstall: verified, comment, createdAt });
  }
}

/**
 * 把演示目录的每个版本物化成真实的安装包文件：内容由 appId+version 确定性生成，
 * sha256/size 回写版本表，让下载校验链路（Range 续传 → sha256 比对 → 落地）可以真跑通。
 * 只服务于 demo/测试环境——生产环境的包由发布方上传。
 */
/**
 * 演示目录里的 sha256 是「同一个字符重复 64 遍」的占位值（seedDemo 用到 a–h 都有，
 * 不只十六进制位，所以字符类不能收窄成 [0-9a-f]）。真包出现这种值的概率约 36/2^256，
 * 可以当作可靠的判别式。
 */
const DEMO_PLACEHOLDER_SHA = /^([0-9a-z])\1{63}$/i;

export function materializeDemoPackages(
  db: CatalogDb,
  packageRoot: string,
  options: { force?: boolean } = {},
): { files: number; bytes: number; skipped: number } {
  mkdirSync(packageRoot, { recursive: true });
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  for (const summary of db.summaries()) {
    const detail = db.detail(summary.id);
    if (!detail) continue;
    for (const version of detail.versions) {
      // 带真实校验值的版本一律不碰：这个函数是给演示目录造占位包的，
      // 一旦跑在真目录库上，把真 installers 的 size/sha256 覆成 96–480KB 的伪随机体，
      // 之后每次真装都会校验失败——而且原来那对值无从找回。
      if (!options.force && !DEMO_PLACEHOLDER_SHA.test(version.sha256)) {
        skipped += 1;
        continue;
      }
      const seed = detail.id + "@" + version.version;
      let hash = 2166136261;
      for (const ch of seed) {
        hash ^= ch.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      const size = 96 * 1024 + (hash % 384) * 1024;
      const header = Buffer.from("appcenter demo package\npackage: " + seed + "\n", "utf8");
      const body = Buffer.alloc(size);
      header.copy(body, 0);
      const pattern = createHash("sha256").update(seed).digest();
      for (let i = header.length; i < size; i++) body[i] = pattern[i % pattern.length]! ^ (i & 0xff);
      // downloadUrl 是目录侧给的字符串：只按 `/` 切的话 `..\..\x.exe` 会整段活下来，
      // 在 Windows 上被 path.join 解释成逃逸（实测真写出到 packageRoot 之外）。
      const base = (version.downloadUrl.split("?")[0] ?? version.downloadUrl).split(/[\\/]+/).pop() ?? "";
      const fileName = safePathSegment(base, seed) || seed + ".bin";
      const target = joinWithinRoot(packageRoot, fileName);
      writeFileSync(target, body);
      db.putVersion(detail.id, { ...version, sizeBytes: size, sha256: createHash("sha256").update(body).digest("hex") });
      files += 1;
      bytes += size;
    }
  }
  return { files, bytes, skipped };
}
