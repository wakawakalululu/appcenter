import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface IconJob {
  /** 稳定标识，通常是应用 id 或注册表项名。 */
  key: string;
  /** 图标来源：exe / dll / ico 文件路径。 */
  source: string;
}

export interface IconResult {
  key: string;
  file: string | null;
  ok: boolean;
  message: string;
}

export interface IconIndex {
  version: 1;
  updatedAt: string;
  /** key → 缓存文件名 */
  icons: Record<string, string>;
  /** 提取失败的来源，避免每次刷新都重试 */
  failed: Record<string, string>;
}

export type ExtractIcons = (jobs: readonly IconJob[], cacheDir: string) => Promise<IconResult[]>;

const INDEX_FILE = "icon-index.json";

function safeKey(key: string): string {
  return key.replace(/[^0-9A-Za-z._-]+/g, "_").slice(0, 64);
}

/**
 * 图标缓存：把 exe/dll/ico 里的图标提取成 PNG 并建立索引。
 * 统一抽取与缓存图标（对应系统图标缓存思路），
 * 区别是索引只存 key→文件映射，不缓存网络图片。
 */
export class IconCache {
  private readonly cacheDir: string;
  private readonly extract: ExtractIcons;
  private index: IconIndex = { version: 1, updatedAt: "", icons: {}, failed: {} };
  private loaded = false;
  private inflight: Promise<IconIndex> | null = null;

  constructor(options: { cacheDir: string; extract?: ExtractIcons }) {
    this.cacheDir = options.cacheDir;
    this.extract = options.extract ?? extractIconsViaPowerShell;
  }

  async load(): Promise<IconIndex> {
    if (this.loaded) return this.index;
    try {
      this.index = JSON.parse(await readFile(path.join(this.cacheDir, INDEX_FILE), "utf8")) as IconIndex;
    } catch {
      this.index = { version: 1, updatedAt: "", icons: {}, failed: {} };
    }
    this.loaded = true;
    return this.index;
  }

  urlFor(key: string): string | null {
    const file = this.index.icons[safeKey(key)];
    return file ? "/icons/" + encodeURIComponent(file) : null;
  }

  /** 只补提取缺失的图标；同一批并发调用合并为一次提取。 */
  async sync(jobs: readonly IconJob[]): Promise<IconIndex> {
    const index = await this.load();
    const pending = jobs.filter((job) => job.key && job.source && !index.icons[safeKey(job.key)] && !index.failed[safeKey(job.key)]);
    if (pending.length === 0) return index;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        await mkdir(this.cacheDir, { recursive: true });
        const results = await this.extract(pending, this.cacheDir);
        for (const result of results) {
          const key = safeKey(result.key);
          if (result.ok && result.file) this.index.icons[key] = path.basename(result.file);
          else this.index.failed[key] = result.message || "extract failed";
        }
        this.index.updatedAt = new Date().toISOString();
        await writeFile(path.join(this.cacheDir, INDEX_FILE), JSON.stringify(this.index, null, 2), "utf8");
        return this.index;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  async forget(key: string): Promise<void> {
    await this.load();
    delete this.index.icons[safeKey(key)];
    delete this.index.failed[safeKey(key)];
    await writeFile(path.join(this.cacheDir, INDEX_FILE), JSON.stringify(this.index, null, 2), "utf8");
  }

  get directory(): string {
    return this.cacheDir;
  }
}

/** 从带引号的注册表值或 DisplayIcon 里取出真正的文件路径。 */
export function iconSourceOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const stripped = raw.replace(/"/g, "").trim();
  if (!stripped) return null;
  const withoutIndex = stripped.split(",")[0]?.trim() ?? stripped;
  const head = withoutIndex.split(/\s+(?=[/-])/)[0] ?? withoutIndex;
  return /\.(exe|dll|ico|lnk)$/i.test(head) ? head : null;
}

/**
 * 用系统自带的 GDI+ 批量提取图标：清单与结果都走文件，
 * 因为 140 个应用的路径 base64 后远超 Windows 命令行长度上限（spawn ENAMETOOLONG）。
 */
export async function extractIconsViaPowerShell(jobs: readonly IconJob[], cacheDir: string): Promise<IconResult[]> {
  if (jobs.length === 0) return [];
  await mkdir(cacheDir, { recursive: true });
  const stamp = Date.now().toString(36);
  const manifestFile = path.join(cacheDir, "manifest." + stamp + ".json");
  const resultFile = path.join(cacheDir, "result." + stamp + ".json");
  const payload = jobs.map((job) => ({ key: safeKey(job.key), source: job.source, out: path.join(cacheDir, safeKey(job.key) + ".png") }));
  await writeFile(manifestFile, JSON.stringify(payload), "utf8");
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "extract-icons.ps1");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-ManifestFile", manifestFile, "-ResultFile", resultFile],
      { windowsHide: true },
    );
    let err = "";
    child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      void rm(manifestFile, { force: true });
      if (code === 0) resolve();
      else reject(new Error("icon extractor exit " + String(code) + (err ? ": " + err.slice(0, 200) : "")));
    });
  });

  let rows: { key: string; file: string | null; ok: boolean; message: string }[] = [];
  try {
    const raw = await readFile(resultFile, "utf8");
    // PowerShell 的 UTF8 编码会带 BOM
    rows = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as typeof rows;
  } finally {
    void rm(resultFile, { force: true });
  }
  const byHash = new Map(rows.map((row) => [row.key, row]));
  return jobs.map((job) => {
    const row = byHash.get(safeKey(job.key));
    return row ? { key: job.key, file: row.file, ok: row.ok, message: row.message } : { key: job.key, file: null, ok: false, message: "not processed" };
  });
}

export async function copyIcon(source: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
}
