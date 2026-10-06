import type { InstalledApp } from "../inventory/inventory.ts";
import type { RegClient, RegistryKey, RegistryValue } from "../inventory/registry.ts";
import type { ResidueItem } from "./scan.ts";

const SEP = "\\";

/** 右键菜单扩展挂载点（shell 扩展），残留扫描的「右键菜单」类。 */
export const CONTEXTMENU_ROOTS: string[] = [
  ["HKCR", "*", "shellex", "ContextMenuHandlers"].join(SEP),
  ["HKCR", "Directory", "shellex", "ContextMenuHandlers"].join(SEP),
  ["HKCR", "Folder", "shellex", "ContextMenuHandlers"].join(SEP),
  ["HKCR", "Drive", "shellex", "ContextMenuHandlers"].join(SEP),
  ["HKCR", "AllFilesystemObjects", "shellex", "ContextMenuHandlers"].join(SEP),
];

function normalizeGuid(value: string): string {
  const trimmed = value.replace(/[{}]/g, "").trim().toLowerCase();
  return trimmed;
}

function extractGuid(raw: string): string | null {
  const match = /\{([0-9A-Fa-f-]+)\}/.exec(raw);
  return match ? normalizeGuid(match[0]) : null;
}

function clsidKey(guid: string): string {
  return ["HKCR", "CLSID", "{" + guid.toUpperCase() + "}"].join(SEP);
}

interface ClsidInfo {
  server: string | null;
  description: string;
}

/**
 * 解析 CLSID 对应的服务器 DLL 与描述。
 * 同一个 shell 扩展常同时挂在多个挂载点（* / Directory / Folder / ...）下，
 * 用缓存把「每个挂载点各查一次」收敛成「每个 CLSID 只查一次」。
 */
async function moduleOfClsid(reg: RegClient, guid: string, cache: Map<string, ClsidInfo>): Promise<ClsidInfo> {
  const cached = cache.get(guid);
  if (cached) return cached;
  const key = clsidKey(guid);
  const keys = await reg.queryTree(key);
  const self = keys.find((k) => k.path.replace(/\\+$/, "").toLowerCase() === key.toLowerCase());
  const description = self?.values.find((v) => v.name === "(Default)" || v.name === "@")?.data ?? "";
  const server =
    keys
      .find((k) => k.path.toLowerCase().endsWith("inprocserver32"))
      ?.values.find((v) => v.name === "(Default)" || v.name === "@")?.data ?? null;
  const info: ClsidInfo = { server, description };
  cache.set(guid, info);
  return info;
}

/** 有界并发：真机上右键扩展常有十几个 CLSID，串行 queryTree 会把这一段拖到 ~0.8s，并发后压到一批的时延。 */
async function mapWithConcurrency<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await work(items[index] as T);
    }
  });
  await Promise.all(runners);
}

/**
 * 找出仍指向该应用的右键菜单扩展。
 * 命中项是挂载点键上的一个值，删除时按值删，备份仍导出整个挂载点键。
 *
 * 两趟结构：先按挂载根原顺序收集候选并汇总去重后的 CLSID，一次性并发解析（真机测得这一段
 * 78% 的耗时来自串行解析每个 CLSID），再按完全相同的顺序出结果——缓存已就绪，判定、去重
 * 与命中时机与逐条解析时一致，只是不再有 await 卡在值循环里。
 */
export async function scanContextMenu(
  app: InstalledApp,
  reg: RegClient,
  matches: (candidate: string) => boolean,
): Promise<ResidueItem[]> {
  const items: ResidueItem[] = [];
  const clsidCache = new Map<string, ClsidInfo>();
  // 五个挂载点并行取数，再按 CONTEXTMENU_ROOTS 原顺序处理，保证结果与顺序不变。
  const dumps = await Promise.all(CONTEXTMENU_ROOTS.map((root) => reg.queryTree(root)));

  interface Candidate {
    root: string;
    key: RegistryKey;
    value: RegistryValue;
    guid: string;
  }
  const candidates: Candidate[] = [];
  const uniqueGuids = new Set<string>();
  for (const [index, root] of CONTEXTMENU_ROOTS.entries()) {
    for (const key of dumps[index] ?? []) {
      if (key.path.replace(/\\+$/, "").toLowerCase() === root.toLowerCase()) continue;
      for (const value of key.values) {
        const guid = extractGuid(value.data) ?? (normalizeGuid(value.data).length === 36 ? normalizeGuid(value.data) : null);
        if (!guid) continue;
        candidates.push({ root, key, value, guid });
        uniqueGuids.add(guid);
      }
    }
  }

  await mapWithConcurrency([...uniqueGuids], 8, async (guid) => {
    await moduleOfClsid(reg, guid, clsidCache);
  });

  const seen = new Set<string>();
  for (const { root, key, value, guid } of candidates) {
    const marker = root.toLowerCase() + "|" + value.name.toLowerCase();
    if (seen.has(marker)) continue;
    const { server, description } = clsidCache.get(guid) ?? { server: null, description: "" };
    const evidence = [server ?? "", description, value.data].filter(Boolean);
    if (!evidence.some((entry) => matches(entry))) continue;
    seen.add(marker);
    // 处理器写成子键的默认值时，残留是那个子键本身；写成值时才是值级残留。
    const isDefault = value.name === "(Default)" || value.name === "@" || value.name === "";
    items.push({
      kind: "contextmenu",
      risk: "medium",
      path: isDefault ? key.path : key.path + SEP + value.name,
      ...(isDefault ? {} : { keyPath: key.path, valueName: value.name }),
      detail: "右键菜单扩展仍指向该应用" + (server ? "：" + server : "") + (description ? "（" + description + "）" : ""),
      reason: "orphan-context-menu-handler",
    });
  }
  return items;
}
