import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { LocalRepo, createLocalFileDownloader, type AppDetail, type Category } from "@appcenter/core";

const categories: Category[] = [{ id: "other", name: "其它", parentId: null, sortOrder: 1 }];

/** 真字节做真校验值，让本地文件下载器走完整路径。 */
function appFor(sourceFile: string, url: string): AppDetail {
  return {
    id: "pkg-app",
    name: "本地镜像包",
    searchKeys: [],
    publisher: "本机",
    categoryId: "other",
    iconUrl: "",
    latestVersion: "1.0.0",
    downloadCount: 0,
    badge: "normal",
    tags: [],
    requiresApproval: false,
    sizeBytes: 0,
    description: "",
    screenshots: [],
    versions: [
      {
        version: "1.0.0",
        releasedAt: "2026-09-01",
        sizeBytes: 0,
        sha256: "0".repeat(64),
        downloadUrl: url,
        releaseNotes: "",
        silent: { kind: "nsis", installArgs: [], uninstallArgs: [], requiresAdmin: false },
      },
    ],
  };
}

async function fixture(): Promise<{ root: string; srcRoot: string; sourceFile: string; body: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "repo-stage-"));
  const srcRoot = await mkdtemp(path.join(tmpdir(), "repo-src-"));
  const sourceFile = path.join(srcRoot, "payload.bin");
  const body = "MIRROR-" + randomBytes(64).toString("hex");
  await writeFile(sourceFile, body, "utf8");
  return {
    root,
    srcRoot,
    sourceFile,
    body,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(srcRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function repoWith(root: string, srcRoot: string): LocalRepo {
  return new LocalRepo({ root, downloader: createLocalFileDownloader([srcRoot]) });
}

/** 用 size/sha 都对得上的版本信息驱动 sync，返回清单里第一条的落盘相对路径。 */
async function syncOnce(f: Awaited<ReturnType<typeof fixture>>): Promise<{ relativePath: string; target: string; report: unknown }> {
  const sha256 = createHash("sha256").update(f.body).digest("hex");
  const app = appFor(f.sourceFile, "file:///" + f.sourceFile.replace(/\\/g, "/"));
  app.versions[0]!.sizeBytes = Buffer.byteLength(f.body);
  app.versions[0]!.sha256 = sha256;
  app.sizeBytes = Buffer.byteLength(f.body);
  app.latestVersion = "1.0.0";
  const report = await repoWith(f.root, f.srcRoot).sync({ apps: [app], categories });
  const manifest = JSON.parse(await readFile(path.join(f.root, "manifest.json"), "utf8")) as { items: { relativePath: string }[] };
  const relativePath = manifest.items[0]!.relativePath;
  return { relativePath, target: path.join(f.root, relativePath), report };
}

/** 递归找残骸：staging 落在 `<root>/<appId>/<version>.exe.copying`，只扫仓库根会漏成假绿。 */
async function debris(dir: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await debris(full)));
    else if (entry.name.includes(".copying")) found.push(full);
  }
  return found;
}

test("对照：本地包能完整镜像到仓库，且不留 staging 残骸", async () => {
  const f = await fixture();
  try {
    const { target, relativePath } = await syncOnce(f);
    assert.ok(relativePath.length > 0, "清单里该有这条镜像的相对路径");
    assert.equal((await readFile(target, "utf8")).length, f.body.length, "镜像字节数应与源包一致");
    assert.deepEqual(await debris(f.root), [], "正常镜像不该留下 staging 残骸");
  } finally {
    await f.cleanup();
  }
});

test("一次陈旧的 <目标>.copying 占位不得把镜像永久打死", async () => {
  const f = await fixture();
  try {
    const { target } = await syncOnce(f);
    await rm(target, { force: true });
    // 上一次进程崩在 rename 之前，留下了同名占位：staging 名写死时，这次 copyFile 撞在目录上，
    // 从此这个包每轮镜像都失败——而失败原因（"illegal operation on a directory"）看起来像源包坏了。
    await mkdir(target + ".copying");
    const report = (await syncOnce(f)).report as { failed: { error: string }[]; saved: string[] };
    assert.equal(report.failed.length, 0, "陈旧占位把镜像打死了：" + String(report.failed[0]?.error));
    assert.equal((await readFile(target, "utf8")).length, f.body.length, "该重新落成完整包");
  } finally {
    await f.cleanup();
  }
});

test("rename 落地失败时不许把 staging 丢在仓库根里", async () => {
  const f = await fixture();
  try {
    const { target } = await syncOnce(f);
    // 目标位换成一个目录 ⇒ rename 必失败（真机上被别的过程持有的目标是同一类失败）。
    await rm(target, { recursive: true, force: true });
    await mkdir(target);
    const report = (await syncOnce(f)).report as { failed: { error: string }[] };
    assert.equal(report.failed.length, 1, "目标位动不了应当记这条失败，实际 " + JSON.stringify(report.failed));
    assert.deepEqual(
      await debris(f.root),
      [],
      "失败的镜像必须删掉自己那份 staging；固定名的 `.copying` 会变成下一轮的陈旧占位",
    );
  } finally {
    await f.cleanup();
  }
});
