import { createHash, randomBytes, verify as verifySignature } from "node:crypto";
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
  /** 给了就由 sync() 先拉远端清单，apps/categories 取自 manifest.catalog。 */
  manifest?: RepoManifestSource;
}

export interface RepoSyncInput {
  apps: readonly AppDetail[];
  categories: readonly Category[];
  /** 默认只保存每个应用的最新版；打开后保存全部历史版本。 */
  allVersions?: boolean;
}

/**
 * sync 的输入源：本机目录快照，或一份远端清单。
 * 二者同构——manifest.items 就是 RepoManifestItem[]，所以不需要另起一条流水线。
 */
export type RepoSyncSource = RepoSyncInput | { manifest: RepoManifest; allVersions?: boolean };

function resolve(root: string | (() => Promise<string> | string)): Promise<string> {
  return typeof root === "string" ? Promise.resolve(root) : Promise.resolve(root()).then((value) => value);
}

/** 由 appId/version/downloadUrl 重建仓库内相对落盘路径；sync 镜像与离线 resolve 取包共用，避免两处漂移。 */
export function relativePathOf(appId: string, version: string, downloadUrl: string): string {
  return [safePathSegment(appId), safePathSegment(version, "0") + extensionOf(downloadUrl)].join("/");
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
      // staging 名必须唯一：写死 `<target>.copying` 时，两个宿主并发镜像同一个包会踩同一个文件
      // （一方按自己的校验值删掉另一方正在写的东西，另一方 rename 拿到 ENOENT），
      // 而且一次崩溃留下的残骸会把之后每一轮镜像都打死——实测 copyfile 报 EPERM，
      // 看起来却像源包坏了。校验也只对自己那份独占的 staging 做，校验值才等于将要落盘的字节。
      const staging = request.target + "." + process.pid + "." + randomBytes(4).toString("hex") + ".copying";
      try {
        await fs.copyFile(source, staging);
        const sha256 = await hashFile(staging);
        if (sha256 !== expectedSha256.toLowerCase()) throw new Error("local package checksum mismatch");
        // Windows 上 rename 覆盖被别的过程持有的目标不是原子替换而是 EPERM，要有界重试。
        let lastError: unknown;
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            await fs.rename(staging, request.target);
            lastError = undefined;
            break;
          } catch (err) {
            lastError = err;
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
          }
        }
        if (lastError) throw lastError;
        return { id: request.id, target: request.target, bytes: stat.size, sha256, fromCache: false };
      } catch (err) {
        await fs.rm(staging, { force: true, maxRetries: 3, retryDelay: 20 }).catch(() => undefined);
        throw err;
      }
    },
  };
}

export const localFileDownloader: DownloadPort = createLocalFileDownloader();

/** http(s) 分支的 URL 前缀白名单语义与 file 分支相反：空 = 拒绝一切 http(s)。 */
export interface RepoDownloaderOptions {
  /** file:// 分支的来源根白名单（沿用现有语义：空 = 不限制）。 */
  allowedFileRoots?: readonly string[];
  allowedUrlPrefixes?: readonly string[];
  /** 网络分支；不传时 http(s) 一律拒绝。 */
  http?: DownloadPort;
}

/**
 * 逐段比对 URL 前缀。不能用 startsWith：`https://good.com.evil.net/x` 是以
 * `https://good.com` 开头的，那样白名单形同虚设。
 */
export function urlWithinPrefix(url: string, prefixes: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return prefixes.some((raw) => {
    let base: URL;
    try {
      base = new URL(raw);
    } catch {
      return false;
    }
    if (base.protocol !== parsed.protocol || base.host !== parsed.host) return false;
    const root = base.pathname.endsWith("/") ? base.pathname : base.pathname + "/";
    return parsed.pathname === base.pathname || parsed.pathname.startsWith(root);
  });
}

/**
 * 仓库下载端口：file:// 走本机复制（size+sha256 与来源根校验都在里面），http(s) 走网络分支。
 * 放行条件刻意收紧：
 * 1. 前缀白名单为空时 http(s) 一律拒绝——否则"放开网络"等于默认放行任意外网 URL；
 * 2. 必须同时给 expected size and sha256——远端清单不可信，缺一即拒。
 */
export function createRepoDownloader(options: RepoDownloaderOptions = {}): DownloadPort {
  const file = createLocalFileDownloader(options.allowedFileRoots ?? []);
  const prefixes = options.allowedUrlPrefixes ?? [];
  return {
    async download(request) {
      if (request.url.startsWith("file://")) return file.download(request);
      if (!/^https?:\/\//i.test(request.url)) {
        throw new Error("repo package source must be file:// or http(s)://: " + request.url);
      }
      if (!urlWithinPrefix(request.url, prefixes)) {
        throw new Error("repo package url outside the allowed prefixes: " + request.url);
      }
      if (!options.http) throw new Error("no http downloader configured for " + request.url);
      if (!request.expectedSize || !request.expectedSha256) {
        throw new Error("remote package requires expected size and sha256");
      }
      return options.http.download(request);
    },
  };
}

/** 远端清单来源。给了 sha256 就必校验字节，给了 publicKey 就必验签名。 */
export interface RepoManifestSource {
  url: string;
  sha256?: string;
  publicKey?: string;
  allowedUrlPrefixes?: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const MANIFEST_MAX_BYTES = 32 * 1024 * 1024;

/** 拉远端清单并做前缀/大小/校验和/结构校验；任一环节不过都 throw，由调用方决定降级。 */
export async function fetchRepoManifest(source: RepoManifestSource): Promise<RepoManifest> {
  const prefixes = source.allowedUrlPrefixes ?? [];
  if (!urlWithinPrefix(source.url, prefixes)) {
    throw new Error("repo manifest url outside the allowed prefixes: " + source.url);
  }
  const fetchImpl = source.fetchImpl ?? fetch;
  const response = await fetchImpl(source.url, { signal: AbortSignal.timeout(source.timeoutMs ?? 15000) });
  if (!response.ok) throw new Error("repo manifest fetch failed: HTTP " + String(response.status));
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MANIFEST_MAX_BYTES) throw new Error("repo manifest too large: " + String(bytes.byteLength));
  if (source.sha256) {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== source.sha256.toLowerCase()) throw new Error("repo manifest checksum mismatch");
  }
  const parsed = JSON.parse(bytes.toString("utf8")) as RepoManifest & { signature?: string };
  if (parsed.formatVersion !== 1) throw new Error("unsupported repo manifest formatVersion: " + String(parsed.formatVersion));
  if (source.publicKey) {
    if (!parsed.signature) throw new Error("repo manifest missing signature");
    const ok = verifySignature(null, bytes, source.publicKey, Buffer.from(parsed.signature, "base64"));
    if (!ok) throw new Error("repo manifest signature mismatch");
  }
  for (const item of parsed.items ?? []) {
    if (!urlWithinPrefix(item.url, prefixes)) {
      throw new Error("repo manifest item url outside the allowed prefixes: " + String(item.url));
    }
    // 清单里的 relativePath 是不可信输入，越界由 sync 的 joinWithinRoot 兜底，这里先挡一道。
    if (item.relativePath.includes("..")) throw new Error("repo manifest item path escapes: " + item.relativePath);
    if (!(item.sizeBytes > 0)) throw new Error("repo manifest item missing sizeBytes: " + item.appId);
    if (!/^[0-9a-f]{64}$/i.test(item.sha256 ?? "")) throw new Error("repo manifest item missing sha256: " + item.appId);
  }
  return parsed;
}

/** 从环境变量读远端清单配置；CATALOG_MANIFEST_URL 没给就不启用在线拉取。 */
export function repoManifestSourceFromEnv(env: NodeJS.ProcessEnv = process.env): RepoManifestSource | undefined {
  const url = env.CATALOG_MANIFEST_URL?.trim();
  if (!url) return undefined;
  return {
    url,
    sha256: env.REPO_MANIFEST_SHA256?.trim() || undefined,
    publicKey: env.REPO_MANIFEST_PUBLIC_KEY?.trim() || undefined,
    allowedUrlPrefixes: (env.REPO_ALLOWED_URL_PREFIXES ?? "").split(",").map((entry) => entry.trim()).filter(Boolean),
  };
}

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
          relativePath: relativePathOf(app.id, version.version, version.downloadUrl),
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

  async sync(input: RepoSyncSource): Promise<RepoSyncReport> {
    const started = Date.now();
    const root = await resolve(this.deps.root);
    await fs.mkdir(root, { recursive: true });
    const manifestFile = path.join(root, "manifest.json");
    const previous = await this.readManifest(root);

    let items: RepoManifestItem[];
    let catalogApps: AppSummary[];
    let catalogCategories: Category[];
    if ("manifest" in input) {
      items = input.manifest.items.map((item) => ({ ...item, status: "pending" as const }));
      catalogApps = input.manifest.catalog.apps;
      catalogCategories = input.manifest.catalog.categories;
    } else {
      items = this.desiredItems(input);
      catalogApps = input.apps.map(({ versions: _versions, ...summary }) => summary);
      catalogCategories = [...input.categories];
    }
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
      catalog: { apps: catalogApps, categories: catalogCategories },
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

  /**
   * 离线安装取包：本地仓库已镜像该 (appId, version) 且磁盘文件大小/校验通过时，
   * 返回其绝对路径与目录记录的 sha256/size，供安装编排器直接复用、跳过网络下载。
   * 未镜像、文件缺失或被篡改则返回 null，调用方回退到网络下载。
   */
  async resolve(
    appId: string,
    version: string,
    downloadUrl: string,
    verify: "size" | "sha256" = this.deps.verify ?? "size",
  ): Promise<{ file: string; sha256: string; size: number } | null> {
    const root = await resolve(this.deps.root);
    const manifest = await this.readManifest(root);
    const rel = relativePathOf(appId, version, downloadUrl);
    const item = manifest.get(rel);
    if (!item) return null;
    const file = joinWithinRoot(root, rel);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) return null;
    if (stat.size !== item.sizeBytes) return null;
    if (verify === "sha256") {
      const actual = await hashFile(file);
      if (actual !== item.sha256.toLowerCase()) return null;
    }
    return { file, sha256: item.sha256, size: item.sizeBytes };
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
  // 临时名必须唯一：仓库根是 CLI 与界面宿主共用的，固定 `<file>.tmp` 有两个必死后果——
  // 两个写者踩同一个文件（先 rename 的一方把另一方还没写完的内容搬成正式清单，后一方 ENOENT），
  // 以及任何一次崩溃留下的残留 `.tmp` 会从此顶死后续每一次写入（实测撞在同名目录上是 EISDIR）。
  // Windows 上 rename 覆盖被别的进程持有的目标还会 EPERM，所以同样要有界重试；
  // 失败时把自己那份临时件清掉，否则它就是下一轮的残留。#27 在缓存与运行配置上踩过同一脚。
  const tmp = file + "." + process.pid + "." + randomBytes(4).toString("hex") + ".tmp";
  try {
    await fs.writeFile(tmp, body, "utf8");
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await fs.rename(tmp, file);
        return;
      } catch (err) {
        lastError = err;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }
    throw lastError;
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
