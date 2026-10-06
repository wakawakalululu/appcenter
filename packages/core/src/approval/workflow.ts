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
  return [grant.appId, grant.userId, grant.issuedAt, grant.expiresAt, grant.token].join("|");
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
      issuedAt: now.toISOString(),
      expiresAt: request.expiresAt ?? new Date(now.getTime() + 86400_000).toISOString(),
    };
    request.status = "granted";
    return { ...unsigned, signature: this.sign(unsigned) };
  }

  revoke(requestId: string): void {
    const request = this.requests.get(requestId);
    if (request) request.status = "revoked";
  }

  revokeFor(context: GrantContext): number {
    let count = 0;
    for (const request of this.requests.values()) {
      if (request.appId === context.appId && request.applicant === context.userId) {
        request.status = "revoked";
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
    if (new Date(grant.expiresAt).getTime() <= now.getTime()) return { ok: false, reason: "expired" };
    const related = [...this.requests.values()].filter((r) => r.appId === context.appId && r.applicant === context.userId);
    if (related.length > 0 && related.every((r) => r.status === "revoked")) return { ok: false, reason: "revoked" };
    return { ok: true, reason: "granted" };
  }
}
