import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dedupeInstalled, scanInstalledApps, toInstalledApp, type InstalledApp, type ScanOptions } from "./inventory.ts";
import { canonicalHive, UNINSTALL_ROOTS, type RegClient, type RegistryKey } from "./registry.ts";

export interface InventoryCacheData {
  version: 1;
  updatedAt: string;
  apps: InstalledApp[];
  /** 完整 canonical registryPath（小写）-> 指纹，用于增量刷新时识别新增/变更。 */
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
    for (const app of apps) fingerprints[pathKey(app)] = fingerprintOf(app);
    const data: InventoryCacheData = { version: 1, updatedAt: new Date().toISOString(), apps, fingerprints };
    this.cache = data;
    await fs.mkdir(this.cacheDir, { recursive: true }).catch(() => undefined);
    // 临时名必须唯一：CLI 与 UI 宿主可能共用同一个 dataDir 并发保存，
    // 固定 `<file>.tmp` 会让两个写入者踩同一个文件，rename 之后一方把半截内容落成正式缓存。
    // Windows 上 rename 覆盖被占用的目标会 EPERM，因此同样有界重试。
    const tmp = this.file() + "." + process.pid + "." + randomBytes(4).toString("hex") + ".tmp";
    try {
      await fs.writeFile(tmp, JSON.stringify(data), "utf8");
      let lastError: unknown;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          await fs.rename(tmp, this.file());
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err;
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
      }
      if (lastError) throw lastError;
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }
}

function fingerprintOf(app: InstalledApp): string {
  return [app.registryPath, app.displayVersion, app.estimatedSizeKb].join("|");
}

/** 缓存与指纹以完整 canonical 路径为键，避免同名 regDir 在 64/32/用户根之间互相覆盖。 */
function pathKey(app: InstalledApp): string {
  return canonicalHive(app.registryPath).toLowerCase();
}

/**
 * 带缓存的清单扫描：命中且未过期直接返回磁盘结果（真机首屏约 2ms）；
 * 过期则走增量刷新——与冷启动同样的「三个卸载根各一次递归 queryTree」批处理，
 * 再与上一轮缓存按指纹合并（复用未变对象、纳入新增、丢弃卸载），并在整体读空时保留最后已知。
 * 单个根查询失败只少掉该根本轮的新结果，其旧缓存按「未知而非空」保留（见 incrementalRefresh）。
 *
 * 为什么不用「逐子键 readKey 点查」：真机 141 个应用对应 ~174 个直接子键，
 * 点查会 fan out 成上百次 reg.exe 进程启动（实测约 6.0s），远慢于每根一次递归的批处理
 * （实测约 1.3s）；Windows 上 reg.exe 的进程启动开销远高于子树解析开销，故刷新走批处理递归。
 */
export async function cachedInstalledApps(
  reg: RegClient,
  cache: InstalledAppCache,
  options: ScanOptions = {},
): Promise<InstalledApp[]> {
  const existing = await cache.load();
  if (existing && cache.isFresh(existing)) return existing.apps;
  if (existing) {
    const merged = await incrementalRefresh(reg, options, existing);
    await cache.save(merged);
    return merged;
  }
  const fresh = await scanInstalledApps(reg, options);
  await cache.save(fresh);
  return fresh;
}

/**
 * 增量刷新：一次批处理重扫（每根一次递归，与 scanInstalledApps 同成本）后与旧缓存合并——
 * 指纹未变沿用缓存对象、变更取新值、消失即视为卸载、全部读空则判定为瞬时失败保留原清单。
 *
 * 「消失即卸载」只对**读成功**的根成立：某个根查询失败（HKCU 被策略禁用、reg.exe 对该 hive 报错）
 * 时它的键集是「未知」而不是「空」，若与真卸载同样处理，一次 hive 故障就会把该根下的软件
 * 全部判为已卸载并落盘，下次首屏命中缓存时用户看到的就是「软件自己没了」。
 */
async function incrementalRefresh(
  reg: RegClient,
  options: ScanOptions,
  existing: InventoryCacheData,
): Promise<InstalledApp[]> {
  const wanted = new Set(options.hives ?? ["HKLM", "HKCU"]);
  const roots = UNINSTALL_ROOTS.filter((r) => wanted.has(r.hive));

  const cachedByPath = new Map<string, InstalledApp>();
  for (const app of existing.apps) cachedByPath.set(pathKey(app), app);
  const priorFp = existing.fingerprints ?? {};

  const results = await Promise.all(
    roots.map((root) =>
      reg.queryTree(root.path).then(
        (keys) => ({ root, keys, error: null as Error | null }),
        (err: unknown) => ({ root, keys: [] as RegistryKey[], error: err instanceof Error ? err : new Error(String(err)) }),
      ),
    ),
  );
  const report =
    options.onRootError ??
    ((err: Error, rootPath: string): void => {
      console.warn("已装清单增量刷新失败（" + rootPath + "）：" + err.message);
    });

  /** 本轮读到结果（含读到空）的根——只有这些根下的「消失」才代表卸载。 */
  const readable = new Set<string>();
  let anyRead = false;
  const collected: InstalledApp[] = [];
  const seen = new Set<string>();
  for (const { root, keys, error } of results) {
    if (error) {
      report(error, root.path);
      continue;
    }
    readable.add(canonicalHive(root.path).toLowerCase());
    if (keys.length > 0) anyRead = true;
    for (const key of keys) {
      const app = toInstalledApp(key, root.label, root.hive, root.hive === "HKLM");
      if (!app) continue;
      if (app.systemComponent && !options.includeSystemComponents) continue;
      const id = pathKey(app);
      if (seen.has(id)) continue;
      seen.add(id);
      const fp = fingerprintOf(app);
      const cached = cachedByPath.get(id);
      collected.push(cached && (priorFp[id] ?? fingerprintOf(cached)) === fp ? cached : app);
    }
  }

  // 本轮扫描的根全部读空但旧清单非空：视为瞬时整体失败，保留最后已知，绝不让 UI 突然清空。
  if (!anyRead && existing.apps.length > 0 && roots.length > 0) return existing.apps;

  // 本轮未扫描（被 hives 过滤掉）与读取失败的根，其缓存原样保留，不误判为已卸载。
  for (const [key, app] of cachedByPath) {
    const underReadable = [...readable].some((root) => key === root || key.startsWith(root + "\\"));
    if (!underReadable) collected.push(app);
  }

  return dedupeInstalled(collected);
}
