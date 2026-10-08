import { test } from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { LocalRepo, localFileDownloader, type AppDetail } from "@appcenter/core";
import { makeTrackedTmp } from "./util/tmp-dirs.ts";

const BS = String.fromCharCode(92);
const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

function appDetail(overrides: { id: string; version: string; downloadUrl: string }): AppDetail {
  return {
    id: overrides.id,
    name: "本地包",
    searchKeys: [],
    publisher: "本机",
    categoryId: "other",
    iconUrl: "",
    latestVersion: overrides.version,
    downloadCount: 0,
    badge: "normal",
    tags: [],
    requiresApproval: false,
    sizeBytes: 0,
    description: "",
    screenshots: [],
    versions: [
      {
        version: overrides.version,
        releasedAt: "2026-09-01",
        sizeBytes: 0,
        sha256: "0".repeat(64),
        downloadUrl: overrides.downloadUrl,
        releaseNotes: "",
        silent: { kind: "nsis", installArgs: [], uninstallArgs: [], requiresAdmin: false },
      },
    ],
  };
}

/** 记录 downloader 真正会被写到的绝对路径。 */
function recorder(written: string[]) {
  return {
    async download(request: { id: string; target: string }) {
      written.push(path.resolve(request.target));
      return { id: request.id, target: request.target, bytes: 0, sha256: "0".repeat(64), fromCache: false };
    },
  };
}

test("回归：目录给的 version/appId 不能让镜像写到仓库根之外", async () => {
  const sandbox = await makeTrackedTmp("repo-contain-");
  const root = path.join(sandbox, "mirror");
  const written: string[] = [];
  const repo = new LocalRepo({ downloader: recorder(written) as never, root });
  await repo.sync({
    apps: [appDetail({ id: "../../pwned", version: "../../../../evilver", downloadUrl: "/p.zip" })],
    categories: [],
  });
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as { items: { relativePath: string }[] };
  assert.ok(manifest.items.length > 0);
  assert.doesNotMatch(manifest.items[0]?.relativePath ?? "", /(^|[\\/])\.\.([\\/]|$)/, "relativePath 不该保留可穿越的段：" + manifest.items[0]?.relativePath);
  for (const file of written) {
    assert.ok(file.startsWith(path.resolve(root) + path.sep), "落盘点越出仓库根：" + file);
  }
});

test("回归：status() 不去 stat 仓库根之外的路径", async () => {
  const sandbox = await makeTrackedTmp("repo-status-");
  const root = path.join(sandbox, "mirror");
  await mkdir(root, { recursive: true });
  // 手工写一份被篡改的清单：条目指向仓库根**外面**一个真实存在的文件。
  const outside = path.join(sandbox, "outside", "1.0.0.exe");
  await mkdir(path.dirname(outside), { recursive: true });
  await writeFile(outside, "not-a-package");
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    root,
    catalog: { apps: [], categories: [] },
    items: [{ appId: "x", name: "x", publisher: "p", categoryId: "c", tags: [], version: "1.0.0", fileName: "1.0.0.exe", relativePath: "../outside/1.0.0.exe", sizeBytes: 13, sha256: "0".repeat(64), url: "file:///dev/null", status: "saved", attempts: 1 }],
  }), "utf8");
  const status = await new LocalRepo({ downloader: recorder([]) as never, root }).status();
  assert.equal(status.saved, 0, "越界条目不能按「已保存」计数，否则会去 stat 仓库外的路径");
  assert.equal(status.pending, 1);
});

test("回归：localFileDownloader 不再把任意本地路径当安装包拷进镜像", async () => {
  const sandbox = await makeTrackedTmp("localdl-");
  const secret = path.join(sandbox, "private.txt");
  const body = Buffer.from("PRIVATE LOCAL CONTENT");
  await writeFile(secret, body);
  const dest = path.join(sandbox, "mirror", "leak", "1.0.exe");

  // 1) 裸绝对路径（不带 file://）必须拒
  await assert.rejects(
    () => localFileDownloader.download({ id: "x", url: secret, target: dest, expectedSize: body.length, expectedSha256: sha(body) } as never),
    /file:\/\//,
    "旧写法把任何绝对路径都当源文件拷进镜像，等于本地文件外泄通道",
  );
  // 2) file:// 但缺少预期 size/sha256 也必须拒
  const url = "file:///" + secret.replace(/\\/g, "/").replace(/^([A-Za-z]:)/, (_m, drive: string) => drive.toLowerCase());
  await assert.rejects(() => localFileDownloader.download({ id: "x", url, target: dest } as never), /expected size and sha256/);
  // 3) 合法的 file:// + 正确校验值仍要能拷（不过度收紧）
  const result = (await localFileDownloader.download({ id: "x", url, target: dest, expectedSize: body.length, expectedSha256: sha(body) } as never)) as { bytes: number; sha256: string };
  assert.equal(result.bytes, body.length);
  assert.equal(await readFile(dest, "utf8"), "PRIVATE LOCAL CONTENT");
});
