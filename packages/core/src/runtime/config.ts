import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 跨进程共享的运行配置，以 %APPDATA% 下的配置文件落盘
 * （download_path 与 installer_cleanup）。UI、无头壳与引擎读的是同一份。
 */
export interface RuntimeConfig {
  downloadDir: string;
  installerCleanup: boolean;
  concurrency: number;
  updateCheckIntervalMinutes: number;
  autoStart: boolean;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  downloadDir: "",
  installerCleanup: true,
  concurrency: 2,
  updateCheckIntervalMinutes: 60,
  autoStart: false,
};

export interface RuntimeConfigIssue {
  field: keyof RuntimeConfig;
  reason: string;
  fallback: string | number | boolean;
}

export function sanitize(input: Partial<RuntimeConfig>): { config: RuntimeConfig; issues: RuntimeConfigIssue[] } {
  const issues: RuntimeConfigIssue[] = [];
  const clamp = <T extends number>(field: keyof RuntimeConfig, value: unknown, min: number, max: number, fallback: T): number => {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
      issues.push({ field, reason: "out of range " + String(min) + ".." + String(max), fallback });
      return fallback;
    }
    return Math.round(numeric);
  };
  return {
    config: {
      downloadDir: typeof input.downloadDir === "string" ? input.downloadDir.trim() : DEFAULT_RUNTIME_CONFIG.downloadDir,
      installerCleanup: typeof input.installerCleanup === "boolean" ? input.installerCleanup : DEFAULT_RUNTIME_CONFIG.installerCleanup,
      concurrency: clamp("concurrency", input.concurrency, 1, 8, DEFAULT_RUNTIME_CONFIG.concurrency),
      updateCheckIntervalMinutes: clamp("updateCheckIntervalMinutes", input.updateCheckIntervalMinutes, 5, 1440, DEFAULT_RUNTIME_CONFIG.updateCheckIntervalMinutes),
      autoStart: typeof input.autoStart === "boolean" ? input.autoStart : DEFAULT_RUNTIME_CONFIG.autoStart,
    },
    issues,
  };
}

export class RuntimeConfigStore {
  private cached: RuntimeConfig | null = null;
  private loading: Promise<RuntimeConfig> | null = null;

  constructor(private readonly file: string, defaults: Partial<RuntimeConfig> = {}) {
    this.base = { ...DEFAULT_RUNTIME_CONFIG, ...sanitize(defaults).config };
  }

  private readonly base: RuntimeConfig;

  get path(): string {
    return this.file;
  }

  async load(): Promise<RuntimeConfig> {
    if (this.cached) return this.cached;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<RuntimeConfig>;
        this.cached = sanitize({ ...this.base, ...raw }).config;
      } catch {
        this.cached = { ...this.base };
      }
      return this.cached;
    })();
    return this.loading;
  }

  /** 先写临时文件再改名，避免半截文件被另一个进程读到。 */
  async save(patch: Partial<RuntimeConfig>): Promise<{ config: RuntimeConfig; issues: RuntimeConfigIssue[] }> {
    const current = await this.load();
    const merged = sanitize({ ...current, ...patch });
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = this.file + ".tmp";
    await writeFile(temp, JSON.stringify(merged.config, null, 2), "utf8");
    await rename(temp, this.file);
    this.cached = merged.config;
    this.loading = null;
    return merged;
  }

  async packageDir(): Promise<string> {
    const config = await this.load();
    return config.downloadDir || path.dirname(this.file);
  }
}
