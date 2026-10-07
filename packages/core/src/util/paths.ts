import path from "node:path";

/**
 * 只留能安全落盘的分量：Windows 保留字符与所有路径分隔符都换掉，
 * 纯点号（`.`/`..`/`...`）整体替换成占位，避免目录穿越段。
 * 注意旧的 `safeName`（orchestrator/installer.ts）**不拦点号也不拦正斜杠**，
 * 所以它单独不足以当作落盘路径的分量净化器。
 */
export function safePathSegment(value: string, fallback = "unknown"): string {
  const cleaned = value
    .replace(/[<>:"\\/|?*\u0000-\u001f]/g, "_")
    .replace(/^\.+$/, "_")
    .trim()
    .replace(/\s+/g, "_");
  return cleaned.slice(0, 80) || fallback;
}

/**
 * 拼出必须落在 root 内的目标路径；越界就抛，绝不把一个外面的路径返回给调用方去写。
 * 分隔符按 `/` 与 `\` 两种都切开：只按 `/` 切时，`..\..\evil.exe` 会整段存活下来，
 * 在 Windows 上被 path.resolve 解释成逃逸（真机已复现：packageRoot 外写出文件）。
 */
export function joinWithinRoot(root: string, relative: string): string {
  const base = path.resolve(root);
  const target = path.resolve(base, ...relative.split(/[\\/]+/).filter(Boolean));
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("refusing to touch a path outside the repo root: " + relative);
  }
  return target;
}
