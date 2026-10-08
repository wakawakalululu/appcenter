import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  InMemoryRegClient,
  RegExeClient,
  UNINSTALL_ROOTS,
  buildCleanupPlan,
  executeCleanup,
  exportRegistryKey,
  readBackupSet,
  regDeleteKey,
  regDeleteValue,
  restoreBackupSet,
  scanResidue,
  toInstalledApp,
  type CleanupPolicy,
  type InstalledApp,
  type ScanEnv,
} from "../packages/core/src/index.ts";

const run = promisify(execFile);
const BS = String.fromCharCode(92);
const SEP = BS;

const KEY_ROOT = ["HKCU", "Software", "AppCenterSelfTest"].join(SEP);
const RUN_KEY = ["HKCU", "Software", "Microsoft", "Windows", "CurrentVersion", "Run"].join(SEP);
const UNINSTALL_KEY = (UNINSTALL_ROOTS[2]?.path ?? "") + SEP + "AppCenterSelfTest";
const PAYLOAD_PATH = ["C:", "appcenter-selftest", "app.exe"].join(SEP);

async function reg(args: string[]): Promise<number> {
  try {
    await run("reg.exe", args, { windowsHide: true });
    return 0;
  } catch (err) {
    const code = (err as { code?: number }).code;
    return typeof code === "number" ? code : -1;
  }
}

async function keyExists(keyPath: string): Promise<boolean> {
  return (await reg(["query", keyPath])) === 0;
}

async function readValue(keyPath: string, name: string): Promise<string | null> {
  try {
    const { stdout } = await run("reg.exe", ["query", keyPath, "/v", name], { windowsHide: true });
    const line = stdout.split(/\r?\n/).find((l) => l.trim().startsWith(name));
    return line ? line.split(/\s{2,}/).pop() ?? null : null;
  } catch {
    return null;
  }
}

const env: ScanEnv = {
  programData: ["C:", "ProgramData"].join(SEP),
  systemRoot: process.env.SystemRoot ?? ["C:", "Windows"].join(SEP),
  appData: path.join(tmpdir(), "selftest-appdata"),
  commonStartMenu: path.join(tmpdir(), "selftest-menu-common"),
  userStartMenu: path.join(tmpdir(), "selftest-menu-user"),
  temp: tmpdir(),
};

console.log("== setup: create synthetic residue under HKCU ==");
await reg(["add", KEY_ROOT, "/v", "Executable", "/t", "REG_SZ", "/d", PAYLOAD_PATH, "/f"]);
await reg(["add", UNINSTALL_KEY, "/v", "DisplayName", "/t", "REG_SZ", "/d", "AppCenter SelfTest", "/f"]);
await reg(["add", UNINSTALL_KEY, "/v", "InstallLocation", "/t", "REG_SZ", "/d", ["C:", "appcenter-selftest"].join(SEP), "/f"]);
await reg(["add", RUN_KEY, "/v", "AppCenterSelfTest", "/t", "REG_SZ", "/d", PAYLOAD_PATH, "/f"]);
console.log("   uninstall key present: " + String(await keyExists(UNINSTALL_KEY)));
console.log("   vendor key present:    " + String(await keyExists(KEY_ROOT)));

const app: InstalledApp | null = toInstalledApp(
  {
    path: UNINSTALL_KEY,
    values: [
      { name: "DisplayName", type: "REG_SZ", data: "AppCenter SelfTest" },
      { name: "InstallLocation", type: "REG_SZ", data: ["C:", "appcenter-selftest"].join(SEP) },
    ],
  },
  "user",
  "HKCU",
);
if (!app) throw new Error("fixture installed app could not be built");

console.log("== scan residue with the real reg.exe client ==");
const report = await scanResidue(app, { reg: new RegExeClient(), fs: { exists: async () => false, readDir: async () => [], readText: async () => null }, env });
const kinds = report.items.map((item) => item.kind + ":" + item.risk);
console.log("   residue: " + JSON.stringify(kinds));
console.log("   phases ms: " + JSON.stringify(report.durationMs));

const registryItems = report.items.filter((item) => item.kind === "registry" || item.kind === "startup");
if (registryItems.length === 0) throw new Error("expected residue on the synthetic keys");

console.log("== cleanup without backup dir must be blocked ==");
const policyBase: CleanupPolicy = {
  includeRisks: ["high", "medium", "low"],
  allowWriteRoots: [["C:", "appcenter-selftest"].join(SEP)],
  confirmToken: "CONFIRM",
};
const blocked = await executeCleanup(
  report,
  policyBase,
  { deleteRegistryKey: regDeleteKey, deleteRegistryValue: regDeleteValue, deletePath: async () => undefined, exportRegistryKey },
  { dryRun: false },
);
console.log("   blockedReason: " + (blocked.blockedReason || "(none)"));

console.log("== cleanup with backup, then restore from the .reg files ==");
const backupDir = await mkdtemp(path.join(tmpdir(), "selftest-backup-"));
const outcome = await executeCleanup(
  report,
  { ...policyBase, backupDir },
  { deleteRegistryKey: regDeleteKey, deleteRegistryValue: regDeleteValue, deletePath: async () => undefined, exportRegistryKey },
  { dryRun: false },
);
console.log("   applied: " + String(outcome.applied.length) + " failed: " + String(outcome.failed.length));
for (const backup of outcome.backups) {
  const info = await stat(backup.file).catch(() => null);
  console.log("   backup " + (info ? info.size + "B " : "MISSING ") + backup.keyPath);
}
console.log("   vendor key after delete:  " + String(await keyExists(KEY_ROOT)));
console.log("   run entry after delete:   " + String((await readValue(RUN_KEY, "AppCenterSelfTest")) !== null));

const set = await readBackupSet(backupDir);
const restored = set ? await restoreBackupSet(set) : { restored: 0, failed: ["no manifest"] };
console.log("   restored: " + String(restored.restored) + " failed: " + JSON.stringify(restored.failed));
console.log("   vendor key after restore: " + String(await keyExists(KEY_ROOT)));
console.log("   vendor value after restore: " + String(await readValue(KEY_ROOT, "Executable")));
console.log("   run entry after restore:  " + String(await readValue(RUN_KEY, "AppCenterSelfTest")));
console.log("   manifest entries: " + String((set?.records ?? []).length) + " sample bytes: " + String((await readFile((set?.records ?? [])[0]?.file ?? outcome.backups[0]?.file ?? "").catch(() => Buffer.alloc(0))).length));

console.log("== teardown: remove every key this script created ==");
await reg(["delete", KEY_ROOT, "/f"]);
await reg(["delete", UNINSTALL_KEY, "/f"]);
await reg(["delete", RUN_KEY, "/v", "AppCenterSelfTest", "/f"]);
console.log("   vendor key gone:  " + String(!(await keyExists(KEY_ROOT))));
console.log("   uninstall key gone: " + String(!(await keyExists(UNINSTALL_KEY))));
console.log("   run entry gone:   " + String((await readValue(RUN_KEY, "AppCenterSelfTest")) === null));
void InMemoryRegClient;
console.log("verify done");
