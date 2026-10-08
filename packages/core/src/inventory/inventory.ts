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

/**
 * Windows 更新组件的识别短语。两处收口：
 * - `KB` 不再当裸子串用，必须后跟数字（KB5034441 这种补丁号），否则偶然含 "KB" 的正常软件会被误判；
 * - 去掉 `MICROSOFT SQL`：SQL Server 是用户主动安装的产品，标成系统组件等于直接从清单里消失。
 */
const SYSTEM_HINTS = ["SERVICE PACK", "UPDATE FOR", "SECURITY UPDATE", "HOTFIX"];

export function isSystemComponent(displayName: string): boolean {
  const upper = displayName.toUpperCase();
  return SYSTEM_HINTS.some((hint) => upper.includes(hint)) || /\bKB\d{3,}\b/.test(upper);
}

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
    systemComponent: isSystemComponent(displayName),
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
  /**
   * 单个卸载根查询失败时的回调。不传就退回 console.warn：
   * 关键是**不能静默**——少扫一个根与「这台机器真的没装软件」在界面上长得一模一样，
   * 而升级计划与残留扫描都会跟着变成空。
   */
  onRootError?: (err: Error, rootPath: string) => void;
}

export async function scanInstalledApps(reg: RegClient, options: ScanOptions = {}): Promise<InstalledApp[]> {
  const wanted = new Set(options.hives ?? ["HKLM", "HKCU"]);
  const roots = UNINSTALL_ROOTS.filter((r) => wanted.has(r.hive));
  // 三个卸载根并行扫描，避免串行累加约 2s 的卡顿。
  // 每个根单独收口：旧写法用裸 Promise.all，任一根失败（HKCU 被策略禁用、reg.exe 对该 hive 报错）
  // 就让整份清单变成 rejected，facade.installed() 不兜异常 ⇒ 已装列表/升级计划/残留扫描一起下线。
  const results = await Promise.all(
    roots.map((root) =>
      reg.queryTree(root.path).then(
        (keys) => ({ root, keys, error: null as Error | null }),
        (err: unknown) => ({ root, keys: [] as RegistryKey[], error: err instanceof Error ? err : new Error(String(err)) }),
      ),
    ),
  );
  const report = options.onRootError ?? ((err: Error, rootPath: string): void => { console.warn("已装清单扫描失败（" + rootPath + "）：" + err.message); });
  const collected: InstalledApp[] = [];
  for (const { root, keys, error } of results) {
    if (error) report(error, root.path);
    for (const key of keys) {
      const app = toInstalledApp(key, root.label, root.hive, root.hive === "HKLM");
      if (!app) continue;
      if (app.systemComponent && !options.includeSystemComponents) continue;
      collected.push(app);
    }
  }
  return dedupeInstalled(collected);
}

/** 已装应用总体积，供安装前的磁盘余量提示使用。 */
export function totalInstalledSizeKb(apps: readonly InstalledApp[]): number {
  return apps.reduce((sum, a) => sum + a.estimatedSizeKb, 0);
}
