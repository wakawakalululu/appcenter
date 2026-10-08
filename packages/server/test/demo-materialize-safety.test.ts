import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CatalogDb, materializeDemoPackages, seedDemo } from "@appcenter/server";

const repoRoot = path.resolve(process.cwd());
const BS = String.fromCharCode(92);

function appWithDownloadUrl(id: string, downloadUrl: string) {
  return {
    id,
    name: "演示逃逸",
    searchKeys: ["esc"],
    publisher: "本机",
    categoryId: "other",
    iconUrl: "",
    latestVersion: "1.0.0",
    downloadCount: 1,
    badge: "normal" as const,
    tags: [],
    requiresApproval: false,
    sizeBytes: 1,
    description: "",
    screenshots: [],
    versions: [
      {
        version: "1.0.0",
        releasedAt: "2026-01-01",
        sizeBytes: 1,
        sha256: "a".repeat(64),
        downloadUrl,
        releaseNotes: "",
        silent: { kind: "nsis" as const, installArgs: ["/S"], uninstallArgs: ["/S"], requiresAdmin: false },
      },
    ],
  };
}

test("物化演示包不得被目录里的 downloadUrl 写到 packageRoot 之外", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mat-root-"));
  const packageRoot = path.join(dir, "store");
  // 逃逸目标名带本次沙箱名：上一轮的越界产物会落在 %TEMP% 里，用固定名会让这条断言
  // 读到陈旧文件、把「已修好」误判成「还没修」。
  const tag = path.basename(dir).replace(/[^A-Za-z0-9]/g, "");
  const bsName = "escape-bs-" + tag + ".exe";
  const db = CatalogDb.memory("mat-secret");
  seedDemo(db);
  // 反斜杠形式：`split("/")` 完全切不开它，旧实现直接 path.join 出去。
  const bsUrl = "/dl/" + ".." + BS + ".." + BS + bsName;
  const absUrl = "C:/Windows/Tasks/escape-abs-" + tag + ".exe";
  db.upsertApp(appWithDownloadUrl("esc-bs", bsUrl) as never, [
    { version: "1.0.0", releasedAt: "2026-01-01", sizeBytes: 1, sha256: "a".repeat(64), downloadUrl: bsUrl, releaseNotes: "", silent: { kind: "nsis", installArgs: ["/S"], uninstallArgs: ["/S"], requiresAdmin: false } },
  ] as never);
  db.upsertApp(appWithDownloadUrl("esc-abs", absUrl) as never, [
    { version: "1.0.0", releasedAt: "2026-01-01", sizeBytes: 1, sha256: "a".repeat(64), downloadUrl: absUrl, releaseNotes: "", silent: { kind: "nsis", installArgs: ["/S"], uninstallArgs: ["/S"], requiresAdmin: false } },
  ] as never);

  materializeDemoPackages(db, packageRoot);

  assert.ok(!existsSync(path.resolve(dir, "..", "..", bsName)), "反斜杠形式把文件写到了 packageRoot 之外：" + bsName);
  assert.ok(!existsSync(path.resolve(tmpdir(), bsName)), "同上：落在 %TEMP% 根上的越界产物");
  assert.ok(!existsSync("C:\\Windows\\Tasks\\escape-abs-" + tag + ".exe"), "绝对路径 downloadUrl 不得被当相对文件名写出去");
  const { readdirSync } = await import("node:fs");
  const written = existsSync(packageRoot) ? readdirSync(packageRoot, { recursive: true }) : [];
  for (const f of written) {
    const abs = path.resolve(packageRoot, String(f));
    assert.ok(abs.startsWith(path.resolve(packageRoot) + path.sep), "落盘点越出 packageRoot：" + abs);
  }
});

test("已带真实校验值的版本不得被演示物化覆写", async () => {
  const db = CatalogDb.memory("mat-clobber");
  seedDemo(db);
  const packageRoot = await mkdtemp(path.join(tmpdir(), "mat-clobber-root-"));
  const target = db.summaries()[0];
  assert.ok(target, "seedDemo 应至少有一个应用");
  const realSha = createHash("sha256").update("一个真实安装包的字节").digest("hex");
  const detail = db.detail(target.id);
  assert.ok(detail);
  const version = detail.versions[0];
  assert.ok(version);
  db.putVersion(target.id, { ...version, sizeBytes: 12345, sha256: realSha });

  materializeDemoPackages(db, packageRoot);

  const after = db.detail(target.id)?.versions[0];
  assert.equal(after?.sha256, realSha, "真实 sha256 被演示占位文件覆写了 ⇒ 之后真装必然校验失败");
  assert.equal(after?.sizeBytes, 12345, "真实体积同样被覆写");
});

test("演示入口不得接受外部 DB_FILE（防止把演示数据灌进真实目录库）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "uidemo-db-"));
  const pretendRealDb = path.join(dir, "catalog.db");
  // 端口一律取 0（临时端口）：曾经写死 8311/8312，两个全量测试并行时第二个 ui-demo
  // 直接 EADDRINUSE 起不来，这条断言就变成 30s 超时的「环境红」——同一条命令单跑必绿。
  // TMP/TEMP 与演示数据目录也必须每次唯一，否则并行的两个进程会在同一个共享目录里互相踩。
  const privateTmp = path.join(dir, "tmp");
  await mkdir(privateTmp, { recursive: true });
  // 必须是个真 SQLite 库：上一版我往里塞纯文本，ui-demo 是**报错退出**而不是「没动库」，
  // 那条断言当时并不成立。用真库 + apps 行数增量做判据才说得清。
  const initial = CatalogDb.open(pretendRealDb);
  assert.equal(initial.summaries().length, 0, "前置：这个库本来是空的");
  initial.raw().close();

  const child = spawn(
    process.execPath,
    ["--experimental-transform-types", path.join(repoRoot, "scripts", "ui-demo.mts")],
    {
      // cwd 也用本次运行的私有目录：ui-demo 把演示安装包物化到相对路径 `smoke-packages`，
      // 用 repoRoot 时两个并行的测试进程会写同一批文件，其中一个会 EPERM 崩在「ui on」之前——
      // 端口收口成 0 之后残留的就是这一处共享路径。
      cwd: dir,
      env: { ...process.env, DB_FILE: pretendRealDb, CATALOG_PORT: "0", UI_PORT: "0", TMP: privateTmp, TEMP: privateTmp },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  child.on("error", () => undefined);
  // 等到它确实起起来（或最多 30s），否则「没动这个库」可能只是因为没跑起来。
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !/ui on/.test(out)) await new Promise<void>((resolve) => setTimeout(resolve, 250));
  const started = /ui on/.test(out);
  child.kill();
  await new Promise<void>((resolve) => (child.exitCode === null ? child.once("exit", () => resolve()) : resolve()));
  assert.ok(started, "ui-demo 没起来，这条断言无意义：" + out.slice(0, 300));

  const after = CatalogDb.open(pretendRealDb);
  const seeded = after.summaries().length;
  after.raw().close();
  assert.equal(seeded, 0, "ui-demo 往外部 DB_FILE 指向的库灌了 " + String(seeded) + " 个演示应用（还会覆写其 size/sha256）");
  // 成功路径收尾删掉本次的私有临时目录；失败时留着，现场比整洁值钱。
  await rm(dir, { recursive: true, force: true });
});
