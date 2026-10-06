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
  const trimmed = input.trim().replace(/^v/i, "");
  const head = trimmed.split(/[-+]/)[0] ?? "";
  const parts = head.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
  const prerelease = /-([0-9A-Za-z.-]+)$/.exec(trimmed)?.[1] ?? "";
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

function prereleaseOf(input: string): string {
  return /-([0-9A-Za-z.-]+)$/.exec(input.trim().replace(/^v/i, ""))?.[1] ?? "";
}

/** 点分数字核心（不限三段）。Windows 版本常见四段（如 12.1.0.28488 / 14.40.33214.0），
 *  只取前三段会把仅第四段不同的版本误判为相等，导致漏报可升级。 */
function numericCore(input: string): number[] {
  const head = input.trim().replace(/^v/i, "").split(/[-+]/)[0] ?? "";
  if (head === "") return [0];
  return head.split(".").map((seg) => {
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
  return comparePrerelease(prereleaseOf(a), prereleaseOf(b));
}

export function gt(a: string, b: string): boolean {
  return compare(a, b) > 0;
}

export function lt(a: string, b: string): boolean {
  return compare(a, b) < 0;
}

export type Operator = "gte" | "gt" | "lte" | "lt" | "eq";

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
        symbol === ">=" ? "gte" : symbol === "<=" ? "lte" : symbol === ">" ? "gt" : symbol === "<" ? "lt" : "eq";
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
    }
  });
}
