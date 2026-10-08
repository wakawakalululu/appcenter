import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cachedInstalledApps,
  InMemoryRegClient,
  InstalledAppCache,
  regKey,
  UNINSTALL_ROOTS,
  type InstalledApp,
  type RegClient,
  type RegistryKey,
} from "@appcenter/core";

const rootPaths = UNINSTALL_ROOTS.map((r) => r.path);

const baseKeys = (): RegistryKey[] => [
  regKey(rootPaths[0] + "\\AppA", { DisplayName: "App A", DisplayVersion: "1.0.0" }),
  regKey(rootPaths[1] + "\\AppB", { DisplayName: "App B", DisplayVersion: "2.0.0" }),
  regKey(rootPaths[2] + "\\AppC", { DisplayName: "App C", DisplayVersion: "3.0.0" }),
];

/** 先落一份健康缓存，再把 updatedAt 拨到远古，强制走「增量刷新」而不是冷启动扫描。 */
async function seedStaleCache(dir: string): Promise<void> {
  await cachedInstalledApps(new InMemoryRegClient(baseKeys()), new InstalledAppCache(dir));
  const file = path.join(dir, "inventory-cache.json");
  const data = JSON.parse(await readFile(file, "utf8"));
  data.updatedAt = "1970-01-01T00:00:00.000Z";
  await writeFile(file, JSON.stringify(data), "utf8");
}

/** 只有路径命中 failFragment 的那个根 reject，其余根照常返回。 */
function partialReg(failFragment: string, keys = baseKeys()): RegClient {
  const inner = new InMemoryRegClient(keys);
  return {
    async queryTree(rootPath: string): Promise<RegistryKey[]> {
      if (rootPath.includes(failFragment)) throw new Error("reg.exe exited with code 2 for " + rootPath);
      return inner.queryTree(rootPath);
    },
    queryChildren: (p: string) => inner.queryChildren(p),
    readKey: (p: string) => inner.readKey(p),
  };
}

const names = (apps: InstalledApp[]): string[] => apps.map((a) => a.displayName).sort();

test("增量刷新时单个根失败不得让整份已装清单查询一起失败", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "icp-"));
  try {
    await seedStaleCache(dir);
    // HKCU 被策略禁用时 reg.exe 只对这一个 hive 报错，另外两个根完全健康。
    const apps = await cachedInstalledApps(partialReg("HKCU"), new InstalledAppCache(dir));
    assert.deepEqual(names(apps), ["App A", "App B", "App C"], "健康根的结果不能因为另一个根失败而消失");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("读空的根要区分「真的没有」和「没读到」：失败根下缓存不得判为已卸载，读成功却为空的根仍判卸载", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "icp-"));
  try {
    await seedStaleCache(dir);

    // 失败根：一次都读不到 ⇒ 未知，保留最后已知。
    const afterFail = await cachedInstalledApps(partialReg("WOW6432Node"), new InstalledAppCache(dir));
    assert.ok(afterFail.some((a) => a.displayName === "App B"), "查询失败的根不能把自家缓存当成「已卸载」清掉");
    const persisted = JSON.parse(await readFile(path.join(dir, "inventory-cache.json"), "utf8")) as { apps: InstalledApp[] };
    assert.ok(
      persisted.apps.some((a) => a.displayName === "App B"),
      "落盘缓存同样要保留：否则下一次首屏命中缓存时 App B 直接消失，用户看到的就是「软件自己没了」",
    );

    // 读成功但子树为空：这才是真的卸载，必须照旧丢弃。
    const keys = baseKeys();
    const dropped = new InMemoryRegClient(keys.filter((k) => !k.path.startsWith(rootPaths[1]!)));
    const afterRealUninstall = await cachedInstalledApps(dropped, new InstalledAppCache(dir, 0));
    assert.ok(!afterRealUninstall.some((a) => a.displayName === "App B"), "真卸载（读成功但键消失）仍要被丢弃，不能一刀切全保留");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("刷新阶段的按根失败必须上报，不能静默当成「这台机器没装软件」", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "icp-"));
  try {
    await seedStaleCache(dir);
    const failingRoot = UNINSTALL_ROOTS.find((r) => r.path.includes("HKCU"))!;
    const seen: string[] = [];
    await cachedInstalledApps(partialReg("HKCU"), new InstalledAppCache(dir), {
      onRootError: (err, root) => seen.push(root + ":" + err.message),
    });
    assert.equal(seen.length, 1, "失败根必须上报一次，实际 " + JSON.stringify(seen));
    assert.ok(seen[0]?.includes(failingRoot.path), "上报的应就是那个失败的根：" + String(seen[0]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("全部根都失败时保留整份旧清单而不是抛出", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "icp-"));
  try {
    await seedStaleCache(dir);
    const broken: RegClient = {
      async queryTree(p: string): Promise<RegistryKey[]> {
        throw new Error("registry unavailable: " + p);
      },
      async queryChildren(): Promise<string[]> {
        return [];
      },
      async readKey(): Promise<RegistryKey | null> {
        return null;
      },
    };
    const seen: string[] = [];
    const apps = await cachedInstalledApps(broken, new InstalledAppCache(dir), {
      onRootError: (_err, root) => seen.push(root),
    });
    assert.deepEqual(names(apps), ["App A", "App B", "App C"], "全失败＝保留最后已知");
    assert.equal(seen.length, UNINSTALL_ROOTS.length, "每个失败的根都该上报，实际 " + JSON.stringify(seen));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("部分失败时健康根仍然正常合并：变更取新值、新装纳入", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "icp-"));
  try {
    await seedStaleCache(dir);
    const refreshed: RegistryKey[] = [
      regKey(rootPaths[0] + "\\AppA", { DisplayName: "App A", DisplayVersion: "1.1.0" }),
      regKey(rootPaths[0] + "\\AppD", { DisplayName: "App D", DisplayVersion: "4.0.0" }),
      regKey(rootPaths[1] + "\\AppB", { DisplayName: "App B", DisplayVersion: "2.0.0" }),
    ];
    const apps = await cachedInstalledApps(partialReg("HKCU", refreshed), new InstalledAppCache(dir));
    const byName = new Map(apps.map((a) => [a.displayName, a.displayVersion]));
    assert.equal(byName.get("App A"), "1.1.0", "健康根的升级仍要取到新值");
    assert.equal(byName.get("App D"), "4.0.0", "健康根的新装仍要纳入");
    assert.equal(byName.get("App B"), "2.0.0");
    assert.equal(byName.get("App C"), "3.0.0", "失败根的旧值保留到最后已知");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
