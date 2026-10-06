import type { AppDetail, AppSummary, Category, RatingInput, RatingDistribution } from "./catalog/types.ts";
import type { Grant } from "./approval/workflow.ts";
import type { SelfUpdateManifest } from "./selfupdate/selfupdate.ts";

export interface ApprovalTicket {
  requestId: string;
  status: string;
  grant?: Grant;
}

/** 目录与审批的 HTTP 客户端：UI 只通过 facade 访问，不直接拼 URL。 */
export class RemoteCatalog {
  constructor(private readonly baseUrl: string, private readonly token: string = "", private readonly fetchImpl: typeof fetch = fetch) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(this.baseUrl + path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: "Bearer " + this.token } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error("catalog " + String(response.status) + " " + path + " " + body.slice(0, 200));
    }
    return (await response.json()) as T;
  }

  summaries(): Promise<AppSummary[]> {
    return this.request("/api/apps");
  }

  categories(): Promise<Category[]> {
    return this.request("/api/categories");
  }

  detail(appId: string): Promise<AppDetail | null> {
    return this.request("/api/apps/" + encodeURIComponent(appId));
  }

  ratingsByApp(): Promise<Record<string, RatingDistribution>> {
    return this.request("/api/ratings");
  }

  distribution(appId: string): Promise<RatingDistribution> {
    return this.request("/api/apps/" + encodeURIComponent(appId) + "/rating");
  }

  submitRating(input: RatingInput): Promise<RatingDistribution> {
    return this.request("/api/apps/" + encodeURIComponent(input.appId) + "/rating", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  requestApproval(appId: string, applicant: string, reason: string, appVersion: string): Promise<ApprovalTicket> {
    return this.request("/api/approvals", {
      method: "POST",
      body: JSON.stringify({ appId, applicant, reason, appVersion }),
    });
  }

  myApprovals(applicant: string): Promise<ApprovalTicket[]> {
    return this.request("/api/approvals?applicant=" + encodeURIComponent(applicant));
  }

  redeemGrant(requestId: string): Promise<Grant> {
    return this.request("/api/approvals/" + encodeURIComponent(requestId) + "/grant", { method: "POST" });
  }

  recordDownload(appId: string): Promise<void> {
    return this.request("/api/apps/" + encodeURIComponent(appId) + "/downloaded", { method: "POST" });
  }

  selfUpdateManifest(): Promise<SelfUpdateManifest> {
    return this.request("/api/self-update");
  }

  banners(): Promise<Banner[]> {
    return this.request("/api/banners");
  }

  bundles(): Promise<Bundle[]> {
    return this.request("/api/bundles");
  }

  bundle(id: string): Promise<Bundle> {
    return this.request("/api/bundles/" + encodeURIComponent(id));
  }

  reportReceipt(appId: string, receipt: InstallReceipt): Promise<{ ok: boolean }> {
    return this.request("/api/apps/" + encodeURIComponent(appId) + "/receipt", { method: "POST", body: JSON.stringify(receipt) });
  }

  receipts(appId: string): Promise<InstallReceipt[]> {
    return this.request("/api/apps/" + encodeURIComponent(appId) + "/receipts");
  }

  notifications(applicant: string): Promise<ApprovalNotification[]> {
    return this.request("/api/notifications?applicant=" + encodeURIComponent(applicant));
  }

  markNotificationDone(id: string): Promise<{ ok: boolean }> {
    return this.request("/api/notifications/" + encodeURIComponent(id) + "/done", { method: "POST" });
  }
}

export interface InstallReceipt {
  version: string;
  result: "success" | "failed";
  exitCode?: number | null;
  durationMs?: number | null;
  error?: string;
  machine?: string;
}

export interface ApprovalNotification {
  id: string;
  appId: string;
  appVersion: string;
  status: string;
  reason: string;
  createdAt: string;
  done: boolean;
}

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
