import { test } from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTrackedTmp, trackExisting } from "./util/tmp-dirs.ts";
import {
  AppCenterFacade,
  CONFIRM_TOKEN,
  RECYCLE_KEEP_DAYS,
  RECYCLE_MAX_BYTES,
  joinWithinRoot,
  parseRecycleStamp,
  pruneRecycle,
  purgeRecycle,
  removeWithinRecycle,
  type CleanupPolicy,
  type ResidueItem,
  type ResidueReport,
  type WindowHost,
} from "@appcenter/core";
import { CatalogDb, createApi, seedDemo } from "@appcenter/server";
import type { AddressInfo } from "node:net";

class NullHost implements WindowHost {
  async create(): Promise<string> { return "win-1"; }
  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async close(): Promise<void> {}
  async focus(): Promise<void> {}
}

const DAY = 86400_000;

/** facade 用的目录名格式：ISO 去掉 : 和 . */
function stampOf(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, "-");
}

async function fakeFacade(): Promise<{ facade: AppCenterFacade; dataDir: string; close: () => Promise<void> }> {
  const db = CatalogDb.memory("recycle-secret");
  seedDemo(db);
  const api = createApi({ db, packageRoot: await makeTrackedTmp("recycle-pkgs-"), adminToken: "admin" });
  const port = await new Promise<number>((resolve) => api.listen(0, "127.0.0.1", () => resolve((api.address() as AddressInfo).port)));
  const dataDir = await makeTrackedTmp("recycle-data-");
  const facade = new AppCenterFacade(
    { serverUrl: "http://127.0.0.1:" + String(port), userId: "me", dataDir, appVersion: "1.0.0", registryKeys: [] },
    new NullHost(),
  );
  return { facade, dataDir, close: async () => { api.closeAllConnections(); await new Promise<void>((r) => api.close(() => r())); } };
}

/** 在回收根里造一个目录项，名字与 mtime 都按给定时间，避免只测一种判据。 */
async function seedEntry(root: string, label: string, whenMs: number, bytes: number): Promise<string> {
  const name = stampOf(whenMs) + "-" + label;
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "payload.bin"), Buffer.alloc(bytes), "utf8");
  await utimes(dir, new Date(whenMs), new Date(whenMs));
  return name;
}

function reportOf(items: ResidueItem[]): ResidueReport {
  return { app: "X", regDir: "", scannedAt: new Date().toISOString(), durationMs: {} as ResidueReport["durationMs"], items, counts: {} as ResidueReport["counts"] };
}

test("回收根与盘点：条目数、占用字节、默认阈值可见", async () => {
  const { facade, dataDir, close } = await fakeFacade();
  try {
    const root = path.join(dataDir, "cleanup-recycle");
    await seedEntry(root, "a", Date.now() - DAY, 1024);
    await seedEntry(root, "b", Date.now() - 2 * DAY, 2048);
    const status = await facade.recycleStatus();
    assert.equal(status.root, root, "回收根应在 dataDir 之下");
    assert.equal(status.entries.length, 2);
    assert.equal(status.totalBytes, 3072, "占用字节要按目录递归求和，否则用户看不到自己占了多少");
    assert.equal(status.keepDays, RECYCLE_KEEP_DAYS);
    assert.equal(status.maxBytes, RECYCLE_MAX_BYTES);
  } finally {
    await close();
  }
});

test("保留期：超期的真删、未超期的留下，dryRun 不动盘", async () => {
  const root = await makeTrackedTmp("recycle-prune-");
  const old = await seedEntry(root, "old", Date.now() - 30 * DAY, 10);
  const fresh = await seedEntry(root, "fresh", Date.now() - DAY, 10);

  const preview = await pruneRecycle(root, { keepDays: 7, dryRun: true });
  assert.equal(preview.deleted.length, 1, "预览应指出会删掉超期那条");
  assert.equal((await readdir(root)).length, 2, "dryRun 不许动盘");

  const pruned = await pruneRecycle(root, { keepDays: 7 });
  assert.deepEqual(pruned.deleted.map((e) => e.name), [old]);
  const left = await readdir(root);
  assert.ok(left.includes(fresh), "未超期的必须留下：" + JSON.stringify(left));
  assert.equal(left.length, 1);
  assert.ok(pruned.bytesReclaimed > 0);
});

test("字节上限：从最旧开始淘汰到阈值之下，而不是全删", async () => {
  const root = await makeTrackedTmp("recycle-cap-");
  const e1 = await seedEntry(root, "c1", Date.now() - 3 * DAY, 5000);
  const e2 = await seedEntry(root, "c2", Date.now() - 2 * DAY, 5000);
  const e3 = await seedEntry(root, "c3", Date.now() - 1 * DAY, 5000);
  const pruned = await pruneRecycle(root, { keepDays: 365, maxBytes: 11000 });
  assert.deepEqual(pruned.deleted.map((e) => e.name), [e1], "只需淘汰最旧的一条就回到上限之内，不该牵连更多");
  const left = await readdir(root);
  assert.ok(left.includes(e2) && left.includes(e3), "未到期且腾空间已够的条目不该被牵连：" + JSON.stringify(left));
  assert.ok(left.length === 2);
});

test("时间戳解析：认得 facade 的目录名，认不得就退回 mtime", () => {
  const ms = Date.UTC(2026, 9, 7, 1, 2, 3, 4);
  assert.equal(parseRecycleStamp(stampOf(ms)), ms, "facade 生成的名字必须能解析回来");
  assert.equal(parseRecycleStamp("not-a-stamp"), null);
  assert.equal(parseRecycleStamp("2026-13-45T99-99-99-999"), null, "越界字段不该被当成时间");
});

test("删除只允许发生在回收根之内", async () => {
  const root = await makeTrackedTmp("recycle-esc-");
  // 这个逃逸兄弟目录是本用例**故意**造的（证明回收不会越界带走 root 之外的东西），
  // 所以它也得显式登记回收——登记走的是同一个 after()，不是让回收器去猜"邻近目录"。
  const outside = trackExisting(path.join(root, "..", "escapee-" + path.basename(root)));
  await mkdir(outside, { recursive: true });
  await assert.rejects(() => removeWithinRecycle(root, ".." + path.sep + path.basename(outside)), /outside|越界|refus/i);
  assert.ok((await stat(outside)).isDirectory(), "被拒之后外面的目录必须还在");

  // 断言的是**不变量**而不是某一种拒绝方式：实测绝对路径会被折叠成 root 内的名字
  // （`C:\Windows\Temp\nope` → `<root>\WindowsTemp\nope`），那也是安全方向；
  // 真正不许发生的是「解析结果跑到 root 之外」。
  const base = path.resolve(root);
  for (const name of ["C:\\Windows\\Temp\\nope", "/etc/passwd", "..\\..\\x", "a/../../b", "ok-child"]) {
    let target: string;
    try {
      target = joinWithinRoot(root, name);
    } catch {
      continue;
    }
    assert.ok(target === base || target.startsWith(base + path.sep), "解析结果跑出回收根：" + name + " → " + target);
  }
});

test("清空要确认串：给错就一条都不删", async () => {
  const root = await makeTrackedTmp("recycle-purge-");
  await seedEntry(root, "p1", Date.now(), 10);
  await assert.rejects(() => purgeRecycle(root, "nope"), /confirm|确认/i);
  assert.equal((await readdir(root)).length, 1, "确认串不对时不该有任何删除");
  const purged = await purgeRecycle(root, CONFIRM_TOKEN);
  assert.equal(purged.deleted.length, 1);
  assert.equal((await readdir(root)).length, 0);
});

test("接线：applyCleanup 之后顺手剪掉超期项（否则「只进不出」依旧成立）", async () => {
  const { facade, dataDir, close } = await fakeFacade();
  try {
    const root = path.join(dataDir, "cleanup-recycle");
    const stale = await seedEntry(root, "stale", Date.now() - 40 * DAY, 16);
    const sandbox = await makeTrackedTmp("recycle-wire-");
    const residue = path.join(sandbox, "leftover-dir");
    await mkdir(residue, { recursive: true });
    await writeFile(path.join(residue, "x.bin"), "data", "utf8");
    const policy: CleanupPolicy = { includeRisks: ["low"], allowWriteRoots: [sandbox], confirmToken: CONFIRM_TOKEN, backupDir: path.join(sandbox, "bk") };
    await facade.applyCleanup(reportOf([{ kind: "directory", risk: "low", path: residue, detail: "残留", reason: "leftover-directory" }]), policy, false);

    const left = await readdir(root);
    assert.ok(!left.includes(stale), "自动剪枝没接上：超期项仍在 " + JSON.stringify(left));
    assert.equal(left.length, 1, "应只剩刚移入的那一条：" + JSON.stringify(left));
    assert.ok(!(await stat(residue).catch(() => null)), "原残留目录应已移走");
  } finally {
    await close();
  }
});
