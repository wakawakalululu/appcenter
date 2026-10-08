export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
  raw: string;
}

const STRICT = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

export function parse(input: string): SemVer | null {
  const m = STRICT.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? "",
    raw: input,
  };
}

export function parseTolerant(input: string): SemVer {
  // 与 numericCore/compare 共用 splitCore：段内取「开头连续数字」，构建元数据一律不参与优先级。
  // 旧写法两处都不一致：整段必须全数字（"1.2.3" 里的 "2abc" 读成 0），
  // 且预发布用 `/-([0-9A-Za-z.-]+)$/` 要求连字符到串尾（于是 "1.2.3-rc.1+build.2" 读不出标签）。
  // 先核过调用方：两个 parse 函数在生产代码里都无人使用，所以统一不需要兼容性妥协。
  const { core, prerelease } = splitCore(input);
  const parts = core.split(".").map((p) => Number(/^\d+/.exec(p)?.[0] ?? "0"));
  return { major: parts[0] ?? 0, minor: parts[1] ?? 0, patch: parts[2] ?? 0, prerelease, raw: input };
}

function comparePrerelease(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "") return 1;
  if (b === "") return -1;
  const as = a.split(".");
  const bs = b.split(".");
  const n = Math.max(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 数字核心与预发布标签的唯一拆法：先剥掉 `+构建元数据`（按语义化版本，构建元数据不参与优先级），
 *  再取核心后第一个 `-` 之后的整段当预发布。
 *  旧写法用 `/-([0-9A-Za-z.-]+)$/`（要求连字符一路到串尾）于是两个方向都错：
 *  `1.2.3-rc.1+build.2` 读不出标签 ⇒ compare 把它当成与 `1.2.3` 相等（丢掉真实预发布，实测读数 0）；
 *  `1.2.3+meta-1` 的尾巴 `-1` 被当成标签 ⇒ compare 判它小于 `1.2.3`（凭空造出预发布，实测读数 -1）。
 *  而严格 parse 对这两串分别给 "rc.1" 和 ""——同一模块两套读法互斥，是上一轮 parseTolerant 那条的同族漏点。 */
function splitCore(input: string): { core: string; prerelease: string } {
  const t = input.trim().replace(/^v/i, "");
  const plus = t.indexOf("+");
  const noBuild = plus === -1 ? t : t.slice(0, plus);
  const dash = noBuild.indexOf("-");
  if (dash === -1) return { core: noBuild, prerelease: "" };
  return { core: noBuild.slice(0, dash), prerelease: noBuild.slice(dash + 1) };
}

/** 点分数字核心（不限三段）。Windows 版本常见四段（如 12.1.0.28488 / 14.40.33214.0），
 *  只取前三段会把仅第四段不同的版本误判为相等，导致漏报可升级。 */
function numericCore(input: string): number[] {
  const core = splitCore(input).core;
  if (core === "") return [0];
  return core.split(".").map((seg) => {
    const digits = /^\d+/.exec(seg);
    return digits ? Number(digits[0]) : 0;
  });
}

export function compare(a: string, b: string): number {
  const ca = numericCore(a);
  const cb = numericCore(b);
  const n = Math.max(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i] ?? 0;
    const y = cb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return comparePrerelease(splitCore(a).prerelease, splitCore(b).prerelease);
}

export function gt(a: string, b: string): boolean {
  return compare(a, b) > 0;
}

export function lt(a: string, b: string): boolean {
  return compare(a, b) < 0;
}

export type Operator = "gte" | "gt" | "lte" | "lt" | "eq" | "neq";

export interface RangeClause {
  operator: Operator;
  version: string;
}

export function parseRange(input: string): RangeClause[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((clause) => {
      const m = /^(>=|<=|!=|>|<|=)?\s*(.+)$/.exec(clause);
      const symbol = m?.[1] ?? "=";
      const version = m?.[2] ?? clause;
      const operator: Operator =
        symbol === ">=" ? "gte" : symbol === "<=" ? "lte" : symbol === ">" ? "gt" : symbol === "<" ? "lt" : symbol === "!=" ? "neq" : "eq";
      return { operator, version };
    });
}

export function satisfies(version: string, range: string): boolean {
  return parseRange(range).every((clause) => {
    const c = compare(version, clause.version);
    switch (clause.operator) {
      case "gte":
        return c >= 0;
      case "gt":
        return c > 0;
      case "lte":
        return c <= 0;
      case "lt":
        return c < 0;
      case "eq":
        return c === 0;
      case "neq":
        return c !== 0;
    }
  });
}
