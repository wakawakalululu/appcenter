import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { LocalRepo, type AppDetail, type Category } from "@appcenter/core";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const MANIFEST = "manifest.json";
const categories: Category[] = [{ id: "other", name: "其它", parentId: null, sortOrder: 1 }];

function appDetail(index: number, sizeBytes: number): AppDetail {
  return {
    id: "app-" + String(index),
    name: "本地包" + String(index),
    searchKeys: [],
    publisher: "本机",
    categoryId: "other",
    iconUrl: "",
    latestVersion: "1.0.0",
    downloadCount: 0,
    badge: "normal",
    tags: [],
    requiresApproval: false,
    sizeBytes,
    description: "",
    screenshots: [],
    versions: [
      {
        version: "1.0.0",
        releasedAt: "2026-09-01",
        sizeBytes,
        sha256: "0".repeat(64),
        downloadUrl: "file:///local/app-" + String(index),
        releaseNotes: "",
        silent: { kind: "nsis", installArgs: [], uninstallArgs: [], requiresAdmin: false },
      },
    ],
  };
}

const appsOf = (count: number, sizeBytes = 4096): AppDetail[] => Array.from({ length: count }, (_, i) => appDetail(i, sizeBytes));

/** 每个实例共用同一个仓库根：真机上 CLI 与界面宿主就是共用 packageRoot 并发 sync。 */
function repoFor(root: string): LocalRepo {
  const downloader = {
    async download(request: { id: string; target: string; expectedSize?: number }) {
      const body = "P".repeat(Math.max(1, request.expectedSize ?? 0));
      await writeFile(request.target, body, "utf8");
      return { id: request.id, target: request.target, bytes: Buffer.byteLength(body), sha256: sha(body), fromCache: false };
    },
  };
  return new LocalRepo({ root, downloader: downloader as never });
}

const tmpDebris = async (root: string): Promise<string[]> =>
  (await readdir(root).catch(() => [] as string[])).filter((name) => name.includes(".tmp"));

test("一次陈旧的 <manifest>.tmp 占位不得顶死之后的每一次清单写入", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repo-atomic-"));
  try {
    // 上一个进程崩在 rename 之前，留下了同名占位。固定 `<file>.tmp` 意味着这份残留从此永久故障：
    // writeFile 撞在一个同名目录上就是 EISDIR，整次 sync 抛错、清单永远写不出来。
    await mkdir(path.join(root, MANIFEST + ".tmp"));
    await repoFor(root).sync({ apps: appsOf(2), categories });
    const manifest = JSON.parse(await readFile(path.join(root, MANIFEST), "utf8")) as { items: unknown[] };
    assert.equal(manifest.items.length, 2, "陈旧临时件把清单写入顶死了");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("sync 成功后清单是完整 JSON，且仓库根里不留临时件", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repo-atomic-"));
  try {
    await repoFor(root).sync({ apps: appsOf(3), categories });
    const manifest = JSON.parse(await readFile(path.join(root, MANIFEST), "utf8")) as { formatVersion: number; items: unknown[] };
    assert.equal(manifest.formatVersion, 1);
    assert.equal(manifest.items.length, 3);
    assert.deepEqual(await tmpDebris(root), [], "sync 成功后不该留下临时件");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("两个宿主并发 sync 同一个仓库根：都不许失败，清单也不许被对方的半成品顶替", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repo-atomic-"));
  try {
    // 载荷写大一点：两个写者的 writeFile→rename 窗口重叠得越实，固定临时名的后果越看得清。
    const results = await Promise.allSettled([
      repoFor(root).sync({ apps: appsOf(40, 200_000), categories }),
      repoFor(root).sync({ apps: appsOf(2, 200_000), categories }),
    ]);
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(
      rejected.length,
      0,
      "并发 sync 有 " + String(rejected.length) + " 次抛错：" + rejected.map((r) => String((r as PromiseRejectedResult).reason?.message).slice(0, 80)).join(" / "),
    );
    const manifest = JSON.parse(await readFile(path.join(root, MANIFEST), "utf8")) as { items: unknown[] };
    assert.ok(
      manifest.items.length === 40 || manifest.items.length === 2,
      "清单必须是某一方的完整内容，实际 " + String(manifest.items.length) + " 条（混写或半截就是损坏）",
    );
    assert.deepEqual(await tmpDebris(root), [], "并发写入之后不该留下临时件");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("清单目标位动不了时 sync 要失败，但不能把自己那份临时件丢在仓库里", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repo-atomic-"));
  try {
    await mkdir(path.join(root, MANIFEST));
    await assert.rejects(() => repoFor(root).sync({ apps: appsOf(2), categories }));
    assert.deepEqual(
      await tmpDebris(root),
      [],
      "失败必须清掉自己那份临时件：留下的固定名 `.tmp` 会被下一次 rename 当正式文件搬走（半截清单落盘）",
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
