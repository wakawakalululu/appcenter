export interface ThemeTokens {
  color: {
    primary: string;
    primaryHover: string;
    primarySoft: string;
    background: string;
    surface: string;
    surfaceRaised: string;
    textPrimary: string;
    textSecondary: string;
    textMuted: string;
    divider: string;
    success: string;
    warning: string;
    danger: string;
    star: string;
    badgeExclusive: string;
    badgeRecommend: string;
    /** 侧栏渐变两端与上面的文字色，构成两段式渐变。 */
    navFrom: string;
    navTo: string;
    onNav: string;
    /** 首页运营位底色，浅底插画背景。 */
    bannerBg: string;
    sectionFrom: string;
    sectionTo: string;
  };
  radius: { sm: number; md: number; lg: number };
  spacing: number[];
  font: { family: string; sizeBase: number; sizeTitle: number };
  assets: { logo: string; banner: string; windowButton: string };
}

export type SkinId = string;

export const BASE_TOKENS: ThemeTokens = {
  color: {
    // 经典皮肤取自经典配色的设计基线（skin_default 主题定义），不是随意取值。
    primary: "#3C5CFE",
    primaryHover: "#2C48E0",
    primarySoft: "#EAEEFF",
    background: "#F5F6FA",
    surface: "#FFFFFF",
    surfaceRaised: "#FFFFFF",
    textPrimary: "#1A1A1A",
    textSecondary: "#4A4F5A",
    textMuted: "#8A9099",
    divider: "#E4E6EB",
    success: "#1BA572",
    warning: "#E8A317",
    danger: "#D93025",
    star: "#FF9500",
    badgeExclusive: "#7B4DFF",
    badgeRecommend: "#FF5A2C",
    navFrom: "#3C5CFE",
    navTo: "#3948FE",
    onNav: "#FFFFFF",
    bannerBg: "#E7F0FE",
    sectionFrom: "#EAF0FF",
    sectionTo: "#F7F9FF",
  },
  radius: { sm: 4, md: 8, lg: 14 },
  spacing: [4, 8, 12, 16, 24, 32],
  font: { family: "PingFang SC, Source Han Sans SC, Microsoft YaHei", sizeBase: 14, sizeTitle: 20 },
  assets: { logo: "assets/logo_combine.png", banner: "assets/recommend_bg1.png", windowButton: "assets/window_btn_min.svg" },
};

const OVERRIDES: Record<string, { label: string; override: DeepPartial<ThemeTokens> }> = {
  default: { label: "经典", override: {} },
  dark: {
    label: "深色",
    override: {
      color: {
        primary: "#4C7DFF",
        primaryHover: "#6E96FF",
        primarySoft: "#1E2740",
        background: "#121418",
        surface: "#1B1E24",
        surfaceRaised: "#23272F",
        textPrimary: "#F2F3F5",
        textSecondary: "#B7BCC6",
        textMuted: "#7C828D",
        divider: "#2C313A",
        navFrom: "#0D0D0E",
        navTo: "#0A0A0A",
        bannerBg: "#1E2740",
        sectionFrom: "#23272F",
        sectionTo: "#1B1E24",
      },
    },
  },
  cny: {
    label: "春节",
    // 取样自 skin_cny/navigation_bg.png（#DA3E3D → #CF3938）。
    override: {
      color: {
        primary: "#DA3E3D",
        primaryHover: "#B92F2E",
        primarySoft: "#FCEBEB",
        background: "#FBF3EA",
        star: "#E5A100",
        badgeRecommend: "#C62828",
        navFrom: "#DA3E3D",
        navTo: "#CF3938",
        bannerBg: "#FBE9E1",
        sectionFrom: "#FBE4DC",
        sectionTo: "#FFF6EE",
      },
    },
  },
  fresh: {
    label: "清新",
    // 取样自 skin_fresh/navigation_bg.png 与实机截图：薄荷绿侧栏 + 浅蓝运营位 + #27D47B 主按钮。
    override: {
      color: {
        primary: "#27D47B",
        primaryHover: "#1FB86A",
        primarySoft: "#F0FCF6",
        background: "#FFFFFF",
        textSecondary: "#33433B",
        textMuted: "#7C8C84",
        divider: "#E7F3EC",
        badgeExclusive: "#12A594",
        navFrom: "#6FE3E1",
        navTo: "#8EF2AC",
        bannerBg: "#E1F2FD",
        sectionFrom: "#70F79B",
        sectionTo: "#C8FBE0",
      },
    },
  },
};

function deepMerge<T extends object>(base: T, override: unknown): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    const current = out[key];
    if (value && typeof value === "object" && current && typeof current === "object" && !Array.isArray(value)) {
      out[key] = deepMerge<Record<string, unknown>>(current as Record<string, unknown>, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export interface SkinValidationError {
  token: string;
  reason: string;
}

const HEX = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

/** 皮肤就是一张 token 覆盖表，UI 只允许引用语义 token。 */
export function validateTokens(tokens: ThemeTokens): SkinValidationError[] {
  const errors: SkinValidationError[] = [];
  for (const [name, value] of Object.entries(tokens.color)) {
    if (!HEX.test(value)) errors.push({ token: "color." + name, reason: "not a hex color" });
  }
  if (tokens.spacing.length < 4) errors.push({ token: "spacing", reason: "need at least 4 steps" });
  if (tokens.font.sizeBase < 10 || tokens.font.sizeBase > 24) errors.push({ token: "font.sizeBase", reason: "out of range" });
  for (const key of ["logo", "banner"] as const) {
    if (!tokens.assets[key]) errors.push({ token: "assets." + key, reason: "missing asset path" });
  }
  return errors;
}

export interface ResolvedSkin {
  id: SkinId;
  label: string;
  tokens: ThemeTokens;
  /** 覆盖表未提供、由基础主题补齐的 token。 */
  fallbacks: string[];
  errors: SkinValidationError[];
}

export class SkinRegistry {
  private readonly skins = new Map<SkinId, { label: string; override: DeepPartial<ThemeTokens> }>();
  private activeId: SkinId = "default";

  constructor() {
    for (const [id, entry] of Object.entries(OVERRIDES)) this.skins.set(id, entry);
  }

  register(id: SkinId, label: string, override: DeepPartial<ThemeTokens>): void {
    this.skins.set(id, { label, override });
  }

  ids(): SkinId[] {
    return [...this.skins.keys()];
  }

  list(): { id: SkinId; label: string }[] {
    return [...this.skins.entries()].map(([id, entry]) => ({ id, label: entry.label }));
  }

  get active(): SkinId {
    return this.activeId;
  }

  setActive(id: SkinId): ResolvedSkin {
    if (!this.skins.has(id)) throw new Error("unknown skin " + id);
    this.activeId = id;
    return this.resolve(id);
  }

  resolve(id: SkinId): ResolvedSkin {
    const entry = this.skins.get(id);
    if (!entry) throw new Error("unknown skin " + id);
    const tokens = deepMerge(BASE_TOKENS, entry.override);
    const fallbacks: string[] = [];
    for (const [group, values] of Object.entries(BASE_TOKENS)) {
      const provided = (entry.override as Record<string, unknown>)[group];
      for (const key of Object.keys(values as object)) {
        if (!provided || !(key in (provided as object))) fallbacks.push(group + "." + key);
      }
    }
    return { id, label: entry.label, tokens, fallbacks, errors: validateTokens(tokens) };
  }

  /** 节日皮肤按日期区间临时生效，区间外返回 null 由调用方回落到 active。 */
  applyFestival(id: SkinId, window: { from: string; to: string }, now = new Date()): ResolvedSkin | null {
    const from = Date.parse(window.from);
    const to = Date.parse(window.to);
    if (Number.isNaN(from) || Number.isNaN(to)) throw new Error("invalid festival window");
    const t = now.getTime();
    if (t < from || t > to) return null;
    return this.resolve(id);
  }
}
