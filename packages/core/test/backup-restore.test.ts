import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { restoreBackup, restoreBackupSetWith, verifyBackupIntegrity, type BackupRecord, type BackupSet } from "@appcenter/core";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * 这些用例一律注入假 importer，因此永远不会真的调用 reg.exe。
 * 而未修改版本会忽略第二个入参直接 `reg import`——所以这里写进文件的内容是**故意无效**的伪 .reg
 * （`not a registry file`），即便被拿去 import 也只会非零退出，不会改动本机注册表。
 */
async function sandbox(content = "not a registry file"): Promise<{ file: string; record: BackupRecord }> {
  const dir = await mkdtemp(path.join(tmpdir(), "backup-restore-"));
  const file = path.join(dir, "key.reg");
  await writeFile(file, content, "utf8");
  return { file, record: { keyPath: "HKLM\\SOFTWARE\\DemoApp", file, sha256: sha(content), ok: true, message: "exported" } };
}

test("回归：摘要不符时必须在 import 之前就拒绝，而不是导进去再说拒绝", async () => {
  const { record } = await sandbox("original backup bytes");
  const tampered = { ...record, sha256: sha("something else entirely") };

  const attempted: string[] = [];
  const outcome = await restoreBackup(tampered, async (file) => {
    attempted.push(file);
    return { ok: true, message: "imported" };
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /mismatch.*refusing to import/i);
  assert.deepEqual(attempted, [], "校验不通过就绝不能调用 importer");
});

test("备份文件缺失时同样不落 importer", async () => {
  const missing: BackupRecord = {
    keyPath: "HKLM\\SOFTWARE\\DemoApp",
    file: path.join(tmpdir(), "definitely-missing-" + Date.now() + ".reg"),
    sha256: sha("x"),
    ok: true,
    message: "exported",
  };
  const attempted: string[] = [];
  const outcome = await restoreBackup(missing, async (file) => {
    attempted.push(file);
    return { ok: true, message: "imported" };
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /backup file missing/);
  assert.deepEqual(attempted, []);
});

test("摘要一致才真正还原，并回报 restored 键名", async () => {
  const { file, record } = await sandbox("original backup bytes");
  const attempted: string[] = [];
  const outcome = await restoreBackup(record, async (target) => {
    attempted.push(target);
    return { ok: true, message: "imported" };
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.message, "restored " + record.keyPath);
  assert.deepEqual(attempted, [file]);
});

test("restoreBackupSetWith 与 verifyBackupIntegrity 的既有顺序保持不变", async () => {
  const { record } = await sandbox("original backup bytes");
  assert.equal((await verifyBackupIntegrity(record)).ok, true);
  const bad = { ...record, sha256: sha("tampered") };
  const set: BackupSet = { dir: path.dirname(record.file), createdAt: new Date().toISOString(), records: [record, bad] };
  const called: string[] = [];
  const result = await restoreBackupSetWith(set, async (f) => {
    called.push(f);
    return { ok: true, message: "imported" };
  });
  assert.equal(result.restored, 1, "只有校验通过的记录才该被导入");
  assert.deepEqual(called, [record.file]);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0] ?? "", /checksum mismatch/);
});
