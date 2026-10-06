import type { InstalledApp } from "../inventory/inventory.ts";
import type { RegClient, RegistryKey } from "../inventory/registry.ts";
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

/**
 * 找出仍指向该应用的右键菜单扩展。
 * 命中项是挂载点键上的一个值，删除时按值删，备份仍导出整个挂载点键。
 */
export async function scanContextMenu(
  app: InstalledApp,
  reg: RegClient,
  matches: (candidate: string) => boolean,
): Promise<ResidueItem[]> {
  const items: ResidueItem[] = [];
  const seen = new Set<string>();
  const clsidCache = new Map<string, ClsidInfo>();
  // 五个挂载点并行取数，再按 CONTEXTMENU_ROOTS 原顺序处理，保证结果与顺序不变。
  const dumps = await Promise.all(CONTEXTMENU_ROOTS.map((root) => reg.queryTree(root)));
  for (const [index, root] of CONTEXTMENU_ROOTS.entries()) {
    const keys: RegistryKey[] = dumps[index] ?? [];
    for (const key of keys) {
      if (key.path.replace(/\\+$/, "").toLowerCase() === root.toLowerCase()) continue;
      for (const value of key.values) {
        const guid = extractGuid(value.data) ?? (normalizeGuid(value.data).length === 36 ? normalizeGuid(value.data) : null);
        if (!guid || seen.has(root.toLowerCase() + "|" + value.name.toLowerCase())) continue;
        const { server, description } = await moduleOfClsid(reg, guid, clsidCache);
        const evidence = [server ?? "", description, value.data].filter(Boolean);
        if (!evidence.some((entry) => matches(entry))) continue;
        seen.add(root.toLowerCase() + "|" + value.name.toLowerCase());
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
    }
  }
  return items;
}
