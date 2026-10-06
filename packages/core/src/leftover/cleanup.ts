import { spawn } from "node:child_process";
import type { RegClient } from "../inventory/registry.ts";
import { writeBackupManifest, type BackupRecord } from "./backup.ts";
import type { ResidueItem, ResidueReport, ResidueRisk } from "./scan.ts";

export type CleanupEffect = "delete-registry-key" | "delete-registry-value" | "delete-path";

export interface CleanupAction {
  id: string;
  effect: CleanupEffect;
  target: string;
  risk: ResidueRisk;
  detail: string;
  /** 值级删除时的宿主键路径与值名；整键删除时就是键路径本身。 */
  keyPath: string;
  valueName?: string;
}

export interface CleanupPolicy {
  includeRisks: ResidueRisk[];
  /** 文件类操作必须落在显式允许写入的根目录内。 */
  allowWriteRoots: string[];
  /** 破坏性操作要求调用方带回确认串，由 UI 侧用户勾选后生成。 */
  confirmToken: string;
  /** 注册表删除前的 .reg 备份目录；缺失时拒绝执行。 */
  backupDir?: string;
}

export const CONFIRM_TOKEN = "CONFIRM";

const SEP = "\\";

const FORBIDDEN_PREFIXES = [
  ["C:", SEP + "WINDOWS"].join(""),
  ["C:", SEP + "PROGRAMDATA", SEP + "MICROSOFT"].join(SEP),
  ["C:", SEP + "USERS", SEP + "ALL USERS", SEP + "MICROSOFT"].join(SEP),
].map((p) => p.toLowerCase());

function norm(value: string): string {
  return value
    .replace(/[\\/]+/g, SEP)
    .replace(/\\+$/, "")
    .toLowerCase();
}

export function isPathSafeToDelete(target: string, policy: CleanupPolicy): { ok: boolean; reason: string } {
  const n = norm(target);
  if (n.length <= 3) return { ok: false, reason: "refusing to delete a drive root" };
  if (FORBIDDEN_PREFIXES.some((f) => n.startsWith(f))) return { ok: false, reason: "refusing to delete a system-owned path" };
  const allowed = policy.allowWriteRoots.map(norm).filter(Boolean);
  if (allowed.length === 0) return { ok: false, reason: "no allowed cleanup roots configured" };
  if (!allowed.some((root) => n === root || n.startsWith(root + SEP))) {
    return { ok: false, reason: "path is outside the allowed cleanup roots" };
  }
  return { ok: true, reason: "allowed" };
}

export interface PlanResult {
  actions: CleanupAction[];
  skipped: { item: ResidueItem; reason: string }[];
}

function registryAction(item: ResidueItem): CleanupAction {
  if (item.keyPath && item.valueName) {
    return {
      id: "regvalue:" + item.keyPath + ":" + item.valueName,
      effect: "delete-registry-value",
      target: item.path,
      keyPath: item.keyPath,
      valueName: item.valueName,
      risk: item.risk,
      detail: item.detail,
    };
  }
  return {
    id: "reg:" + item.path,
    effect: "delete-registry-key",
    target: item.path,
    keyPath: item.path,
    risk: item.risk,
    detail: item.detail,
  };
}

export function buildCleanupPlan(report: ResidueReport, policy: CleanupPolicy): PlanResult {
  const actions: CleanupAction[] = [];
  const skipped: PlanResult["skipped"] = [];
  for (const item of report.items) {
    if (!policy.includeRisks.includes(item.risk)) {
      skipped.push({ item, reason: "risk " + item.risk + " is not selected" });
      continue;
    }
    if (item.kind === "registry" || item.kind === "startup" || item.kind === "service" || item.kind === "contextmenu") {
      actions.push(registryAction(item));
      continue;
    }
    const guard = isPathSafeToDelete(item.path, policy);
    if (!guard.ok) {
      skipped.push({ item, reason: guard.reason });
      continue;
    }
    actions.push({ id: "path:" + item.path, effect: "delete-path", target: item.path, keyPath: item.path, risk: item.risk, detail: item.detail });
  }
  return { actions, skipped };
}

export interface CleanupDeps {
  deleteRegistryKey(keyPath: string): Promise<void>;
  deleteRegistryValue(keyPath: string, valueName: string): Promise<void>;
  deletePath(path: string, recursive: boolean): Promise<void>;
  /** 注入式备份，生产用 reg.exe export，测试用假实现，避免执行器里藏着进程调用。 */
  exportRegistryKey(keyPath: string, dir: string): Promise<BackupRecord>;
}

export interface CleanupOutcome {
  planned: CleanupAction[];
  skipped: PlanResult["skipped"];
  applied: CleanupAction[];
  failed: { action: CleanupAction; message: string }[];
  backups: BackupRecord[];
  manifestFile: string | null;
  dryRun: boolean;
  blockedReason: string;
}

/**
 * 清理执行器，默认 dryRun 只产出动作清单。
 * 真正执行需要同时满足：风险被勾选、路径在白名单内、确认串正确、给出备份目录。
 * 任何注册表改动（整键或单个值）都先导出所属键的 .reg 并写进清单文件，
 * 导出失败的那一项不会被删除——宁可留残留，也不留不可恢复的状态。
 */
export async function executeCleanup(
  report: ResidueReport,
  policy: CleanupPolicy,
  deps: CleanupDeps,
  options: { dryRun?: boolean } = {},
): Promise<CleanupOutcome> {
  const dryRun = options.dryRun ?? true;
  const { actions, skipped } = buildCleanupPlan(report, policy);
  const preview: CleanupOutcome = {
    planned: actions,
    skipped,
    applied: [],
    failed: [],
    backups: [],
    manifestFile: null,
    dryRun: true,
    blockedReason: "",
  };
  if (dryRun) return preview;
  if (policy.confirmToken !== CONFIRM_TOKEN) return { ...preview, blockedReason: "confirmation token missing" };
  const touchesRegistry = actions.some((action) => action.effect !== "delete-path");
  if (touchesRegistry && !policy.backupDir) {
    return { ...preview, blockedReason: "registry backup directory required before deleting keys" };
  }

  const records: BackupRecord[] = [];
  const backedUp = new Map<string, BackupRecord>();
  if (policy.backupDir) {
    const keyPaths = [...new Set(actions.filter((action) => action.effect !== "delete-path").map((action) => action.keyPath))];
    for (const keyPath of keyPaths) {
      const record = await deps
        .exportRegistryKey(keyPath, policy.backupDir)
        .catch(
          (err: unknown): BackupRecord => ({
            keyPath,
            file: "",
            sha256: "",
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      records.push(record);
      if (record.ok) backedUp.set(norm(keyPath), record);
    }
  }
  const manifestFile = policy.backupDir
    ? await writeBackupManifest({ dir: policy.backupDir, createdAt: new Date().toISOString(), records })
    : null;

  const applied: CleanupAction[] = [];
  const failed: CleanupOutcome["failed"] = [];
  for (const action of actions) {
    if (action.effect === "delete-path") {
      try {
        await deps.deletePath(action.target, true);
        applied.push(action);
      } catch (err) {
        failed.push({ action, message: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }
    if (!backedUp.has(norm(action.keyPath))) {
      failed.push({ action, message: "backup failed for " + action.keyPath });
      continue;
    }
    try {
      if (action.effect === "delete-registry-value" && action.valueName) await deps.deleteRegistryValue(action.keyPath, action.valueName);
      else await deps.deleteRegistryKey(action.keyPath);
      applied.push(action);
    } catch (err) {
      failed.push({ action, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { planned: actions, skipped, applied, failed, backups: records, manifestFile, dryRun: false, blockedReason: "" };
}

export async function regDeleteKey(keyPath: string): Promise<void> {
  await runReg(["delete", keyPath, "/f"]);
}

/** 启动项这类残留只是键上的一个值，删值不能连整键一起删。 */
export async function regDeleteValue(keyPath: string, valueName: string): Promise<void> {
  await runReg(["delete", keyPath, "/v", valueName, "/f"]);
}

async function runReg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("reg.exe", args, { windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("reg " + String(args[0]) + " exit " + String(code)))));
  });
}

export async function countSubKeys(reg: RegClient, root: string): Promise<number> {
  return (await reg.queryTree(root)).length;
}
