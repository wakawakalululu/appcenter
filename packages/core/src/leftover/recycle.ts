import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { CONFIRM_TOKEN } from "./cleanup.ts";
import { joinWithinRoot } from "../util/paths.ts";

/**
 * 回收目录的保留策略。
 *
 * #26 把文件类残留从「不可逆递归删除」换成「移动到 `<dataDir>/cleanup-recycle/<时间戳>`」，
 * 但只进不出：跑几次清理就把磁盘越占越满，而且用户看不到自己占了多少。
 * 这里补上盘点、按期/按量剪枝与显式清空。
 *
 * 默认值不是拍出来的：`keepDays = 7` 与本仓库既有的审批凭证有效期（`createApproval` 里
 * `Date.now() + 7 * 86400_000`）对齐，给用户一周反悔窗口；`maxBytes = 2 GiB` 是硬顶，
 * 超过就从最旧开始淘汰——宁可少留几份可恢复项，也不能让清理功能把系统盘吃掉。
 */
export const RECYCLE_KEEP_DAYS = 7;
export const RECYCLE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DAY_MS = 86400_000;

export interface RecycleEntry {
  /** 目录项名字（facade 生成的是 `<ISO 时间戳>` + 可选后缀）。 */
  name: string;
  path: string;
  bytes: number;
  /** 从名字解析出的移动时间；解析不出时为 null，由调用方退回 mtime。 */
  stampMs: number | null;
  mtimeMs: number;
}

export interface RecycleStatus {
  root: string;
  entries: RecycleEntry[];
  totalBytes: number;
  keepDays: number;
  maxBytes: number;
}

export interface PruneOptions {
  keepDays?: number;
  maxBytes?: number;
  /** 注入时钟，方便测试。 */
  now?: () => number;
  dryRun?: boolean;
}

export interface PruneResult {
  deleted: RecycleEntry[];
  kept: RecycleEntry[];
  bytesReclaimed: number;
}

/**
 * 解析 facade 生成的时间戳目录名：`2026-08-28T01-02-37-176Z`
 * （即 `new Date().toISOString().replace(/[:.]/g, "-")`，末尾的 Z 也在名字里）。
 * 字段越界（13 月、99 分）一律当解析失败，不硬凑一个时间。
 */
export function parseRecycleStamp(name: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const sec = Number(s);
  const milli = Number(ms);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || sec > 59 || milli > 999) return null;
  const stamp = Date.UTC(year, month - 1, day, hour, minute, sec, milli);
  return Number.isFinite(stamp) ? stamp : null;
}

/** 递归求目录占用字节；单个文件读不到就跳过，不让盘点整体失败。 */
async function dirBytes(target: string): Promise<number> {
  let total = 0;
  let children: string[];
  try {
    children = await readdir(target);
  } catch {
    return 0;
  }
  for (const child of children) {
    const full = path.join(target, child);
    try {
      const info = await stat(full);
      if (info.isDirectory()) total += await dirBytes(full);
      else if (info.isFile()) total += info.size;
    } catch {
      continue;
    }
  }
  return total;
}

/** 列出回收根下的条目。根不存在视为空（还没做过任何清理）。 */
export async function listRecycle(root: string): Promise<RecycleEntry[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const entries: RecycleEntry[] = [];
  for (const name of names) {
    const full = joinWithinRoot(root, name);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    if (!info.isDirectory()) continue;
    entries.push({ name, path: full, bytes: await dirBytes(full), stampMs: parseRecycleStamp(name), mtimeMs: info.mtimeMs });
  }
  // 老→新：字节上限淘汰必须从最旧的开始，顺序写反就会先删掉刚移进来的那份。
  return entries.sort((a, b) => movedAt(a) - movedAt(b) || a.name.localeCompare(b.name));
}

/** 条目的「移动时间」：名字解析优先，退回 mtime（人工放进去的目录也该被管到）。 */
function movedAt(entry: RecycleEntry): number {
  return entry.stampMs ?? entry.mtimeMs;
}

/**
 * 删除回收根内的一个条目。名字先过 `joinWithinRoot`：
 * `../x` 或绝对路径一律拒，宁可错杀也不能让「清空回收目录」变成任意删除。
 */
export async function removeWithinRecycle(root: string, name: string): Promise<void> {
  const target = joinWithinRoot(root, name);
  await rm(target, { recursive: true, force: true });
}

/** 按保留期 + 字节上限剪枝；`dryRun` 只报告不动盘。 */
export async function pruneRecycle(root: string, options: PruneOptions = {}): Promise<PruneResult> {
  const keepDays = options.keepDays ?? RECYCLE_KEEP_DAYS;
  const maxBytes = options.maxBytes ?? RECYCLE_MAX_BYTES;
  const now = options.now ? options.now() : Date.now();
  const cutoff = now - keepDays * DAY_MS;
  const entries = await listRecycle(root);
  const deleted: RecycleEntry[] = [];
  const kept: RecycleEntry[] = [];
  let remaining = entries.reduce((sum, e) => sum + e.bytes, 0);

  for (const entry of entries) {
    const expired = movedAt(entry) < cutoff;
    // 超期直接删；未超期的只有在**仍然超字节上限**时才从最旧开始淘汰，
    // 一旦落回上限之内就停手——不该把没到期的条目全删掉。
    if (!expired && remaining <= maxBytes) {
      kept.push(entry);
      continue;
    }
    if (!options.dryRun) await removeWithinRecycle(root, entry.name);
    deleted.push(entry);
    remaining -= entry.bytes;
  }
  return { deleted, kept, bytesReclaimed: deleted.reduce((sum, e) => sum + e.bytes, 0) };
}

/** 整盘清空：破坏性操作，必须带确认串。 */
export async function purgeRecycle(root: string, confirmToken: string, options: { now?: () => number } = {}): Promise<PruneResult> {
  if (confirmToken !== CONFIRM_TOKEN) throw new Error("purge requires the confirmation token");
  return pruneRecycle(root, { keepDays: 0, maxBytes: 0, now: options.now });
}

/** 盘点视图：给 UI 与 `cleanup.recycle` 用。 */
export async function recycleStatus(root: string, options: { keepDays?: number; maxBytes?: number } = {}): Promise<RecycleStatus> {
  const entries = await listRecycle(root);
  return {
    root,
    entries,
    totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
    keepDays: options.keepDays ?? RECYCLE_KEEP_DAYS,
    maxBytes: options.maxBytes ?? RECYCLE_MAX_BYTES,
  };
}
