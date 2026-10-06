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

export function compare(a: string, b: string): number {
  const x = parseTolerant(a);
  const y = parseTolerant(b);
  for (const key of ["major", "minor", "patch"] as const) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  return comparePrerelease(x.prerelease, y.prerelease);
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
