import { promises as fs } from "node:fs";
import path from "node:path";
import { dedupeInstalled, scanInstalledApps, toInstalledApp, type InstalledApp, type ScanOptions } from "./inventory.ts";
import { canonicalHive, UNINSTALL_ROOTS, type RegClient } from "./registry.ts";

export interface InventoryCacheData {
  version: 1;
  updatedAt: string;
  apps: InstalledApp[];
  /** regDir -> 指纹，用于增量刷新时识别新增/变更。 */
  fingerprints: Record<string, string>;
}

/**
 * 已装清单落盘缓存：首屏直接命中磁盘，不再走真实注册表扫描（真机约 2s）。
 * 文件读写沿用 runtime-config 的「临时文件 + rename」原子范式。
 */
export class InstalledAppCache {
  private cache: InventoryCacheData | null = null;
  private inflight: Promise<InventoryCacheData | null> | null = null;

  constructor(
    private readonly cacheDir: string,
    private readonly ttlMs: number = 30 * 60 * 1000,
  ) {}

  private file(): string {
    return path.join(this.cacheDir, "inventory-cache.json");
  }

  isFresh(data: InventoryCacheData | null): boolean {
    if (!data) return false;
    const age = Date.now() - Date.parse(data.updatedAt);
    return age >= 0 && age < this.ttlMs;
  }

  async load(): Promise<InventoryCacheData | null> {
    if (this.cache) return this.cache;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const raw = await fs.readFile(this.file(), "utf8");
        const data = JSON.parse(raw) as InventoryCacheData;
        if (!data || data.version !== 1 || !Array.isArray(data.apps) || !data.fingerprints) return null;
        this.cache = data;
        return data;
      } catch {
        return null;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  async save(apps: InstalledApp[]): Promise<void> {
    const fingerprints: Record<string, string> = {};
    for (const app of apps) fingerprints[app.regDir] = fingerprintOf(app);
    const data: InventoryCacheData = { version: 1, updatedAt: new Date().toISOString(), apps, fingerprints };
    this.cache = data;
    await fs.mkdir(this.cacheDir, { recursive: true }).catch(() => undefined);
    const tmp = this.file() + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(data), "utf8");
    await fs.rename(tmp, this.file());
  }
}

function fingerprintOf(app: InstalledApp): string {
  return [app.registryPath, app.displayVersion, app.estimatedSizeKb].join("|");
}

/**
 * 带缓存的清单扫描：命中且未过期直接返回（首屏 < 300ms）；
 * 过期则走增量刷新——先 queryChildren 发现子键，再对单个 regDir 做窄查询，避免整棵递归。
 * 冷启动（无缓存）退化为并行全量扫描。
 */
export async function cachedInstalledApps(
  reg: RegClient,
  cache: InstalledAppCache,
  options: ScanOptions = {},
): Promise<InstalledApp[]> {
  const existing = await cache.load();
  if (existing && cache.isFresh(existing)) return existing.apps;
  if (existing) {
    const merged = await incrementalRefresh(reg, options);
    await cache.save(merged);
    return merged;
  }
  const fresh = await scanInstalledApps(reg, options);
  await cache.save(fresh);
  return fresh;
}

async function incrementalRefresh(reg: RegClient, options: ScanOptions): Promise<InstalledApp[]> {
  const wanted = new Set(options.hives ?? ["HKLM", "HKCU"]);
  const roots = UNINSTALL_ROOTS.filter((r) => wanted.has(r.hive));
  const childSets = await Promise.all(roots.map((r) => reg.queryChildren(r.path)));
  const collected: InstalledApp[] = [];
  await Promise.all(
    roots.map(async (root, index) => {
      for (const childPath of childSets[index] ?? []) {
        for (const key of await reg.queryTree(childPath)) {
          const app = toInstalledApp(key, root.label, root.hive, root.hive === "HKLM");
          if (!app) continue;
          if (app.systemComponent && !options.includeSystemComponents) continue;
          collected.push(app);
        }
      }
    }),
  );
  const seen = new Set<string>();
  const deduped: InstalledApp[] = [];
  for (const app of collected) {
    const id = canonicalHive(app.registryPath).toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(app);
  }
  return dedupeInstalled(deduped);
}
