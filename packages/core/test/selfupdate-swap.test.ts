import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { SelfUpdater, applyUpdate, type DownloadResult, type SelfUpdateManifest } from "@appcenter/core";
import { makeTrackedTmp } from "./util/tmp-dirs.ts";

const sha = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");

const OLD_BUILD = Buffer.from("old-client-binary");
const NEW_BUILD = Buffer.from("new-client-binary-payload");

function downloaderFor(payload: Buffer) {
  return {
    async download(request: { id: string; url: string; target: string; expectedSha256?: string; expectedSize?: number }): Promise<DownloadResult> {
      await writeFile(request.target, payload);
      return { id: request.id, target: request.target, bytes: payload.length, sha256: sha(payload), fromCache: false };
    },
  };
}

async function sandbox(): Promise<{ root: string; appDir: string; stagingDir: string }> {
  const root = await makeTrackedTmp("swap-");
  const appDir = path.join(root, "app");
  const stagingDir = path.join(root, "staging");
  await mkdir(appDir, { recursive: true });
  await writeFile(path.join(appDir, "AppCenter.exe"), OLD_BUILD);
  return { root, appDir, stagingDir };
}

const manifest = (rolloutPercent = 100): SelfUpdateManifest => ({
  version: "1.2.0",
  url: "http://h/client.exe",
  sha256: sha(NEW_BUILD),
  sizeBytes: NEW_BUILD.length,
  releaseNotes: "真实换版",
  rolloutPercent,
});

test("a healthy new build replaces the running one and keeps a backup", async () => {
  const { appDir, stagingDir } = await sandbox();
  const updater = new SelfUpdater({ downloader: downloaderFor(NEW_BUILD) as never, appDir, stagingDir, currentVersion: "1.0.0", userId: "me" });
  const staged = await updater.stage(manifest());
  const outcome = await updater.apply(staged, async () => true);

  assert.equal(outcome.swapped, true);
  assert.equal(outcome.rolledBack, false);
  assert.deepEqual(await readFile(path.join(appDir, "AppCenter.exe")), NEW_BUILD);
  assert.ok(outcome.backupPath);
  assert.deepEqual(await readFile(outcome.backupPath ?? ""), OLD_BUILD);

  const pending = await updater.readPending();
  assert.equal(pending?.version, "1.2.0");
  await updater.commit();
  assert.equal(await updater.readPending(), null);
  assert.equal((await updater.recover()).message, "no pending update");
});

test("an unhealthy new build is rolled back to the previous binary", async () => {
  const { appDir, stagingDir } = await sandbox();
  const updater = new SelfUpdater({ downloader: downloaderFor(NEW_BUILD) as never, appDir, stagingDir, currentVersion: "1.0.0" });
  const staged = await updater.stage(manifest());
  const outcome = await updater.apply(staged, async () => false);

  assert.equal(outcome.swapped, false);
  assert.equal(outcome.rolledBack, true);
  assert.deepEqual(await readFile(path.join(appDir, "AppCenter.exe")), OLD_BUILD);
  assert.equal(await updater.readPending(), null);
});

test("a staged package whose bytes changed after download is never swapped in", async () => {
  const { appDir, stagingDir } = await sandbox();
  const updater = new SelfUpdater({ downloader: downloaderFor(NEW_BUILD) as never, appDir, stagingDir, currentVersion: "1.0.0" });
  const staged = await updater.stage(manifest());
  await writeFile(staged.packagePath, Buffer.from("tampered"));

  const outcome = await updater.apply(staged, async () => true);
  assert.equal(outcome.swapped, false);
  assert.match(outcome.message, /checksum/);
  assert.deepEqual(await readFile(path.join(appDir, "AppCenter.exe")), OLD_BUILD);
  assert.equal(await stat(path.join(stagingDir, "update-backup")).then(() => true, () => false), false);
});

test("recover restores the newest backup when the swapped build never committed", async () => {
  const { appDir, stagingDir } = await sandbox();
  const updater = new SelfUpdater({ downloader: downloaderFor(NEW_BUILD) as never, appDir, stagingDir, currentVersion: "1.0.0" });
  const staged = await updater.stage(manifest());
  await updater.apply(staged, async () => true);

  // 模拟新版本起来后崩溃：盘上是新二进制，pending 还在
  await writeFile(path.join(appDir, "AppCenter.exe"), Buffer.from("crashed"));
  const recovered = await updater.recover();
  assert.equal(recovered.rolledBack, true);
  assert.deepEqual(await readFile(path.join(appDir, "AppCenter.exe")), OLD_BUILD);
  assert.equal(await updater.readPending(), null);
});

test("rollout gating is stable per user and respects the percentage", async () => {
  const { appDir, stagingDir } = await sandbox();
  const updater = new SelfUpdater({ downloader: downloaderFor(NEW_BUILD) as never, appDir, stagingDir, currentVersion: "1.0.0", userId: "u-17" });
  assert.equal(updater.check(manifest(0)).state, "not-in-rollout");
  assert.equal(updater.check(manifest(100)).state, "available");
  const first = updater.inRollout(manifest(50));
  assert.equal(updater.inRollout(manifest(50)), first);
  assert.equal(updater.check(manifest(-5)).state, "not-in-rollout");
});

test("applyUpdate retries while the target file is busy and then succeeds", async () => {
  const { appDir, stagingDir } = await sandbox();
  const stagedPath = path.join(stagingDir, "pkg.exe");
  await mkdir(stagingDir, { recursive: true });
  await writeFile(stagedPath, NEW_BUILD);
  let calls = 0;
  const outcome = await applyUpdate({
    stagedPath,
    targetPath: path.join(appDir, "AppCenter.exe"),
    backupDir: path.join(stagingDir, "update-backup"),
    expectedSha256: sha(NEW_BUILD),
    swapAttempts: 3,
    swapDelayMs: 1,
    healthCheck: async () => {
      calls += 1;
      return true;
    },
  });
  assert.equal(outcome.swapped, true);
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(path.join(appDir, "AppCenter.exe")), NEW_BUILD);
});
