import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryRegClient, regKey, UNINSTALL_ROOTS, type RegClient, type RegistryKey } from "@appcenter/core";
import { InstalledAppCache, cachedInstalledApps, scanInstalledApps } from "@appcenter/core";

const rootPaths = UNINSTALL_ROOTS.map((r) => r.path);

const seedKeys = (): RegistryKey[] => [
  regKey(rootPaths[0] + "\\AppA", { DisplayName: "App A", DisplayVersion: "1.0.0" }),
  regKey(rootPaths[1] + "\\AppB", { DisplayName: "App B", DisplayVersion: "2.0.0" }),
  regKey(rootPaths[2] + "\\AppC", { DisplayName: "App C", DisplayVersion: "3.0.0" }),
];

/** 包裹一层计数，验证缓存命中时不再触达真实注册表。 */
class CountingRegClient implements RegClient {
  queryTreeCalls = 0;
  queryChildrenCalls = 0;
  readKeyCalls = 0;
  constructor(private readonly inner: RegClient) {}
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

test("readKey returns the exact key without recursing and null when missing", async () => {
  const reg = new InMemoryRegClient(seedKeys());
  const hit = await reg.readKey(rootPaths[0] + "\\AppA");
  assert.equal(hit?.path, rootPaths[0] + "\\AppA");
  assert.equal(hit?.values.find((v) => v.name === "DisplayName")?.data, "App A");
  assert.equal(await reg.readKey(rootPaths[0] + "\\Nope"), null);
});

test("inventory cache round-trips to disk and honours TTL", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ic-"));
  try {
    const apps = await scanInstalledApps(new InMemoryRegClient(seedKeys()));
    const cache = new InstalledAppCache(dir, 30 * 60 * 1000);
    assert.equal(await cache.load(), null);
    await cache.save(apps);
    const loaded = await cache.load();
    assert.ok(loaded);
    assert.equal(loaded?.apps.length, 3);

    // 默认 TTL 内视为新鲜
    assert.equal(cache.isFresh(loaded), true);
    // TTL 为 0 时永远过期
    const strict = new InstalledAppCache(dir, 0);
    assert.equal(strict.isFresh(loaded), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cachedInstalledApps serves a fresh cache without touching the registry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ic-"));
  try {
    const counting = new CountingRegClient(new InMemoryRegClient(seedKeys()));
    const cache = new InstalledAppCache(dir);
    const first = await cachedInstalledApps(counting, cache);
    assert.equal(first.length, 3);
    const treeAfterFirst = counting.queryTreeCalls;
    assert.equal(treeAfterFirst, 3, "冷启动并行扫描 3 个卸载根");

    // 第二次在 TTL 内命中缓存：不应再调用 queryTree
    const second = await cachedInstalledApps(counting, cache);
    assert.equal(second.length, 3);
    assert.equal(counting.queryTreeCalls, treeAfterFirst, "命中缓存后未再扫描注册表");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cachedInstalledApps refreshes a stale cache with one batched re-scan per root", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ic-"));
  try {
    const counting = new CountingRegClient(new InMemoryRegClient(seedKeys()));
    const cache = new InstalledAppCache(dir, 30 * 60 * 1000);
    // 手工写入一个很早以前的空缓存，使其过期
    const fs = await import("node:fs/promises");
    const file = path.join(dir, "inventory-cache.json");
    const stale = { version: 1, updatedAt: "1970-01-01T00:00:00.000Z", apps: [], fingerprints: {} };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(stale), "utf8");

    const apps = await cachedInstalledApps(counting, cache);
    assert.equal(apps.length, 3, "增量刷新仍得到正确应用");
    // 真机证据驱动的契约：每根各一次递归批处理，绝不 fan out 成逐子键点查
    assert.equal(counting.queryTreeCalls, 3, "每个卸载根各一次递归 queryTree");
    assert.equal(counting.queryChildrenCalls, 0, "不再按直接子键展开点查");
    assert.equal(counting.readKeyCalls, 0, "刷新不走逐子键 readKey（真机上百次进程启动会拖到 ~6s）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** 用一轮正常扫描落盘，再把 updatedAt 拨到远古，构造「过期但有内容」的缓存。 */
async function seedStale(dir: string, reg: RegClient): Promise<void> {
  await cachedInstalledApps(reg, new InstalledAppCache(dir));
  const fs = await import("node:fs/promises");
  const file = path.join(dir, "inventory-cache.json");
  const data = JSON.parse(await fs.readFile(file, "utf8"));
  data.updatedAt = "1970-01-01T00:00:00.000Z";
  await fs.writeFile(file, JSON.stringify(data), "utf8");
}

test("incremental refresh merges version changes, new installs and removals", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ic-"));
  try {
    const before = [
      regKey(rootPaths[0] + "\\AppA", { DisplayName: "App A", DisplayVersion: "1.0.0" }),
      regKey(rootPaths[1] + "\\AppB", { DisplayName: "App B", DisplayVersion: "2.0.0" }),
    ];
    await seedStale(dir, new InMemoryRegClient(before));

    const after = new InMemoryRegClient([
      regKey(rootPaths[0] + "\\AppA", { DisplayName: "App A", DisplayVersion: "1.1.0" }), // 升级
      regKey(rootPaths[2] + "\\AppC", { DisplayName: "App C", DisplayVersion: "3.0.0" }), // 新装
      // AppB 已卸载（其键消失）
    ]);
    const apps = await cachedInstalledApps(after, new InstalledAppCache(dir));
    const byName = new Map(apps.map((a) => [a.displayName, a.displayVersion]));
    assert.deepEqual([...byName.keys()].sort(), ["App A", "App C"]);
    assert.equal(byName.get("App A"), "1.1.0", "变更项取到新值而非旧缓存");
    assert.ok(!byName.has("App B"), "子键消失即判定为已卸载并丢弃");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("incremental refresh preserves the cached list when a registry read comes back empty", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ic-"));
  try {
    await seedStale(dir, new InMemoryRegClient(seedKeys()));
    // 所有卸载根都读空（reg.exe 瞬时失败），不能让 UI 突然把清单清空
    class EmptyClient implements RegClient {
      async queryChildren(): Promise<string[]> {
        return [];
      }
      async readKey(): Promise<RegistryKey | null> {
        return null;
      }
      async queryTree(): Promise<RegistryKey[]> {
        return [];
      }
    }
    const apps = await cachedInstalledApps(new EmptyClient(), new InstalledAppCache(dir));
    assert.deepEqual(
      apps.map((a) => a.displayName).sort(),
      ["App A", "App B", "App C"],
      "整体读空时保留最后已知，清单不缩水",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("incremental refresh discovers nested uninstall entries in one batched pass", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ic-"));
  try {
    const keys = [
      regKey(rootPaths[0] + "\\AppA", { DisplayName: "App A", DisplayVersion: "1.0.0" }),
      regKey(rootPaths[0] + "\\Container", { Publisher: "Nobody" }), // 本身不是应用项
      regKey(rootPaths[0] + "\\Container\\Nested", { DisplayName: "Nested App", DisplayVersion: "0.9" }),
    ];
    await seedStale(dir, new InMemoryRegClient(keys));
    const counting = new CountingRegClient(new InMemoryRegClient(keys));
    const apps = await cachedInstalledApps(counting, new InstalledAppCache(dir));
    const names = apps.map((a) => a.displayName).sort();
    assert.deepEqual(names, ["App A", "Nested App"], "深层嵌套的卸载项在批处理递归中仍被发现");
    assert.equal(counting.queryTreeCalls, 3, "每根一次递归，覆盖嵌套键");
    assert.equal(counting.readKeyCalls, 0, "不做逐子键点查");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cache fingerprints are keyed by full path so same-leaf entries across roots don't collide", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ic-"));
  try {
    const keys = [
      regKey(rootPaths[0] + "\\Shared", { DisplayName: "Alpha", DisplayVersion: "1.0", InstallLocation: "C:\\Alpha" }),
      regKey(rootPaths[1] + "\\Shared", { DisplayName: "Beta", DisplayVersion: "2.0", InstallLocation: "C:\\Beta" }),
    ];
    await seedStale(dir, new InMemoryRegClient(keys));
    const apps = await cachedInstalledApps(new InMemoryRegClient(keys), new InstalledAppCache(dir));
    assert.deepEqual(apps.map((a) => a.displayName).sort(), ["Alpha", "Beta"], "同名叶子在 64/32 两根下各自保留");

    const fs = await import("node:fs/promises");
    const data = JSON.parse(await fs.readFile(path.join(dir, "inventory-cache.json"), "utf8"));
    const fpKeys: string[] = Object.keys(data.fingerprints);
    assert.equal(fpKeys.length, 2, "两条独立指纹，未被叶子键互相覆盖");
    assert.ok(fpKeys.every((k) => k.includes("uninstall")), "指纹键是完整 canonical 路径而非 regDir 叶子");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanInstalledApps reads all three roots in parallel and dedupes", async () => {
  const apps = await scanInstalledApps(new InMemoryRegClient(seedKeys()));
  assert.equal(apps.length, 3);
  assert.deepEqual(
    apps.map((a) => a.displayName).sort(),
    ["App A", "App B", "App C"],
  );
});
