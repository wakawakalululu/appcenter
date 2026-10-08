import type { CatalogEntry } from "../catalog/view.ts";

/**
 * 机群资产心跳：客户端把「本机装了哪些目录内应用、哪些可升级/待审批」汇总上报，
 * 供管理端统计覆盖率与到达率。
 *
 * 范围红线：只上报目录内应用的身份与版本（appId + version）与计数量，
 * 绝不采集进程列表、窗口、浏览记录、屏幕或任何终端行为数据。
 * 这与被明确排除的「终端行为采集」是两回事——这里只回答
 * 「分发下去的软件在这台机器上是什么状态」。
 */

/** 一台机器上某个目录应用的安装态。 */
export interface AssetApp {
  appId: string;
  version: string;
  upgradable: boolean;
}

export interface AssetSummary {
  /** 稳定的机器/用户标识，来自 FacadeConfig.userId，不含硬件指纹。 */
  machineId: string;
  /** 客户端自身版本，便于管理端排查旧版本占比。 */
  appVersion: string;
  reportedAt: string;
  /** 目录内已装应用（含可升级）。 */
  installed: AssetApp[];
  /** 待审批（需申请且尚无凭证）的应用 id。 */
  needsApproval: string[];
  counts: {
    installed: number;
    upgradable: number;
    needsApproval: number;
    /** 客户端本地待处理审批数，来自引擎而非目录联表。 */
    pendingApprovals: number;
  };
}

export interface BuildAssetInput {
  machineId: string;
  appVersion: string;
  /** 目录与本机清单联表后的视图（facade.catalogView()）。 */
  entries: readonly CatalogEntry[];
  pendingApprovals?: number;
  reportedAt?: string;
}

/**
 * 从联表视图派生上报摘要。纯函数、无 IO，便于测试与审计上报面：
 * 输出的字段集合就是客户端愿意告诉服务端的全部信息。
 */
export function buildAssetSummary(input: BuildAssetInput): AssetSummary {
  const installed: AssetApp[] = [];
  const needsApproval: string[] = [];
  for (const entry of input.entries) {
    if (entry.installedVersion !== null) {
      installed.push({
        appId: entry.app.id,
        version: entry.installedVersion,
        upgradable: entry.installState === "upgradable",
      });
    }
    if (entry.installState === "needs-approval") needsApproval.push(entry.app.id);
  }
  installed.sort((a, b) => a.appId.localeCompare(b.appId));
  needsApproval.sort();
  return {
    machineId: input.machineId,
    appVersion: input.appVersion,
    reportedAt: input.reportedAt ?? new Date().toISOString(),
    installed,
    needsApproval,
    counts: {
      installed: installed.length,
      upgradable: installed.filter((app) => app.upgradable).length,
      needsApproval: needsApproval.length,
      pendingApprovals: Math.max(0, input.pendingApprovals ?? 0),
    },
  };
}

/** 管理端看到的单机记录（服务端存储后回填首次/最近上报时间与离线判定）。 */
export interface FleetAgent extends AssetSummary {
  firstSeenAt: string;
  lastSeenAt: string;
  /** 距最近一次上报的毫秒数；无法解析时为 +∞。 */
  lastSeenAgeMs: number;
  /** 超过 staleAfter 阈值未上报即视为离线。 */
  stale: boolean;
}

/** 一台机器的一次历史心跳快照（只留计数，不留全量清单，避免时序表膨胀）。 */
export interface FleetHistoryPoint {
  reportedAt: string;
  installed: number;
  upgradable: number;
  needsApproval: number;
}

/** 管理端单机详情：最近快照 + 时序历史。 */
export interface FleetDetail {
  agent: FleetAgent;
  history: FleetHistoryPoint[];
}

/** 管理端机群汇总：逐机记录 + 全局计数。 */
export interface FleetReport {
  agents: FleetAgent[];
  totals: {
    agents: number;
    installed: number;
    upgradable: number;
    needsApproval: number;
    /** 离线（超过阈值未上报）的机器数。 */
    stale: number;
  };
}

/** 默认离线阈值：24 小时未上报即视为离线。 */
export const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * 离线判定纯函数：给定最近上报时间与阈值，算出机龄与是否离线。
 * 无法解析的时间戳按「无穷老」处理，宁可标离线也不谎报在线。
 */
export function stalenessOf(
  lastSeenAt: string,
  now: number = Date.now(),
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): { ageMs: number; stale: boolean } {
  const parsed = Date.parse(lastSeenAt);
  const ageMs = Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : Math.max(0, now - parsed);
  return { ageMs, stale: ageMs > staleAfterMs };
}
