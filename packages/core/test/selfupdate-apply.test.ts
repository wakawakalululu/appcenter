import { test } from "node:test";
import { makeTrackedTmp } from "./util/tmp-dirs.ts";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { SelfUpdater, type DownloadResult, type SelfUpdateManifest, type StagedUpdate } from "@appcenter/core";

const sha = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");
const OLD_BUILD = Buffer.from("old-client-binary");
const NEW_BUILD = Buffer.from("new-client-binary-payload");
const EVIL_BUILD = Buffer.from("attorney-supplied-arbitrary-file");

function downloaderFor(payload: Buffer) {
  return {
    async download(request: { id: string; url: string; target: string }): Promise<DownloadResult> {
      await writeFile(request.target, payload);
      return { id: request.id, target: request.target, bytes: payload.length, sha256: sha(payload), fromCache: false };
    },
  };
}

async function sandbox(): Promise<{ appDir: string; stagingDir: string; exe: string; backupDir: string }> {
  const root = await makeTrackedTmp("selfupd-");
  const appDir = path.join(root, "app");
  const stagingDir = path.join(root, "staging");
  await mkdir(appDir, { recursive: true });
  const exe = path.join(appDir, "AppCenter.exe");
  await writeFile(exe, OLD_BUILD);
  return { appDir, stagingDir, exe, backupDir: path.join(stagingDir, "update-backup") };
}

const manifest = (payload: Buffer): SelfUpdateManifest => ({
  version: "1.2.0",
  url: "http://h/client.exe",
  sha256: sha(payload),
  sizeBytes: payload.length,
  releaseNotes: "真实换版",
});

const updaterIn = (dir: { appDir: string; stagingDir: string }, payload: Buffer): SelfUpdater =>
  new SelfUpdater({ downloader: downloaderFor(payload) as never, appDir: dir.appDir, stagingDir: dir.stagingDir, currentVersion: "1.0.0", userId: "me" });

test("回归：apply 必须核对磁盘上的 pending 标记，不能让调用方指定任意文件覆盖主程序", async () => {
  const dir = await sandbox();
  const updater = updaterIn(dir, NEW_BUILD);
  await updater.stage(manifest(NEW_BUILD));

  // 攻击面：RPC/调用方直接递来一个「自洽」的 StagedUpdate（路径与 sha 都指向别的文件）。
  // 旧实现全盘接受——packagePath 与 sha256 都取自入参，校验自然通过，于是任意文件换入主程序。
  const evilPath = path.join(dir.stagingDir, "evil.exe");
  await mkdir(dir.stagingDir, { recursive: true });
  await writeFile(evilPath, EVIL_BUILD);
  const forged: StagedUpdate = { version: "1.2.0", packagePath: evilPath, stagedAt: new Date().toISOString(), sha256: sha(EVIL_BUILD) };

  const outcome = await updater.apply(forged, async () => true);
  assert.equal(outcome.swapped, false, "与 pending 标记不符的入参不得换版");
  assert.match(outcome.message, /does not match the pending marker/);
  assert.deepEqual(await readFile(dir.exe), OLD_BUILD, "主程序必须原样保留");
});

test("回归：没有 pending 标记时 apply 直接拒绝", async () => {
  const dir = await sandbox();
  const updater = updaterIn(dir, NEW_BUILD);
  const staged: StagedUpdate = {
    version: "9.9.9",
    packagePath: path.join(dir.stagingDir, "ghost.exe"),
    stagedAt: new Date().toISOString(),
    sha256: sha(NEW_BUILD),
  };
  const outcome = await updater.apply(staged, async () => true);
  assert.equal(outcome.swapped, false);
  assert.match(outcome.message, /no pending update marker/);
});

test("回归：只 stage 过、从未 apply 时，recover 不得拿旧备份覆盖在用程序", async () => {
  const dir = await sandbox();
  const updater = updaterIn(dir, NEW_BUILD);
  await updater.stage(manifest(NEW_BUILD));

  // 上一次成功升级留下的备份：旧实现把「pending 还在 + 没 commit」当成回滚信号，
  // 于是这份从未被换掉的在用程序被降级成备份里的内容。
  await mkdir(dir.backupDir, { recursive: true });
  await writeFile(path.join(dir.backupDir, "AppCenter.2026-01-01T00-00-00-000Z.exe.bak"), Buffer.from("ancient-build"));

  const outcome = await updater.recover();
  assert.equal(outcome.rolledBack, false, "没有换版证据就不能回滚");
  assert.match(outcome.message, /never applied|nothing to roll back/i);
  assert.deepEqual(await readFile(dir.exe), OLD_BUILD, "在用程序必须保持原样");
});

test("确实换成了新版但没 commit 时，recover 仍要回滚（安全网没被削掉）", async () => {
  const dir = await sandbox();
  const updater = updaterIn(dir, NEW_BUILD);
  const staged = await updater.stage(manifest(NEW_BUILD));
  const applied = await updater.apply(staged, async () => false); // 健康检查不过 => updater 自己已回滚
  assert.equal(applied.rolledBack, true);
  assert.deepEqual(await readFile(dir.exe), OLD_BUILD);

  // 再来一次：健康检查通过但不 commit，pending 与「二进制确实变了」同时成立，recover 该回滚。
  const staged2 = await updater.stage(manifest(NEW_BUILD));
  const ok = await updater.apply(staged2, async () => true);
  assert.equal(ok.swapped, true);
  const recovered = await updater.recover();
  assert.equal(recovered.rolledBack, true, "真有换版证据时必须回滚");
  assert.deepEqual(await readFile(dir.exe), OLD_BUILD);
});

test("暂存包被篡改时 apply 拒绝，且失败的 pending 不会在下次启动反噬成降级", async () => {
  const dir = await sandbox();
  const updater = updaterIn(dir, NEW_BUILD);
  const staged = await updater.stage(manifest(NEW_BUILD));
  await writeFile(staged.packagePath, Buffer.from("tampered-after-staging"));

  const outcome = await updater.apply(staged, async () => true);
  assert.equal(outcome.swapped, false);
  assert.match(outcome.message, /checksum mismatch/);
  assert.deepEqual(await readFile(dir.exe), OLD_BUILD);

  // 反噬场景：apply 没换成，但 pending 与健康标记都留下了，而且备份目录里躺着上一次升级的旧备份。
  // 旧实现下次启动会「照着 pending 回滚」，把在用的 OLD_BUILD 换成 ancient-build。
  await mkdir(dir.backupDir, { recursive: true });
  await writeFile(path.join(dir.backupDir, "AppCenter.2026-01-01T00-00-00-000Z.exe.bak"), Buffer.from("ancient-build"));
  const recovered = await updater.recover();
  assert.equal(recovered.rolledBack, false, "二进制从未被换掉，就没有回滚的理由");
  assert.match(recovered.message, /unchanged since staging|nothing to roll back/i);
  assert.deepEqual(await readFile(dir.exe), OLD_BUILD, "在用程序不能被一份没启用的 pending 降级");
});
