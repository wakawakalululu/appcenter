import type { InstalledApp } from "../inventory/inventory.ts";
import { compare } from "../util/semver.ts";
import type { AppSummary, Category, RatingDistribution } from "./types.ts";

/**
 * 目录与本机清单联表后的视图模型。
 * 界面上的按钮语义（打开 / 升级 / 一键安装 / 申请）全部由这里决定，
 * 前端不再自己猜状态。
 */
export type InstallState = "not-installed" | "installed" | "upgradable" | "needs-approval";
export type PrimaryAction = "open" | "upgrade" | "install" | "request";

export interface CatalogEntry {
  app: AppSummary;
  ratings: RatingDistribution | null;
  iconUrl: string | null;
  installState: InstallState;
  action: PrimaryAction;
  installedVersion: string | null;
  /** 可切换的历史版本，用于「一键安装 ▾」拆分按钮。 */
  otherVersions: string[];
  categoryPath: string[];
  /** 匹配可信度：3 精确同名，2 名称包含，1 仅厂商同名，0 未匹配。 */
  matchQuality: number;
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s\-_·．.]+/g, "");
}

function stripVersionSuffix(value: string): string {
  return normalizeName(value).replace(/(正式版|版|pro|enterprise|x\d+|\d+(\.\d+)+)$/g, "");
}

export function matchInstalled(app: AppSummary, installed: readonly InstalledApp[]): { app: InstalledApp | null; quality: number } {
  const target = normalizeName(app.name);
  const targetStem = stripVersionSuffix(app.name);
  let best: { app: InstalledApp | null; quality: number } = { app: null, quality: 0 };
  for (const item of installed) {
    const name = normalizeName(item.displayName);
    const stem = stripVersionSuffix(item.displayName);
    let quality = 0;
    if (name === target) quality = 3;
    else if (name.includes(target) || target.includes(name)) quality = 2;
    else if (stem === targetStem && targetStem.length > 3) quality = 2;
    else if (app.publisher && item.publisher && normalizeName(item.publisher).includes(normalizeName(app.publisher))) quality = 1;
    if (quality > best.quality) best = { app: item, quality };
  }
  return best;
}

export interface BuildInput {
  apps: readonly AppSummary[];
  installed: readonly InstalledApp[];
  ratings?: Record<string, RatingDistribution>;
  icons?: (appId: string) => string | null;
  categories?: readonly Category[];
  /** 已持有有效凭证的应用集合。 */
  granted?: ReadonlySet<string>;
  latestVersions?: Record<string, string[]>;
}

function categoryTrail(categories: readonly Category[], categoryId: string): string[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const out: string[] = [];
  let cursor = byId.get(categoryId);
  let guard = 0;
  while (cursor && guard++ < 10) {
    out.unshift(cursor.name);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return out;
}

export function buildCatalogEntries(input: BuildInput): CatalogEntry[] {
  return input.apps.map((app) => {
    const match = matchInstalled(app, input.installed);
    const installedVersion = match.quality >= 2 ? match.app?.displayVersion ?? null : null;
    const upgradable = installedVersion !== null && compare(app.latestVersion, installedVersion) > 0;
    const needsApproval = app.requiresApproval && !(input.granted?.has(app.id) ?? false);
    const installState: InstallState = needsApproval && installedVersion === null ? "needs-approval" : upgradable ? "upgradable" : installedVersion ? "installed" : needsApproval ? "needs-approval" : "not-installed";
    const action: PrimaryAction = installState === "upgradable" ? "upgrade" : installState === "installed" ? "open" : installState === "needs-approval" ? "request" : "install";
    const versions = input.latestVersions?.[app.id] ?? [];
    return {
      app,
      ratings: input.ratings?.[app.id] ?? null,
      iconUrl: input.icons?.(app.id) ?? null,
      installState,
      action,
      installedVersion,
      otherVersions: versions.filter((v) => v !== app.latestVersion).slice(0, 6),
      categoryPath: input.categories ? categoryTrail(input.categories, app.categoryId) : [],
      matchQuality: match.quality,
    };
  });
}

/** 「必备应用」横条：优先推荐位与专属，其次下载量，排除需要审批的。 */
export function essentialStrip(entries: readonly CatalogEntry[], limit = 8): CatalogEntry[] {
  const weight = (entry: CatalogEntry): number => {
    const badge = entry.app.badge === "recommend" ? 100 : entry.app.badge === "exclusive" ? 60 : 0;
    return badge + Math.log10(entry.app.downloadCount + 1) * 5;
  };
  return entries
    .filter((entry) => entry.installState !== "needs-approval")
    .sort((a, b) => weight(b) - weight(a) || a.app.name.localeCompare(b.app.name, "zh-Hans-CN"))
    .slice(0, limit);
}

export interface CategorySection {
  categoryId: string;
  name: string;
  path: string[];
  items: CatalogEntry[];
  total: number;
}

/** 首页分类卡片：每个分类取前 N 个，按分类顺序排列。 */
export function categorySections(entries: readonly CatalogEntry[], perCategory = 3): CategorySection[] {
  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.app.categoryId) ?? [];
    list.push(entry);
    groups.set(entry.app.categoryId, list);
  }
  const sections: CategorySection[] = [];
  for (const [categoryId, list] of groups) {
    const ordered = [...list].sort((a, b) => b.app.downloadCount - a.app.downloadCount || a.app.name.localeCompare(b.app.name, "zh-Hans-CN"));
    sections.push({
      categoryId,
      name: ordered[0]?.categoryPath.at(-1) ?? categoryId,
      path: ordered[0]?.categoryPath ?? [],
      items: ordered.slice(0, perCategory),
      total: ordered.length,
    });
  }
  return sections.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "zh-Hans-CN"));
}

export const ACTION_LABEL: Record<PrimaryAction, string> = {
  open: "打开",
  upgrade: "升级",
  install: "一键安装",
  request: "申请",
};

export const STATE_LABEL: Record<InstallState, string> = {
  "not-installed": "未安装",
  installed: "已安装",
  upgradable: "可升级",
  "needs-approval": "需审批",
};
