import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DownloadError, Downloader } from "@appcenter/core";

const PAYLOAD = new TextEncoder().encode("PACKAGE-BYTES-FOR-LANDING-TEST");
const SHA = createHash("sha256").update(PAYLOAD).digest("hex");

function fakeResponse(chunk: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(chunk.length) }),
    body: {
      getReader() {
        let sent = false;
        return { read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: chunk })) };
      },
    },
  } as unknown as Response;
}

/** 数「为了让包落地，把整份载荷取了几遍」。 */
function countingFetch(spy: { calls: number }) {
  return (async () => {
    spy.calls += 1;
    return fakeResponse(PAYLOAD);
  }) as unknown as typeof fetch;
}

async function sandbox(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "dl-land-"));
}

function download(target: string, calls: { calls: number }): Promise<unknown> {
  return new Downloader({ fetchImpl: countingFetch(calls), attempts: 3, baseDelayMs: 1 }).download({
    id: "app@1.0.0",
    url: "http://x/pkg.bin",
    target,
    expectedSize: PAYLOAD.length,
    expectedSha256: SHA,
  });
}

/**
 * 落地段的失败在真机上是「目标位动不了」：被杀软/安装进程占住时 rm 与 rename 都 EPERM
 * （#27 已实测过这个 Windows 语义），或目标位是个同名目录。两种都不是下载本身出错。
 * 这里用「目标位是目录」做**确定性、跨平台、不起进程**的复现——注意它复现的是
 * 「落地抛出的不是 DownloadError 因而被外层误判成可重试的下载故障」这一条，
 * 不是复现杀软占用；两者的错误形状相同（裸 fs 错误 + .part 已校验完整）。
 */
async function targetIsADirectory(): Promise<{ dir: string; target: string }> {
  const dir = await sandbox();
  const target = path.join(dir, "pkg.bin");
  await mkdir(target);
  return { dir, target };
}

test("落地失败要能被分类成下载错误，而不是把裸 fs 错误抛给安装编排", async () => {
  const { dir, target } = await targetIsADirectory();
  const spy = { calls: 0 };
  try {
    const err = await download(target, spy).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err !== null, "目标位是目录却「下载成功」，说明这次没复现到落地失败");
    assert.ok(
      err instanceof DownloadError,
      "抛的是裸 fs 错误（" + String((err as Error).name) + ": " + String((err as Error).message) + "）：外层只能当未知失败，界面拿不到可解释的类别",
    );
    assert.equal((err as DownloadError).kind, "landing", "落地失败要有自己的类别，实际 " + String((err as DownloadError).kind));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("落地失败不该把已经校验过的整包重下一遍又一遍", async () => {
  const { dir, target } = await targetIsADirectory();
  const spy = { calls: 0 };
  try {
    await download(target, spy).then(
      () => null,
      () => null,
    );
    assert.equal(
      spy.calls,
      1,
      "目标位动不了不是「重下就能好」的故障，却把完整载荷取了 " + String(spy.calls) + " 次（.part 早就校验通过了，白烧流量与时间）",
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("落地失败要保留已校验的 .part，并在目标位腾开后直接补上落地", async () => {
  const { dir, target } = await targetIsADirectory();
  const spy = { calls: 0 };
  try {
    await download(target, spy).then(
      () => null,
      () => null,
    );
    const part = target + ".part";
    const partStat = await stat(part).catch(() => null);
    assert.ok(partStat, "落地失败后 .part 必须留着，否则下次要从头下载");
    assert.equal(partStat?.size, PAYLOAD.length, "留下的 .part 应当就是完整载荷，实际 " + String(partStat?.size));

    await rm(target, { recursive: true, force: true });
    const result = await download(target, { calls: 0 });
    assert.ok(result && typeof result === "object", "腾开目标位后仍失败");
    assert.equal((await readFile(target)).toString("utf8"), "PACKAGE-BYTES-FOR-LANDING-TEST");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("对照：目标位是普通旧文件时照旧覆盖落地（别把正常路径挡死）", async () => {
  const dir = await sandbox();
  const target = path.join(dir, "pkg.bin");
  await writeFile(target, "STALE-OLD-PACKAGE-BYTES");
  try {
    const result = (await download(target, { calls: 0 })) as { sha256: string };
    assert.equal(result.sha256, SHA, "旧文件应被覆盖为新包");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
