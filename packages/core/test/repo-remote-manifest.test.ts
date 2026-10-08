/**
 * 在线拉取（远端清单 + http(s) 安装包）的离线回归。
 * 全程注入 fetchImpl / FakeHttp，不发任何真实网络请求。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTrackedTmp } from "./util/tmp-dirs.ts";
import {
  LocalRepo,
  createRepoDownloader,
  fetchRepoManifest,
  urlWithinPrefix,
  repoManifestSourceFromEnv,
  type AppDetail,
  type Category,
  type DownloadPort,
  type DownloadResult,
  type RepoManifest,
} from "@appcenter/core";

/** 只做「按 url 吐字节 + 校验 expected 值」，用来冒充网络分支。 */
class FakeHttp implements DownloadPort {
  readonly calls: string[] = [];
  constructor(private readonly files: Map<string, Buffer>) {}

  async download(req: { id: string; url: string; target: string; expectedSha256?: string; expectedSize?: number }): Promise<DownloadResult> {
    this.calls.push(req.url);
    const bytes = this.files.get(req.url);
    if (!bytes) throw new Error("http-status: 404 " + req.url);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (req.expectedSha256 && req.expectedSha256 !== sha256) throw new Error("checksum-mismatch: " + req.url);
    if (req.expectedSize !== undefined && req.expectedSize !== bytes.length) throw new Error("size-mismatch: " + req.url);
    await mkdir(path.dirname(req.target), { recursive: true });
    await writeFile(req.target, bytes);
    return { id: req.id, target: req.target, bytes: bytes.length, sha256, fromCache: false };
  }
}

const categories: Category[] = [{ id: "dev", name: "开发工具", parentId: null, sortOrder: 1 }];
const PREFIX = "https://mirror.test/repo";

function app(id: string, version: string, url: string, bytes: Buffer): AppDetail {
  return {
    id,
    name: id,
    searchKeys: [],
    publisher: "厂商",
    categoryId: "dev",
    iconUrl: "",
    latestVersion: version,
    downloadCount: 1,
    badge: "normal",
    tags: [],
    requiresApproval: false,
    sizeBytes: bytes.length,
    description: "",
    screenshots: [],
    versions: [
      {
        version,
        releasedAt: "2026-09-01",
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        downloadUrl: url,
        releaseNotes: "",
        silent: { kind: "nsis", installArgs: ["/S"], uninstallArgs: ["/S"] },
      },
    ],
  };
}

function jsonFetch(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

function manifestOf(items: RepoManifest["items"]): RepoManifest {
  return { formatVersion: 1, generatedAt: new Date().toISOString(), root: "", catalog: { apps: [], categories }, items };
}

test("urlWithinPrefix 逐段比对，不被 startsWith 骗过", () => {
  assert.equal(urlWithinPrefix("https://mirror.test/repo/a.exe", [PREFIX]), true);
  // 这条专门钉死 startsWith 实现：good.com.evil.net 不能以 good.com 前缀放行。
  assert.equal(urlWithinPrefix("https://mirror.test.evil.net/repo/a.exe", [PREFIX]), false);
  assert.equal(urlWithinPrefix("https://mirror.test/other/a.exe", [PREFIX]), false);
  assert.equal(urlWithinPrefix("ftp://mirror.test/repo/a.exe", [PREFIX]), false);
});

test("http(s) 走网络分支并落盘", async () => {
  const root = await makeTrackedTmp("repo-http-");
  const bytes = Buffer.from("remote payload");
  const url = PREFIX + "/tool.exe";
  const http = new FakeHttp(new Map([[url, bytes]]));
  const repo = new LocalRepo({ downloader: createRepoDownloader({ allowedUrlPrefixes: [PREFIX], http }), root, verify: "size" });
  const report = await repo.sync({ apps: [app("tool", "1.0.0", url, bytes)], categories });
  assert.equal(report.failed.length, 0);
  assert.equal(report.saved.length, 1);
  assert.deepEqual(http.calls, [url]);
});

test("白名单外的 url 在发请求前就被拒", async () => {
  const root = await makeTrackedTmp("repo-block-");
  const bytes = Buffer.from("payload");
  const url = "https://evil.test/a.exe";
  const http = new FakeHttp(new Map([[url, bytes]]));
  const repo = new LocalRepo({ downloader: createRepoDownloader({ allowedUrlPrefixes: [PREFIX], http }), root });
  const report = await repo.sync({ apps: [app("tool", "1.0.0", url, bytes)], categories });
  assert.equal(report.failed.length, 1);
  assert.deepEqual(http.calls, [], "被拒的 url 根本不该发出请求");
});

test("不配前缀时 http(s) 一律拒绝（默认不放行外网）", async () => {
  const root = await makeTrackedTmp("repo-noprefix-");
  const bytes = Buffer.from("payload");
  const url = PREFIX + "/a.exe";
  const http = new FakeHttp(new Map([[url, bytes]]));
  const repo = new LocalRepo({ downloader: createRepoDownloader({ http }), root });
  const report = await repo.sync({ apps: [app("tool", "1.0.0", url, bytes)], categories });
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0]!.error, /outside the allowed prefixes/);
  assert.deepEqual(http.calls, []);
});

test("sync 接受远端清单作为输入源", async () => {
  const root = await makeTrackedTmp("repo-manifest-");
  const bytes = Buffer.from("manifest payload");
  const url = PREFIX + "/tool.exe";
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = manifestOf([
    {
      appId: "tool", name: "tool", publisher: "p", categoryId: "dev", tags: [], version: "1.0.0",
      fileName: "tool.exe", relativePath: "tool/1.0.0.exe", sizeBytes: bytes.length, sha256, url, status: "pending", attempts: 0,
    },
  ]);
  const http = new FakeHttp(new Map([[url, bytes]]));
  const repo = new LocalRepo({ downloader: createRepoDownloader({ allowedUrlPrefixes: [PREFIX], http }), root, verify: "size" });
  const report = await repo.sync({ manifest });
  assert.equal(report.failed.length, 0);
  assert.equal(report.saved.length, 1);
  const written = await readFile(path.join(root, "tool", "1.0.0.exe"));
  assert.equal(createHash("sha256").update(written).digest("hex"), sha256);
});

test("fetchRepoManifest 拒绝不认识的 formatVersion", async () => {
  const body = { ...manifestOf([]), formatVersion: 2 };
  await assert.rejects(
    () => fetchRepoManifest({ url: PREFIX + "/manifest.json", allowedUrlPrefixes: [PREFIX], fetchImpl: jsonFetch(body) }),
    /formatVersion/,
  );
});

test("fetchRepoManifest 拒绝校验和不符的清单", async () => {
  await assert.rejects(
    () =>
      fetchRepoManifest({
        url: PREFIX + "/manifest.json",
        sha256: "0".repeat(64),
        allowedUrlPrefixes: [PREFIX],
        fetchImpl: jsonFetch(manifestOf([])),
      }),
    /checksum mismatch/,
  );
});

test("fetchRepoManifest 拒绝条目 url 越出白名单", async () => {
  const body = manifestOf([
    {
      appId: "a", name: "a", publisher: "p", categoryId: "dev", tags: [], version: "1.0.0",
      fileName: "a.exe", relativePath: "a/1.0.0.exe", sizeBytes: 10, sha256: "0".repeat(64),
      url: "https://evil.test/a.exe", status: "pending", attempts: 0,
    },
  ]);
  await assert.rejects(
    () => fetchRepoManifest({ url: PREFIX + "/manifest.json", allowedUrlPrefixes: [PREFIX], fetchImpl: jsonFetch(body) }),
    /outside the allowed prefixes/,
  );
});

test("fetchRepoManifest 拒绝 relativePath 越界的条目", async () => {
  const body = manifestOf([
    {
      appId: "a", name: "a", publisher: "p", categoryId: "dev", tags: [], version: "1.0.0",
      fileName: "a.exe", relativePath: "../outside/1.0.0.exe", sizeBytes: 10, sha256: "0".repeat(64),
      url: PREFIX + "/a.exe", status: "pending", attempts: 0,
    },
  ]);
  await assert.rejects(
    () => fetchRepoManifest({ url: PREFIX + "/manifest.json", allowedUrlPrefixes: [PREFIX], fetchImpl: jsonFetch(body) }),
    /path escapes/,
  );
});

test("repoManifestSourceFromEnv 没给 CATALOG_MANIFEST_URL 就不启用在线拉取", () => {
  assert.equal(repoManifestSourceFromEnv({}), undefined);
  const source = repoManifestSourceFromEnv({
    CATALOG_MANIFEST_URL: PREFIX + "/manifest.json",
    REPO_ALLOWED_URL_PREFIXES: PREFIX + ", https://other.test/x",
    REPO_MANIFEST_SHA256: "a".repeat(64),
  });
  assert.equal(source?.url, PREFIX + "/manifest.json");
  assert.deepEqual(source?.allowedUrlPrefixes, [PREFIX, "https://other.test/x"]);
  assert.equal(source?.sha256, "a".repeat(64));
});
