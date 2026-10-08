import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AppDetail, AppVersion } from "../catalog/types.ts";
import type { InstalledApp } from "../inventory/inventory.ts";
import type { DownloadProgress, DownloadResult } from "../download/downloader.ts";
import type { ExecutionResult } from "../runner/executor.ts";
import { buildPlan, classifyExit, parseUninstallCommand, type ExecutionRequest, type ProcessRunner } from "../runner/executor.ts";
import type { ApprovalWorkflow, Grant } from "../approval/workflow.ts";
import { scanResidue, type FileSystemProbe, type ResidueReport, type ScanEnv } from "../leftover/scan.ts";
import type { RegClient } from "../inventory/registry.ts";
import { compare } from "../util/semver.ts";
import { joinWithinRoot, safePathSegment } from "../util/paths.ts";
import { resolveInstalledInstance } from "../inventory/select.ts";

export type JobState =
  | "queued"
  | "downloading"
  | "verifying"
  | "awaiting_approval"
  | "installing"
  | "succeeded"
  | "needs_reboot"
  | "failed"
  | "cancelled";

export type JobKind = "install" | "uninstall";

export interface InstallJob {
  id: string;
  appId: string;
  appName: string;
  version: string;
  /** 安装成功后从注册表回读到的真实已装版本；缺失表示回读未命中。 */
  installedVersion?: string;
  state: JobState;
  phase: "install" | "upgrade";
  /** silent 走静默参数；manual 弹安装向导。 */
  mode?: "silent" | "manual";
  /** 卸载任务也会走到 succeeded，回执只该由安装/升级任务上报。 */
  kind?: JobKind;
  progress?: DownloadProgress;
  error?: string;
  history: { state: JobState; at: string }[];
  packagePath?: string;
  execution?: ExecutionResult;
  residue?: ResidueReport;
}

export interface CatalogSource {
  detail(appId: string): Promise<AppDetail | null>;
}

export interface InventorySource {
  installed(): Promise<InstalledApp[]>;
}

export interface DownloadPort {
  download(req: { id: string; url: string; target: string; expectedSha256?: string; expectedSize?: number }): Promise<DownloadResult>;
}

export interface GrantStore {
  get(appId: string, userId: string): Grant | undefined;
  clear(appId: string, userId: string): void;
}

export interface OrchestratorDeps {
  catalog: CatalogSource;
  inventory: InventorySource;
  downloader: DownloadPort;
  runner: ProcessRunner;
  approvals: ApprovalWorkflow;
  reg: RegClient;
  fs: FileSystemProbe;
  env: ScanEnv;
  packageDir: string | (() => Promise<string> | string);
  /** 安装成功后是否删掉下载下来的安装包（installer_cleanup 开关）。 */
  installerCleanup?: () => Promise<boolean> | boolean;
  userId: string;
  grantStore: GrantStore;
  /**
   * 本地仓库离线取包：命中返回已镜像包的绝对路径与校验，否则 null（回退网络）。
   * 由 facade 注入 `LocalRepo.resolve`；不传则安装永远走网络下载（旧行为不变）。
   */
  resolveLocalPackage?: (appId: string, version: string, downloadUrl: string) => Promise<{ file: string; sha256: string; size: number } | null>;
  /** 本地文件复制端口（file:// 复制 + 校验），把本地仓库的包落到安装临时目录。 */
  fileDownloader?: DownloadPort;
}

const BLOCKING: JobState[] = ["queued", "downloading", "verifying", "installing"];

export class InstallOrchestrator {
  readonly events = new EventEmitter();
  private readonly jobs = new Map<string, InstallJob>();
  private readonly queue: string[] = [];
  private running = 0;
  private readonly concurrency: number;

  constructor(
    private readonly deps: OrchestratorDeps,
    options: { concurrency?: number } = {},
  ) {
    this.concurrency = Math.max(1, options.concurrency ?? 1);
  }

  list(): InstallJob[] {
    return [...this.jobs.values()];
  }

  get(id: string): InstallJob | undefined {
    return this.jobs.get(id);
  }

  /** 订阅任务状态变化，UI 据此渲染进度条与托盘图标。 */
  onJob(listener: (job: InstallJob) => void): () => void {
    this.events.on("job", listener);
    return () => this.events.off("job", listener);
  }

  private transition(job: InstallJob, state: JobState, patch: Partial<InstallJob> = {}): void {
    job.state = state;
    Object.assign(job, patch);
    job.history.push({ state, at: new Date().toISOString() });
    this.events.emit("job", { ...job });
  }

  async enqueue(
    appId: string,
    options: { version?: string; phase?: "install" | "upgrade"; mode?: "silent" | "manual" } = {},
  ): Promise<InstallJob> {
    const detail = await this.deps.catalog.detail(appId);
    if (!detail) throw new Error("unknown app " + appId);
    const version = this.pickVersion(detail, options.version);
    const id = detail.id + "@" + version.version;
    const existing = this.jobs.get(id);
    if (existing && BLOCKING.includes(existing.state)) return existing;

    const job: InstallJob = {
      id,
      appId: detail.id,
      appName: detail.name,
      version: version.version,
      state: "queued",
      phase: options.phase ?? "install",
      mode: options.mode ?? detail.installMode ?? "silent",
      history: [],
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.transition(job, "queued");
    void this.drain().catch(() => undefined);
    return job;
  }

  /** 批量安装：落队后按并发闸执行，默认串行以避免安装器互相争用。 */
  async bulk(appIds: readonly string[]): Promise<InstallJob[]> {
    const jobs: InstallJob[] = [];
    for (const appId of appIds) jobs.push(await this.enqueue(appId));
    return jobs;
  }

  private pickVersion(detail: AppDetail, wanted?: string): AppVersion {
    const version = wanted
      ? detail.versions.find((v) => v.version === wanted)
      : (detail.versions.find((v) => v.version === detail.latestVersion) ?? detail.versions[0]);
    if (!version) throw new Error("no publishable version for " + detail.id);
    return version;
  }

  private async drain(): Promise<void> {
    while (this.running < this.concurrency) {
      const id = this.queue.shift();
      if (!id) return;
      const job = this.jobs.get(id);
      if (!job) continue;
      this.running++;
      void this.execute(job)
        .catch(() => undefined)
        .finally(() => {
          this.running--;
          void this.drain().catch(() => undefined);
        });
    }
  }

  /**
   * 每一步都必须在同一个 try 里收口。旧写法把 `catalog.detail` / `pickVersion` /
   * `resolvePackageDir` / `inventory.installed` / `buildPlan` 都留在 try 之外，
   * 一旦它们抛出，任务就永远停在 queued/downloading（非终态），
   * 而调用侧是 `void this.execute(job)`——未处理的拒绝在本机 Node 24 上直接把进程打死（真退出码 1）。
   */
  private async execute(job: InstallJob): Promise<void> {
    try {
      await this.runSteps(job);
    } catch (err) {
      this.transition(job, "failed", { error: errorMessage(err) });
    }
  }

  private async runSteps(job: InstallJob): Promise<void> {
    const detail = await this.deps.catalog.detail(job.appId);
    if (!detail) {
      this.transition(job, "failed", { error: "app disappeared from catalog" });
      return;
    }
    const version = this.pickVersion(detail, job.version);

    if (detail.requiresApproval && !(await this.passesApprovalGate(job, detail, version))) return;

    // 应用名与版本号都是目录侧给的字符串：`safeName` 的字符类替换了 `\` 却漏了 `/`，
    // 于是 `"x/../../escapee"` 能原样进文件名，path.join 归一后把安装包写到 packageDir 之外
    // （实测任务还报 succeeded，包落在 %TEMP% 根）。落盘分量一律过 safePathSegment + 包含性断言。
    const packageDir = await resolvePackageDir(this.deps.packageDir);
    const packagePath = joinWithinRoot(
      packageDir,
      safePathSegment(detail.name) + "-" + safePathSegment(version.version, "0") + extensionOf(version.downloadUrl),
    );
    this.transition(job, "downloading");
    let downloaded: DownloadResult;
    try {
      const local =
        this.deps.resolveLocalPackage
          ? await this.deps.resolveLocalPackage(detail.id, version.version, version.downloadUrl)
          : null;
      if (local && this.deps.fileDownloader) {
        // 命中本地镜像：直接复制已校验的包，跳过网络下载（离线可用）。
        downloaded = await this.deps.fileDownloader.download({
          id: job.id,
          url: pathToFileURL(local.file).href,
          target: packagePath,
          expectedSha256: local.sha256,
          expectedSize: local.size,
        });
      } else {
        downloaded = await this.deps.downloader.download({
          id: job.id,
          url: version.downloadUrl,
          target: packagePath,
          expectedSha256: version.sha256,
          expectedSize: version.sizeBytes,
        });
      }
    } catch (err) {
      this.transition(job, "failed", { error: errorMessage(err) });
      return;
    }
    this.transition(job, "verifying", { packagePath: downloaded.target });

    const installed = await this.deps.inventory.installed();
    const prior = selectPriorInstall(detail.name, installed);
    if (prior && version.minUpgradeFrom && compare(prior.displayVersion, version.minUpgradeFrom) < 0) {
      const removal = await this.runUninstall(prior, version.silent.extraSuccessExitCodes ?? []);
      if (!removal.ok) {
        await this.cleanupPackage(downloaded).catch(() => undefined);
        this.transition(job, "failed", { error: "pre-uninstall failed: " + removal.message });
        return;
      }
    }

    this.transition(job, "installing");
    const plan = buildPlan({
      silent: version.silent,
      packagePath: downloaded.target,
      targetDirectory: defaultTarget(detail.name),
      phase: job.phase === "upgrade" ? "upgrade" : "install",
      appDisplayName: detail.name,
      interactive: job.mode === "manual",
    });
    try {
      const result = await this.deps.runner.run(plan);
      const verdict = classifyExit(result.exitCode, version.silent.extraSuccessExitCodes ?? []);
      if (!verdict.ok) {
        await this.cleanupPackage(downloaded);
        this.transition(job, "failed", { error: "installer exit " + String(result.exitCode), execution: result });
        return;
      }
      // 安装到此已经成功：回读版本或清理安装包出问题，都不能把它反过来改判成 failed。
      const installedVersion = await this.readInstalledVersion(detail.name, job.version).catch(() => undefined);
      await this.cleanupPackage(downloaded).catch(() => undefined);
      this.transition(job, verdict.requiresReboot ? "needs_reboot" : "succeeded", { execution: result, installedVersion });
    } catch (err) {
      await this.cleanupPackage(downloaded).catch(() => undefined);
      this.transition(job, "failed", { error: errorMessage(err) });
    }
  }

  private async passesApprovalGate(job: InstallJob, detail: AppDetail, version: AppVersion): Promise<boolean> {
    const grant = this.deps.grantStore.get(detail.id, this.deps.userId);
    const verdict = grant
      ? this.deps.approvals.verifyGrant(grant, {
          appId: detail.id,
          userId: this.deps.userId,
          appVersion: version.version,
        })
      : { ok: false, reason: "no-grant" };
    if (!verdict.ok) {
      if (grant) this.deps.grantStore.clear(detail.id, this.deps.userId);
      this.transition(job, "awaiting_approval", { error: verdict.reason });
      return false;
    }
    this.deps.grantStore.clear(detail.id, this.deps.userId);
    return true;
  }

  /** 卸载后立即做残留扫描，返回报告而不是直接删除，清理计划由用户确认。 */
  async uninstall(appIdOrName: string, regDir?: string): Promise<InstallJob> {
    const detail = await this.deps.catalog.detail(appIdOrName);
    const installed = await this.deps.inventory.installed();
    // 目标选择收口到 resolveInstalledInstance：真机上同名不同实例确实存在
    // （本机 141 项里 `Universal CRT Redistributable` 就有两条不同 GUID、两个版本），
    // 旧实现按 displayName `find` 取首条 ⇒ 点下面那行卸掉的却是上面那行。
    const target = resolveInstalledInstance(installed, { nameOrId: appIdOrName, regDir, catalogName: detail?.name });

    const job: InstallJob = {
      id: "uninstall@" + target.regDir.toLowerCase() + "@" + (target.displayVersion || "0"),
      appId: detail?.id ?? target.displayName,
      appName: target.displayName,
      version: target.displayVersion,
      state: "queued",
      phase: "install",
      kind: "uninstall",
      history: [],
    };
    this.jobs.set(job.id, job);
    this.transition(job, "installing");
    // 卸载已经建了任务，之后任何一步抛错（残留扫描踩到字段不全的注册表项就是实例）
    // 都必须把任务落到终态：调用侧多是 `void orchestrator.uninstall(...)`，
    // 非终态 + 未处理拒绝在本机 Node 24 上就是宿主猝死。
    try {
      const removal = await this.runUninstall(target, []);
      if (!removal.ok) {
        this.transition(job, "failed", { error: removal.message });
        return job;
      }
      this.transition(job, "verifying");
      const report = await scanResidue(target, { reg: this.deps.reg, fs: this.deps.fs, env: this.deps.env });
      this.transition(job, "succeeded", { residue: report });
    } catch (err) {
      this.transition(job, "failed", { error: errorMessage(err) });
    }
    return job;
  }

  private async runUninstall(
    target: InstalledApp,
    extraSuccess: readonly number[],
  ): Promise<{ ok: boolean; message: string }> {
    const raw = (target.quietUninstallString ?? target.uninstallString ?? "").trim();
    if (!raw) return { ok: false, message: "no uninstall entry for " + target.displayName };
    try {
      const request = parseUninstallCommand(raw, target.quietUninstallString !== null);
      const result = await this.deps.runner.run(request);
      const verdict = classifyExit(result.exitCode, extraSuccess);
      return verdict.ok ? { ok: true, message: "" } : { ok: false, message: "uninstaller exit " + String(result.exitCode) + " (" + verdict.meaning + ")" };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  }

  /** 安装包落地后，按 installerCleanup 开关删除它（无论安装成功/失败/异常）。 */
  private async cleanupPackage(downloaded: DownloadResult): Promise<void> {
    if (await shouldCleanupInstaller(this.deps)) {
      await fs.rm(downloaded.target, { force: true }).catch(() => undefined);
    }
  }

  /** 装后从已装清单按显示名回读真实版本号；歧义时宁可判未命中也不臆测（见 resolveInstalledVersion）。 */
  private async readInstalledVersion(displayName: string, requestedVersion?: string): Promise<string | undefined> {
    const installed = await this.deps.inventory.installed();
    return resolveInstalledVersion(displayName, requestedVersion, installed);
  }
}

/**
 * 装后版本回读的保守解析。真机测量表明：对当前这台机器，大小写/空白归一化并不能多命中任何一个目录
 * 应用（0 额），但「Universal CRT Redistributable」这类组件在注册表里存在多条同名不同版本的卸载项——
 * 旧的 `.find()` 取第一条，会把「到底装上了哪个版本」读成别的实例的版本。因此这里绝不做模糊名匹配，
 * 且只在能唯一定位时才回读：
 *  1. 请求版本恰好与某条同名候选一致 → 认定该版本已落地；
 *  2. 同名候选唯一 → 回读它（注册表可能与请求不同，如实反映实际在装版本）；
 *  3. 多条不同版本且无法用请求版本定位 → 返回 undefined（判为未命中），而不是返回首条的错误版本。
 */
export function resolveInstalledVersion(
  displayName: string,
  requestedVersion: string | undefined,
  installed: readonly InstalledApp[],
): string | undefined {
  const candidates = installed.filter((a) => a.displayName === displayName);
  if (candidates.length === 0) return undefined;
  if (requestedVersion && candidates.some((a) => a.displayVersion === requestedVersion)) return requestedVersion;
  if (candidates.length === 1) return candidates[0]?.displayVersion;
  return undefined;
}

/** 升级前置检查要的是「本机当前这套到底哪个版本」。同名多条时取版本最高的一条，避免取到旧实例。 */
export function selectPriorInstall(displayName: string, installed: readonly InstalledApp[]): InstalledApp | undefined {
  const candidates = installed.filter((a) => a.displayName === displayName);
  if (candidates.length === 0) return undefined;
  return candidates.reduce((max, a) => (compare(a.displayVersion, max.displayVersion) > 0 ? a : max));
}

export function safeName(name: string): string {
  return name.replace(/[<>:"\\|?*]/g, "_").trim().replace(/\s+/g, "_") || "app";
}

export function extensionOf(url: string): string {
  const clean = (url.split("?")[0] ?? url).toLowerCase();
  for (const ext of ["msi", "exe", "msix", "zip", "7z"]) {
    if (clean.endsWith("." + ext)) return "." + ext;
  }
  return ".exe";
}

export function defaultTarget(name: string): string {
  const root = process.env.ProgramFiles ?? "C:\\Program Files";
  return path.join(root, safeName(name));
}

async function resolvePackageDir(value: string | (() => Promise<string> | string)): Promise<string> {
  return typeof value === "string" ? value : await value();
}

async function shouldCleanupInstaller(deps: OrchestratorDeps): Promise<boolean> {
  return deps.installerCleanup ? Boolean(await deps.installerCleanup()) : false;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
