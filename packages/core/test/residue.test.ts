import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readBackupSet, restoreBackupSetWith, verifyBackupIntegrity, writeBackupManifest } from "../src/leftover/backup.ts";
import {
  InMemoryRegClient,
  SingleInstanceLock,
  UNINSTALL_ROOTS,
  RUN_ROOTS,
  SERVICES_ROOT,
  regKey,
  scanInstalledApps,
  scanResidue,
  buildCleanupPlan,
  executeCleanup,
  type CleanupPolicy,
} from "@appcenter/core";

const BS = String.fromCharCode(92);

test("single instance lock is held by a live process and reclaimed when stale", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lock-"));
  const file = path.join(dir, "appcenter.lock");
  const lock = new SingleInstanceLock(file);
  const first = await lock.acquire();
  assert.equal(first.acquired, true);
  const second = await new SingleInstanceLock(file).acquire();
  assert.equal(second.acquired, false);
  assert.equal(second.holderPid, process.pid);

  await writeFile(file, JSON.stringify({ pid: 2_147_483_646, at: Date.now() }), "utf8");
  const stale = await new SingleInstanceLock(file).acquire();
  assert.equal(stale.acquired, true);
  await lock.release();
});

test("residue scan on a synthetic machine catches every leftover class and the plan classifies them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "residue-"));
  const installDir = ["C:", "Program Files", "Demo App"].join(BS);
  const uninstallRoot = UNINSTALL_ROOTS[0]?.path ?? "";
  const reg = new InMemoryRegClient([
    regKey(uninstallRoot + BS + "DemoApp", {
      DisplayName: "Demo App",
      DisplayVersion: "1.0.0",
      InstallLocation: installDir,
      UninstallString: installDir + BS + "unins000.exe",
      DisplayIcon: installDir + BS + "demo.ico",
      Publisher: "Demo",
    }),
    regKey(SERVICES_ROOT + BS + "DemoSvc", { ImagePath: installDir + BS + "demo-service.exe" }),
    regKey(RUN_ROOTS[0] ?? "", { DemoApp: installDir + BS + "demo.exe" }),
    regKey(["HKLM", "SOFTWARE", "Demo", "DemoApp"].join(BS), { Cache: installDir + BS + "cache" }),
  ]);
  const existing = new Set([installDir, ["C:", "ProgramData", "Demo App"].join(BS)].map((p) => p.toLowerCase()));
  const report = await scanResidue((await scanInstalledApps(reg))[0]!, {
    reg,
    fs: { exists: async (p: string) => existing.has(p.toLowerCase()), readDir: async () => [], readText: async () => null },
    env: {
      programData: ["C:", "ProgramData"].join(BS),
      appData: dir,
      commonStartMenu: ["C:", "StartMenu"].join(BS),
      userStartMenu: dir,
      temp: dir,
      systemRoot: ["C:", "Windows"].join(String.fromCharCode(92)),    },
  });

  const byKind = new Set(report.items.map((i) => i.kind));
  assert.ok(byKind.has("registry"));
  assert.ok(byKind.has("service"));
  assert.ok(byKind.has("startup"));
  assert.ok(byKind.has("directory"));
  assert.ok(report.items.filter((i) => i.kind === "registry").every((i) => i.risk === "medium"));
  assert.ok(report.items.filter((i) => i.kind === "service" || i.kind === "startup").every((i) => i.risk === "high"));

  const policy: CleanupPolicy = {
    includeRisks: ["medium", "low"],
    allowWriteRoots: [installDir, ["C:", "ProgramData"].join(BS)],
    confirmToken: "CONFIRM",
    backupDir: ["C:", "backup"].join(BS),
  };
  const plan = buildCleanupPlan(report, policy);
  assert.equal(plan.actions.every((a) => a.risk === "medium" || a.risk === "low"), true);
  assert.ok(plan.skipped.every((s) => s.reason.includes("not selected")));

  const touched: string[] = [];
  const exporter = async (k: string, dir: string) => ({ keyPath: k, file: dir + "/" + k + ".reg", sha256: "abc", ok: true, message: "fake export" });
  const outcome = await executeCleanup(
    report,
    { ...policy, includeRisks: ["high", "medium", "low"] },
    {
      deleteRegistryKey: async (p: string) => void touched.push("reg " + p),
      deleteRegistryValue: async (p: string, v: string) => void touched.push("reg " + p + ":" + v),
      deletePath: async (p: string) => void touched.push("path " + p),
      exportRegistryKey: exporter,
    },
    { dryRun: false },
  );
  assert.equal(outcome.dryRun, false);
  assert.equal(outcome.failed.length, 0);
  assert.equal(touched.length, outcome.applied.length);
  assert.ok(touched.some((t) => t.startsWith("reg ")));
  assert.ok(touched.some((t) => t.startsWith("path ")));
  assert.equal(outcome.backups.length, outcome.applied.filter((a) => a.effect !== "delete-path").length);
  assert.ok(outcome.manifestFile);

  // 没有备份目录就拒绝删注册表项；导出失败则单项跳过，绝不留下不可恢复的状态
  const noDir = await executeCleanup(
    report,
    { ...policy, includeRisks: ["high", "medium", "low"], backupDir: undefined },
    { deleteRegistryKey: async () => undefined, deleteRegistryValue: async () => undefined, deletePath: async () => undefined, exportRegistryKey: exporter },
    { dryRun: false },
  );
  assert.match(noDir.blockedReason, /backup directory required/);

  const brokenBackup = await executeCleanup(
    report,
    { ...policy, includeRisks: ["high", "medium", "low"] },
    {
      deleteRegistryKey: async () => undefined,
      deleteRegistryValue: async () => undefined,
      deletePath: async () => undefined,
      exportRegistryKey: async (keyPath: string) => ({ keyPath, file: "", sha256: "", ok: false, message: "export failed" }),
    },
    { dryRun: false },
  );
  assert.equal(brokenBackup.applied.some((a) => a.effect === "delete-registry-key"), false);
  assert.ok(brokenBackup.failed.every((f) => f.message.includes("backup failed")));
});

test("backup manifests round-trip and a tampered .reg refuses to import", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "backup-"));
  const record = { keyPath: "HKCU\Software\Demo", file: path.join(dir, "demo.reg"), sha256: "", ok: true, message: "exported" };
  const payload = Buffer.from("Windows Registry Editor Version 5.00");
  await writeFile(record.file, payload);
  const { createHash } = await import("node:crypto");
  record.sha256 = createHash("sha256").update(payload).digest("hex");

  await writeBackupManifest({ dir, createdAt: new Date().toISOString(), records: [record] });
  const set = await readBackupSet(dir);
  assert.equal(set?.records.length, 1);
  assert.equal(set?.records[0]?.keyPath, "HKCU\Software\Demo");

  let imported: string | null = null;
  const restored = await restoreBackupSetWith(set!, async (file: string) => {
    imported = file;
    return { ok: true, message: "restored" };
  });
  assert.equal(restored.restored, 1);
  assert.equal(imported, record.file);

  await writeFile(record.file, "tampered");
  const check = await verifyBackupIntegrity(set!.records[0]);
  assert.equal(check.ok, false);
  assert.match(check.message, /checksum/);
});

test("context menu handlers still pointing at the app are reported as value-level residue", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ctx-"));
  const clsid = "{6B2C1D4E-1111-2222-3333-444455556666}";
  const handlerRoot = ["HKCR", "*", "shellex", "ContextMenuHandlers"].join(BS);
  const reg = new InMemoryRegClient([
    regKey(handlerRoot + BS + "DemoShell", { "(Default)": clsid }),
    regKey(["HKCR", "CLSID", clsid].join(BS), { "(Default)": "Demo Shell Extension" }),
    regKey(["HKCR", "CLSID", clsid, "InprocServer32"].join(BS), { "(Default)": installDirOf("DemoShell") + BS + "shell.dll" }),
  ]);
  const app = (await scanInstalledApps(new InMemoryRegClient([
    regKey((UNINSTALL_ROOTS[0]?.path ?? "") + BS + "DemoShell", {
      DisplayName: "Demo Shell",
      DisplayVersion: "1.0.0",
      InstallLocation: installDirOf("DemoShell"),
      UninstallString: installDirOf("DemoShell") + BS + "unins000.exe",
    }),
  ])))![0]!;
  const report = await scanResidue(app, {
    reg,
    fs: { exists: async () => false, readDir: async () => [], readText: async () => null },
    env: { programData: dir, appData: dir, commonStartMenu: dir, userStartMenu: dir, temp: dir, systemRoot: dir },
  });
  const hit = report.items.find((item) => item.kind === "contextmenu");
  assert.ok(hit, "expected a context menu residue item");
  assert.equal(hit?.path, handlerRoot + BS + "DemoShell");
  assert.equal(hit?.valueName, undefined);
  assert.equal(report.counts.contextmenu, 1);

  const plan = buildCleanupPlan(report, { includeRisks: ["medium"], allowWriteRoots: [dir], confirmToken: "CONFIRM" });
  const action = plan.actions.find((a) => a.target.includes("DemoShell"));
  assert.equal(action?.effect, "delete-registry-key");
});

function installDirOf(name: string): string {
  return ["C:", "Program Files", name].join(BS);
}

/** 包裹一层计数，用来证明「同一 CLSID 只解析一次」。 */
class CountingRegClient {
  readonly queried: string[] = [];
  constructor(private readonly inner: import("@appcenter/core").RegClient) {}
  async queryTree(rootPath: string): Promise<import("@appcenter/core").RegistryKey[]> {
    this.queried.push(rootPath);
    return this.inner.queryTree(rootPath);
  }
  async queryChildren(rootPath: string): Promise<string[]> {
    this.queried.push(rootPath);
    return this.inner.queryChildren(rootPath);
  }
  async readKey(p: string): Promise<import("@appcenter/core").RegistryKey | null> {
    this.queried.push(p);
    return this.inner.readKey(p);
  }
}

test("the same CLSID mounted on several handlers is resolved only once", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ctx-memo-"));
  const clsid = "{6B2C1D4E-AAAA-BBBB-CCCC-DDDDEEEEFFFF}";
  const clsidPath = ["HKCR", "CLSID", clsid].join(BS);
  const mounted = ["*", "Directory", "Folder"];
  const reg = new InMemoryRegClient([
    ...mounted.map((entry) =>
      regKey(["HKCR", entry, "shellex", "ContextMenuHandlers", "DemoShell"].join(BS), { "(Default)": clsid }),
    ),
    regKey(clsidPath, { "(Default)": "Demo Shell Extension" }),
    regKey(clsidPath + BS + "InprocServer32", { "(Default)": installDirOf("DemoShell") + BS + "shell.dll" }),
  ]);
  const app = (await scanInstalledApps(new InMemoryRegClient([
    regKey((UNINSTALL_ROOTS[0]?.path ?? "") + BS + "DemoShell", {
      DisplayName: "Demo Shell",
      DisplayVersion: "1.0.0",
      InstallLocation: installDirOf("DemoShell"),
      UninstallString: installDirOf("DemoShell") + BS + "unins000.exe",
    }),
  ])))![0]!;

  const counting = new CountingRegClient(reg);
  const report = await scanResidue(app, {
    reg: counting,
    fs: { exists: async () => false, readDir: async () => [], readText: async () => null },
    env: { programData: dir, appData: dir, commonStartMenu: dir, userStartMenu: dir, temp: dir, systemRoot: dir },
  });

  // 结果不变：三个挂载点各报一条。
  assert.equal(report.counts.contextmenu, mounted.length, "三个挂载点都应被报出");
  // 收益：CLSID 只解析一次，而不是每个挂载点一次。
  const clsidQueries = counting.queried.filter((p) => p.toLowerCase().startsWith(clsidPath.toLowerCase()));
  assert.equal(clsidQueries.length, 1, "同一 CLSID 只应解析一次，实际 " + String(clsidQueries.length) + " 次");
});
