import { test } from "node:test";
import assert from "node:assert/strict";
import { executeCleanup, type CleanupDeps, type CleanupPolicy, type ResidueItem, type ResidueReport } from "@appcenter/core";

const BS = String.fromCharCode(92);
const KINDS = ["registry", "service", "startup", "task", "menu", "shortcut", "directory", "userdata", "contextmenu"] as const;

function report(items: ResidueItem[]): ResidueReport {
  return {
    app: "演示应用",
    regDir: "DemoApp",
    scannedAt: new Date(0).toISOString(),
    durationMs: Object.fromEntries(KINDS.map((k) => [k, 0])) as ResidueReport["durationMs"],
    counts: Object.fromEntries(KINDS.map((k) => [k, items.filter((i) => i.kind === k).length])) as ResidueReport["counts"],
    items,
  };
}

const dirItem = (path: string): ResidueItem => ({ kind: "directory", risk: "low", path, detail: "安装目录残留", reason: "leftover-directory" });

const policy = (extra: Partial<CleanupPolicy> = {}): CleanupPolicy => ({
  includeRisks: ["low", "medium", "high"],
  allowWriteRoots: ["C:" + BS + "Program Files", "C:" + BS + "ProgramData"],
  confirmToken: "CONFIRM",
  backupDir: "C:" + BS + "backup",
  ...extra,
});

function deps(spy: { deleted: string[]; moved: [string, string][] }, opts: { failMove?: boolean } = {}): CleanupDeps {
  return {
    deleteRegistryKey: async () => undefined,
    deleteRegistryValue: async () => undefined,
    deletePath: async (p: string) => void spy.deleted.push(p),
    exportRegistryKey: async (keyPath: string, dir: string) => ({ keyPath, file: dir + "/" + keyPath + ".reg", sha256: "abc", ok: true, message: "fake" }),
    movePath: async (from: string, to: string) => {
      if (opts.failMove) throw new Error("access denied");
      spy.moved.push([from, to]);
    },
  };
}

test("给了 recycleDir 就移动而非删除：递归删除不再是不可逆操作", async () => {
  const spy = { deleted: [] as string[], moved: [] as [string, string][] };
  const outcome = await executeCleanup(
    report([dirItem("C:" + BS + "Program Files" + BS + "DemoApp")]),
    policy({ recycleDir: "C:" + BS + "ProgramData" + BS + "appcenter-recycle" }),
    deps(spy),
    { dryRun: false },
  );
  assert.deepEqual(spy.deleted, [], "有回收目录时不该做任何不可逆删除");
  assert.equal(spy.moved.length, 1);
  assert.equal(spy.moved[0]?.[0], "C:" + BS + "Program Files" + BS + "DemoApp");
  assert.match(spy.moved[0]?.[1] ?? "", /appcenter-recycle/, "落点必须在回收目录内");
  assert.equal(outcome.applied.length, 1);
  assert.equal(outcome.failed.length, 0);
});

test("没给 recycleDir 时保持原行为（可逆化是可选的，不强加给调用方）", async () => {
  const spy = { deleted: [] as string[], moved: [] as [string, string][] };
  const outcome = await executeCleanup(report([dirItem("C:" + BS + "ProgramData" + BS + "DemoApp")]), policy(), deps(spy), { dryRun: false });
  assert.deepEqual(spy.deleted, ["C:" + BS + "ProgramData" + BS + "DemoApp"]);
  assert.equal(spy.moved.length, 0);
  assert.equal(outcome.applied.length, 1);
});

test("移动失败算 failed，不谎报已清理", async () => {
  const spy = { deleted: [] as string[], moved: [] as [string, string][] };
  const outcome = await executeCleanup(report([dirItem("C:" + BS + "Program Files" + BS + "DemoApp")]), policy({ recycleDir: "C:" + BS + "recycle" }), deps(spy, { failMove: true }), { dryRun: false });
  assert.equal(outcome.applied.length, 0);
  assert.equal(outcome.failed.length, 1);
  assert.match(outcome.failed[0]?.message ?? "", /access denied/);
  assert.deepEqual(spy.deleted, [], "移动失败也不能回退成不可逆删除");
});

test("dryRun 下既不删除也不移动", async () => {
  const spy = { deleted: [] as string[], moved: [] as [string, string][] };
  const outcome = await executeCleanup(report([dirItem("C:" + BS + "Program Files" + BS + "DemoApp")]), policy({ recycleDir: "C:" + BS + "recycle" }), deps(spy), { dryRun: true });
  assert.equal(outcome.dryRun, true);
  assert.deepEqual(spy.deleted, []);
  assert.deepEqual(spy.moved, []);
  assert.equal(outcome.planned.length, 1);
});
