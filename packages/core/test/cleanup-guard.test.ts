import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCleanupPlan,
  executeCleanup,
  isRegistryTargetSafe,
  isSystemOwnedPath,
  type CleanupPolicy,
  type ResidueItem,
  type ResidueReport,
} from "@appcenter/core";

const BS = String.fromCharCode(92);
const KINDS = ["registry", "service", "startup", "task", "menu", "shortcut", "directory", "userdata", "contextmenu"] as const;

const join = (...parts: string[]): string => parts.join(BS);

function report(items: ResidueItem[]): ResidueReport {
  return {
    app: "演示应用",
    regDir: "DemoApp",
    scannedAt: new Date(0).toISOString(),
    durationMs: Object.fromEntries(KINDS.map((kind) => [kind, 0])) as ResidueReport["durationMs"],
    counts: Object.fromEntries(KINDS.map((kind) => [kind, items.filter((i) => i.kind === kind).length])) as ResidueReport["counts"],
    items,
  };
}

function item(kind: ResidueItem["kind"], path: string, extra: Partial<ResidueItem> = {}): ResidueItem {
  return { kind, risk: "medium", path, detail: kind + " residue", reason: "test-provided", ...extra };
}

const policy: CleanupPolicy = {
  includeRisks: ["high", "medium", "low"],
  allowWriteRoots: [join("C:", "Program Files"), join("C:", "ProgramData")],
  confirmToken: "CONFIRM",
  backupDir: join("C:", "backup"),
};

const planned = (items: ResidueItem[]): string[] => buildCleanupPlan(report(items), policy).actions.map((a) => a.target);
const skippedReason = (items: ResidueItem[]): string => {
  const plan = buildCleanupPlan(report(items), policy);
  assert.equal(plan.actions.length, 0, "不该产出的动作竟然产出了: " + JSON.stringify(plan.actions.map((a) => a.target)));
  return plan.skipped[0]?.reason ?? "(未被跳过)";
};

test("回归：伪造报告里的关键系统键不得进入清理计划", () => {
  const reason = skippedReason([item("service", join("HKLM", "SYSTEM", "CurrentControlSet", "Services", "Tcpip"))]);
  assert.match(reason, /protected/i, "删掉 Tcpip 服务键等于毁掉整机网络栈");

  assert.match(skippedReason([item("registry", join("HKLM", "SOFTWARE", "Microsoft", "Windows NT", "CurrentVersion"))]), /outside|protected/i);
  assert.match(skippedReason([item("registry", join("HKLM", "SAM"))]), /protected/i);
  assert.match(skippedReason([item("registry", join("HKU", "S-1-5-18", "Desktop"))]), /outside/i);
});

test("真实残留仍然正常产出动作，收口没有把功能一起挡死", () => {
  const targets = planned([
    item("service", join("HKLM", "SYSTEM", "CurrentControlSet", "Services", "DemoSvc")),
    item("registry", join("HKLM", "SOFTWARE", "Microsoft", "Windows", "CurrentVersion", "Uninstall", "DemoApp")),
    item("registry", join("HKLM", "SOFTWARE", "DemoVendor", "Config")),
    item("contextmenu", join("HKCR", "*", "shellex", "ContextMenuHandlers", "DemoHandler")),
    item("startup", join("HKCU", "Software", "Microsoft", "Windows", "CurrentVersion", "Run", "DemoApp"), {
      keyPath: join("HKCU", "Software", "Microsoft", "Windows", "CurrentVersion", "Run"),
      valueName: "DemoApp",
    }),
  ]);
  assert.equal(targets.length, 5, "五个合法目标都应保留，实际: " + JSON.stringify(targets));
});

test("作用域根与更深的子键都不能整棵删", () => {
  // Uninstall 根自身：不是「某个卸载项」，而是所有应用。
  assert.match(skippedReason([item("registry", join("HKLM", "SOFTWARE", "Microsoft", "Windows", "CurrentVersion", "Uninstall"))]), /scope root|outside/i);
  // 卸载树里再深一层也不是扫描器会产出的目标。
  assert.match(
    skippedReason([item("registry", join("HKLM", "SOFTWARE", "Microsoft", "Windows", "CurrentVersion", "Uninstall", "DemoApp", "InstallProperties"))]),
    /single uninstall entry/i,
  );
  // Services 根的孙键：扫描器只会产出直接子键。
  assert.match(skippedReason([item("service", join("HKLM", "SYSTEM", "CurrentControlSet", "Services", "DemoSvc", "Parameters"))]), /direct child|scope root/i);
  // 整棵 CLSID。
  assert.match(skippedReason([item("contextmenu", join("HKCR", "CLSID"))]), /CLSID|scope root/i);
  // 整棵 Run 键（删值可以，删键不行）。
  assert.match(skippedReason([item("startup", join("HKCU", "Software", "Microsoft", "Windows", "CurrentVersion", "Run"))]), /run key|scope root/i);
  // 删 Run 键上的一个值是合法操作，必须仍然放行。
  assert.deepEqual(
    planned([
      item("startup", join("HKCU", "Software", "Microsoft", "Windows", "CurrentVersion", "Run", "DemoApp"), {
        keyPath: join("HKCU", "Software", "Microsoft", "Windows", "CurrentVersion", "Run"),
        valueName: "DemoApp",
      }),
    ]).length,
    1,
  );
});

test("值级删除必须带值名，且值名不能长得像 reg.exe 开关", () => {
  const runKey = join("HKCU", "Software", "Microsoft", "Windows", "CurrentVersion", "Run");
  assert.match(
    skippedReason([item("startup", runKey + BS + "DemoApp", { keyPath: runKey, valueName: "/f" })]),
    /switch/i,
  );
});

test("收口真的传到执行器：受保护键的删除回调一次都不会被调用", async () => {
  const touched: string[] = [];
  const outcome = await executeCleanup(
    report([
      item("service", join("HKLM", "SYSTEM", "CurrentControlSet", "Services", "Tcpip")),
      item("service", join("HKLM", "SYSTEM", "CurrentControlSet", "Services", "DemoSvc")),
    ]),
    policy,
    {
      deleteRegistryKey: async (p: string) => void touched.push(p),
      deleteRegistryValue: async (p: string, v: string) => void touched.push(p + ":" + v),
      deletePath: async (p: string) => void touched.push(p),
      exportRegistryKey: async (keyPath: string, dir: string) => ({
        keyPath,
        file: dir + "/" + keyPath + ".reg",
        sha256: "abc",
        ok: true,
        message: "fake export",
      }),
    },
    { dryRun: false },
  );
  assert.deepEqual(touched, [join("HKLM", "SYSTEM", "CurrentControlSet", "Services", "DemoSvc")]);
  assert.equal(outcome.applied.length, 1);
  assert.equal(outcome.failed.length, 0, "被收口挡下的项应算 skipped，不该混进 failed");
});

test("系统目录判断不再依赖硬编码 C: 盘", () => {
  assert.equal(isSystemOwnedPath("d:" + BS + "windows" + BS + "system32"), true);
  assert.equal(isSystemOwnedPath("e:" + BS + "programdata" + BS + "microsoft" + BS + "demo"), true);
  assert.equal(isSystemOwnedPath("c:" + BS + "program files" + BS + "demo"), false);
  assert.equal(isSystemOwnedPath("c:" + BS + "programdata" + BS + "demoapp"), false, "ProgramData 下的应用目录不能被误判成系统目录");
});

test("纯函数判据可直接调用（供 UI 侧提前拒绝）", () => {
  assert.equal(isRegistryTargetSafe(join("HKLM", "SYSTEM", "CurrentControlSet", "Services", "Winmgmt"), "service", "delete-registry-key").ok, false);
  assert.equal(isRegistryTargetSafe(join("HKLM", "SYSTEM", "CurrentControlSet", "Services", "DemoSvc"), "service", "delete-registry-key").ok, true);
  assert.equal(isRegistryTargetSafe(join("HKCR", "CLSID", "{00000000-0000-0000-0000-000000000000}"), "contextmenu", "delete-registry-key").ok, true);
});
