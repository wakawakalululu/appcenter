import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  InMemoryRegClient,
  RUN_ROOTS,
  SERVICES_ROOT,
  UNINSTALL_ROOTS,
  buildCleanupPlan,
  regKey,
  scanInstalledApps,
  scanResidue,
  type CleanupPolicy,
  type RegClient,
  type RegistryKey,
  type ResidueItem,
  type ResidueReport,
} from "@appcenter/core";

const BS = String.fromCharCode(92);
const join = (...parts: string[]): string => parts.join(BS);
const installDir = join("C:", "Program Files", "Demo App");

const policy: CleanupPolicy = {
  includeRisks: ["high", "medium", "low"],
  allowWriteRoots: [join("C:", "Program Files"), join("C:", "ProgramData")],
  confirmToken: "CONFIRM",
  backupDir: join("C:", "backup"),
};

function healthyReg(): InMemoryRegClient {
  const uninstallRoot = UNINSTALL_ROOTS[0]?.path ?? "";
  return new InMemoryRegClient([
    regKey(uninstallRoot + BS + "DemoApp", {
      DisplayName: "Demo App",
      DisplayVersion: "1.0.0",
      InstallLocation: installDir,
      UninstallString: installDir + BS + "unins000.exe",
      Publisher: "Demo",
    }),
    regKey(SERVICES_ROOT + BS + "DemoSvc", { ImagePath: installDir + BS + "demo-service.exe" }),
    // 启动项分放两个根：坏掉其中一个时，另一个的命中必须还在（隔离而不是整段丢）。
    regKey(RUN_ROOTS[0] ?? "", { DemoAppA: installDir + BS + "demo-a.exe" }),
    regKey(RUN_ROOTS[1] ?? "", { DemoAppB: installDir + BS + "demo-b.exe" }),
  ]);
}

/** 只让命中 failFragment 的那个根失败，模拟 HKCU 被策略禁用 / reg.exe 对该 hive 报错。 */
function flakyReg(failFragment: string): RegClient {
  const inner = healthyReg();
  return {
    async queryTree(rootPath: string): Promise<RegistryKey[]> {
      if (rootPath.includes(failFragment)) throw new Error("reg.exe exited with code 2 for " + rootPath);
      return inner.queryTree(rootPath);
    },
    queryChildren: (p: string) => inner.queryChildren(p),
    readKey: (p: string) => inner.readKey(p),
  };
}

async function depsFor(reg: RegClient): Promise<{ deps: Parameters<typeof scanResidue>[1]; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "residue-gap-"));
  return {
    dir,
    deps: {
      reg,
      fs: { exists: async () => false, readDir: async () => [], readText: async () => null },
      env: {
        programData: join("C:", "ProgramData"),
        appData: dir,
        commonStartMenu: join("C:", "StartMenu"),
        userStartMenu: dir,
        temp: dir,
        systemRoot: join("C:", "Windows"),
      },
    },
  };
}

async function scanWithFailure(failFragment: string): Promise<{ report: ResidueReport; cleanup: () => Promise<void> }> {
  const app = (await scanInstalledApps(healthyReg()))[0]!;
  const { deps, dir } = await depsFor(flakyReg(failFragment));
  const report = await scanResidue(app, deps);
  return { report, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

const startupItems = (report: ResidueReport): ResidueItem[] => report.items.filter((i) => i.kind === "startup");

test("单个启动项根读失败：整段不许抛，也别把另一个根的命中一起丢掉", async () => {
  const failingRoot = RUN_ROOTS[1] ?? "";
  const { report, cleanup } = await scanWithFailure("RunOnce");
  try {
    assert.ok(
      startupItems(report).some((i) => i.path.startsWith(RUN_ROOTS[0] ?? "")),
      "读成功的那个根的启动项被一起丢了（实际 " + JSON.stringify(startupItems(report).map((i) => i.path)) + "）",
    );
    assert.ok(!startupItems(report).some((i) => i.path.startsWith(failingRoot)), "失败根读不出东西，不该凭空冒出它的项");
  } finally {
    await cleanup();
  }
});

test("少扫了一段必须在报告上留下可见缺口（哪个类别、哪个源、为什么）", async () => {
  const { report, cleanup } = await scanWithFailure("RunOnce");
  try {
    const gaps = report.gaps ?? [];
    assert.ok(gaps.length > 0, "整段读失败却没有任何缺口记录 ⇒ 报告以「就这些残留」的完整外观喂给清理");
    const gap = gaps.find((g) => g.kind === "startup");
    assert.ok(gap, "缺口必须标在 startup 这一类上，实际 " + JSON.stringify(gaps));
    assert.ok(String(gap?.source).includes("RunOnce"), "缺口要指明是哪个源读失败，实际 " + String(gap?.source));
    assert.match(String(gap?.error), /reg\.exe|code 2/, "缺口要带上失败原因，实际 " + String(gap?.error));
  } finally {
    await cleanup();
  }
});

test("有缺口的报告不得进入清理计划：宁可让人重扫一次", async () => {
  const { report, cleanup } = await scanWithFailure("RunOnce");
  try {
    assert.ok(startupItems(report).length > 0, "前置条件：报告里得有项，否则拒绝与否都无意义");
    const plan = buildCleanupPlan(report, policy);
    assert.equal(plan.actions.length, 0, "扫描不完整的报告仍产出了 " + String(plan.actions.length) + " 个删除动作：" + JSON.stringify(plan.actions.map((a) => a.target)));
    assert.match(String(plan.skipped[0]?.reason), /不完整/, "拒绝理由要说明是扫描不完整，实际：" + String(plan.skipped[0]?.reason));
  } finally {
    await cleanup();
  }
});

test("对照：完整扫到的报告照旧出计划（别把拒绝做成无条件）", async () => {
  const app = (await scanInstalledApps(healthyReg()))[0]!;
  const { deps, dir } = await depsFor(healthyReg());
  try {
    const report = await scanResidue(app, deps);
    assert.equal((report.gaps ?? []).length, 0, "健康扫描不该带缺口，实际 " + JSON.stringify(report.gaps));
    const plan = buildCleanupPlan(report, policy);
    assert.ok(plan.actions.length > 0, "健康报告也该能出计划，否则拒绝逻辑做过头了");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
