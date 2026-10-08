import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTEXTMENU_ROOTS,
  scanContextMenu,
  scanResidue,
  type InstalledApp,
  type RegClient,
  type RegistryKey,
} from "@appcenter/core";

const BS = String.fromCharCode(92);
const installDir = ["C:", "Program Files", "Demo App"].join(BS);
const ROOT0 = CONTEXTMENU_ROOTS[0] ?? "";
const ROOT1 = CONTEXTMENU_ROOTS[1] ?? "";
const G1 = "{11111111-1111-1111-1111-111111111111}";
const G2 = "{22222222-2222-2222-2222-222222222222}";
const CLSID1 = ["HKCR", "CLSID", G1].join(BS);
const CLSID2 = ["HKCR", "CLSID", G2].join(BS);

/** 真机形态：挂载点子键的 (Default) 是 CLSID，CLSID 键的 InprocServer32 指向扩展 DLL。 */
const KEYS: RegistryKey[] = [
  { path: ROOT0, values: [] },
  { path: ROOT0 + BS + "DemoExt1", values: [{ name: "(Default)", type: "REG_SZ", data: G1 }] },
  { path: ROOT1 + BS + "DemoExt2", values: [{ name: "(Default)", type: "REG_SZ", data: G2 }] },
  { path: CLSID1, values: [{ name: "(Default)", type: "REG_SZ", data: "Demo 扩展一" }] },
  { path: CLSID1 + BS + "InprocServer32", values: [{ name: "(Default)", type: "REG_SZ", data: installDir + BS + "ext1.dll" }] },
  { path: CLSID2, values: [{ name: "(Default)", type: "REG_SZ", data: "Demo 扩展二" }] },
  { path: CLSID2 + BS + "InprocServer32", values: [{ name: "(Default)", type: "REG_SZ", data: installDir + BS + "ext2.dll" }] },
];

/** 按**键边界**取子树（与修好的真实桩一致，别在这里重新引入过宽匹配）。 */
function treeOf(rootPath: string): RegistryKey[] {
  const prefix = rootPath.toLowerCase().replace(/\\+$/, "");
  return KEYS.filter((k) => {
    const key = k.path.toLowerCase();
    return key === prefix || key.startsWith(prefix + BS);
  });
}

function stubReg(failPaths: string[]): RegClient {
  const isFailing = (p: string): boolean => failPaths.some((f) => p.toLowerCase() === f.toLowerCase());
  return {
    async queryTree(rootPath: string): Promise<RegistryKey[]> {
      if (isFailing(rootPath)) throw new Error("reg.exe exited with code 1 for " + rootPath);
      return treeOf(rootPath);
    },
    async queryChildren(rootPath: string): Promise<string[]> {
      if (isFailing(rootPath)) throw new Error("reg.exe exited with code 1 for " + rootPath);
      return [];
    },
    async readKey(keyPath: string): Promise<RegistryKey | null> {
      if (isFailing(keyPath)) throw new Error("reg.exe exited with code 1 for " + keyPath);
      return KEYS.find((k) => k.path.toLowerCase() === keyPath.toLowerCase()) ?? null;
    },
  };
}

const app: InstalledApp = {
  regDir: "DemoApp",
  registryPath: "HKLM" + BS + "SOFTWARE" + BS + "Microsoft" + BS + "Windows" + BS + "CurrentVersion" + BS + "Uninstall" + BS + "DemoApp",
  hive: "HKLM",
  scope: "machine-64",
  displayName: "Demo App",
  displayVersion: "1.0.0",
  publisher: "Demo",
  installLocation: installDir,
  uninstallString: installDir + BS + "unins000.exe",
  quietUninstallString: null,
  displayIcon: installDir + BS + "demo.ico",
  isMsi: false,
  estimatedSizeKb: 1024,
  installDate: null,
  systemComponent: false,
  needsElevation: false,
};

const matchesApp = (candidate: string): boolean => candidate.toLowerCase().includes(installDir.toLowerCase());

test("对照：两个挂载点各挂一个扩展，两个都该被认出来", async () => {
  const out = await scanContextMenu(app, stubReg([]), matchesApp);
  assert.equal(out.items.length, 2, "fixture 本身要能出两项，否则后面的断言没有意义，实际 " + String(out.items.length));
  assert.deepEqual(out.gaps, [], "健康扫描不该有缺口");
});

test("单个挂载根读失败：只丢这一根，别根的命中保留并精确记到那个根", async () => {
  const out = await scanContextMenu(app, stubReg([ROOT1]), matchesApp);
  assert.equal(out.items.length, 1, "另一个挂载根的扩展不该跟着一起消失，实际 " + String(out.items.length));
  assert.match(String(out.items[0]?.path), /DemoExt1/, "剩下的应是 ROOT0 那一项");
  assert.equal(out.gaps.length, 1, "应恰好一条缺口，实际 " + JSON.stringify(out.gaps));
  assert.equal(out.gaps[0]?.kind, "contextmenu");
  assert.equal(out.gaps[0]?.source, ROOT1, "缺口要精确到失败的那个挂载根");
});

test("单个 CLSID 解析失败：别的扩展照旧出结果，缺口记到那个 CLSID 而不是整类", async () => {
  const out = await scanContextMenu(app, stubReg([CLSID2 + BS + "InprocServer32", CLSID2]), matchesApp);
  assert.equal(out.items.length, 1, "坏一个 CLSID 不该让整类归零，实际 " + String(out.items.length));
  assert.match(String(out.items[0]?.path), /DemoExt1/, "健康那个仍要被认出来");
  assert.ok(
    out.gaps.some((g) => g.kind === "contextmenu" && /CLSID/i.test(g.source) && g.source.includes("22222222")),
    "缺口要指到坏掉的那个 CLSID，实际 " + JSON.stringify(out.gaps),
  );
});

test("scanResidue 端到端：CLSID 级缺口要透传进报告，而不是被阶段级兜底成整段", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ctx-gap-"));
  try {
    const report = await scanResidue(app, {
      reg: stubReg([CLSID2 + BS + "InprocServer32", CLSID2]),
      fs: { exists: async () => false, readDir: async () => [], readText: async () => null },
      env: {
        programData: ["C:", "ProgramData"].join(BS),
        appData: dir,
        commonStartMenu: ["C:", "StartMenu"].join(BS),
        userStartMenu: dir,
        temp: dir,
        systemRoot: ["C:", "Windows"].join(BS),
      },
    });
    const ctxGaps = (report.gaps ?? []).filter((g) => g.kind === "contextmenu");
    assert.ok(ctxGaps.length > 0, "报告里该有 contextmenu 的缺口");
    assert.ok(
      ctxGaps.every((g) => !g.source.startsWith("phase:")),
      "缺口被阶段级兜底成整段（粒度太粗，一个坏键会停用整个右键类）：" + JSON.stringify(ctxGaps.map((g) => g.source)),
    );
    assert.ok(
      ctxGaps.some((g) => /CLSID/i.test(g.source)),
      "应精确到 CLSID，实际 " + JSON.stringify(ctxGaps.map((g) => g.source)),
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
