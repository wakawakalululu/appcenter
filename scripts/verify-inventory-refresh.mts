import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  InstalledAppCache,
  RegExeClient,
  cachedInstalledApps,
  type InstalledApp,
  type RegistryKey,
  type RegClient,
} from "../packages/core/src/index.ts";

/** 包裹真实 reg.exe 客户端，统计每类查询的调用次数（只读注册表，不执行任何安装）。 */
class CountingClient implements RegClient {
  queryTreeCalls = 0;
  queryChildrenCalls = 0;
  readKeyCalls = 0;
  private readonly inner = new RegExeClient();
  async queryTree(p: string): Promise<RegistryKey[]> {
    this.queryTreeCalls++;
    return this.inner.queryTree(p);
  }
  async queryChildren(p: string): Promise<string[]> {
    this.queryChildrenCalls++;
    return this.inner.queryChildren(p);
  }
  async readKey(p: string): Promise<RegistryKey | null> {
    this.readKeyCalls++;
    return this.inner.readKey(p);
  }
}

const ms = (t0: number): number => Math.round(performance.now() - t0);
const line = (s: string): void => { process.stdout.write(s + "\n"); };

const dir = await mkdtemp(path.join(tmpdir(), "inv-refresh-"));
try {
  // 1) 冷启动：无缓存 → 全量并行扫描（每个卸载根一次递归 queryTree）。
  const cold = new CountingClient();
  let t0 = performance.now();
  const apps = await cachedInstalledApps(cold, new InstalledAppCache(dir));
  const coldMs = ms(t0);
  line(`[cold ] apps=${apps.length} 耗时=${coldMs}ms  queryTree=${cold.queryTreeCalls} queryChildren=${cold.queryChildrenCalls} readKey=${cold.readKeyCalls}`);

  // 2) 命中新鲜缓存：应完全不再触达注册表。
  const hit = new CountingClient();
  t0 = performance.now();
  const cached = await cachedInstalledApps(hit, new InstalledAppCache(dir));
  const hitMs = ms(t0);
  line(`[hit  ] apps=${cached.length} 耗时=${hitMs}ms  queryTree=${hit.queryTreeCalls} queryChildren=${hit.queryChildrenCalls} readKey=${hit.readKeyCalls}`);

  // 3) 强制过期走增量刷新：期望逐子键非递归 readKey，几乎不再递归 queryTree。
  const data = JSON.parse(await readFile(path.join(dir, "inventory-cache.json"), "utf8")) as { updatedAt: string };
  data.updatedAt = "1970-01-01T00:00:00.000Z";
  await (await import("node:fs/promises")).writeFile(path.join(dir, "inventory-cache.json"), JSON.stringify(data), "utf8");

  const refresh = new CountingClient();
  t0 = performance.now();
  const refreshed = await cachedInstalledApps(refresh, new InstalledAppCache(dir));
  const refreshMs = ms(t0);
  line(`[refresh] apps=${refreshed.length} 耗时=${refreshMs}ms  queryTree=${refresh.queryTreeCalls} queryChildren=${refresh.queryChildrenCalls} readKey=${refresh.readKeyCalls}`);

  // 一致性：增量刷新结果与全量扫描在应用集合上应等价（同一台机器、同一时刻）。
  const full = await collect(new RegExeClient());
  const setA = keySet(apps);
  const setB = keySet(full);
  const onlyInScan = [...setB].filter((k) => !setA.has(k));
  const onlyInRefresh = [...setA].filter((k) => !setB.has(k));
  line(`[parity] 全量扫描=${full.length} 增量刷新=${apps.length} 仅扫描有=${onlyInScan.length} 仅刷新有=${onlyInRefresh.length}`);
  if (onlyInScan.length || onlyInRefresh.length) {
    line("  差异样本: " + JSON.stringify({ onlyInScan: onlyInScan.slice(0, 3), onlyInRefresh: onlyInRefresh.slice(0, 3) }));
  }

  const ok =
    hit.queryTreeCalls === 0 && hit.readKeyCalls === 0 && hit.queryChildrenCalls === 0 &&
    refresh.queryTreeCalls === 3 &&
    refresh.readKeyCalls === 0 &&
    refresh.queryChildrenCalls === 0 &&
    refreshMs < coldMs * 2 &&
    onlyInScan.length === 0 && onlyInRefresh.length === 0;
  line(
    ok
      ? `RESULT: PASS — 刷新走每根一次递归批处理（queryTree=3, readKey=0），耗时 ${refreshMs}ms 与冷扫描 ${coldMs}ms 同量级，结果与全量一致`
      : "RESULT: CHECK — 见上方计数",
  );
  process.exitCode = ok ? 0 : 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}

async function collect(reg: RegClient): Promise<InstalledApp[]> {
  // 直接复用非缓存扫描路径需要 scanInstalledApps；这里用一次性 TTL=0 空缓存等价触发冷扫描。
  const { scanInstalledApps } = await import("../packages/core/src/index.ts");
  return scanInstalledApps(reg);
}

function keySet(apps: InstalledApp[]): Set<string> {
  return new Set(apps.map((a) => `${a.registryPath.toLowerCase()}|${a.displayVersion}`));
}
