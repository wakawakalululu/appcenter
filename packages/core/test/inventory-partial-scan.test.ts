import { test } from "node:test";
import assert from "node:assert/strict";
import { UNINSTALL_ROOTS, scanInstalledApps, type RegClient, type RegistryKey, type RegistryValue } from "@appcenter/core";

const key = (path: string, name: string, version: string): RegistryKey => {
  const values: RegistryValue[] = [
    { name: "DisplayName", type: "REG_SZ", data: name },
    { name: "DisplayVersion", type: "REG_SZ", data: version },
    { name: "Publisher", type: "REG_SZ", data: "厂商" },
    { name: "UninstallString", type: "REG_SZ", data: "C:\\app\\unins000.exe /S" },
  ];
  return { path, values };
};

/** RegClient 只有这三个方法：queryTree / queryChildren / readKey。 */
function stubReg(impl: (rootPath: string) => Promise<RegistryKey[]>): RegClient {
  return {
    queryTree: impl,
    async queryChildren(): Promise<string[]> { return []; },
    async readKey(): Promise<RegistryKey | null> { return null; },
  };
}

/** 只有匹配 `failFragment` 的那个根会炸：模拟 HKCU 被策略禁用、reg.exe 对该 hive 报错。 */
function flakyReg(failFragment: string): { reg: RegClient; failingRoot: string } {
  const failing = UNINSTALL_ROOTS.find((r) => r.path.includes(failFragment)) ?? UNINSTALL_ROOTS[1]!;
  const reg = stubReg(async (rootPath: string) => {
    if (rootPath === failing.path) throw new Error("reg.exe exited with code 2 for " + rootPath);
    const index = UNINSTALL_ROOTS.findIndex((r) => r.path === rootPath);
    return [key(rootPath + "\\Good-" + String(index), "健康应用" + String(index), "1.0.0")];
  });
  return { reg, failingRoot: failing.path };
}

test("单个注册表根查询失败不得让整份已装清单消失", async () => {
  const { reg, failingRoot } = flakyReg("CurrentVersion\\Uninstall");
  const apps = await scanInstalledApps(reg);

  assert.ok(apps.length > 0, "一个根失败就把全部结果丢掉了（清单变成「已安装 0 个应用」，升级计划与残留扫描会跟着一起空）；失败根=" + failingRoot);
  assert.ok(apps.every((a) => a.displayName.startsWith("健康应用")), "只该少掉失败那个根的条目");
});

test("部分失败要能被调用方看见（不能静默当成「真的没装」）", async () => {
  const { reg, failingRoot } = flakyReg("CurrentVersion\\Uninstall");
  const seen: string[] = [];
  await scanInstalledApps(reg, { onRootError: (err, root) => seen.push(root + ":" + err.message) });
  assert.equal(seen.length, 1, "失败根必须上报一次，实际 " + JSON.stringify(seen));
  assert.ok(seen[0]?.includes(failingRoot), "上报的应就是那个失败的根：" + String(seen[0]));
});

test("全部根都失败时仍然是空数组而不是抛出（与部分失败同一套语义）", async () => {
  const reg = stubReg(async (p: string) => { throw new Error("all broken " + p); });
  const seen: string[] = [];
  const apps = await scanInstalledApps(reg, { onRootError: (_err, root) => seen.push(root) });
  assert.deepEqual(apps, []);
  assert.equal(seen.length, UNINSTALL_ROOTS.length, "每个失败的根都该上报，实际 " + JSON.stringify(seen));
});
