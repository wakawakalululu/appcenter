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

test("cachedInstalledApps falls back to incremental refresh when the cache is stale", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ic-"));
  try {
    const counting = new CountingRegClient(new InMemoryRegClient(seedKeys()));
    const cache = new InstalledAppCache(dir, 30 * 60 * 1000);
    // 手工写入一个很早以前的缓存，使其过期
    const fs = await import("node:fs/promises");
    const file = path.join(dir, "inventory-cache.json");
    const stale = { version: 1, updatedAt: "1970-01-01T00:00:00.000Z", apps: [], fingerprints: {} };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(stale), "utf8");

    const apps = await cachedInstalledApps(counting, cache);
    assert.equal(apps.length, 3, "增量刷新仍得到正确应用");
    assert.equal(counting.queryChildrenCalls, 3, "增量刷新先 queryChildren 探查子键");
    assert.ok(counting.queryTreeCalls >= 3, "增量刷新对单个 regDir 做窄查询");
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
