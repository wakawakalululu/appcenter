import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SwapRequest {
  /** 已通过目录校验、落在暂存区的新版本包。 */
  stagedPath: string;
  /** 正在使用的可执行文件。 */
  targetPath: string;
  backupDir: string;
  expectedSha256: string;
  /** 换版后由调用方给出的健康判据，例如启动新版本读取版本号。 */
  healthCheck?: () => Promise<boolean>;
  /** 目标文件被占用时的重试次数与间隔（Windows 上替换运行中的映像会 EBUSY）。 */
  swapAttempts?: number;
  swapDelayMs?: number;
  now?: () => Date;
}

export interface SwapOutcome {
  swapped: boolean;
  rolledBack: boolean;
  backupPath: string | null;
  message: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

/** 供上层做「换版前后是否真的变了」判据用；文件不存在时返回 null 而不是抛。 */
export async function fileSha256(file: string): Promise<string | null> {
  try {
    return await sha256(file);
  } catch {
    return null;
  }
}

function backupName(targetPath: string, stamp: string): string {
  const base = path.basename(targetPath, path.extname(targetPath));
  return path.join(path.dirname(targetPath), base + "-" + stamp + path.extname(targetPath));
}

/**
 * 真实换版：校验暂存包 → 备份在用文件 → 覆盖（占用时重试）→ 健康检查 → 不健康立即回滚。
 * 整个过程只碰 targetPath 与 backupDir，不删除暂存包，由调用方在确认成功后清理。
 */
export async function applyUpdate(request: SwapRequest): Promise<SwapOutcome> {
  const staged = await stat(request.stagedPath).catch(() => null);
  if (!staged) return { swapped: false, rolledBack: false, backupPath: null, message: "staged package missing" };
  const actual = await sha256(request.stagedPath);
  if (actual !== request.expectedSha256.toLowerCase()) {
    return { swapped: false, rolledBack: false, backupPath: null, message: "staged package checksum mismatch" };
  }

  await mkdir(request.backupDir, { recursive: true });
  // 宿主目录可能还不存在（首次落到沙箱 appDir），copyFile 不会自己建父目录。
  await mkdir(path.dirname(request.targetPath), { recursive: true });
  const stamp = (request.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(request.backupDir, path.basename(request.targetPath) + "." + stamp + ".bak");
  const previous = await stat(request.targetPath).catch(() => null);
  if (previous) await copyFile(request.targetPath, backupPath);

  const attempts = Math.max(1, request.swapAttempts ?? 5);
  let lastError = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await copyFile(request.stagedPath, request.targetPath);
      lastError = "";
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(request.swapDelayMs ?? 200);
    }
  }
  if (lastError) {
    if (previous) await copyFile(backupPath, request.targetPath).catch(() => undefined);
    return { swapped: false, rolledBack: false, backupPath: previous ? backupPath : null, message: "swap failed: " + lastError };
  }

  const healthy = request.healthCheck ? await request.healthCheck().catch(() => false) : true;
  if (healthy) {
    return { swapped: true, rolledBack: false, backupPath: previous ? backupPath : null, message: "update applied" };
  }
  if (previous) {
    await copyFile(backupPath, request.targetPath);
    return { swapped: false, rolledBack: true, backupPath, message: "health check failed, restored previous build" };
  }
  await rm(request.targetPath, { force: true });
  return { swapped: false, rolledBack: true, backupPath: null, message: "health check failed, removed broken build" };
}

/** 确认成功后清理备份，保留最近 keep 份用于应急。 */
export async function pruneBackups(backupDir: string, keep = 2): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(backupDir).catch(() => [] as string[]);
  const withTime = await Promise.all(
    entries
      .filter((name) => name.includes(".bak"))
      .map(async (name) => ({ name, mtime: (await stat(path.join(backupDir, name))).mtimeMs })),
  );
  const stale = withTime.sort((a, b) => b.mtime - a.mtime).slice(Math.max(0, keep));
  for (const entry of stale) await rm(path.join(backupDir, entry.name), { force: true });
  return stale.map((entry) => entry.name);
}
