import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppDetail, AppSummary, Category } from "../catalog/types.ts";
import type { DownloadPort } from "../orchestrator/installer.ts";
import { extensionOf } from "../orchestrator/installer.ts";
import { joinWithinRoot, safePathSegment } from "../util/paths.ts";

/**
 * 本地应用包仓库：把目录里的安装包持久化到磁盘并维护一份自描述清单。
 * 与安装编排器的临时下载不同——这里是可审计、可离线复用的镜像：
 * manifest.json 同时携带目录快照（应用 + 分类），拿到目录即拿到全部语义。
 */
export type RepoItemStatus = "saved" | "failed" | "pending";

export interface RepoManifestItem {
  appId: string;
  name: string;
  publisher: string;
  categoryId: string;
  tags: string[];
  version: string;
  fileName: string;
  /** 相对仓库根目录的落盘路径，统一正斜杠，便于跨工具读取。 */
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  url: string;
  status: RepoItemStatus;
  error?: string;
  savedAt?: string;
  attempts: number;
}

export interface RepoManifest {
  formatVersion: 1;
  generatedAt: string;
  root: string;
  /** 目录快照：清单脱离服务端也能说明「这些包是什么」。 */
  catalog: { apps: AppSummary[]; categories: Category[] };
  items: RepoManifestItem[];
}

export interface RepoSyncReport {
  root: string;
  manifestFile: string;
  saved: string[];
  cached: string[];
  failed: { appId: string; version: string; error: string }[];
  totalBytes: number;
  durationMs: number;
}

export interface RepoStatus {
  root: string;
  manifestFile: string;
  manifestExists: boolean;
  saved: number;
  failed: number;
  pending: number;
  totalBytes: number;
  items: RepoManifestItem[];
}

export interface LocalRepoOptions {
  downloader: DownloadPort;
  root: string | (() => Promise<string> | string);
  /** cached 判定强度：size 只对文件大小，sha256 逐字节校验（大文件慎用）。 */
  verify?: "size" | "sha256";
  concurrency?: number;
  /** 目录里的 downloadUrl 常是相对路径（/dl/...），这里补全成绝对 URL。 */
  urlBase?: string;
}

export interface RepoSyncInput {
  apps: readonly AppDetail[];
  categories: readonly Category[];
  /** 默认只保存每个应用的最新版；打开后保存全部历史版本。 */
  allVersions?: boolean;
}

function resolve(root: string | (() => Promise<string> | string)): Promise<string> {
  return typeof root === "string" ? Promise.resolve(root) : Promise.resolve(root()).then((value) => value);
}

/**
 * 本地文件端口：url 是 file:// 时直接复制并校验，不走网络。
 * 自动发现出来的真实安装包靠它镜像进仓库（含 sha256 与清单）。
 *
 * 三条硬约束，缺一条就拒：
 * 1. 只认 `file://`。旧写法把裸绝对路径也当源文件，等于「目录里塞一条 `C:\...`
 *    就能把本地任意文件拷进镜像、再随清单外泄」的后门；
 * 2. 必须同时给 expected size and sha256——少一个就等于放弃校验；
 * 3. 给了 allowedRoots 时源文件必须落在其中之一内。真机工作流（build-real-catalog）
 *    本来就知道来源根，应当传进来；默认导出不带白名单，行为等同旧代码。
 */
export function createLocalFileDownloader(allowedRoots: readonly string[] = []): DownloadPort {
  return {
    async download(request) {
      if (!request.url.startsWith("file://")) throw new Error("local package source must be a file:// URL: " + request.url);
      const expectedSize = request.expectedSize;
      const expectedSha256 = request.expectedSha256;
      if (!expectedSize || !expectedSha256) throw new Error("local package requires expected size and sha256");
      const source = fileURLToPath(request.url);
      if (allowedRoots.length > 0) {
        const resolvedSource = path.resolve(source);
        const inside = allowedRoots.some((root) => {
          const base = path.resolve(root);
          return resolvedSource === base || resolvedSource.startsWith(base + path.sep);
        });
        if (!inside) throw new Error("local package source outside the allowed roots: " + source);
      }
      const stat = await fs.stat(source).catch(() => null);
      if (!stat || !stat.isFile()) throw new Error("local package missing: " + source);
      if (stat.size !== expectedSize) {
        throw new Error("local package size mismatch: " + String(stat.size) + " != " + String(expectedSize));
      }
      await fs.mkdir(path.dirname(request.target), { recursive: true });
      // 先复制到临时名再改名，避免半个文件被当成已镜像成功。
      const staging = request.target + ".copying";
      await fs.copyFile(source, staging);
      const sha256 = await hashFile(staging);
      if (sha256 !== expectedSha256.toLowerCase()) {
        await fs.rm(staging, { force: true });
        throw new Error("local package checksum mismatch");
      }
      await fs.rename(staging, request.target);
      return { id: request.id, target: request.target, bytes: stat.size, sha256, fromCache: false };
    },
  };
}

export const localFileDownloader: DownloadPort = createLocalFileDownloader();

async function hashFile(file: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export class LocalRepo {
  constructor(private readonly deps: LocalRepoOptions) {}

  async manifestFile(): Promise<string> {
    return path.join(await resolve(this.deps.root), "manifest.json");
  }

  private desiredItems(input: RepoSyncInput): RepoManifestItem[] {
    const items: RepoManifestItem[] = [];
    for (const app of input.apps) {
      const latest = app.versions.find((v) => v.version === app.latestVersion) ?? app.versions[0];
      const versions = input.allVersions ? app.versions : latest ? [latest] : [];
      for (const version of versions) {
        const base = version.downloadUrl.split("?")[0] ?? version.downloadUrl;
        const fileName = base.split("/").pop() ?? "package.bin";
        const url =
          this.deps.urlBase && version.downloadUrl.startsWith("/")
            ? this.deps.urlBase.replace(/\/+$/, "") + version.downloadUrl
            : version.downloadUrl;
        items.push({
          appId: app.id,
          name: app.name,
          publisher: app.publisher,
          categoryId: app.categoryId,
          tags: app.tags,
          version: version.version,
          fileName,
          // appId 与 version 都是目录侧给的字符串：`safeName` 不拦点号也不拦正斜杠，
          // 单靠它拼得出 `../../evil`。落盘分量一律过 safePathSegment。
          relativePath: [safePathSegment(app.id), safePathSegment(version.version, "0") + extensionOf(version.downloadUrl)].join("/"),
          sizeBytes: version.sizeBytes,
          sha256: version.sha256,
          url,
          status: "pending",
          attempts: 0,
        });
      }
    }
    return items;
  }

  async sync(input: RepoSyncInput): Promise<RepoSyncReport> {
    const started = Date.now();
    const root = await resolve(this.deps.root);
    await fs.mkdir(root, { recursive: true });
    const manifestFile = path.join(root, "manifest.json");
    const previous = await this.readManifest(root);

    const items = this.desiredItems(input);
    const verify = this.deps.verify ?? "size";
    const report: RepoSyncReport = { root, manifestFile, saved: [], cached: [], failed: [], totalBytes: 0, durationMs: 0 };

    const queue = [...items];
    const workers = Array.from({ length: Math.max(1, this.deps.concurrency ?? 2) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        item.attempts = (previous.get(item.relativePath)?.attempts ?? 0) + 1;
        try {
          // 越界的 relativePath 只让这条失败，别让一个坏条目把整轮 sync 抛掉。
          const target = joinWithinRoot(root, item.relativePath);
          const stat = await fs.stat(target).catch(() => null);
          let cached = Boolean(stat && stat.size === item.sizeBytes);
          if (cached && verify === "sha256") cached = (await hashFile(target)) === item.sha256;
          if (!cached) {
            await fs.mkdir(path.dirname(target), { recursive: true });
            await this.deps.downloader.download({
              id: item.appId + "@" + item.version,
              url: item.url,
              target,
              expectedSha256: item.sha256,
              expectedSize: item.sizeBytes,
            });
          }
          item.status = "saved";
          item.savedAt = cached ? previous.get(item.relativePath)?.savedAt ?? new Date().toISOString() : new Date().toISOString();
          delete item.error;
          report.totalBytes += item.sizeBytes;
          (cached ? report.cached : report.saved).push(item.appId + "@" + item.version);
        } catch (err) {
          item.status = "failed";
          item.error = err instanceof Error ? err.message : String(err);
          report.failed.push({ appId: item.appId, version: item.version, error: item.error });
        }
      }
    });
    await Promise.all(workers);

    const manifest: RepoManifest = {
      formatVersion: 1,
      generatedAt: new Date().toISOString(),
      root,
      catalog: { apps: input.apps.map(({ versions: _versions, ...summary }) => summary), categories: [...input.categories] },
      items,
    };
    await writeAtomic(manifestFile, JSON.stringify(manifest, null, 2));
    report.durationMs = Date.now() - started;
    return report;
  }

  private async readManifest(root: string): Promise<Map<string, RepoManifestItem>> {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8")) as RepoManifest;
      return new Map(parsed.items.map((item) => [item.relativePath, item]));
    } catch {
      return new Map();
    }
  }

  /** 只读盘点：按当前磁盘事实（文件存在 + 大小/校验）重算每个条目的状态。 */
  async status(options: { verify?: "size" | "sha256" } = {}): Promise<RepoStatus> {
    const root = await resolve(this.deps.root);
    const manifestFile = path.join(root, "manifest.json");
    let parsed: RepoManifest | null = null;
    try {
      parsed = JSON.parse(await fs.readFile(manifestFile, "utf8")) as RepoManifest;
    } catch {
      return { root, manifestFile, manifestExists: false, saved: 0, failed: 0, pending: 0, totalBytes: 0, items: [] };
    }
    const verify = options.verify ?? this.deps.verify ?? "size";
    let saved = 0;
    let failed = 0;
    let pending = 0;
    let totalBytes = 0;
    for (const item of parsed.items) {
      let target: string;
      try {
        target = joinWithinRoot(root, item.relativePath);
      } catch {
        // 清单被篡改指向仓库外时，不去 stat 外面的文件，直接按未落盘处理。
        item.status = "pending";
        pending += 1;
        continue;
      }
      const stat = await fs.stat(target).catch(() => null);
      const intact = Boolean(stat && stat.size === item.sizeBytes && (verify !== "sha256" || (await hashFile(target)) === item.sha256));
      if (intact) {
        item.status = "saved";
        saved += 1;
        totalBytes += item.sizeBytes;
      } else if (item.status === "failed") {
        failed += 1;
      } else {
        item.status = "pending";
        pending += 1;
      }
    }
    return { root, manifestFile, manifestExists: true, saved, failed, pending, totalBytes, items: parsed.items };
  }
}

async function writeAtomic(file: string, body: string): Promise<void> {
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, file);
}
