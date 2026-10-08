import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type ApprovalStatus = "draft" | "pending" | "approved" | "rejected" | "expired" | "revoked" | "granted";

export interface ApprovalRequest {
  id: string;
  appId: string;
  appVersion: string;
  applicant: string;
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
  expiresAt?: string;
}

export interface Grant {
  token: string;
  appId: string;
  userId: string;
  /**
   * 被批准的具体版本。审批请求本来就是按版本建的（approvals.app_version），
   * 凭证若不绑版本，批一个旧版本就能装同应用的任意新版本 —— 审批的门禁作用形同虚设。
   */
  appVersion: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}

export interface GrantContext {
  appId: string;
  userId: string;
  appVersion: string;
}

export class ApprovalError extends Error {}

function payloadOf(grant: Omit<Grant, "signature">): string {
  // 字段顺序必须与服务端 signGrantPayload 完全一致，否则两侧签出来的串对不上。
  return [grant.appId, grant.userId, grant.appVersion, grant.issuedAt, grant.expiresAt, grant.token].join("|");
}

/**
 * 审批闸门。
 *
 * 传入 secret 时（服务端或同信任域）凭证用 HMAC 自校验；
 * 不传 secret 时（客户端）凭证的真实性由签发方保证，本地只校验归属、有效期与吊销状态，
 * 因为客户端不可能安全保存签发密钥，把密钥打进安装包等于没有校验。
 */
export class ApprovalWorkflow {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly secret: string;
  /** requestId → 已签发的 grant token：吊销要能落到具体凭证上，而不是只改请求状态。 */
  private readonly issuedTokens: Map<string, string> = new Map();
  private readonly revokedTokens: Set<string> = new Set();

  constructor(secret = "") {
    this.secret = secret;
  }

  get issuerTrusted(): boolean {
    return this.secret === "";
  }

  submit(input: { appId: string; appVersion: string; applicant: string; reason: string; ttlMs?: number }): ApprovalRequest {
    if (!input.appId) throw new ApprovalError("appId is required");
    if (input.reason.trim().length < 4) throw new ApprovalError("reason needs at least 4 characters");
    const now = new Date();
    const request: ApprovalRequest = {
      id: "req_" + randomBytes(8).toString("hex"),
      appId: input.appId,
      appVersion: input.appVersion,
      applicant: input.applicant,
      reason: input.reason.trim(),
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? 7 * 86400_000)).toISOString(),
    };
    this.requests.set(request.id, request);
    return request;
  }

  track(request: ApprovalRequest): void {
    this.requests.set(request.id, request);
  }

  list(filter: { applicant?: string; status?: ApprovalStatus } = {}): ApprovalRequest[] {
    return [...this.requests.values()]
      .filter((r) => (filter.applicant ? r.applicant === filter.applicant : true))
      .filter((r) => (filter.status ? r.status === filter.status : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  decide(id: string, decision: "approved" | "rejected", decidedBy: string, note = ""): ApprovalRequest {
    const request = this.requests.get(id);
    if (!request) throw new ApprovalError("unknown request " + id);
    if (request.status !== "pending") throw new ApprovalError("request is " + request.status);
    request.status = decision;
    request.decidedAt = new Date().toISOString();
    request.decidedBy = decidedBy;
    request.decisionNote = note;
    return request;
  }

  issueGrant(requestId: string, now = new Date()): Grant {
    const request = this.requests.get(requestId);
    if (!request) throw new ApprovalError("unknown request " + requestId);
    if (request.status !== "approved") throw new ApprovalError("request is " + request.status);
    const unsigned: Omit<Grant, "signature"> = {
      token: randomBytes(16).toString("hex"),
      appId: request.appId,
      userId: request.applicant,
      appVersion: request.appVersion,
      issuedAt: now.toISOString(),
      expiresAt: request.expiresAt ?? new Date(now.getTime() + 86400_000).toISOString(),
    };
    request.status = "granted";
    const grant = { ...unsigned, signature: this.sign(unsigned) };
    this.issuedTokens.set(request.id, grant.token);
    return grant;
  }

  revoke(requestId: string): void {
    const request = this.requests.get(requestId);
    if (!request) return;
    request.status = "revoked";
    const token = this.issuedTokens.get(requestId);
    if (token) this.revokedTokens.add(token);
  }

  revokeFor(context: GrantContext): number {
    let count = 0;
    for (const request of this.requests.values()) {
      if (request.appId === context.appId && request.applicant === context.userId) {
        request.status = "revoked";
        const token = this.issuedTokens.get(request.id);
        if (token) this.revokedTokens.add(token);
        count++;
      }
    }
    return count;
  }

  private sign(payload: Omit<Grant, "signature">): string {
    if (this.issuerTrusted) return "";
    return createHmac("sha256", this.secret).update(payloadOf(payload)).digest("hex");
  }

  verifyGrant(grant: Grant, context: GrantContext, now = new Date()): { ok: boolean; reason: string } {
    if (!this.issuerTrusted) {
      const expected = Buffer.from(this.sign(grant), "hex");
      const actual = Buffer.from(grant.signature, "hex");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return { ok: false, reason: "signature-invalid" };
      }
    } else if (grant.signature.length > 0 && !/^[0-9a-f]{64}$/i.test(grant.signature)) {
      return { ok: false, reason: "signature-malformed" };
    }
    if (grant.appId !== context.appId) return { ok: false, reason: "app-mismatch" };
    if (grant.userId !== context.userId) return { ok: false, reason: "user-mismatch" };
    // 缺版本字段的旧凭证同样拒掉：把它当「不限版本」用就等于给历史泄漏开后门。
    if (!grant.appVersion || grant.appVersion !== context.appVersion) return { ok: false, reason: "version-mismatch" };
    // 时间戳解析不了就必须当作「已失效」：旧写法 `new Date("乱码").getTime() <= now` 拿到 NaN，
    // 比较恒为 false，于是这张凭证永远不会过期。
    const issuedAt = Date.parse(grant.issuedAt);
    const expiresAt = Date.parse(grant.expiresAt);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return { ok: false, reason: "timestamp-unparseable" };
    if (expiresAt <= issuedAt) return { ok: false, reason: "expiry-not-after-issue" };
    if (expiresAt <= now.getTime()) return { ok: false, reason: "expired" };
    if (this.revokedTokens.has(grant.token)) return { ok: false, reason: "revoked" };
    const related = [...this.requests.values()].filter((r) => r.appId === context.appId && r.applicant === context.userId);
    if (related.length > 0 && related.every((r) => r.status === "revoked")) return { ok: false, reason: "revoked" };
    return { ok: true, reason: "granted" };
  }
}
