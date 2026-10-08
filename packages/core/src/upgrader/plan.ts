import type { AppDetail, AppSummary } from "../catalog/types.ts";
import type { InstalledApp } from "../inventory/inventory.ts";
import { compare } from "../util/semver.ts";
import { nameMatchQuality } from "../catalog/view.ts";

export type UpgradeAction = "overwrite" | "uninstall-then-install" | "not-available" | "up-to-date";

export interface UpgradeCandidate {
  appId: string;
  name: string;
  installedVersion: string;
  availableVersion: string;
  action: UpgradeAction;
  sizeBytes: number;
  releaseNotes: string;
  requiresApproval: boolean;
  /** 在装版本低于 minUpgradeFrom 时必须先卸载，避免旧包残留叠加。 */
  reason: string;
  /**
   * 同名存在多条卸载项且版本不一时，列出全部在装版本（升序）。
   * 候选只能按一条实例决策，界面据此说明「按哪条定的」，不至于把另一条的存在藏起来。
   */
  installedVariants?: string[];
}

export interface UpgradePlanInput {
  installed: readonly InstalledApp[];
  catalog: readonly AppSummary[];
  details: (appId: string) => Promise<AppDetail | null>;
  /** 目录外的手工安装不参与升级。 */
  includeUnknown?: boolean;
}

const ARCH_TOKEN = /(x64|x86|x32|arm64|amd64|i386|win32|win64)/g;

/** 名字里出现的所有架构标记（排序后拼接，便于两边比较）。 */
function archOf(value: string): string {
  return [...new Set([...value.toLowerCase().matchAll(ARCH_TOKEN)].map((m) => m[0]))].sort().join("+");
}

/**
 * 匹配规则不在这里重写：升级侧曾经自带一份「双向无界子串」，而 #30 已经把目录视图的
 * 子串命中收口成「前缀 + 尾巴只能是限定词」。真机 140 个显示名两两按旧规则量出 **98 对**误配，
 * 其中 `微信` ⊂ `企业微信`、`Microsoft Edge` ⊂ `Microsoft Edge WebView2 Runtime` 会直接
 * 造出假可升级项（把企业微信的版本当成微信的在装版本去比大小）。
 * 厂商相同仍不足以配对（#28）：只认名称级命中，即 quality ≥ 2。
 */
function nameMatches(app: AppSummary, item: InstalledApp): boolean {
  if (nameMatchQuality(app, item) < 2) return false;
  // 架构不同就是两个包。共用判据的词根分支会剥掉尾部的 `x64/x86` 之类后缀，于是真机上成对存在的
  // `Windows SDK Desktop Headers x86` 与 `… x64`、`Universal CRT Tools x86/x64`（实测 10 对）会被并成
  // 同一产品，把 x86 那条当成 x64 的在装版本比大小 —— 升级侧必须把架构视为硬约束。
  // 两边都标了架构且不一致才算不同产品；只有一边标了（`演示应用` ⊂ `演示应用 (x64) 2.0.0`）
  // 是合法形状 —— 目录项本来就不带架构，这一支被既有测试钉为「有真机支撑」，不能否掉。
  const installedArch = archOf(item.displayName);
  const catalogArch = archOf(app.name);
  return !installedArch || !catalogArch || installedArch === catalogArch;
}

export async function buildUpgradePlan(input: UpgradePlanInput): Promise<UpgradeCandidate[]> {
  const out: UpgradeCandidate[] = [];
  for (const app of input.catalog) {
    const matching = input.installed.filter((i) => nameMatches(app, i) && i.displayVersion.trim() !== "");
    if (matching.length === 0) continue;
    // 不能拿 `find` 的首条来决策：同名不同实例（真机如 `Universal CRT Redistributable` 两条不同 GUID、
    // 两个版本）时，首条若是较高的版本，较低那条就被遮挡——它永远不出现在升级列表里；
    // 而 action 也会按错的实例算，本该「先卸载再装」的被报成「可直接覆盖」。
    // 取版本最低的那条＝最保守：过时的实例藏不起来，动作也按最需要谨慎的那条定。
    const match = matching.reduce((lowest, candidate) => (compare(candidate.displayVersion, lowest.displayVersion) < 0 ? candidate : lowest));
    if (compare(app.latestVersion, match.displayVersion) <= 0) continue;
    const variants = [...new Set(matching.map((i) => i.displayVersion))];
    const detail = await input.details(app.id);
    if (!detail) continue;
    const version = detail.versions.find((v) => v.version === app.latestVersion) ?? detail.versions[0];
    if (!version) continue;
    const minFrom = version.minUpgradeFrom;
    const canOverwrite = !minFrom || compare(match.displayVersion, minFrom) >= 0;
    out.push({
      appId: app.id,
      name: app.name,
      installedVersion: match.displayVersion,
      availableVersion: version.version,
      action: canOverwrite ? "overwrite" : "uninstall-then-install",
      sizeBytes: version.sizeBytes,
      releaseNotes: version.releaseNotes,
      requiresApproval: app.requiresApproval,
      reason: canOverwrite ? "direct-upgrade" : "installed version is below minUpgradeFrom",
      ...(variants.length > 1 ? { installedVariants: variants.sort((a, b) => compare(a, b)) } : {}),
    });
  }
  return out.sort((a, b) => compare(b.availableVersion, a.availableVersion));
}

export function summarizePlan(candidates: readonly UpgradeCandidate[]): {
  total: number;
  bytes: number;
  blockedByApproval: number;
  needsUninstall: number;
} {
  return {
    total: candidates.length,
    bytes: candidates.reduce((s, c) => s + c.sizeBytes, 0),
    blockedByApproval: candidates.filter((c) => c.requiresApproval).length,
    needsUninstall: candidates.filter((c) => c.action === "uninstall-then-install").length,
  };
}
