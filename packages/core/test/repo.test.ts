import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalRepo, type AppDetail, type Category, type DownloadPort, type DownloadResult } from "@appcenter/core";

class FakeDownloader implements DownloadPort {
  readonly calls: string[] = [];
  constructor(
    private readonly files: Map<string, Buffer>,
    private readonly missingUrls: ReadonlySet<string> = new Set(),
  ) {}

  async download(req: { id: string; url: string; target: string; expectedSha256?: string; expectedSize?: number }): Promise<DownloadResult> {
    this.calls.push(req.url);
    if (this.missingUrls.has(req.url)) throw new Error("http-status: 404 " + req.url);
    const bytes = this.files.get(req.url);
    if (!bytes) throw new Error("http-status: 404 " + req.url);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (req.expectedSha256 && req.expectedSha256 !== sha) throw new Error("checksum-mismatch: " + req.url);
    if (req.expectedSize !== undefined && req.expectedSize !== bytes.length) throw new Error("size-mismatch: " + req.url);
    await mkdir(path.dirname(req.target), { recursive: true });
    await writeFile(req.target, bytes);
    return { id: req.id, target: req.target, bytes: bytes.length, sha256: sha, fromCache: false };
  }
}

const category = (id: string, name: string, parentId: string | null = null): Category => ({ id, name, parentId, sortOrder: 1 });
const categories = [category("dev", "开发工具"), category("office", "办公协同")];

/** 目录与下载源必须同源：sha256 与字节来自同一份 Buffer，否则校验必炸。 */
function fixture(defs: { id: string; name: string; categoryId?: string; versions: string[] }[]): { apps: AppDetail[]; files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  const apps = defs.map((def) => {
    const versions = def.versions.map((version) => {
      const bytes = Buffer.from(def.id + "@" + version + " payload");
      const downloadUrl = "/dl/" + def.id + "-" + version + ".exe";
      files.set(downloadUrl, bytes);
      return {
        version,
        releasedAt: "2026-09-01",
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        downloadUrl,
        releaseNotes: "notes",
        silent: { kind: "nsis" as const, installArgs: ["/S"], uninstallArgs: ["/S"] },
      };
    });
    return {
      id: def.id,
      name: def.name,
      searchKeys: [],
      publisher: "厂商 " + def.id,
      categoryId: def.categoryId ?? "dev",
      iconUrl: "",
      latestVersion: versions[0]!.version,
      downloadCount: 10,
      badge: "normal" as const,
      tags: ["标签"],
      requiresApproval: false,
      sizeBytes: versions.reduce((sum, v) => sum + v.sizeBytes, 0),
      description: "描述",
      screenshots: [],
      versions,
    };
  });
  return { apps, files };
}

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

test("sync saves every latest version and writes a self-describing manifest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repo-"));
  const { apps, files } = fixture([
    { id: "wps", name: "WPS Office", categoryId: "office", versions: ["12.1.0", "12.0.0"] },
    { id: "ide", name: "代码编辑器", versions: ["3.4.2"] },
  ]);
  const repo = new LocalRepo({ downloader: new FakeDownloader(files), root });

  const report = await repo.sync({ apps, categories });
  assert.equal(report.saved.length, 2, "默认只保存最新版：两个应用各一个");
  assert.equal(report.failed.length, 0);
  assert.ok(report.totalBytes > 0);

  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.catalog.apps.length, 2, "清单要带目录快照");
  assert.deepEqual(manifest.catalog.categories.map((c: Category) => c.id), ["dev", "office"]);
  assert.equal(manifest.items.length, 2, "历史版本不随默认同步");
  const saved = manifest.items.find((item: { appId: string }) => item.appId === "wps");
  assert.equal(saved.status, "saved");
  assert.equal(saved.relativePath, "wps/12.1.0.exe");
  assert.equal(saved.sha256, sha(files.get("/dl/wps-12.1.0.exe")!));
  const landed = await readFile(path.join(root, ...saved.relativePath.split("/")));
  assert.equal(landed.toString(), "wps@12.1.0 payload");
  await rm(root, { recursive: true, force: true });
});

test("allVersions pulls historical versions too", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repo-"));
  const { apps, files } = fixture([{ id: "ide", name: "代码编辑器", versions: ["3.4.2", "3.3.0"] }]);
  const report = await new LocalRepo({ downloader: new FakeDownloader(files), root }).sync({ apps, categories, allVersions: true });
  assert.equal(report.saved.length, 2);
  await rm(root, { recursive: true, force: true });
});

test("second sync caches instead of re-downloading", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repo-"));
  const { apps, files } = fixture([{ id: "ide", name: "代码编辑器", versions: ["3.4.2"] }]);
  const first = new FakeDownloader(files);
  await new LocalRepo({ downloader: first, root }).sync({ apps, categories });
  assert.equal(first.calls.length, 1);

  const second = new FakeDownloader(files);
  const report = await new LocalRepo({ downloader: second, root }).sync({ apps, categories });
  assert.equal(second.calls.length, 0, "命中缓存的包不应再发请求");
  assert.equal(report.cached.length, 1);
  assert.equal(report.saved.length, 0);
  await rm(root, { recursive: true, force: true });
});

test("failed downloads are recorded, do not abort the run and succeed on retry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repo-"));
  const { apps, files } = fixture([{ id: "ide", name: "代码编辑器", versions: ["3.4.2"] }]);
  const broken = new FakeDownloader(files, new Set(["/dl/ide-3.4.2.exe"]));
  const first = await new LocalRepo({ downloader: broken, root }).sync({ apps, categories });
  assert.equal(first.failed.length, 1);
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.items[0].status, "failed");
  assert.match(manifest.items[0].error, /404/);

  const healed = await new LocalRepo({ downloader: new FakeDownloader(files), root }).sync({ apps, categories });
  assert.equal(healed.saved.length, 1);
  assert.equal(healed.failed.length, 0);
  const after = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.equal(after.items[0].status, "saved");
  assert.equal(after.items[0].attempts, 2, "重试次数要累计");
  await rm(root, { recursive: true, force: true });
});

test("status recomputes item state from what is actually on disk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repo-"));
  const { apps, files } = fixture([{ id: "ide", name: "代码编辑器", versions: ["3.4.2"] }]);
  await new LocalRepo({ downloader: new FakeDownloader(files), root }).sync({ apps, categories });

  const intact = await new LocalRepo({ downloader: new FakeDownloader(files), root }).status();
  assert.equal(intact.saved, 1);
  assert.equal(intact.pending, 0);

  await rm(path.join(root, "ide", "3.4.2.exe"));
  const missing = await new LocalRepo({ downloader: new FakeDownloader(files), root }).status();
  assert.equal(missing.pending, 1, "文件丢了要从 saved 落回 pending");
  assert.equal(missing.saved, 0);
  await rm(root, { recursive: true, force: true });
});

test("verify=sha256 refuses a cached file whose bytes no longer match", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repo-"));
  const { apps, files } = fixture([{ id: "ide", name: "代码编辑器", versions: ["3.4.2"] }]);
  const good = files.get("/dl/ide-3.4.2.exe")!;
  await new LocalRepo({ downloader: new FakeDownloader(files), root }).sync({ apps, categories });

  // 同长度、不同内容：size 档位放行，只有 sha256 档位能识破。
  const tampered = Buffer.from(good.toString().replace(/a/g, "b"));
  assert.equal(tampered.length, good.length);
  assert.notEqual(sha(tampered), sha(good));
  await writeFile(path.join(root, "ide", "3.4.2.exe"), tampered);

  const sizeMode = await new LocalRepo({ downloader: new FakeDownloader(files), root }).status();
  assert.equal(sizeMode.saved, 1, "size 档位只看大小，判为完好");

  const repo = new LocalRepo({ downloader: new FakeDownloader(files), root, verify: "sha256" });
  const report = await repo.sync({ apps, categories });
  assert.equal(report.cached.length, 0, "字节被篡改的缓存不应算命中");
  assert.equal(report.saved.length, 1);
  const landed = await readFile(path.join(root, "ide", "3.4.2.exe"));
  assert.equal(landed.toString(), good.toString(), "重新下载应覆盖被篡改的文件");
  await rm(root, { recursive: true, force: true });
});

test("resolve returns the mirrored package when present and intact", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repo-"));
  const { apps, files } = fixture([{ id: "ide", name: "代码编辑器", versions: ["3.4.2"] }]);
  await new LocalRepo({ downloader: new FakeDownloader(files), root }).sync({ apps, categories });

  const hit = await new LocalRepo({ downloader: new FakeDownloader(files), root }).resolve("ide", "3.4.2", "/dl/ide-3.4.2.exe");
  assert.ok(hit, "已镜像且完整的包应命中");
  assert.equal(hit!.sha256, sha(files.get("/dl/ide-3.4.2.exe")!));
  assert.equal(hit!.size, files.get("/dl/ide-3.4.2.exe")!.length);
  assert.ok(hit!.file.endsWith(path.join("ide", "3.4.2.exe")));
  await rm(root, { recursive: true, force: true });
});

test("resolve misses on unknown version, unknown app or missing file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repo-"));
  const { apps, files } = fixture([{ id: "ide", name: "代码编辑器", versions: ["3.4.2"] }]);
  await new LocalRepo({ downloader: new FakeDownloader(files), root }).sync({ apps, categories });
  const repo = new LocalRepo({ downloader: new FakeDownloader(files), root });

  assert.equal(await repo.resolve("ide", "9.9.9", "/dl/ide-9.9.9.exe"), null, "未知版本不命中");
  assert.equal(await repo.resolve("other", "3.4.2", "/dl/other-3.4.2.exe"), null, "未知应用不命中");
  await rm(path.join(root, "ide", "3.4.2.exe"));
  assert.equal(await repo.resolve("ide", "3.4.2", "/dl/ide-3.4.2.exe"), null, "文件被删后不命中");
  await rm(root, { recursive: true, force: true });
});

test("resolve with verify=sha256 rejects a tampered cached file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repo-"));
  const { apps, files } = fixture([{ id: "ide", name: "代码编辑器", versions: ["3.4.2"] }]);
  const good = files.get("/dl/ide-3.4.2.exe")!;
  await new LocalRepo({ downloader: new FakeDownloader(files), root }).sync({ apps, categories });
  const tampered = Buffer.from(good.toString().replace(/a/g, "b"));
  assert.equal(tampered.length, good.length);
  await writeFile(path.join(root, "ide", "3.4.2.exe"), tampered);

  const sizeRepo = new LocalRepo({ downloader: new FakeDownloader(files), root, verify: "size" });
  assert.ok(await sizeRepo.resolve("ide", "3.4.2", "/dl/ide-3.4.2.exe"), "size 档位只看大小，判为命中");

  const shaRepo = new LocalRepo({ downloader: new FakeDownloader(files), root, verify: "sha256" });
  assert.equal(await shaRepo.resolve("ide", "3.4.2", "/dl/ide-3.4.2.exe"), null, "sha256 档位识破篡改");
  await rm(root, { recursive: true, force: true });
});
