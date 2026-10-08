import path from "node:path";
import { promises as fs } from "node:fs";
import { readBackupSet, restoreBackupSet } from "@appcenter/core";
import type {
  AppCenterFacade,
  CleanupPolicy,
  InstallReceipt,
  ResidueReport,
  RuntimeConfig,
  WindowRole,
} from "@appcenter/core";

export interface RpcResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * UI 与 CLI 共用的方法表。新增能力只需要在这里加一条，
 * 前端与 shell 都能立刻调用，避免两套分发逻辑漂移。
 */
export async function dispatch(facade: AppCenterFacade, method: string, params: Record<string, unknown> = {}): Promise<RpcResult> {
  const str = (key: string): string => String(params[key] ?? "");
  try {
    switch (method) {
      case "catalog.refresh":
        return { ok: true, result: await facade.refreshCatalog() };
      case "catalog.search": {
        const hits = await facade.search({
          text: str("text"),
          categoryId: params.categoryId ? String(params.categoryId) : undefined,
          badge: params.badge ? (String(params.badge) as never) : undefined,
          limit: params.limit ? Number(params.limit) : undefined,
        });
        const ratings = await facade.allRatings().catch(() => ({}));
        return { ok: true, result: hits.map((hit) => ({ ...hit, app: { ...hit.app, ratings: (ratings as Record<string, unknown>)[hit.app.id] } })) };
      }
      case "catalog.categories":
        return { ok: true, result: await facade.categories() };
      case "catalog.detail":
        return { ok: true, result: await facade.detail(str("appId")) };
      case "catalog.view":
        return { ok: true, result: await facade.catalogView() };
      case "catalog.home":
        return { ok: true, result: await facade.homeView() };
      case "catalog.exclusive":
        return { ok: true, result: await facade.exclusiveView() };
      case "icons.sync":
        return { ok: true, result: await facade.syncIcons() };
      case "repo.sync":
        return {
          ok: true,
          result: await facade.syncLocalRepo({
            allVersions: params.allVersions === true,
            dir: params.dir ? String(params.dir) : undefined,
            verify: params.verify === "sha256" ? "sha256" : "size",
          }),
        };
      case "repo.status":
        return { ok: true, result: await facade.localRepoStatus(params.dir ? String(params.dir) : undefined) };
      case "window.control":
        return { ok: true, result: await facade.windowControl(str("action"), str("windowId")) };
      case "catalog.rating":
        return { ok: true, result: await facade.rating(str("appId")) };
      case "catalog.rate":
        return { ok: true, result: await facade.rate({ appId: str("appId"), userId: str("userId") || "me", stars: Number(params.stars ?? 0), verifiedInstall: Boolean(params.verifiedInstall), comment: str("comment"), createdAt: new Date().toISOString() }) };
      case "installed.list":
        return { ok: true, result: await facade.installed() };
      case "upgrade.plan":
        return { ok: true, result: await facade.upgrades() };
      case "app.install":
        return { ok: true, result: await facade.install(str("appId"), params.version ? String(params.version) : undefined, params.mode === "manual" ? "manual" : "silent") };
      case "app.open":
        return { ok: true, result: await facade.openInstalled(str("appId")) };
      case "runtime.dirs":
        return { ok: true, result: { packageDir: await facade.packageDir(), dataDir: facade.dataDirectory(), iconCount: await facade.syncIcons() } };
      case "runtime.config":
        return { ok: true, result: await facade.runtimeConfig() };
      case "runtime.updateConfig":
        return { ok: true, result: await facade.updateRuntimeConfig((params.config ?? params) as Partial<RuntimeConfig>) };
      case "runtime.startChecks":
        return { ok: true, result: await facade.startScheduledChecks({ immediate: params.immediate !== false }) };
      case "runtime.stopChecks":
        return { ok: true, result: facade.stopScheduledChecks() };
      case "receipt.report":
        return { ok: true, result: await facade.reportReceipt(str("appId"), params.receipt as InstallReceipt) };
      case "receipt.list":
        return { ok: true, result: await facade.receipts(str("appId")) };
      case "notification.list":
        return { ok: true, result: await facade.pollNotifications() };
      case "notification.done":
        return { ok: true, result: await facade.markNotificationDone(str("id")) };
      case "heartbeat.report":
        return { ok: true, result: await facade.reportHeartbeat() };
      case "fleet.summary":
        return { ok: true, result: await facade.fleet(params.staleAfterHours === undefined ? undefined : Number(params.staleAfterHours)) };
      case "fleet.detail":
        return { ok: true, result: await facade.fleetDetail(str("machineId"), params.staleAfterHours === undefined ? undefined : Number(params.staleAfterHours)) };
      case "bundle.list":
        return { ok: true, result: await facade.bundles() };
      case "bundle.install":
        return { ok: true, result: await facade.installBundle(str("bundleId")) };
      case "bundle.progress":
        return { ok: true, result: facade.bundleProgress(str("runId")) };
      case "bundle.runs":
        return { ok: true, result: facade.bundleRuns() };
      case "app.bulkInstall":
        return { ok: true, result: await facade.bulkInstall((params.appIds as string[] | undefined) ?? []) };
      case "app.uninstall":
        return { ok: true, result: await facade.uninstall(str("name"), str("regDir") || undefined) };
      case "jobs.list":
        return { ok: true, result: facade.jobs() };
      case "residue.report":
        return { ok: true, result: await facade.residueReport(str("name"), str("regDir") || undefined) };
      case "cleanup.plan":
        return { ok: true, result: facade.cleanupPlan(params.report as ResidueReport, params.policy as CleanupPolicy) };
      case "cleanup.apply":
        return { ok: true, result: await facade.applyCleanup(params.report as ResidueReport, params.policy as CleanupPolicy, params.dryRun !== false) };
      case "cleanup.recycle":
        return { ok: true, result: await facade.recycleStatus() };
      case "cleanup.recyclePrune":
        return { ok: true, result: await facade.pruneRecycle({ keepDays: params.keepDays as number | undefined, maxBytes: params.maxBytes as number | undefined, dryRun: params.dryRun === true }) };
      case "cleanup.recyclePurge":
        return { ok: true, result: await facade.purgeRecycle(str("confirmToken")) };
      case "cleanup.restore": {
        const set = await readBackupSet(str("backupDir"));
        if (!set) return { ok: false, error: "no backup manifest in " + str("backupDir") };
        return { ok: true, result: await restoreBackupSet(set) };
      }
      case "approval.request":
        return { ok: true, result: await facade.requestApproval(str("appId"), str("reason")) };
      case "approval.list":
        return { ok: true, result: await facade.approvalRequests() };
      case "approval.listAll":
        return { ok: true, result: await facade.adminApprovalList() };
      case "approval.decide":
        return { ok: true, result: await facade.decideApproval(str("requestId"), (str("decision") === "rejected" ? "rejected" : "approved") as "approved" | "rejected", str("note")) };
      case "approval.revoke":
        return { ok: true, result: await facade.revokeApproval(str("requestId")) };
      case "approval.attachGrant":
        await facade.attachGrant(str("requestId"));
        return { ok: true, result: true };
      case "ui.window":
        return { ok: true, result: await facade.openWindow((str("role") || "main") as WindowRole, { route: params.route ? String(params.route) : undefined, key: params.key ? String(params.key) : undefined, allowMultiple: Boolean(params.allowMultiple) }) };
      case "ui.windows":
        return { ok: true, result: facade.windowList() };
      case "ui.closeToTray":
        return { ok: true, result: await facade.closeWindow(str("id")) };
      case "ui.skin":
        return { ok: true, result: facade.skin(params.id ? String(params.id) : undefined) };
      case "ui.skins":
        return { ok: true, result: facade.skins.list() };
      case "ui.setSkin":
        return { ok: true, result: facade.setSkin(str("id")) };
      case "ui.tray":
        return { ok: true, result: facade.trayView() };
      case "ui.trayAction":
        return { ok: true, result: await facade.trayAction(str("action")) };
      case "selfupdate.check":
        return { ok: true, result: await facade.checkSelfUpdate() };
      case "selfupdate.stage":
        return { ok: true, result: await facade.stageSelfUpdate(params.manifest as never) };
      case "selfupdate.apply":
        return { ok: true, result: await facade.applySelfUpdate(params.staged as never) };
      case "selfupdate.commit":
        await facade.commitSelfUpdate();
        return { ok: true, result: true };
      case "selfupdate.pending":
        return { ok: true, result: await facade.pendingSelfUpdate() };
      case "selfupdate.recover":
        return { ok: true, result: await facade.recoverSelfUpdate() };
      default:
        return { ok: false, error: "unknown method " + method };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function contentType(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** 静态资源解析：拒绝越出 webRoot 的路径。 */
export function resolveStatic(webRoot: string, urlPath: string): string | null {
  const requested = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  if (requested.includes("..") || requested.includes("%")) return null;
  const target = path.resolve(webRoot, requested);
  const root = path.resolve(webRoot);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

export async function readStatic(webRoot: string, urlPath: string): Promise<{ file: string; body: Buffer } | null> {
  const target = resolveStatic(webRoot, urlPath);
  if (!target) return null;
  try {
    const body = await fs.readFile(target);
    return { file: target, body };
  } catch {
    return null;
  }
}
