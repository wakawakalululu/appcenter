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
  // 各类连字符/破折号（含 U+2010–U+2015、全角－）与 ASCII 分隔符同等对待：
  // Windows 显示名里 `Redistributable – x64` 这类写法很常见，只剥 ASCII `-` 会让尾巴判定失败。
  return value.normalize("NFKC").toLowerCase().replace(/[\s\-_·．.\u2010-\u2015－]+/g, "");
}

/**
 * 去掉版本类后缀。注意归一化已经把点号删掉了，所以旧写法里 `\d+(\.\d+)+$` 这一支**永远匹配不上**；
 * 归一化后的版本号是一串裸数字，要按尾部数字串来剥才真能吃到 `WPS Office (12.1.0.28488)` 这类带版本的显示名。
 */
function stripVersionSuffix(value: string): string {
  return normalizeName(value).replace(/(正式版|版|pro|enterprise|x\d+|\d+)$/g, "");
}

/**
 * 子串命中的收口。真机测量出的误配是 `Git` ⊂ `vs_githubprotocolhandlermsi`、`微信` ⊂ `企业微信`
 * （旧写法是无界 `includes`，双向都算命中）；而唯一合法的命中 `WPS Office` ⊂ `WPS Office (12.1.0.28488)`
 * 是**前缀**关系。只按长度卡会误伤 `钉钉` ⊂ `钉钉6.5.0` 这类短名产品，
 * 所以规则是：短的必须是长的**前缀**，且尾巴只能是限定词（版本号 / 架构 / 括号组 / 版·Pro 一类词）。
 *
 * 尾巴必须「全是限定词」而不是「首字符是数字或名字够长」：真机里
 * `Microsoft Edge` ⊂ `Microsoft Edge WebView2 Runtime` 满足旧条件（前缀且 ≥5 字符）却是**另一个组件**，
 * 会被当成 Edge 的在装版本比大小；而合法形状 `演示应用` ⊂ `演示应用 (x64) 2.0.0` 的尾巴是括号限定词，
 * 必须放行（升级侧测试已把它钉为合法关系）。
 */
/**
 * 尾巴只允许「限定词」：版本号、架构、括号组、以及一小组已知的发行版后缀词。
 * 不能把 `a-z` 整段放进字符类——那样 `webview2runtime` 也算通过，等于没收口。
 * 认不准的尾巴一律拒绝：宁可不给升级候选/不认已装，也不能拿另一个组件的版本来比大小。
 */
const QUALIFIER_TOKEN =
  "(?:x64|x86|x32|arm64|amd64|i386|win32|win64|windows|mac|linux|portable|user|machine|admin|enterprise|community|standard|lite|beta|rc|pro|preview|build|xiii|xii|xi|ix|viii|vii|vi|iv|iii|ii|xl|xx|xv|x|v|i|版|专业版|企业版|正式版|中文|国际|海外|\\d[\\d.\\-+]*|[（）()\\[\\]{}._+\\-]+)";
const QUALIFIER_TAIL = new RegExp("^(?:" + QUALIFIER_TOKEN + ")+$");

function qualifierTail(remainder: string): boolean {
  // 归一化已经去掉空格与点号，所以尾巴里的版本号形如 `200`、括号组形如 `(x64)`。
  return remainder.length > 0 && QUALIFIER_TAIL.test(remainder);
}

function prefixHit(shorter: string, longer: string): boolean {
  if (!shorter || shorter === longer) return false;
  if (!longer.startsWith(shorter)) return false;
  return qualifierTail(longer.slice(shorter.length));
}

/**
 * 名称级匹配可信度：3 精确同名，2 前缀或词根命中，1 仅厂商相关，0 不算数。
 * 目录视图与升级计划共用这一条判据（#30 的收口 + #28 的「厂商相同不足以配对」），
 * 不再各写一套匹配——两处规则漂移过一次，就是升级侧那份无界双向子串造成的假可升级项。
 */
export function nameMatchQuality(app: AppSummary, item: InstalledApp): number {
  const target = normalizeName(app.name);
  const targetStem = stripVersionSuffix(app.name);
  const name = normalizeName(item.displayName);
  const stem = stripVersionSuffix(item.displayName);
  if (name === target) return 3;
  if (prefixHit(target, name) || prefixHit(name, target)) return 2;
  if (stem === targetStem && targetStem.length > 3) return 2;
  if (app.publisher && item.publisher && normalizeName(item.publisher).includes(normalizeName(app.publisher))) return 1;
  return 0;
}

export function matchInstalled(app: AppSummary, installed: readonly InstalledApp[]): { app: InstalledApp | null; quality: number } {
  let best: { app: InstalledApp | null; quality: number } = { app: null, quality: 0 };
  for (const item of installed) {
    const quality = nameMatchQuality(app, item);
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
    // 匹配到本机条目不等于知道版本号：真机不少卸载项的 DisplayVersion 是空串而不是缺失，
    // 空串一旦进 compare() 就会被当成 0，导致这个应用永远显示「可升级」。
    const detected = match.quality >= 2 && match.app !== null;
    const rawVersion = detected ? match.app?.displayVersion ?? "" : "";
    const installedVersion = rawVersion.trim() === "" ? null : rawVersion;
    const upgradable = installedVersion !== null && compare(app.latestVersion, installedVersion) > 0;
    const needsApproval = app.requiresApproval && !(input.granted?.has(app.id) ?? false);
    // 审批只挡「会写入的动作」：没装、或确实有新版待装时才转成申请；
    // 已装且已是最新无需安装，不该把状态说成待审批。
    const installState: InstallState = needsApproval && (!detected || upgradable) ? "needs-approval" : upgradable ? "upgradable" : detected ? "installed" : "not-installed";
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
