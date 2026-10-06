import type { AppBadge, AppSummary, Category, CategoryId, MatchedField } from "./types.ts";

export type { MatchedField };

export function normalize(input: string): string {
  return input.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length === 1) out.add(s);
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

export function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const left = bigrams(a);
  const right = bigrams(b);
  let hit = 0;
  for (const g of left) if (right.has(g)) hit++;
  return (2 * hit) / (left.size + right.size);
}

const FIELD_WEIGHT: Record<MatchedField, number> = { name: 100, searchKeys: 60, publisher: 30, tags: 25 };

export interface SearchQuery {
  text: string;
  categoryId?: CategoryId;
  /** 由 facade 展开成含子树的集合，直接调用方也可以自己传。 */
  categoryIds?: CategoryId[];
  badge?: AppBadge;
  limit?: number;
  offset?: number;
}

export interface SearchHit {
  app: AppSummary;
  score: number;
  matchedOn: MatchedField;
}

function fieldScore(needle: string, haystack: string): number {
  const hay = normalize(haystack);
  if (!hay) return 0;
  if (hay === needle) return 1;
  if (hay.startsWith(needle)) return 0.85;
  if (hay.includes(needle)) return 0.7;
  return dice(needle, hay) * 0.5;
}

export function searchCatalog(apps: readonly AppSummary[], query: SearchQuery): SearchHit[] {
  const needle = normalize(query.text);
  const wanted = query.categoryIds ?? (query.categoryId ? [query.categoryId] : null);
  const hits: SearchHit[] = [];
  for (const app of apps) {
    if (wanted && !wanted.includes(app.categoryId)) continue;
    if (query.badge && app.badge !== query.badge) continue;
    let best = 0;
    let matchedOn: MatchedField = "name";
    const consider = (field: MatchedField, value: string) => {
      const s = fieldScore(needle, value) * FIELD_WEIGHT[field];
      if (s > best) {
        best = s;
        matchedOn = field;
      }
    };
    if (needle) {
      consider("name", app.name);
      for (const k of app.searchKeys) consider("searchKeys", k);
      consider("publisher", app.publisher);
      for (const t of app.tags) consider("tags", t);
      if (best === 0) continue;
    }
    const popularity = Math.min(1, Math.log10(app.downloadCount + 1) / 5) * 4;
    const badgeBonus = app.badge === "recommend" ? 6 : app.badge === "exclusive" ? 3 : 0;
    hits.push({ app, score: best + popularity + badgeBonus, matchedOn });
  }
  hits.sort((a, b) => b.score - a.score || a.app.name.localeCompare(b.app.name, "zh-Hans-CN"));
  const offset = query.offset ?? 0;
  return hits.slice(offset, offset + (query.limit ?? 50));
}

export interface CategoryNode {
  id: CategoryId;
  name: string;
  path: string[];
  sortOrder: number;
  appCount: number;
  children: CategoryNode[];
}

export function buildCategoryTree(categories: readonly Category[], apps: readonly AppSummary[]): CategoryNode[] {
  const nodes = new Map<CategoryId, CategoryNode>();
  for (const c of categories) {
    nodes.set(c.id, { id: c.id, name: c.name, path: [], sortOrder: c.sortOrder, appCount: 0, children: [] });
  }
  const roots: CategoryNode[] = [];
  for (const c of categories) {
    const node = nodes.get(c.id);
    if (!node) continue;
    const parent = c.parentId ? nodes.get(c.parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const direct = new Map<CategoryId, number>();
  for (const a of apps) direct.set(a.categoryId, (direct.get(a.categoryId) ?? 0) + 1);
  const walk = (node: CategoryNode, trail: string[], guard: Set<CategoryId>): number => {
    node.path = [...trail, node.name];
    node.children.sort((a, b) => a.sortOrder - b.sortOrder);
    let total = direct.get(node.id) ?? 0;
    if (!guard.has(node.id)) {
      guard.add(node.id);
      for (const child of node.children) total += walk(child, node.path, guard);
    }
    node.appCount = total;
    return total;
  };
  roots.sort((a, b) => a.sortOrder - b.sortOrder);
  for (const r of roots) walk(r, [], new Set());
  return roots;
}

/** 分类是树，点击父分类应当包含其全部子分类下的应用。 */
export function categorySubtreeIds(categories: readonly Category[], rootId: CategoryId): CategoryId[] {
  const childrenOf = new Map<CategoryId, CategoryId[]>();
  for (const category of categories) {
    const parent = category.parentId;
    if (!parent) continue;
    const list = childrenOf.get(parent) ?? [];
    list.push(category.id);
    childrenOf.set(parent, list);
  }
  const out: CategoryId[] = [];
  const seen = new Set<CategoryId>();
  const stack: CategoryId[] = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const child of childrenOf.get(id) ?? []) stack.push(child);
  }
  return out;
}
