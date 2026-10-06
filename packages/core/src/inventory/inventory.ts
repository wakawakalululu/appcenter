import type { RegistryKey } from "./registry.ts";
import { readValue, UNINSTALL_ROOTS, type RegClient } from "./registry.ts";

/**
 * 字段命名与产品在卸载残留扫描日志中可见的清单结构对齐：
 * regDir / displayName / displayVersion / publisher / installLocation / uninstallString / displayIcon。
 */
export interface InstalledApp {
  regDir: string;
  registryPath: string;
  hive: string;
  scope: string;
  displayName: string;
  displayVersion: string;
  publisher: string;
  installLocation: string | null;
  uninstallString: string | null;
  quietUninstallString: string | null;
  displayIcon: string | null;
  isMsi: boolean;
  estimatedSizeKb: number;
  installDate: string | null;
  /** Windows 更新组件等系统项默认不出现在应用中心列表里。 */
  systemComponent: boolean;
  /** 注册表项不可写（需要提权才能清理）时标记出来。 */
  needsElevation: boolean;
}

const SYSTEM_HINTS = ["KB", "SERVICE PACK", "UPDATE FOR", "SECURITY UPDATE", "HOTFIX", "MICROSOFT SQL"];

export function toInstalledApp(key: RegistryKey, scope: string, hive: string, needsElevation = false): InstalledApp | null {
  const displayName = readValue(key, "DisplayName");
  if (!displayName) return null;
  const segments = key.path.split("\\").filter(Boolean);
  const regDir = segments[segments.length - 1] ?? key.path;
  const uninstallString = readValue(key, "UninstallString") ?? null;
  const windowsInstaller = readValue(key, "WindowsInstaller") === "1";
  return {
    regDir,
    registryPath: key.path,
    hive,
    scope,
    displayName,
    displayVersion: readValue(key, "DisplayVersion") ?? "",
    publisher: readValue(key, "Publisher") ?? "",
    installLocation: readValue(key, "InstallLocation") ?? null,
    uninstallString,
    quietUninstallString: readValue(key, "QuietUninstallString") ?? null,
    displayIcon: readValue(key, "DisplayIcon") ?? null,
    isMsi: windowsInstaller || /msiexec/i.test(uninstallString ?? ""),
    estimatedSizeKb: Number(readValue(key, "EstimatedSize") ?? 0) || 0,
    installDate: readValue(key, "InstallDate") ?? null,
    systemComponent: SYSTEM_HINTS.some((hint) => displayName.toUpperCase().includes(hint)),
    needsElevation,
  };
}

/** 同一软件在 HKLM/HKCU 或 32/64 两处都出现时合并，保留可卸载信息更完整的一条。 */
export function dedupeInstalled(apps: readonly InstalledApp[]): InstalledApp[] {
  const byIdentity = new Map<string, InstalledApp>();
  for (const app of apps) {
    const identity = [app.displayName.toLowerCase(), app.displayVersion.toLowerCase(), (app.installLocation ?? app.regDir).toLowerCase()].join("|");
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, app);
      continue;
    }
    const score = (a: InstalledApp): number => (a.uninstallString ? 2 : 0) + (a.installLocation ? 1 : 0);
    if (score(app) > score(existing)) byIdentity.set(identity, app);
  }
  return [...byIdentity.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, "zh-Hans-CN"));
}

export interface ScanOptions {
  includeSystemComponents?: boolean;
  hives?: ("HKLM" | "HKCU")[];
}

export async function scanInstalledApps(reg: RegClient, options: ScanOptions = {}): Promise<InstalledApp[]> {
  const wanted = new Set(options.hives ?? ["HKLM", "HKCU"]);
  const roots = UNINSTALL_ROOTS.filter((r) => wanted.has(r.hive));
  // 三个卸载根并行扫描，避免串行累加约 2s 的卡顿。
  const keySets = await Promise.all(roots.map((r) => reg.queryTree(r.path)));
  const collected: InstalledApp[] = [];
  roots.forEach((root, index) => {
    for (const key of keySets[index] ?? []) {
      const app = toInstalledApp(key, root.label, root.hive, root.hive === "HKLM");
      if (!app) continue;
      if (app.systemComponent && !options.includeSystemComponents) continue;
      collected.push(app);
    }
  });
  return dedupeInstalled(collected);
}

/** 已装应用总体积，供安装前的磁盘余量提示使用。 */
export function totalInstalledSizeKb(apps: readonly InstalledApp[]): number {
  return apps.reduce((sum, a) => sum + a.estimatedSizeKb, 0);
}
