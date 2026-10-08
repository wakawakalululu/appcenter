import { spawn } from "node:child_process";
import path from "node:path";
import { RUN_ROOTS, SERVICES_ROOT, UNINSTALL_ROOTS } from "../inventory/registry.ts";
import type { RegClient } from "../inventory/registry.ts";
import { writeBackupManifest, type BackupRecord } from "./backup.ts";
import type { ResidueItem, ResidueKind, ResidueReport, ResidueRisk } from "./scan.ts";

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
  /** 给了就「移动到回收目录」代替不可逆删除；仍需显式确认串，移动失败该项算 failed。 */
  recycleDir?: string;
}

export const CONFIRM_TOKEN = "CONFIRM";

const SEP = "\\";

/** 文件类残留里永不删除的系统目录：按「盘符之后的首段目录名」判断，换盘安装也照样挡住。 */
const SYSTEM_OWNED_HEADS: string[][] = [["windows"], ["winnt"], ["programdata", "microsoft"], ["users", "all users", "microsoft"]];

/**
 * 关键系统注册表子树。白名单作用域已经能挡住绝大多数越界目标，
 * 这些是「作用域内但绝不能碰」的例外：删了就把网络栈/服务控制管理器一起带走。
 */
const PROTECTED_KEY_PREFIXES: string[] = [
  ["HKLM", "SYSTEM", "CurrentControlSet", "Control"],
  ["HKLM", "SYSTEM", "CurrentControlSet", "Services", "Tcpip"],
  ["HKLM", "SYSTEM", "CurrentControlSet", "Services", "Netbt"],
  ["HKLM", "SYSTEM", "CurrentControlSet", "Services", "AFD"],
  ["HKLM", "SYSTEM", "CurrentControlSet", "Services", "mrxsmb"],
  ["HKLM", "SYSTEM", "CurrentControlSet", "Services", "LanmanServer"],
  ["HKLM", "SYSTEM", "CurrentControlSet", "Services", "LanmanWorkstation"],
  ["HKLM", "SYSTEM", "CurrentControlSet", "Services", "Winmgmt"],
  ["HKLM", "SYSTEM", "CurrentControlSet", "Services", "Schedule"],
  ["HKLM", "SYSTEM", "CurrentControlSet", "Services", "RpcSs"],
  ["HKLM", "SYSTEM", "CurrentControlSet", "Services", "DcomLaunch"],
  ["HKLM", "SOFTWARE", "Microsoft", "Windows NT"],
  ["HKLM", "SAM"],
  ["HKLM", "SECURITY"],
].map((parts) => parts.join(SEP).toLowerCase());

const UNINSTALL_SCOPE_ROOTS = UNINSTALL_ROOTS.map((root) => root.path.toLowerCase());
const RUN_SCOPE_ROOTS = RUN_ROOTS.map((root) => root.toLowerCase());
const SERVICES_SCOPE_ROOT = SERVICES_ROOT.toLowerCase();
const SOFTWARE_SCOPE_ROOTS = [
  ["HKLM", "SOFTWARE"].join(SEP),
  ["HKLM", "SOFTWARE", "WOW6432Node"].join(SEP),
  ["HKCU", "SOFTWARE"].join(SEP),
].map((parts) => parts.toLowerCase());
const HKCR_ROOT = "hkcr";

/**
 * 各作用域的根键自身：删掉它们等于删掉整棵树（所有卸载项 / 所有启动项 / 所有服务 / 整个 SOFTWARE），
 * 任何一条残留都不该产出这种动作。值级删除仍然允许（启动项本来就是 Run 键上的一个值）。
 */
const SCOPE_ROOTS_NEVER_DELETED = [
  ...UNINSTALL_SCOPE_ROOTS,
  ...RUN_SCOPE_ROOTS,
  SERVICES_SCOPE_ROOT,
  ...SOFTWARE_SCOPE_ROOTS,
  HKCR_ROOT,
  ["hkcr", "clsid"].join(SEP),
];

export interface Guard {
  ok: boolean;
  reason: string;
}

function segments(value: string): string[] {
  return value.split(SEP).filter(Boolean);
}

function under(candidate: string, root: string): boolean {
  return candidate.startsWith(root + SEP);
}

function isDirectChild(candidate: string, root: string): boolean {
  return under(candidate, root) && segments(candidate).length === segments(root).length + 1;
}

export function isSystemOwnedPath(normalized: string): boolean {
  const parts = segments(normalized);
  const head = /^[a-z]:$/.test(parts[0] ?? "") ? parts.slice(1) : parts;
  return SYSTEM_OWNED_HEADS.some((prefix) => prefix.every((part, index) => head[index] === part));
}

/**
 * 注册表删除目标的收口。残留报告是可被伪造的输入，所以这里不看「像不像残留」，
 * 只看键路径能不能由扫描器合法产出：服务键只能是 Services 的直接子键，
 * 启动项只能落在 Run 根（且不许整键删 Run），厂商配置只能在三个 SOFTWARE 根之下，
 * 右键菜单只能是 HKCR 之下且不许整棵 CLSID。
 * 残余风险：作用域内仍能删掉别的软件自己的 SOFTWARE 子键——所以每一次注册表删除都必须先导出 .reg，
 * 这条闸口不能替代备份，只能把「删任意键」这种灾难性越界挡住。
 */
export function isRegistryTargetSafe(keyPath: string, kind: ResidueKind, effect: CleanupEffect, valueName?: string): Guard {
  const n = norm(keyPath);
  if (!n) return { ok: false, reason: "empty registry key path" };
  if (PROTECTED_KEY_PREFIXES.some((p) => n === p || under(n, p))) return { ok: false, reason: "protected system registry subtree" };
  if (effect === "delete-registry-key" && SCOPE_ROOTS_NEVER_DELETED.includes(n)) return { ok: false, reason: "refusing to delete a scope root" };
  if (effect === "delete-registry-value") {
    if (!valueName) return { ok: false, reason: "value-level delete without a value name" };
    // reg.exe 会把以 / 或 - 开头的参数当开关，值名不该长这样；挡住免得 /f 之类被当参数吞掉。
    if (valueName.startsWith("/") || valueName.startsWith("-")) return { ok: false, reason: "value name looks like a reg.exe switch" };
  }

  if (kind === "service") {
    if (!isDirectChild(n, SERVICES_SCOPE_ROOT)) return { ok: false, reason: "service key must be a direct child of the services root" };
    return { ok: true, reason: "allowed" };
  }
  if (kind === "startup") {
    const host = RUN_SCOPE_ROOTS.find((root) => n === root || under(n, root));
    if (!host) return { ok: false, reason: "startup key is not under a Run root" };
    if (effect === "delete-registry-key" && n === host) return { ok: false, reason: "refusing to delete an entire Run key" };
    return { ok: true, reason: "allowed" };
  }
  if (kind === "registry") {
    if (UNINSTALL_SCOPE_ROOTS.some((root) => isDirectChild(n, root))) return { ok: true, reason: "allowed" };
    // 卸载树里只认「某一条卸载项」这一层：再深的键扫描器不会产出，而下面的 SOFTWARE 白名单会放行它。
    if (UNINSTALL_SCOPE_ROOTS.some((root) => under(n, root))) return { ok: false, reason: "uninstall subtree target must be a single uninstall entry" };
    if (SOFTWARE_SCOPE_ROOTS.some((root) => under(n, root))) return { ok: true, reason: "allowed" };
    return { ok: false, reason: "registry key is outside the uninstall / vendor-config scope" };
  }
  if (kind === "contextmenu") {
    if (!under(n, HKCR_ROOT)) return { ok: false, reason: "context menu key is not under HKCR" };
    if (n === ["hkcr", "clsid"].join(SEP)) return { ok: false, reason: "refusing to delete the whole CLSID tree" };
    return { ok: true, reason: "allowed" };
  }
  return { ok: false, reason: "not a registry residue kind" };
}

function norm(value: string): string {
  return value
    .replace(/[\\/]+/g, SEP)
    .replace(/\\+$/, "")
    .toLowerCase();
}

export function isPathSafeToDelete(target: string, policy: CleanupPolicy): { ok: boolean; reason: string } {
  const n = norm(target);
  if (n.length <= 3) return { ok: false, reason: "refusing to delete a drive root" };
  if (isSystemOwnedPath(n)) return { ok: false, reason: "refusing to delete a system-owned path" };
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
  // 扫描不完整的报告一律不出计划。理由不是「找到的项不可信」，而是**「已经卸载」这个前提不再可证**：
  // 残留清理默认这台机器上该项属于卸载后的遗留，而判断依据（卸载项是否还在、启动项/服务指向谁）
  // 正是那些没读到的注册表根。少扫一段的后果是「本该出现的残留没出现在勾选列表里」，
  // 用户却是在「这就是全部残留」的印象下确认的。重扫一次只花一两秒，删错了不能。
  const gaps = report.gaps ?? [];
  const incompleteReason = gaps.length > 0 ? "本次扫描不完整（" + gaps.map((g) => g.kind + "←" + g.source).join("、") + "），拒绝据此删除" : "";
  for (const item of report.items) {
    if (incompleteReason) {
      skipped.push({ item, reason: incompleteReason });
      continue;
    }
    if (!policy.includeRisks.includes(item.risk)) {
      skipped.push({ item, reason: "risk " + item.risk + " is not selected" });
      continue;
    }
    if (item.kind === "registry" || item.kind === "startup" || item.kind === "service" || item.kind === "contextmenu") {
      const action = registryAction(item);
      // 这四类过去完全不过闸，等于「报告里写什么键就删什么键」——伪造一份报告就能删
      // HKLM\SYSTEM\CurrentControlSet\Services\Tcpip。现在与文件类一样先做作用域收口。
      const guard = isRegistryTargetSafe(action.keyPath, item.kind, action.effect, action.valueName);
      if (!guard.ok) {
        skipped.push({ item, reason: guard.reason });
        continue;
      }
      actions.push(action);
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
  /**
   * 可选：把残留整体搬进回收目录（同盘 rename 就是移动），给了就不会做不可逆删除。
   * 文件类残留过去只有 `deletePath(..., true)` 一条路——递归删除且不进备份清单，
   * 删错了没有任何恢复手段（注册表类反而先导 .reg，两条路径的安全等级不一致）。
   */
  movePath?(from: string, to: string): Promise<void>;
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
        if (policy.recycleDir && deps.movePath) {
          // 移动到回收目录而不是就地删掉：同盘 rename 对目录同样成立，失败就是抛错、不会留下半个副本。
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          await deps.movePath(action.target, path.join(policy.recycleDir, path.basename(action.target) + "." + stamp));
        } else {
          await deps.deletePath(action.target, true);
        }
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
