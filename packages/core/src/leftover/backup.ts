import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface BackupRecord {
  keyPath: string;
  file: string;
  sha256: string;
  ok: boolean;
  message: string;
}

export interface BackupSet {
  dir: string;
  createdAt: string;
  records: BackupRecord[];
}

function runTool(program: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function safeFileName(keyPath: string): string {
  const hash = createHash("sha1").update(keyPath.toLowerCase()).digest("hex").slice(0, 10);
  return keyPath.replace(/[^0-9A-Za-z._-]+/g, "_").slice(-56) + "." + hash + ".reg";
}

/**
 * 删除注册表项之前必须先导出 .reg。
 * 导出失败的项一律不进入删除动作，宁可留下残留也不能留下无法恢复的状态。
 */
export async function exportRegistryKey(keyPath: string, dir: string): Promise<BackupRecord> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, safeFileName(keyPath));
  const result = await runTool("reg.exe", ["export", keyPath, file, "/y"]);
  if (result.code !== 0) {
    return { keyPath, file, sha256: "", ok: false, message: "reg export exit " + String(result.code) };
  }
  const content = await readFile(file).catch(() => null);
  if (!content || content.length === 0) return { keyPath, file, sha256: "", ok: false, message: "backup file empty" };
  return { keyPath, file, sha256: createHash("sha256").update(content).digest("hex"), ok: true, message: "exported" };
}

export async function createBackupSet(keyPaths: readonly string[], dir: string): Promise<BackupSet> {
  const records: BackupRecord[] = [];
  for (const keyPath of keyPaths) records.push(await exportRegistryKey(keyPath, dir));
  const set: BackupSet = { dir, createdAt: new Date().toISOString(), records };
  await writeFile(path.join(dir, "backup-manifest.json"), JSON.stringify(set, null, 2), "utf8");
  return set;
}

export async function writeBackupManifest(set: BackupSet): Promise<string> {
  await mkdir(set.dir, { recursive: true });
  const file = path.join(set.dir, "backup-manifest.json");
  await writeFile(file, JSON.stringify(set, null, 2), "utf8");
  return file;
}

export async function readBackupSet(dir: string): Promise<BackupSet | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, "backup-manifest.json"), "utf8")) as BackupSet;
  } catch {
    return null;
  }
}

/** 用备份把注册表项写回去，用于误删恢复与清理后的撤销。 */
export async function restoreBackup(record: BackupRecord): Promise<{ ok: boolean; message: string }> {
  const result = await runTool("reg.exe", ["import", record.file]);
  if (result.code !== 0) return { ok: false, message: "reg import exit " + String(result.code) };
  const content = await readFile(record.file).catch(() => null);
  if (!content) return { ok: false, message: "backup file missing" };
  if (record.sha256 && createHash("sha256").update(content).digest("hex") !== record.sha256) {
    return { ok: false, message: "backup checksum mismatch, refusing to import" };
  }
  return { ok: true, message: "restored " + record.keyPath };
}

export async function restoreBackupSet(set: BackupSet): Promise<{ restored: number; failed: string[] }> {
  let restored = 0;
  const failed: string[] = [];
  for (const record of set.records.filter((r) => r.ok)) {
    const outcome = await restoreBackup(record);
    if (outcome.ok) restored++;
    else failed.push(record.keyPath + ": " + outcome.message);
  }
  return { restored, failed };
}

/** 校验备份文件没被动过，导入前先跑一遍。 */
export async function verifyBackupIntegrity(record: BackupRecord): Promise<{ ok: boolean; message: string }> {
  const content = await readFile(record.file).catch(() => null);
  if (!content) return { ok: false, message: "backup file missing" };
  if (record.sha256 && createHash("sha256").update(content).digest("hex") !== record.sha256) {
    return { ok: false, message: "backup checksum mismatch" };
  }
  return { ok: true, message: "backup verified" };
}

/** 用注入的 importer 还原（生产走 reg.exe import），便于测试与批量撤销。 */
export async function restoreBackupSetWith(
  set: BackupSet,
  importFile: (file: string) => Promise<{ ok: boolean; message: string }>,
): Promise<{ restored: number; failed: string[] }> {
  let restored = 0;
  const failed: string[] = [];
  for (const record of set.records.filter((r) => r.ok)) {
    const check = await verifyBackupIntegrity(record);
    if (!check.ok) {
      failed.push(record.keyPath + ": " + check.message);
      continue;
    }
    const outcome = await importFile(record.file);
    if (outcome.ok) restored++;
    else failed.push(record.keyPath + ": " + outcome.message);
  }
  return { restored, failed };
}
