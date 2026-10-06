export type AppId = string;
export type CategoryId = string;
export type AppBadge = "recommend" | "exclusive" | "normal";
export type InstallerKind = "msi" | "msix" | "nsis" | "inno" | "archive" | "script";
/** silent 走静默参数一键装；manual 弹安装向导由用户完成（界面为「手动安装」描边按钮）。 */
export type InstallMode = "silent" | "manual";

export interface SilentSpec {
  kind: InstallerKind;
  installArgs: string[];
  uninstallArgs: string[];
  upgradeArgs?: string[];
  /** 额外视为成功的退出码，例如 msiexec 的 3010 表示需要重启。 */
  extraSuccessExitCodes?: number[];
  /** archive 与 script 类安装的工作目录。 */
  targetDirectory?: string;
  requiresAdmin?: boolean;
}

export interface AppVersion {
  version: string;
  releasedAt: string;
  sizeBytes: number;
  sha256: string;
  downloadUrl: string;
  releaseNotes: string;
  silent: SilentSpec;
  /** 可直接覆盖安装的最低在装版本，低于此版本需先卸载再安装。 */
  minUpgradeFrom?: string;
}

export interface AppSummary {
  id: AppId;
  name: string;
  /** 上架方维护的搜索关键字，例如英文名、别名、拼音。 */
  searchKeys: string[];
  publisher: string;
  categoryId: CategoryId;
  iconUrl: string;
  latestVersion: string;
  downloadCount: number;
  badge: AppBadge;
  tags: string[];
  requiresApproval: boolean;
  sizeBytes: number;
  /** 缺省按 silent 处理；目录里显式声明 manual 的应用展示「手动安装」。 */
  installMode?: InstallMode;
}

export interface AppDetail extends AppSummary {
  description: string;
  screenshots: string[];
  versions: AppVersion[];
}

export interface Category {
  id: CategoryId;
  name: string;
  parentId: CategoryId | null;
  sortOrder: number;
}

export interface RatingDistribution {
  /** 索引 0..4 对应 1..5 星。 */
  buckets: [number, number, number, number, number];
  mean: number;
  count: number;
}

export interface RatingInput {
  appId: AppId;
  userId: string;
  stars: number;
  verifiedInstall: boolean;
  comment?: string;
  createdAt: string;
}

export type MatchedField = "name" | "searchKeys" | "publisher" | "tags";
