import type { InstallJob } from "../orchestrator/installer.ts";

export type TrayStatus = "idle" | "downloading" | "update-available" | "awaiting-approval" | "needs-reboot" | "error";

export interface TrayContext {
  jobs: readonly InstallJob[];
  upgradeCount: number;
  pendingApprovals: number;
}

const ACTIVE: InstallJob["state"][] = ["queued", "downloading", "verifying", "installing"];

/** 所有任务里时间戳最晚的一次状态迁移；没有可用时间戳时返回 null。 */
export function latestTransition(jobs: readonly InstallJob[]): { state: InstallJob["state"]; time: number } | null {
  let best: { state: InstallJob["state"]; time: number } | null = null;
  for (const job of jobs) {
    for (const step of job.history ?? []) {
      const time = Date.parse(step.at);
      if (!Number.isFinite(time)) continue;
      if (!best || time >= best.time) best = { state: step.state, time };
    }
  }
  return best;
}

export function trayStatusFor(ctx: TrayContext): TrayStatus {
  if (ctx.jobs.some((j) => j.state === "needs_reboot")) return "needs-reboot";
  if (ctx.jobs.some((j) => j.state === "awaiting_approval") || ctx.pendingApprovals > 0) return "awaiting-approval";
  if (ctx.jobs.some((j) => ACTIVE.includes(j.state))) return "downloading";
  // 失败是终态、不是持续状态：只要之后有任何一次成功/推进，就不该继续把托盘钉在 error，
  // 否则一条历史失败会永久盖住「有可用更新」这一行。
  if (latestTransition(ctx.jobs)?.state === "failed") return "error";
  if (ctx.upgradeCount > 0) return "update-available";
  return "idle";
}

export interface TrayIconSpec {
  file: string;
  tooltip: string;
  badge: number;
}

const ICONS: Record<TrayStatus, string> = {
  idle: "tray/idle.ico",
  downloading: "tray/progress.ico",
  "update-available": "tray/update.ico",
  "awaiting-approval": "tray/pending.ico",
  "needs-reboot": "tray/reboot.ico",
  error: "tray/error.ico",
};

const TOOLTIPS: Record<TrayStatus, string> = {
  idle: "应用中心",
  downloading: "正在下载安装包",
  "update-available": "有可用更新",
  "awaiting-approval": "有申请等待审批",
  "needs-reboot": "需要重启以完成安装",
  error: "最近一次安装失败",
};

export function trayIconFor(status: TrayStatus, badge = 0): TrayIconSpec {
  return { file: ICONS[status], tooltip: TOOLTIPS[status], badge };
}

export interface TrayMenuItem {
  id: string;
  label: string;
  kind: "action" | "separator";
  enabled: boolean;
  badge?: number;
  action?: string;
}

/** 菜单按状态收敛：空闲不出现暂停项，等待审批时突出申请入口。 */
export function buildTrayMenu(ctx: TrayContext): TrayMenuItem[] {
  const status = trayStatusFor(ctx);
  const items: TrayMenuItem[] = [
    { id: "open", label: "打开应用中心", kind: "action", enabled: true, action: "window.open:main" },
    { id: "sep1", label: "", kind: "separator", enabled: true },
  ];
  if (status === "downloading") {
    items.push({ id: "pause", label: "暂停全部下载", kind: "action", enabled: true, action: "download.pauseAll" });
    items.push({ id: "sep2", label: "", kind: "separator", enabled: true });
  }
  if (ctx.upgradeCount > 0) {
    items.push({ id: "upgrade", label: "升级 " + String(ctx.upgradeCount) + " 个应用", kind: "action", enabled: true, action: "upgrade.all", badge: ctx.upgradeCount });
  }
  if (ctx.pendingApprovals > 0) {
    items.push({ id: "approvals", label: "查看我的申请", kind: "action", enabled: true, action: "window.open:approvals", badge: ctx.pendingApprovals });
  }
  items.push({ id: "settings", label: "下载与安装设置", kind: "action", enabled: true, action: "window.open:settings" });
  items.push({ id: "sep3", label: "", kind: "separator", enabled: true });
  items.push({ id: "quit", label: "退出应用中心", kind: "action", enabled: true, action: "app.quit" });
  return items;
}
