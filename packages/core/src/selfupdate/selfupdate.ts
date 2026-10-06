import { promises as fs } from "node:fs";
import path from "node:path";
import { compare } from "../util/semver.ts";
import { applyUpdate, fileSha256, pruneBackups, type SwapOutcome } from "./updater.ts";
import type { DownloadPort } from "../orchestrator/installer.ts";

export interface SelfUpdateManifest {
  version: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  releaseNotes: string;
  /** 低于此版本的客户端不允许直接换版，需要先走全量安装。 */
  minCurrentVersion?: string;
  mandatory?: boolean;
  /** 灰度比例 0..100，按用户标识哈希决定命中，保证同一用户结果稳定。 */
  rolloutPercent?: number;
}

export interface StagedUpdate {
  version: string;
  packagePath: string;
  stagedAt: string;
  sha256: string;
}

export interface HealthMarker {
  expectedVersion: string;
  startedAt: string;
  healthy: boolean;
  /**
   * 写标记时在用的可执行文件摘要：recover() 用它判断「这次到底换没换成」。
   * 没有这个字段（旧标记）时不做回滚，只丢弃 pending——因为光有 pending 并不能证明
   * 二进制被动过，凭它去恢复一份旧备份就是一次静默降级。
   */
  preSwapSha256?: string | null;
}

export interface SelfUpdaterDeps {
  downloader: DownloadPort;
  appDir: string;
  stagingDir: string;
  currentVersion: string;
  executableName?: string;
  userId?: string;
  now?: () => Date;
}

const PENDING = "update-pending.json";
const BACKUP = "update-backup";
const HEALTH = "update-health.json";

export type CheckResult =
  | { state: "up-to-date"; currentVersion: string }
  | { state: "available"; version: string; mandatory: boolean }
  | { state: "too-old"; version: string; required: string }
  | { state: "not-in-rollout"; version: string; percent: number };

export class SelfUpdater {
  private readonly deps: SelfUpdaterDeps;

  constructor(deps: SelfUpdaterDeps) {
    this.deps = deps;
  }

  private get exeName(): string {
    return this.deps.executableName ?? "AppCenter.exe";
  }

  private get pendingFile(): string {
    return path.join(this.deps.stagingDir, PENDING);
  }

  private get healthFile(): string {
    return path.join(this.deps.stagingDir, HEALTH);
  }

  private get backupDir(): string {
    return path.join(this.deps.stagingDir, BACKUP);
  }

  /** 灰度命中判定：同一 userId 对同一版本始终得到相同结果，避免来回抖动。 */
  inRollout(manifest: SelfUpdateManifest): boolean {
    const percent = manifest.rolloutPercent ?? 100;
    if (percent >= 100) return true;
    if (percent <= 0) return false;
    const key = (this.deps.userId ?? "anonymous") + "@" + manifest.version;
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    return hash % 100 < percent;
  }

  check(manifest: SelfUpdateManifest): CheckResult {
    if (manifest.minCurrentVersion && compare(this.deps.currentVersion, manifest.minCurrentVersion) < 0) {
      return { state: "too-old", version: manifest.version, required: manifest.minCurrentVersion };
    }
    if (compare(manifest.version, this.deps.currentVersion) <= 0) {
      return { state: "up-to-date", currentVersion: this.deps.currentVersion };
    }
    if (!this.inRollout(manifest)) {
      return { state: "not-in-rollout", version: manifest.version, percent: manifest.rolloutPercent ?? 0 };
    }
    return { state: "available", version: manifest.version, mandatory: Boolean(manifest.mandatory) };
  }

  /** 下载并校验到暂存区，写 pending 标记；此时不影响正在运行的版本。 */
  async stage(manifest: SelfUpdateManifest): Promise<StagedUpdate> {
    await fs.mkdir(this.deps.stagingDir, { recursive: true });
    const packagePath = path.join(this.deps.stagingDir, "appcenter-setup-" + manifest.version + ".exe");
    const result = await this.deps.downloader.download({
      id: "selfupdate@" + manifest.version,
      url: manifest.url,
      target: packagePath,
      expectedSha256: manifest.sha256,
      expectedSize: manifest.sizeBytes,
    });
    const staged: StagedUpdate = {
      version: manifest.version,
      packagePath: result.target,
      stagedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      sha256: manifest.sha256,
    };
    await fs.writeFile(this.pendingFile, JSON.stringify(staged, null, 2), "utf8");
    return staged;
  }

  /**
   * 换版：先核对调用方传来的暂存信息与磁盘上的 pending 标记一致（否则等于让调用方
   * 指定任意文件覆盖主程序），再写健康标记，最后走 applyUpdate 的
   * 校验→备份→覆盖→健康检查→失败回滚。
   * 没给 healthCheck 时不再是「默认健康」，而是当场复核换进去的内容确实是暂存包。
   */
  async apply(staged: StagedUpdate, healthCheck?: () => Promise<boolean>): Promise<SwapOutcome> {
    const pending = await this.readPending();
    if (!pending) return this.failed("no pending update marker; run stage() first");
    if (
      pending.version !== staged.version ||
      pending.sha256.toLowerCase() !== staged.sha256.toLowerCase() ||
      path.resolve(pending.packagePath) !== path.resolve(staged.packagePath)
    ) {
      return this.failed("staged update does not match the pending marker");
    }

    const targetPath = path.join(this.deps.appDir, this.exeName);
    const marker: HealthMarker = {
      expectedVersion: staged.version,
      startedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      healthy: false,
      preSwapSha256: await fileSha256(targetPath),
    };
    await fs.mkdir(this.deps.stagingDir, { recursive: true });
    await fs.writeFile(this.healthFile, JSON.stringify(marker, null, 2), "utf8");

    const outcome = await applyUpdate({
      stagedPath: staged.packagePath,
      targetPath,
      backupDir: this.backupDir,
      expectedSha256: staged.sha256,
      healthCheck: healthCheck ?? (async () => (await fileSha256(targetPath)) === staged.sha256.toLowerCase()),
      now: this.deps.now,
    });

    // pending 只在「确实换成了新版、等 commit() 确认」与「已回滚」之外都保持原样：
    // 安全靠的是下面的换版证据判据，而不是靠偷偷删标记（删了会把调用方看到的待确认状态一并抹掉）。
    if (outcome.rolledBack) await fs.rm(this.pendingFile, { force: true });
    if (outcome.swapped) await pruneBackups(this.backupDir, 3);
    return outcome;
  }

  private failed(message: string): SwapOutcome {
    return { swapped: false, rolledBack: false, backupPath: null, message };
  }

  /**
   * 由换版后真正跑起来的版本调用：pending 存在即代表"这次换版还没被确认"，
   * 确认后一律清除；有健康标记时顺带置为 healthy，供 recover 判断。
   */
  async commit(): Promise<void> {
    const health = await this.readHealth();
    if (health) await fs.writeFile(this.healthFile, JSON.stringify({ ...health, healthy: true }, null, 2), "utf8");
    await fs.rm(this.pendingFile, { force: true });
  }

  async readPending(): Promise<StagedUpdate | null> {
    try {
      return JSON.parse(await fs.readFile(this.pendingFile, "utf8")) as StagedUpdate;
    } catch {
      return null;
    }
  }

  async readHealth(): Promise<HealthMarker | null> {
    try {
      return JSON.parse(await fs.readFile(this.healthFile, "utf8")) as HealthMarker;
    } catch {
      return null;
    }
  }

  private async latestBackup(): Promise<string | null> {
    const entries = await fs.readdir(this.backupDir).catch(() => [] as string[]);
    const dated = await Promise.all(
      entries
        .filter((name) => name.endsWith(".bak"))
        .map(async (name) => ({ name, mtime: (await fs.stat(path.join(this.backupDir, name))).mtimeMs })),
    );
    dated.sort((a, b) => b.mtime - a.mtime);
    if (dated[0]) return path.join(this.backupDir, dated[0].name);
    const legacy = path.join(this.backupDir, this.exeName.replace(/\.exe$/i, "") + "-" + this.deps.currentVersion + ".exe");
    const exists = await fs.stat(legacy).catch(() => null);
    return exists ? legacy : null;
  }

  /** 启动时调用：pending 仍存在且未 commit，说明这次换版可能没被确认，按证据决定是否回滚备份。 */
  async recover(): Promise<{ rolledBack: boolean; version: string | null; message: string }> {
    const pending = await this.readPending();
    if (!pending) return { rolledBack: false, version: null, message: "no pending update" };
    const health = await this.readHealth();
    if (health?.healthy) {
      await fs.rm(this.pendingFile, { force: true });
      return { rolledBack: false, version: pending.version, message: "previous update already committed" };
    }
    // 光有 pending 不能证明二进制被动过：stage() 就会写 pending，用户不点「立即应用」也留着。
    // 拿这份证据去恢复旧备份，实际就是一次静默降级。两种「无换版证据」的情形都只说明原因，
    // 不删 pending——删除会连带抹掉调用方看到的待确认状态，安全靠的是这里不回滚，而不是靠删标记。
    if (!health) {
      return { rolledBack: false, version: pending.version, message: "staged update was never applied; nothing to roll back" };
    }
    if (health.preSwapSha256 !== undefined) {
      const current = await fileSha256(path.join(this.deps.appDir, this.exeName));
      if (current === health.preSwapSha256) {
        return { rolledBack: false, version: pending.version, message: "binary unchanged since staging; nothing to roll back" };
      }
    }
    const backup = await this.latestBackup();
    if (!backup) return { rolledBack: false, version: pending.version, message: "no backup available" };
    try {
      await fs.copyFile(backup, path.join(this.deps.appDir, this.exeName));
      await fs.rm(this.pendingFile, { force: true });
      return { rolledBack: true, version: pending.version, message: "restored " + path.basename(backup) };
    } catch (err) {
      return { rolledBack: false, version: pending.version, message: err instanceof Error ? err.message : String(err) };
    }
  }
}

export { applyUpdate, pruneBackups, type SwapOutcome } from "./updater.ts";
