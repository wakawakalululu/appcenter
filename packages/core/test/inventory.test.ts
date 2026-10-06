import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryRegClient,
  REG_KEY_SAMPLE,
  UNINSTALL_ROOTS,
  buildCleanupPlan,
  executeCleanup,
  isPathSafeToDelete,
  normPath,
  parseRegQuery,
  regKey,
  scanInstalledApps,
  scanResidue,
  toInstalledApp,
  type CleanupPolicy,
  type InstalledApp,
  type ScanEnv,
} from "@appcenter/core";

const BS = String.fromCharCode(92);
const UNINSTALL = UNINSTALL_ROOTS[0]?.path ?? "";
const APP_DIR = ["C:", "Program Files", "Sogou", "SogouExplorer"].join(BS);

const ENV: ScanEnv = {
  programData: ["C:", "ProgramData"].join(BS),
  appData: ["C:", "Users", "me", "AppData", "Roaming"].join(BS),
  commonStartMenu: ["C:", "StartMenu"].join(BS),
  userStartMenu: ["C:", "UserStart"].join(BS),
  temp: ["C:", "Temp"].join(BS),
  systemRoot: ["C:", "Windows"].join(String.fromCharCode(92)),};

function sampleApp(over: Partial<InstalledApp> = {}): InstalledApp {
  return {
    regDir: "SogouExplorer",
    registryPath: UNINSTALL + BS + "SogouExplorer",
    hive: "HKLM",
    scope: "machine-64",
    displayName: "搜狗高速浏览器",
    displayVersion: "13.9.6121.400",
    publisher: "北京搜狗科技发展有限公司",
    installLocation: APP_DIR,
    uninstallString: APP_DIR + BS + "uninst.exe",
    quietUninstallString: null,
    displayIcon: APP_DIR + BS + "app_sogou.ico",
    isMsi: false,
    estimatedSizeKb: 409600,
    installDate: "20260801",
    systemComponent: false,
    needsElevation: true,
    ...over,
  };
}

const probe = (existing: readonly string[]) => ({
  async exists(p: string): Promise<boolean> {
    return existing.map((e) => normPath(e)).includes(normPath(p));
  },
  async readDir(): Promise<string[]> {
    return [];
  },
  async readText(): Promise<string | null> {
    return null;
  },
});

test("reg.exe output parses into typed keys", () => {
  const keys = parseRegQuery(REG_KEY_SAMPLE);
  assert.equal(keys.length, 2);
  const app = toInstalledApp(keys[0] ?? keys[0]!, "machine-64", "HKLM");
  assert.equal(app?.displayVersion, "13.9.6121.400");
  assert.equal(app?.installLocation, APP_DIR);
  assert.equal(app?.displayName, "搜狗高速浏览器");
});

test("entries without DisplayName are skipped and system updates are flagged", async () => {
  const reg = new InMemoryRegClient([
    regKey(UNINSTALL + BS + "NoName", { DisplayVersion: "1.0" }),
    regKey(UNINSTALL + BS + "Update", { DisplayName: "Security Update for Windows", Publisher: "Microsoft" }),
    regKey(UNINSTALL + BS + "Wps", { DisplayName: "WPS Office", DisplayVersion: "12.1.0" }),
  ]);
  assert.equal((await scanInstalledApps(reg)).length, 1);
  assert.equal((await scanInstalledApps(reg, { includeSystemComponents: true })).length, 2);
});

test("the same product listed twice collapses into one row", async () => {
  const reg = new InMemoryRegClient([
    regKey(UNINSTALL + BS + "App", { DisplayName: "Demo", DisplayVersion: "1.0", InstallLocation: ["C:", "demo"].join(BS) }),
    regKey(UNINSTALL + BS + "App2", { DisplayName: "Demo", DisplayVersion: "1.0", InstallLocation: ["C:", "demo"].join(BS) }),
  ]);
  assert.equal((await scanInstalledApps(reg)).length, 1);
});

test("residue scan separates registry, service, startup and directory findings", async () => {
  const app = sampleApp();
  const reg = new InMemoryRegClient([
    regKey(app.registryPath, { DisplayName: app.displayName }),
    regKey(["HKLM", "SYSTEM", "CurrentControlSet", "Services", "SogouSvc"].join(BS), { ImagePath: APP_DIR + BS + "svc.exe" }),
    regKey(["HKCU", "Software", "Microsoft", "Windows", "CurrentVersion", "Run"].join(BS), {
      SogouExplorer: APP_DIR + BS + "SogouExplorer.exe",
    }),
    regKey(["HKLM", "SOFTWARE", "Sogou", "SogouExplorer"].join(BS), { Path: APP_DIR }),
  ]);
  const report = await scanResidue(app, { reg, fs: probe([APP_DIR]), env: ENV });
  const kinds = new Set(report.items.map((i) => i.kind));
  assert.ok(kinds.has("registry"));
  assert.ok(kinds.has("service"));
  assert.ok(kinds.has("startup"));
  assert.ok(kinds.has("directory"));
  assert.equal(new Set(report.items.map((i) => i.path + i.kind)).size, report.items.length);
  assert.ok(report.durationMs.registry >= 0);
  assert.ok(!Number.isNaN(Date.parse(report.scannedAt)));
});

test("cleanup plan refuses system paths, drive roots and unselected risks", async () => {
  const app = sampleApp();
  const report = await scanResidue(app, {
    reg: new InMemoryRegClient([regKey(app.registryPath, { DisplayName: app.displayName })]),
    fs: probe([["C:", "Windows", "Temp", "SogouExplorer"].join(BS)]),
    env: { ...ENV, temp: ["C:", "Windows", "Temp"].join(BS) },
  });
  const policy: CleanupPolicy = {
    includeRisks: ["low", "medium", "high"],
    allowWriteRoots: [APP_DIR],
    confirmToken: "CONFIRM",
  };
  const plan = buildCleanupPlan(report, policy);
  assert.ok(plan.skipped.length > 0);
  assert.ok(isPathSafeToDelete(APP_DIR, policy).ok);
  assert.equal(isPathSafeToDelete(["C:", "Windows", "System32"].join(BS), policy).ok, false);
  assert.equal(isPathSafeToDelete("C:" + BS, policy).ok, false);
  assert.equal(isPathSafeToDelete(APP_DIR, { ...policy, allowWriteRoots: [] }).ok, false);
});

test("cleanup stays dry-run by default and is blocked without the confirm token", async () => {
  const app = sampleApp();
  const report = await scanResidue(app, {
    reg: new InMemoryRegClient([regKey(app.registryPath, { DisplayName: app.displayName })]),
    fs: probe([APP_DIR]),
    env: ENV,
  });
  const deleted: string[] = [];
  const deps = {
    deleteRegistryKey: async (p: string) => void deleted.push(p),
    deleteRegistryValue: async (p: string, v: string) => void deleted.push(p + ":" + v),
    deletePath: async (p: string) => void deleted.push(p),
    exportRegistryKey: async (k: string, dir: string) => ({ keyPath: k, file: dir, sha256: "", ok: true, message: "fake export" }),
  };
  const policy: CleanupPolicy = { includeRisks: ["low"], allowWriteRoots: [APP_DIR], confirmToken: "CONFIRM" };
  assert.deepEqual((await executeCleanup(report, policy, deps)).applied, []);
  const blocked = await executeCleanup(report, { ...policy, confirmToken: "" }, deps, { dryRun: false });
  assert.equal(blocked.applied.length, 0);
  assert.match(blocked.blockedReason, /confirmation/);
  const applied = await executeCleanup(report, policy, deps, { dryRun: false });
  assert.ok(applied.applied.length > 0);
  assert.equal(deleted.length, applied.applied.length);
});
