import type { AppDetail, AppSummary } from "../catalog/types.ts";
import type { InstalledApp } from "../inventory/inventory.ts";
import { compare } from "../util/semver.ts";

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
}

export interface UpgradePlanInput {
  installed: readonly InstalledApp[];
  catalog: readonly AppSummary[];
  details: (appId: string) => Promise<AppDetail | null>;
  /** 目录外的手工安装不参与升级。 */
  includeUnknown?: boolean;
}

function bestMatch(installed: InstalledApp, app: AppSummary): boolean {
  const name = installed.displayName.toLowerCase();
  const target = app.name.toLowerCase();
  if (name === target) return true;
  if (name.includes(target) || target.includes(name)) return true;
  return installed.publisher.length > 0 && app.publisher.length > 0 && installed.publisher.toLowerCase() === app.publisher.toLowerCase();
}

export async function buildUpgradePlan(input: UpgradePlanInput): Promise<UpgradeCandidate[]> {
  const out: UpgradeCandidate[] = [];
  for (const app of input.catalog) {
    const match = input.installed.find((i) => bestMatch(i, app));
    if (!match) continue;
    if (compare(app.latestVersion, match.displayVersion) <= 0) continue;
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
