import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

export interface DownloadRequest {
  id: string;
  url: string;
  /** 最终落地路径。 */
  target: string;
  expectedSha256?: string;
  expectedSize?: number;
  headers?: Record<string, string>;
}

export interface DownloadProgress {
  id: string;
  received: number;
  total: number;
  speed: number;
  resumed: boolean;
}

export interface DownloadResult {
  id: string;
  target: string;
  bytes: number;
  sha256: string;
  fromCache: boolean;
}

interface SidecarState {
  url: string;
  size: number;
  etag: string | null;
  received: number;
}

export interface DownloaderOptions {
  concurrency?: number;
  attempts?: number;
  baseDelayMs?: number;
  /** 续传状态落盘间隔，太小会拖慢下载。 */
  sidecarFlushBytes?: number;
  /** 注入以便测试。 */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
}

export class DownloadError extends Error {
  constructor(
    readonly kind: "http-status" | "checksum-mismatch" | "size-mismatch" | "incomplete" | "network" | "cancelled" | "landing",
    message: string,
    readonly detail: Record<string, string | number> = {},
  ) {
    super(kind + ": " + message);
  }
}

/**
 * 可重试的 HTTP 状态：限流、超时与网关类故障换个时刻就成；
 * 其余 4xx（404/403 等）重试只是白耗一轮，留在 fatal 里。
 */
const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** 落地原地重试次数：50/100/200ms 累计约 350ms，够覆盖杀软那种一闪而过的占用。 */
const LANDING_ATTEMPTS = 4;

const partPath = (target: string) => target + ".part";
const statePath = (target: string) => target + ".part.json";

async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

async function loadSidecar(target: string, url: string): Promise<SidecarState | null> {
  try {
    const state = JSON.parse(await fs.readFile(statePath(target), "utf8")) as SidecarState;
    if (state.url !== url) return null;
    const part = await fs.stat(partPath(target)).catch(() => null);
    if (!part || part.size !== state.received) return null;
    return state;
  } catch {
    return null;
  }
}

async function saveSidecar(target: string, state: SidecarState): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(statePath(target), JSON.stringify(state), "utf8");
}

async function dropSidecar(target: string): Promise<void> {
  await fs.rm(partPath(target), { force: true });
  await fs.rm(statePath(target), { force: true });
}

function backoff(attempt: number, base: number): number {
  const capped = Math.min(base * 2 ** attempt, 30000);
  return Math.round(capped / 2 + Math.random() * (capped / 2));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DownloadError("cancelled", "aborted during backoff"));
      },
      { once: true },
    );
  });
}

/**
 * 断点续传下载器。Range 可用时从 .part 续传，否则整段重下；
 * 体积与 sha256 校验通过后原子改名到 target，失败时保留 .part 供下次续传。
 */
export class Downloader {
  private concurrency: number;
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onProgress?: (p: DownloadProgress) => void;
  private readonly signal?: AbortSignal;
  private readonly inFlight = new Map<string, Promise<DownloadResult>>();
  private slots: number;
  private readonly waiters: (() => void)[] = [];
  private readonly sidecarFlushBytes: number;

  constructor(options: DownloaderOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.attempts = Math.max(1, options.attempts ?? 4);
    this.baseDelayMs = options.baseDelayMs ?? 300;
    this.sidecarFlushBytes = Math.max(256, options.sidecarFlushBytes ?? 1048576);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onProgress = options.onProgress;
    this.signal = options.signal;
    this.slots = this.concurrency;
  }

  /** 运行期改并发：降档只影响未分配名额，升档唤醒排队中的请求。 */
  setConcurrency(value: number): void {
    const next = Math.max(1, Math.min(8, Math.round(value)));
    const delta = next - this.concurrency;
    this.concurrency = next;
    if (delta > 0) {
      for (let i = 0; i < delta; i++) {
        const waiter = this.waiters.shift();
        if (!waiter) {
          this.slots++;
          continue;
        }
        waiter();
      }
    } else {
      this.slots = Math.max(0, this.slots + delta);
    }
  }

  /**
   * 同一「id + url + target」的并发请求复用同一个 Promise。
   * 只按 id 去重是错的：id 由调用方给（`appId@version`），换 packageRoot 或换源重下时
   * id 不变而目标变了，第二个请求会直接拿到第一个的结果，自己的文件根本没下。
   */
  download(request: DownloadRequest): Promise<DownloadResult> {
    const key = request.id + "\u0000" + request.url + "\u0000" + request.target;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const task = this.withSlot(() => this.run(request, key));
    this.inFlight.set(key, task);
    void task.catch(() => this.inFlight.delete(key));
    return task;
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.slots > 0) {
      this.slots--;
    } else {
      // 排队途中被取消必须当场落败：旧实现只 push 了一个 resolve，取消要等前一个下载
      // 结束才轮得到它失败——前一个要是卡住，取消就永远不生效。
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new DownloadError("cancelled", "aborted while queued"));
        };
        const waiter = (): void => {
          this.signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        this.signal?.addEventListener("abort", onAbort, { once: true });
        this.waiters.push(waiter);
      });
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.slots++;
    }
  }

  private async run(request: DownloadRequest, key: string): Promise<DownloadResult> {
    if (this.signal?.aborted) throw new DownloadError("cancelled", "aborted before start");
    try {
      return await this.attempt(request);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async targetValid(request: DownloadRequest): Promise<DownloadResult | null> {
    const stat = await fs.stat(request.target).catch(() => null);
    if (!stat) return null;
    if (request.expectedSize !== undefined && stat.size !== request.expectedSize) return null;
    const sha = await sha256OfFile(request.target);
    if (request.expectedSha256 && sha !== request.expectedSha256.toLowerCase()) return null;
    await dropSidecar(request.target);
    return { id: request.id, target: request.target, bytes: stat.size, sha256: sha, fromCache: true };
  }

  private async attempt(request: DownloadRequest): Promise<DownloadResult> {
    const cached = await this.targetValid(request);
    if (cached) return cached;

    let lastError: unknown = null;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      try {
        return await this.transfer(request);
      } catch (err) {
        lastError = err;
        const httpStatus = err instanceof DownloadError && err.kind === "http-status" ? Number(err.detail.status) : 0;
        const fatal =
          err instanceof DownloadError &&
          (err.kind === "cancelled" ||
            err.kind === "checksum-mismatch" ||
            err.kind === "size-mismatch" ||
            // 落地失败重下也解决不了：.part 已经校验通过，问题在目标位动不了。
            err.kind === "landing" ||
            (err.kind === "http-status" && !RETRYABLE_HTTP_STATUS.has(httpStatus)));
        if (fatal) throw err;
        if (attempt < this.attempts - 1) await sleep(backoff(attempt, this.baseDelayMs), this.signal);
      }
    }
    throw lastError instanceof Error ? lastError : new DownloadError("network", "unknown failure");
  }

  private async transfer(request: DownloadRequest): Promise<DownloadResult> {
    await fs.mkdir(path.dirname(request.target), { recursive: true });
    const part = partPath(request.target);
    const resume = await loadSidecar(request.target, request.url);
    const offset = resume?.received ?? 0;
    const headers: Record<string, string> = { ...request.headers };
    if (offset > 0) {
      headers["Range"] = "bytes=" + String(offset) + "-";
      // 只发 Range 不发 If-Range：服务端换了文件也照样给一段新内容，拼起来就是
      // 新旧混合体——带 sha256 时表现为校验失败白下一半，不带时就静默落地。
      if (resume?.etag) headers["If-Range"] = resume.etag;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(request.url, { headers, signal: this.signal });
    } catch (err) {
      if (this.signal?.aborted) throw new DownloadError("cancelled", "aborted during request");
      throw new DownloadError("network", err instanceof Error ? err.message : String(err));
    }
    if (!response.ok && response.status !== 206) {
      throw new DownloadError("http-status", "status " + String(response.status), { status: response.status });
    }

    const totalHeader = response.headers.get("content-range")?.split("/")[1] ?? response.headers.get("content-length");
    const size = Number(totalHeader ?? resume?.size ?? request.expectedSize ?? 0) || 0;
    const startFrom = response.status === 206 ? offset : 0;
    if (startFrom === 0 && offset > 0) {
      await fs.rm(part, { force: true });
      await fs.rm(statePath(request.target), { force: true });
    }
    // 服务端没理会 If-Range、照样用新内容回了 206：这时续传必错，丢掉 .part 重来
    // （incomplete 不在 fatal 之列，外层会立刻再试一轮，那一轮就是全量下载）。
    const remoteEtag = response.headers.get("etag");
    if (startFrom > 0 && resume?.etag && remoteEtag && remoteEtag !== resume.etag) {
      await dropSidecar(request.target);
      throw new DownloadError("incomplete", "remote changed since " + String(offset) + " bytes (etag " + resume.etag + " -> " + remoteEtag + ")");
    }
    if (!response.body) throw new DownloadError("network", "empty response body");

    let received = startFrom;
    const startedAt = Date.now();
    let sinceFlush = 0;
    const out = await fs.open(part, startFrom > 0 ? "r+" : "w");
    try {
      if (startFrom === 0) await out.truncate(0);
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.signal?.aborted) throw new DownloadError("cancelled", "aborted mid-stream");
        const chunk = Buffer.from(value);
        let written = 0;
        while (written < chunk.length) {
          const { bytesWritten } = await out.write(chunk, written, chunk.length - written, received + written);
          written += bytesWritten > 0 ? bytesWritten : chunk.length - written;
        }
        received += written;
        sinceFlush += written;
        if (sinceFlush >= this.sidecarFlushBytes) {
          await saveSidecar(request.target, {
            url: request.url,
            size: Math.max(size, received),
            etag: response.headers.get("etag"),
            received,
          });
          sinceFlush = 0;
        }
        const elapsed = (Date.now() - startedAt) / 1000;
        this.onProgress?.({
          id: request.id,
          received,
          total: Math.max(size, received),
          speed: elapsed > 0 ? Math.round((received - startFrom) / elapsed) : 0,
          resumed: startFrom > 0,
        });
      }
    } finally {
      await out.close();
    }

    await saveSidecar(request.target, {
      url: request.url,
      size,
      etag: response.headers.get("etag"),
      received,
    });

    const finalSize = (await fs.stat(part)).size;
    if (size > 0 && finalSize < size) {
      throw new DownloadError("incomplete", "got " + String(finalSize) + " of " + String(size), {
        actual: finalSize,
        expected: size,
      });
    }
    if (request.expectedSize !== undefined && finalSize !== request.expectedSize) {
      throw new DownloadError("size-mismatch", "expected " + String(request.expectedSize) + " got " + String(finalSize));
    }
    const sha = await sha256OfFile(part);
    if (request.expectedSha256 && sha !== request.expectedSha256.toLowerCase()) {
      await dropSidecar(request.target);
      throw new DownloadError("checksum-mismatch", "sha256 mismatch", { expected: request.expectedSha256, actual: sha });
    }
    await this.land(part, request.target);
    await dropSidecar(request.target);
    return { id: request.id, target: request.target, bytes: finalSize, sha256: sha, fromCache: false };
  }

  /**
   * 把已校验通过的 .part 换成正式文件。这一段在 Windows 上是「目标位动不了」的高发区：
   * 杀软或上一轮安装进程占着目标时 rm 与 rename 都会 EPERM（#27 在同一条路径上实测过），
   * 目标位被同名目录占着时则是 EISDIR。
   *
   * 两处要紧的语义：
   * - 只做**原地**有限重试，绝不退回「重新下载」：字节已经下完并通过校验，重下只是白烧流量；
   *   旧写法抛的是裸 fs 错误，外层的 fatal 判据认不出来，于是整包被重试了三遍仍然失败。
   * - 失败收口成 DownloadError("landing") 并带上 code/target，让安装编排与界面能认出
   *   「这是落地故障」而不是「网络故障」。
   * - 不悄悄删掉目标位的目录或强闯占用：那属于「猜用户想要什么」，宁可留下 .part 让人再点一次。
   */
  private async land(part: string, target: string): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < LANDING_ATTEMPTS; attempt++) {
      try {
        await fs.rm(target, { force: true });
        await fs.rename(part, target);
        return;
      } catch (err) {
        lastError = err;
        if (this.signal?.aborted) break;
        if (attempt < LANDING_ATTEMPTS - 1) await new Promise<void>((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
      }
    }
    const detail: Record<string, string | number> = { target };
    const code = (lastError as { code?: string } | null)?.code;
    if (code) detail.code = String(code);
    if (lastError instanceof Error) detail.reason = lastError.message;
    throw new DownloadError("landing", "安装包落地失败，目标文件动不了", detail);
  }
}
