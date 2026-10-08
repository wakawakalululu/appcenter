import type { InstalledApp } from "./inventory.ts";

/**
 * 「哪一行」的选择器。卸载与残留报告都按行操作，而这两条路径过去都只拿 displayName 去
 * `find` 清单的第一条——同名不同实例在本机 141 项里实测就有（`Universal CRT Redistributable`
 * 两条不同 GUID、两个版本），于是点下面那行操作的却是上面那行。
 */
export interface InstanceSelector {
  /** 调用方给的字符串：可能是显示名，也可能是 regDir（CLI 与旧调用形态都这么传）。 */
  nameOrId: string;
  /** UI 每行带下来的注册表叶子名——同名不同实例只有它能区分。 */
  regDir?: string;
  /** 目录 id 解析出来的应用名（卸载侧有，残留报告侧没有）。 */
  catalogName?: string;
}

/** 只给名字却命中多条时抛出：让调用方补 regDir，而不是靠清单排序猜一条。 */
export class AmbiguousInstanceError extends Error {}

/**
 * 解析优先级：显式 regDir > 目录名 > 原样给的字符串（当名字试）> 当 regDir 试。
 * 每一步都大小写不敏感地比 regDir，命中多条一律拒绝——这两条路径一个是破坏性卸载、
 * 一个是喂破坏性清理的报告，选错对象的代价比「多点一次」大得多。
 */
export function resolveInstalledInstance(installed: readonly InstalledApp[], sel: InstanceSelector): InstalledApp {
  const byRegDir = (want: string) => installed.filter((i) => i.regDir.toLowerCase() === want.toLowerCase());
  const given = sel.regDir?.trim() ?? "";
  const candidates =
    given && byRegDir(given).length > 0
      ? byRegDir(given)
      : sel.catalogName
        ? installed.filter((i) => i.displayName === sel.catalogName)
        : [];
  const fallbackName = candidates.length > 0 ? candidates : installed.filter((i) => i.displayName === sel.nameOrId);
  const resolved = fallbackName.length > 0 ? fallbackName : byRegDir(sel.nameOrId);
  if (resolved.length === 0) throw new Error("not installed: " + sel.nameOrId);
  if (resolved.length > 1) {
    throw new AmbiguousInstanceError(
      "ambiguous target: " + String(resolved.length) + " 个同名实例（" + resolved.map((c) => c.regDir).join(", ") + "），需要指定 regDir",
    );
  }
  return resolved[0]!;
}
