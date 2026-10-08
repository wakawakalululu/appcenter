import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Downloader } from "./download/downloader.ts";
import { RemoteCatalog, type ApprovalNotification, type Banner, type Bundle, type InstallReceipt } from "./remote.ts";
import type { AppDetail, AppSummary, Category, RatingDistribution, RatingInput } from "./catalog/types.ts";
import { buildCategoryTree, categorySubtreeIds, searchCatalog, type CategoryNode, type SearchHit, type SearchQuery } from "./catalog/search.ts";
import { scanInstalledApps, type InstalledApp } from "./inventory/inventory.ts";
import { InstalledAppCache, cachedInstalledApps } from "./inventory/cache.ts";
import { resolveInstalledInstance } from "./inventory/select.ts";
import { InMemoryRegClient, RegExeClient, type RegClient, type RegistryKey } from "./inventory/registry.ts";
import { scanResidue, type FileSystemProbe, type ResidueReport, type ScanEnv } from "./leftover/scan.ts";
import { exportRegistryKey } from "./leftover/backup.ts";
import {
  buildCleanupPlan,
  executeCleanup,
  regDeleteKey,
  regDeleteValue,
  type CleanupOutcome,
  type CleanupPolicy,
  type PlanResult,
} from "./leftover/cleanup.ts";
import { pruneRecycle, purgeRecycle, recycleStatus, type PruneOptions, type PruneResult, type RecycleStatus } from "./leftover/recycle.ts";
import { ChildProcessRunner, type ProcessRunner } from "./runner/executor.ts";
import { RuntimeConfigStore, type RuntimeConfig, type RuntimeConfigIssue } from "./runtime/config.ts";
import { IconCache, iconSourceOf } from "./inventory/icons.ts";
import { buildAssetSummary, type AssetSummary, type FleetDetail, type FleetReport } from "./inventory/heartbeat.ts";
import {
  buildCatalogEntries,
  categorySections,
  essentialStrip,
  matchInstalled,
  type CatalogEntry,
  type CategorySection,
} from "./catalog/view.ts";
import { InstallOrchestrator, type InstallJob, type JobState } from "./orchestrator/installer.ts";
import { LocalRepo, localFileDownloader, type RepoStatus, type RepoSyncReport } from "./localrepo/repo.ts";
import { ApprovalWorkflow, type ApprovalRequest } from "./approval/workflow.ts";
import { buildUpgradePlan, summarizePlan, type UpgradeCandidate } from "./upgrader/plan.ts";
import { SelfUpdater, type CheckResult, type SelfUpdateManifest, type StagedUpdate, type SwapOutcome } from "./selfupdate/selfupdate.ts";
import { SkinRegistry, type ResolvedSkin } from "./theme/skin.ts";
import { SingleInstanceLock, WindowManager, type WindowDescriptor, type WindowHost, type WindowRole } from "./windows/manager.ts";
import {
  buildTrayMenu,
  trayIconFor,
  trayStatusFor,
  type TrayContext,
  type TrayIconSpec,
  type TrayMenuItem,
  type TrayStatus,
} from "./tray/state.ts";
import { AutoStartController, RegAutoStartBackend, type AutoStartBackend } from "./runtime/autostart.ts";

/** 服务端审批工单投影 → 本地 ApprovalRequest，供「我的申请」与管理员视图共用。 */
function approvalRequestFromTicket(t: {
  requestId: string;
  appId: string;
  appVersion: string;
  applicant: string;
  status: string;
  reason: string;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  expiresAt?: string;
}): ApprovalRequest {
  return {
    id: t.requestId,
    appId: t.appId,
    appVersion: t.appVersion,
    applicant: t.applicant,
    reason: t.reason,
    status: t.status as ApprovalRequest["status"],
    createdAt: t.createdAt,
    decidedAt: t.decidedAt || undefined,
    decidedBy: t.decidedBy || undefined,
    expiresAt: t.expiresAt || undefined,
  };
}

export interface FacadeConfig {
  serverUrl: string;
  userId: string;
  /** 下载缓存、审批凭证与自升级暂存的根目录。 */
  dataDir: string;
  /** 本地应用包仓库根目录；不传默认 `<dataDir>/local-repo`。 */
  localRepoDir?: string;
  appVersion: string;
  /** 测试与离线演示时注入内存注册表。 */
  registryKeys?: readonly RegistryKey[];
  runner?: ProcessRunner;
  token?: string;
  /** 只有与服务端同信任域的部署才需要；客户端留空即由签发方保证凭证真实性。 */
  grantSecret?: string;
  /**
   * 打包后客户端 exe 所在目录，自升级会就地替换其中的 exe。
   * 不传就用数据目录下的沙箱：开发宿主里 process.execPath 是 node.exe，
   * 直接拿它所在目录等于往 Program Files\nodejs 写文件。
   */
  selfUpdateAppDir?: string;
  /** 开机自启后端；不传用真实 Windows Run 键。测试可注入内存实现。 */
  autoStartBackend?: AutoStartBackend;
  /** 写入 Run 键的启动命令行；不传则用当前进程命令行。 */
  autoStartCommand?: string;
}

export class MemoryGrantStore {
  private readonly grants = new Map<string, Grant>();

  private key(appId: string, userId: string): string {
    return appId + "@" + userId;
  }

  get(appId: string, userId: string): Grant | undefined {
    return this.grants.get(this.key(appId, userId));
  }

  put(grant: Grant): void {
    this.grants.set(this.key(grant.appId, grant.userId), grant);
  }

  clear(appId: string, userId: string): void {
    this.grants.delete(this.key(appId, userId));
  }

  /** 当前用户持有且未过期的授权 appId 集合，供 catalog 视图翻转「需审批」状态。 */
  grantedAppIds(userId: string, now: Date = new Date()): Set<string> {
    const out = new Set<string>();
    for (const grant of this.grants.values()) {
      if (grant.userId === userId && new Date(grant.expiresAt).getTime() > now.getTime()) {
        out.add(grant.appId);
      }
    }
    return out;
  }
}

import type { Grant } from "./approval/workflow.ts";

/** 只有这些终态值得上报回执，中间态不需要打扰服务端。 */
const RECEIPT_STATES: JobState[] = ["succeeded", "needs_reboot", "failed"];

const nodeProbe: FileSystemProbe = {
  async exists(target: string): Promise<boolean> {
    try {
      await fs.stat(target);
      return true;
    } catch {
      return false;
    }
  },
  async readDir(target: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(target, { withFileTypes: true });
      return entries.map((entry) => path.join(target, entry.name));
    } catch {
      return [];
    }
  },
  async readText(target: string): Promise<string | null> {
    try {
      const buf = await fs.readFile(target);
      return decodeTextWithBom(buf);
    } catch {
      return null;
    }
  },
};

/**
 * 按 BOM 识别文本编码并解码，供残留扫描读取计划任务定义等文件。
 * 真机取证：`System32\Tasks` 里 221 个任务文件全部是 UTF-16LE（BOM `FF FE`），
 * 之前固定按 UTF-8 读会让 `"<Task"` 匹配命中 0 个，整类「计划任务残留」在真机上形同虚设。
 */
export function decodeTextWithBom(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = buf.subarray(2);
    const swapped = Buffer.from(body);
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const a = swapped[i] as number;
      const b = swapped[i + 1] as number;
      swapped[i] = b;
      swapped[i + 1] = a;
    }
    return swapped.toString("utf16le");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8");
  }
  return buf.toString("utf8");
}

export function defaultScanEnv(): ScanEnv {
  const home = os.homedir();
  const programData = process.env.ProgramData ?? "C:\\ProgramData";
  return {
    programData,
    appData: process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
    commonStartMenu: path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs"),
    userStartMenu: path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs"),
    temp: os.tmpdir(),
    systemRoot: process.env.SystemRoot ?? ["C:", "Windows"].join(path.sep),
  };
}

export interface TrayView {
  status: TrayStatus;
  icon: TrayIconSpec;
  menu: TrayMenuItem[];
}

/** 首页轮播：服务端运营位与目录条目的联表结果，entry 为空表示纯图文位。 */
export interface BannerSlide {
  id: string;
  title: string;
  subtitle: string;
  image: string | null;
  link: string | null;
  entry: CatalogEntry | null;
}

/** 首页的装机套装条目：apps 是已经联到目录的部分，missing 是已下架的数量。 */
export interface BundleSlide {
  id: string;
  title: string;
  subtitle: string;
  apps: CatalogEntry[];
  missing: number;
}

export interface ScheduleState {
  running: boolean;
  lastCheckAt: string | null;
  lastCheckError: string | null;
  lastHeartbeatAt: string | null;
  unreadNotifications: number;
}

/** 一次整包安装的记录。 */
export interface BundleRun {
  id: string;
  bundleId: string;
  title: string;
  startedAt: string;
  jobIds: string[];
  /** 已经装到最新版、这次不必再装的应用。 */
  skipped: string[];
  /** 套装里引用了但目录已下架的应用。 */
  unknown: string[];
}

export interface BundleProgress {
  run: BundleRun;
  jobs: InstallJob[];
  total: number;
  done: number;
  failed: number;
  running: number;
  awaitingApproval: number;
  percent: number;
}

function durationOf(history: { state: string; at: string }[]): number | null {
  const first = history.at(0)?.at;
  const last = history.at(-1)?.at;
  if (first === undefined || last === undefined) return null;
  const start = Date.parse(first);
  const end = Date.parse(last);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

/**
 * 面向 UI 宿主的统一入口：目录浏览、安装卸载、审批、皮肤、窗口与托盘。
 * Flutter 或 Electron 只需实现 WindowHost 并订阅 onJob。
 */
export class AppCenterFacade {
  readonly skins = new SkinRegistry();
  readonly windows: WindowManager;
  readonly lock: SingleInstanceLock;

  private readonly remote: RemoteCatalog;
  private readonly downloader: Downloader;
  private readonly grants = new MemoryGrantStore();
  private readonly approvals: ApprovalWorkflow;
  private readonly reg: RegClient;
  private readonly orchestrator: InstallOrchestrator;
  private readonly localRepo: LocalRepo;
  private readonly selfUpdater: SelfUpdater;
  private readonly iconCache: IconCache;
  private readonly runtime: RuntimeConfigStore;
  /** 真实注册表模式下启用已装清单缓存（首屏 < 300ms）；注入内存注册表时为空，直接扫描。 */
  private readonly inventoryCache: import("./inventory/cache.ts").InstalledAppCache | null;
  private readonly autoStart: AutoStartController;
  private readonly autoStartCommand: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private catalogCache: AppDetail[] = [];
  private categoryCache: Category[] = [];
  private upgradeCount = 0;
  private pendingApprovals = 0;
  private lastCheckAt: string | null = null;
  private lastCheckError: string | null = null;
  private lastHeartbeatAt: string | null = null;
  private unreadNotifications = 0;
  private readonly bundleRunLog: BundleRun[] = [];

  constructor(
    private readonly config: FacadeConfig,
    host: WindowHost,
  ) {
    this.approvals = new ApprovalWorkflow(config.grantSecret ?? "");
    this.remote = new RemoteCatalog(config.serverUrl, config.token ?? "");
    this.reg = config.registryKeys ? new InMemoryRegClient(config.registryKeys) : new RegExeClient();
    this.inventoryCache = config.registryKeys
      ? null
      : new InstalledAppCache(path.join(config.dataDir, "inventory"));
    this.autoStart = new AutoStartController(config.autoStartBackend ?? new RegAutoStartBackend());
    this.autoStartCommand = config.autoStartCommand ?? [process.execPath, ...process.argv.slice(1)].join(" ");
    this.runtime = new RuntimeConfigStore(path.join(config.dataDir, "runtime-config.json"), {
      downloadDir: path.join(config.dataDir, "packages"),
    });
    this.downloader = new Downloader({ concurrency: 2 });
    this.localRepo = new LocalRepo({
      downloader: this.downloader,
      root: config.localRepoDir ?? path.join(config.dataDir, "local-repo"),
      verify: "size",
      // 目录里的 downloadUrl 常是相对路径（/dl/...）：单例同样要补全，否则 sync 到磁盘的
      // url 字段是相对值，离线 resolve / 二次下载会以「Failed to parse URL」整体失败。
      urlBase: config.serverUrl,
    });
    void this.runtime
      .load()
      .then((cfg) => this.downloader.setConcurrency(cfg.concurrency))
      .catch(() => undefined);
    this.iconCache = new IconCache({ cacheDir: path.join(config.dataDir, "icons") });
    this.windows = new WindowManager(host);
    this.lock = new SingleInstanceLock(path.join(config.dataDir, "appcenter.lock"));
    this.orchestrator = new InstallOrchestrator(
      {
        catalog: { detail: (id) => this.detail(id) },
        inventory: { installed: () => this.installed() },
        downloader: this.downloader,
        runner: config.runner ?? new ChildProcessRunner(),
        approvals: this.approvals,
        reg: this.reg,
        fs: nodeProbe,
        env: defaultScanEnv(),
        packageDir: () => this.runtime.packageDir(),
        installerCleanup: async () => (await this.runtime.load()).installerCleanup,
        userId: config.userId,
        grantStore: this.grants,
        resolveLocalPackage: (appId, version, downloadUrl) => this.localRepo.resolve(appId, version, downloadUrl),
        fileDownloader: localFileDownloader,
      },
      { concurrency: 1 },
    );
    this.selfUpdater = new SelfUpdater({
      downloader: this.downloader,
      appDir: config.selfUpdateAppDir ?? path.join(config.dataDir, "selfupdate", "current"),
      stagingDir: path.join(config.dataDir, "selfupdate"),
      currentVersion: config.appVersion,
      userId: config.userId,
    });
    this.orchestrator.onJob((job) => {
      this.pendingApprovals = this.orchestrator.list().filter((j) => j.state === "awaiting_approval").length;
      // 终态只会出现一次，一次安装尝试对应一条回执。
      if (RECEIPT_STATES.includes(job.state) && job.kind !== "uninstall") void this.reportJobReceipt(job).catch(() => undefined);
    });
  }

  onJob(listener: (job: InstallJob) => void): () => void {
    return this.orchestrator.onJob(listener);
  }

  async refreshCatalog(): Promise<number> {
    const summaries = await this.remote.summaries();
    const details: AppDetail[] = [];
    for (const summary of summaries) {
      const detail = await this.remote.detail(summary.id);
      details.push(detail ?? { ...summary, description: "", screenshots: [], versions: [] });
    }
    this.catalogCache = details;
    this.categoryCache = await this.remote.categories();
    return this.catalogCache.length;
  }

  private summaries(): AppSummary[] {
    return this.catalogCache;
  }

  async search(query: SearchQuery): Promise<SearchHit[]> {
    if (this.catalogCache.length === 0) await this.refreshCatalog();
    const expanded: SearchQuery =
      query.categoryId && !query.categoryIds
        ? { ...query, categoryIds: categorySubtreeIds(this.categoryCache, query.categoryId) }
        : query;
    return searchCatalog(this.summaries(), expanded);
  }

  async categories(): Promise<CategoryNode[]> {
    if (this.catalogCache.length === 0) await this.refreshCatalog();
    return buildCategoryTree(this.categoryCache, this.summaries());
  }

  async detail(appId: string): Promise<AppDetail | null> {
    const cached = this.catalogCache.find((a) => a.id === appId);
    if (cached) return cached;
    const fetched = await this.remote.detail(appId);
    if (fetched) this.catalogCache.push(fetched);
    return fetched;
  }

  async rating(appId: string): Promise<RatingDistribution> {
    return this.remote.distribution(appId);
  }

  rate(input: RatingInput): Promise<RatingDistribution> {
    return this.remote.submitRating(input);
  }

  installed(): Promise<InstalledApp[]> {
    if (this.inventoryCache) return cachedInstalledApps(this.reg, this.inventoryCache);
    return scanInstalledApps(this.reg);
  }

  async upgrades(): Promise<{ candidates: UpgradeCandidate[]; summary: ReturnType<typeof summarizePlan> }> {
    if (this.catalogCache.length === 0) await this.refreshCatalog();
    const candidates = await buildUpgradePlan({
      installed: await this.installed(),
      catalog: this.summaries(),
      details: (id) => this.detail(id),
    });
    const summary = summarizePlan(candidates);
    this.upgradeCount = summary.total;
    return { candidates, summary };
  }

  install(appId: string, version?: string, mode?: "silent" | "manual"): Promise<InstallJob> {
    return this.orchestrator.enqueue(appId, { version, mode });
  }

  bulkInstall(appIds: readonly string[]): Promise<InstallJob[]> {
    return this.orchestrator.bulk(appIds);
  }

  bundles(): Promise<Bundle[]> {
    return this.remote.bundles();
  }

  /**
   * 装机套装：整包排队，已装到最新版的应用跳过，需要审批的应用照常入队
   * （由编排器落到 awaiting_approval），一块都不阻塞其余应用。
   */
  async installBundle(bundleId: string): Promise<BundleRun> {
    const bundle = await this.remote.bundle(bundleId);
    if (this.catalogCache.length === 0) await this.refreshCatalog();
    const entries = await this.catalogView();
    const byId = new Map(entries.map((entry) => [entry.app.id, entry]));
    const jobIds: string[] = [];
    const skipped: string[] = [];
    const unknown: string[] = [];
    for (const appId of bundle.appIds) {
      const entry = byId.get(appId);
      if (!entry) {
        unknown.push(appId);
        continue;
      }
      if (entry.installState === "installed") {
        skipped.push(appId);
        continue;
      }
      const job = await this.orchestrator.enqueue(appId, entry.installState === "upgradable" ? { phase: "upgrade" } : {});
      jobIds.push(job.id);
    }
    const run: BundleRun = {
      id: "bundle@" + bundle.id + "#" + Date.now().toString(36),
      bundleId: bundle.id,
      title: bundle.title,
      startedAt: new Date().toISOString(),
      jobIds,
      skipped,
      unknown,
    };
    this.bundleRunLog.push(run);
    if (this.bundleRunLog.length > 10) this.bundleRunLog.shift();
    return run;
  }

  /** 整包进度：给"捆绑安装"进度面板用，不重复编排器的状态机。 */
  bundleProgress(runId: string): BundleProgress | null {
    const run = this.bundleRunLog.find((r) => r.id === runId);
    if (!run) return null;
    const jobs = run.jobIds
      .map((id) => this.orchestrator.get(id))
      .filter((job): job is InstallJob => Boolean(job));
    const done = jobs.filter((job) => job.state === "succeeded" || job.state === "needs_reboot").length;
    const failed = jobs.filter((job) => job.state === "failed").length;
    const awaitingApproval = jobs.filter((job) => job.state === "awaiting_approval").length;
    const running = jobs.filter((job) => ["queued", "downloading", "verifying", "installing"].includes(job.state)).length;
    const settled = done + failed + awaitingApproval;
    return {
      run,
      jobs,
      total: run.jobIds.length,
      done,
      failed,
      running,
      awaitingApproval,
      percent: run.jobIds.length === 0 ? 100 : Math.round((settled / run.jobIds.length) * 100),
    };
  }

  bundleRuns(): BundleRun[] {
    return [...this.bundleRunLog];
  }

  upgrade(appId: string): Promise<InstallJob> {
    return this.orchestrator.enqueue(appId, { phase: "upgrade" });
  }

  uninstall(nameOrId: string, regDir?: string): Promise<InstallJob> {
    return this.orchestrator.uninstall(nameOrId, regDir);
  }

  jobs(): InstallJob[] {
    return this.orchestrator.list();
  }

  windowList(): WindowDescriptor[] {
    return this.windows.list();
  }

  closeWindow(id: string): Promise<{ minimizedToTray: boolean }> {
    return this.windows.requestClose(id);
  }

  setSkin(id: string): ResolvedSkin {
    return this.skins.setActive(id);
  }

  /** 托盘菜单项落到具体动作上，宿主只需要把 action 字符串回传。 */
  async trayAction(action: string): Promise<{ handled: boolean; result?: unknown }> {
    const [name, argument] = action.split(":");
    if (name === "window.open") {
      const win = await this.openWindow((argument || "main") as WindowRole);
      return { handled: true, result: win };
    }
    if (name === "upgrade.all") {
      const plan = await this.upgrades();
      const jobs = await this.bulkInstall(plan.candidates.map((c) => c.appId));
      return { handled: true, result: jobs.map((j) => j.id) };
    }
    return { handled: false };
  }

  /**
   * 过去只读本机内存：管理员已批准/驳回的状态不会回流，前端「我的申请」永远停在 pending。
   * 现在以服务端为权威源，拉取后同步回本地工作流（凭证校验依赖它）；服务端不可达再退回本地清单。
   */
  async approvalRequests(): Promise<ApprovalRequest[]> {
    try {
      const tickets = await this.remote.myApprovals(this.config.userId);
      for (const t of tickets) this.approvals.track(approvalRequestFromTicket(t));
      return tickets.map(approvalRequestFromTicket);
    } catch {
      return this.approvals.list({ applicant: this.config.userId });
    }
  }

  /** 管理端：拉取全部审批工单（需要管理员令牌）。 */
  async adminApprovalList(): Promise<ApprovalRequest[]> {
    const tickets = await this.remote.adminApprovals();
    for (const t of tickets) this.approvals.track(approvalRequestFromTicket(t));
    return tickets.map(approvalRequestFromTicket);
  }

  /** 管理员受理 / 驳回；decidedBy 默认当前用户。 */
  async decideApproval(requestId: string, decision: "approved" | "rejected", note = ""): Promise<boolean> {
    const res = await this.remote.decideApproval(requestId, decision, this.config.userId, note);
    return res.ok;
  }

  /** 管理员吊销已签发 / 待处理的凭证（落库为 revoked，使已发凭证失效）。 */
  async revokeApproval(requestId: string): Promise<boolean> {
    const res = await this.remote.revokeApproval(requestId);
    return res.ok;
  }

  /**
   * 残留报告按**行**取：这份报告会直接喂 `cleanupPlan`/`applyCleanup`，
   * 选错实例就意味着「按 A 的残留确认清理、实际删的是 B 的键与目录」。
   */
  async residueReport(nameOrId: string, regDir?: string): Promise<ResidueReport> {
    const target = resolveInstalledInstance(await this.installed(), { nameOrId, regDir });
    return scanResidue(target, { reg: this.reg, fs: nodeProbe, env: defaultScanEnv() });
  }

  cleanupPlan(report: ResidueReport, policy: CleanupPolicy): PlanResult {
    return buildCleanupPlan(report, policy);
  }

  applyCleanup(report: ResidueReport, policy: CleanupPolicy, dryRun = true): Promise<CleanupOutcome> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const withBackup: CleanupPolicy = {
      ...policy,
      backupDir: policy.backupDir ?? path.join(this.config.dataDir, "cleanup-backups", stamp),
      // 默认「移动到回收目录」而不是就地递归删除：move 失败只让该项算 failed、残留原地留着，
      // 不会退化成半删。要真正回收磁盘空间，调用方显式传 recycleDir: ""（空串走 nullish 分支）。
      // 跨盘移动会 EXDEV 报错而该项 failed——宁可让人再点一次，也不在这里偷偷 copy+rm。
      recycleDir: policy.recycleDir ?? path.join(this.config.dataDir, "cleanup-recycle", stamp),
    };
    return executeCleanup(
      report,
      withBackup,
      {
        deleteRegistryKey: regDeleteKey,
        deleteRegistryValue: regDeleteValue,
        deletePath: (target, recursive) => fs.rm(target, { recursive, force: true }).then(() => undefined),
        movePath: async (from, to) => {
          await fs.mkdir(path.dirname(to), { recursive: true });
          await fs.rename(from, to);
        },
        exportRegistryKey,
      },
      { dryRun },
    ).then(async (outcome) => {
      // 回收目录若只进不出，几次清理就会把系统盘占满：顺手按默认策略剪一刀。
      // 剪枝失败不该让本次清理算失败，所以吞掉错误只留痕。
      await this.pruneRecycle().catch((err: unknown) => {
        console.error("recycle prune after cleanup failed: " + (err instanceof Error ? err.message : String(err)));
      });
      return outcome;
    });
  }

  /** 回收根：#26 之后文件类残留先移到这里，保留策略见 leftover/recycle.ts。 */
  recycleDir(): string {
    return path.join(this.config.dataDir, "cleanup-recycle");
  }

  recycleStatus(): Promise<RecycleStatus> {
    return recycleStatus(this.recycleDir());
  }

  pruneRecycle(options: PruneOptions = {}): Promise<PruneResult> {
    return pruneRecycle(this.recycleDir(), options);
  }

  /** 整盘清空回收目录：破坏性操作，必须带确认串。 */
  purgeRecycle(confirmToken: string): Promise<PruneResult> {
    return purgeRecycle(this.recycleDir(), confirmToken);
  }

  /** 申请提交到服务端，本地工作流只保留同一份记录用于状态展示与凭证校验。 */
  async requestApproval(appId: string, reason: string): Promise<ApprovalRequest> {
    const detail = await this.detail(appId);
    const version = detail?.latestVersion ?? "0.0.0";
    await this.remote.requestApproval(appId, this.config.userId, reason, version);
    const local = this.approvals.submit({ appId, appVersion: version, applicant: this.config.userId, reason });
    this.pendingApprovals += 1;
    return local;
  }

  async attachGrant(requestId: string): Promise<void> {
    const grant = await this.remote.redeemGrant(requestId);
    this.grants.put(grant);
    this.pendingApprovals = Math.max(0, this.pendingApprovals - 1);
  }

  trayContext(): TrayContext {
    return { jobs: this.orchestrator.list(), upgradeCount: this.upgradeCount, pendingApprovals: this.pendingApprovals };
  }

  trayView(ctx: TrayContext = this.trayContext()): TrayView {
    const status = trayStatusFor(ctx);
    const badge = ctx.upgradeCount + ctx.pendingApprovals;
    return { status, icon: trayIconFor(status, badge), menu: buildTrayMenu(ctx) };
  }

  openWindow(role: WindowRole, options: { route?: string; key?: string; allowMultiple?: boolean } = {}): Promise<WindowDescriptor> {
    return this.windows.open(role, options);
  }

  skin(id?: string): ResolvedSkin {
    return this.skins.resolve(id ?? this.skins.active);
  }

  async checkSelfUpdate(): Promise<{ manifest: SelfUpdateManifest; result: CheckResult }> {
    const manifest = await this.remote.selfUpdateManifest();
    return { manifest, result: this.selfUpdater.check(manifest) };
  }

  stageSelfUpdate(manifest: SelfUpdateManifest): Promise<StagedUpdate> {
    return this.selfUpdater.stage(manifest);
  }

  applySelfUpdate(staged: StagedUpdate, healthCheck?: () => Promise<boolean>): Promise<SwapOutcome> {
    return this.selfUpdater.apply(staged, healthCheck);
  }

  recoverSelfUpdate(): Promise<{ rolledBack: boolean; version: string | null; message: string }> {
    return this.selfUpdater.recover();
  }

  commitSelfUpdate(): Promise<void> {
    return this.selfUpdater.commit();
  }

  pendingSelfUpdate(): Promise<StagedUpdate | null> {
    return this.selfUpdater.readPending();
  }

  allRatings(): Promise<Record<string, RatingDistribution>> {
    return this.remote.ratingsByApp();
  }

  /** 视图层入口：目录与本机清单联表，按钮语义由引擎决定而不是前端猜。 */
  async catalogView(): Promise<CatalogEntry[]> {
    if (this.catalogCache.length === 0) await this.refreshCatalog();
    const ratings = await this.allRatings().catch(() => ({} as Record<string, RatingDistribution>));
    const versions: Record<string, string[]> = {};
    for (const detail of this.catalogCache) versions[detail.id] = detail.versions.map((v) => v.version);
    const installed = await this.installed();
    const granted = this.grants.grantedAppIds(this.config.userId);
    const entries = buildCatalogEntries({
      apps: this.summaries(),
      installed,
      ratings,
      categories: this.categoryCache,
      latestVersions: versions,
      icons: (appId) => this.catalogCache.find((a) => a.id === appId)?.iconUrl ?? null,
      granted,
    });
    for (const entry of entries) {
      const match = matchInstalled(entry.app, installed);
      if (match.quality >= 2 && match.app) {
        const cached = this.iconCache.urlFor(match.app.regDir.toLowerCase());
        if (cached) entry.iconUrl = cached;
      }
    }
    return entries;
  }

  /**
   * 专属应用：租户被授权独享的那批应用。为其提供独立页面和空态，
   * 所以这里按 badge 过滤并保留联表后的安装状态，而不是让前端自己猜。
   */
  async exclusiveView(): Promise<CatalogEntry[]> {
    const entries = await this.catalogView();
    return entries.filter((entry) => entry.app.badge === "exclusive");
  }

  async homeView(): Promise<{ banners: BannerSlide[]; bundles: BundleSlide[]; essential: CatalogEntry[]; sections: CategorySection[] }> {
    const entries = await this.catalogView();
    const byId = new Map(entries.map((entry) => [entry.app.id, entry]));
    const banners: BannerSlide[] = [];
    // 服务端运营位优先：没有配置时才退回按 badge 派生的轮播。
    const serverBanners = await this.remote.banners().catch(() => [] as Banner[]);
    for (const banner of serverBanners) {
      const appId = banner.link.startsWith("app:") ? banner.link.slice(4) : null;
      const entry = appId ? byId.get(appId) ?? null : null;
      // 只认服务端显式配置的封面图；拿应用图标当背景会在大 banner 上撑出巨大的字母水印。
      banners.push({
        id: banner.id,
        title: banner.title,
        subtitle: banner.subtitle,
        image: banner.imageUrl || null,
        link: banner.link,
        entry,
      });
    }
    if (banners.length === 0) {
      for (const entry of entries.filter((e) => e.app.badge === "recommend").slice(0, 2)) {
        banners.push({ id: "derived:" + entry.app.id, title: entry.app.name, subtitle: entry.app.publisher, image: null, link: null, entry });
      }
    }
    // 装机套装：服务端实体 + 目录联表，缺掉的应用（下架）不展示但要留痕。
    const serverBundles = await this.remote.bundles().catch(() => [] as Bundle[]);
    const bundles: BundleSlide[] = serverBundles.map((bundle) => {
      const apps = bundle.appIds.map((id) => byId.get(id) ?? null);
      return {
        id: bundle.id,
        title: bundle.title,
        subtitle: bundle.subtitle,
        apps: apps.filter((entry): entry is CatalogEntry => Boolean(entry)),
        missing: bundle.appIds.filter((_, index) => !apps[index]).length,
      };
    });
    return { banners: banners.slice(0, 4), bundles, essential: essentialStrip(entries, 8), sections: categorySections(entries, 3) };
  }

  /** 从已安装应用的 exe/ico 提取图标并建立缓存索引。 */
  async syncIcons(): Promise<number> {
    const installed = await this.installed();
    const jobs = installed
      .map((app) => ({
        key: app.regDir.toLowerCase(),
        source: iconSourceOf(app.displayIcon) ?? iconSourceOf(app.uninstallString) ?? "",
      }))
      .filter((job) => Boolean(job.source));
    const index = await this.iconCache.sync(jobs);
    return Object.keys(index.icons).length;
  }

  /**
   * 本地应用包仓库：把目录安装包持久化到磁盘并生成自描述清单（含目录快照）。
   * 与安装编排器的临时下载相对——这是可审计、可离线复用的镜像。
   */
  async syncLocalRepo(options: { allVersions?: boolean; dir?: string; verify?: "size" | "sha256" } = {}): Promise<RepoSyncReport> {
    if (this.catalogCache.length === 0) await this.refreshCatalog();
    const repo =
      options.dir
        ? new LocalRepo({ downloader: this.downloader, root: options.dir, verify: options.verify, urlBase: this.config.serverUrl })
        : this.localRepo;
    return repo.sync({ apps: this.catalogCache, categories: this.categoryCache, allVersions: options.allVersions });
  }

  /** 盘点本地仓库：清单条目按磁盘事实重算状态。 */
  async localRepoStatus(dir?: string): Promise<RepoStatus> {
    const repo = dir ? new LocalRepo({ downloader: this.downloader, root: dir }) : this.localRepo;
    return repo.status();
  }

  /** 顶栏窗口按钮：最小化与关闭交给 WindowManager，最大化由原生壳负责。 */
  async windowControl(action: string, windowId: string): Promise<{ handled: boolean; result?: unknown }> {
    if (action === "minimize" && windowId) {
      await this.windows.hide(windowId);
      return { handled: true, result: this.windows.list() };
    }
    if (action === "close" && windowId) {
      const outcome = await this.windows.requestClose(windowId);
      return { handled: true, result: outcome };
    }
    if (action === "focus") {
      return { handled: true, result: await this.windows.focusOrOpen("main") };
    }
    return { handled: false };
  }

  iconsDir(): string {
    return this.iconCache.directory;
  }

  packageDir(): Promise<string> {
    return this.runtime.packageDir();
  }

  async runtimeConfig(): Promise<{ config: RuntimeConfig; file: string; scheduler: ScheduleState }> {
    return { config: await this.runtime.load(), file: this.runtime.path, scheduler: this.scheduleState() };
  }

  async updateRuntimeConfig(patch: Partial<RuntimeConfig>): Promise<{ config: RuntimeConfig; issues: RuntimeConfigIssue[]; scheduler: ScheduleState }> {
    const saved = await this.runtime.save(patch);
    this.downloader.setConcurrency(saved.config.concurrency);
    // 开机自启是用户可见、可关闭的设置项：随开关直接落到 Run 键。
    if (patch.autoStart !== undefined) await this.autoStart.apply(saved.config.autoStart, this.autoStartCommand);
    // 检查周期改了就重建定时器，否则保持原状。
    if (this.timer !== null && patch.updateCheckIntervalMinutes !== undefined) await this.startScheduledChecks({ immediate: false });
    return { ...saved, scheduler: this.scheduleState() };
  }

  /** 开机/启动时把当前配置里的 autoStart 同步到 Run 键（幂等）。 */
  async applyAutoStart(): Promise<void> {
    const config = await this.runtime.load();
    await this.autoStart.apply(config.autoStart, this.autoStartCommand);
  }

  /**
   * 定时检查更新与审批通知，采用小时级轮询。
   * 用普通 setInterval（unref，不阻塞退出）而不是服务+计划任务+驱动的多层保活：
   * 用户随时可以 stopScheduledChecks() 停掉，状态也在设置页可见。
   */
  async startScheduledChecks(options: { immediate?: boolean } = {}): Promise<ScheduleState> {
    const config = await this.runtime.load();
    this.stopScheduledChecks();
    const periodMs = Math.max(5, config.updateCheckIntervalMinutes) * 60_000;
    this.timer = setInterval(() => void this.runScheduledCheck(), periodMs);
    this.timer.unref?.();
    if (options.immediate !== false) await this.runScheduledCheck();
    return this.scheduleState();
  }

  stopScheduledChecks(): ScheduleState {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    return this.scheduleState();
  }

  scheduleState(): ScheduleState {
    return {
      running: this.timer !== null,
      lastCheckAt: this.lastCheckAt,
      lastCheckError: this.lastCheckError,
      lastHeartbeatAt: this.lastHeartbeatAt,
      unreadNotifications: this.unreadNotifications,
    };
  }

  private async runScheduledCheck(): Promise<void> {
    this.lastCheckAt = new Date().toISOString();
    try {
      if (this.catalogCache.length === 0) await this.refreshCatalog();
      await this.upgrades();
      await this.pollNotifications();
      // 心跳失败不应污染检查状态：它是旁路上报，独立吞掉错误。
      await this.reportHeartbeat().catch(() => undefined);
      this.lastCheckError = null;
    } catch (err) {
      this.lastCheckError = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * 机群资产心跳：把本机目录应用的安装态摘要上报服务端，供管理端统计。
   * 只回答「分发下去的软件装成什么样」，不采集任何终端行为数据。
   */
  async reportHeartbeat(): Promise<AssetSummary> {
    const entries = await this.catalogView();
    const summary = buildAssetSummary({
      machineId: this.config.userId,
      appVersion: this.config.appVersion,
      entries,
      pendingApprovals: this.pendingApprovals,
    });
    await this.remote.reportHeartbeat(summary);
    this.lastHeartbeatAt = summary.reportedAt;
    return summary;
  }

  /** 管理端：全部机器最近一次心跳与全局计数（需管理员令牌）；staleAfterHours 控制离线阈值。 */
  fleet(staleAfterHours?: number): Promise<FleetReport> {
    return this.remote.fleet(staleAfterHours);
  }

  /** 管理端：单机详情，最近快照 + 时序历史（需管理员令牌）。 */
  fleetDetail(machineId: string, staleAfterHours?: number): Promise<FleetDetail> {
    return this.remote.fleetDetail(machineId, staleAfterHours);
  }

  /** 分发回执：装上/没装上都要告诉服务端，管理端才看得见真实到达率。 */
  reportReceipt(appId: string, receipt: InstallReceipt): Promise<{ ok: boolean }> {
    return this.remote.reportReceipt(appId, receipt);
  }

  receipts(appId: string): Promise<InstallReceipt[]> {
    return this.remote.receipts(appId);
  }

  /** 任务终态自动转回执，宿主不需要自己决定上报什么。 */
  async reportJobReceipt(job: InstallJob): Promise<boolean> {
    if (job.state !== "succeeded" && job.state !== "needs_reboot" && job.state !== "failed") return false;
    const outcome = job.state === "failed" ? "failed" : "success";
    await this.remote.reportReceipt(job.appId, {
      version: job.version,
      result: outcome,
      exitCode: job.execution?.exitCode ?? null,
      durationMs: durationOf(job.history),
      error: outcome === "failed" ? (job.error ?? "") : "",
      machine: this.config.userId,
    });
    return true;
  }

  notifications(): Promise<ApprovalNotification[]> {
    return this.remote.notifications(this.config.userId);
  }

  /** 拉取审批通知并缓存未读数，返回仍未确认的那部分。 */
  async pollNotifications(): Promise<ApprovalNotification[]> {
    const list = await this.notifications();
    this.unreadNotifications = list.filter((note) => !note.done).length;
    return list.filter((note) => !note.done);
  }

  async markNotificationDone(id: string): Promise<{ ok: boolean }> {
    const result = await this.remote.markNotificationDone(id);
    await this.pollNotifications().catch(() => undefined);
    return result;
  }

  dataDirectory(): string {
    return this.config.dataDir;
  }

  /** 打开本机已安装的应用：只在能确定 exe 路径时启动，不提权。 */
  async openInstalled(appId: string): Promise<{ launched: boolean; message: string }> {
    const summary = this.summaries().find((a) => a.id === appId);
    const installed = await this.installed();
    const match = summary ? matchInstalled(summary, installed) : { app: null, quality: 0 };
    const target = match.app ? iconSourceOf(match.app.displayIcon) ?? iconSourceOf(match.app.uninstallString) : null;
    if (!target || !target.toLowerCase().endsWith(".exe")) return { launched: false, message: "not launchable" };
    try {
      const { spawn } = await import("node:child_process");
      const child = spawn(target, [], { detached: true, stdio: "ignore", windowsHide: true });
      // spawn 的 ENOENT/EACCES 不在这个 try 里：它是异步 'error' 事件（实测栈顶是
      // ChildProcess._handle.onexit）。没有监听器就是 Unhandled 'error' → 宿主进程 exit 1，
      // 于是「点一下打开一个已卸载应用的残留图标」就能把托盘/桌面壳打死。
      // 也不能直接回 launched:true——那是谎报；等 'spawn'/'error' 谁先到再回答，
      // 并给一个兜底超时，避免这个 UI 调用被挂住。
      const failure = await new Promise<string | null>((resolve) => {
        let settled = false;
        const settle = (value: string | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => settle(null), 3000);
        child.once("error", (err) => settle(err instanceof Error ? err.message : String(err)));
        child.once("spawn", () => settle(null));
      });
      if (failure) return { launched: false, message: failure };
      child.unref();
      return { launched: true, message: "已启动 " + target };
    } catch (err) {
      return { launched: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  recordDownload(appId: string): Promise<void> {
    return this.remote.recordDownload(appId);
  }
}
