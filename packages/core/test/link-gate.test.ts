import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 门禁的判据必须由测试钉住，否则它会悄悄退化成空断言（本项目已经栽过好几次）。
// 三条用例：能落地的引用要绿、死链要红、由路由现场生成的路径不能被误伤。
const repoRoot = path.resolve(process.cwd());
const script = path.join(repoRoot, "scripts", "check-links.mjs");

async function makeRepo(): Promise<string> {
  const dir = await mkdtempSafe();
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: dir, USERPROFILE: dir } });
  run(["init", "-q"]);
  run(["config", "user.email", "t@example.invalid"]);
  run(["config", "user.name", "t"]);
  return dir;
}

async function mkdtempSafe(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(path.join(os.tmpdir(), "ac-links-gate-"));
}

function runGate(dir: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [script], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

test("引用能落地 ⇒ 绿", async () => {
  const dir = await makeRepo();
  try {
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "docs", "target.md"), "# 目标\n");
    await writeFile(path.join(dir, "README.md"), "看图 [说明](docs/target.md)\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const r = runGate(dir);
    assert.equal(r.code, 0, "不该报红：" + r.out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("死链 ⇒ 必须红，并点名是哪一条", async () => {
  const dir = await makeRepo();
  try {
    await writeFile(path.join(dir, "README.md"), "见 [不存在的文件](NO-SUCH-DOC.md)\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const r = runGate(dir);
    assert.notEqual(r.code, 0, "死链没被判红，这条门禁等于没装");
    assert.match(r.out, /NO-SUCH-DOC\.md/, "红了但没点名是哪条引用");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("被 gitignore 的本机文件 ⇒ 也算红（本机正常、上线 404）", async () => {
  const dir = await makeRepo();
  try {
    await writeFile(path.join(dir, ".gitignore"), "secret/\n");
    await mkdir(path.join(dir, "secret"), { recursive: true });
    await writeFile(path.join(dir, "secret", "note.md"), "x\n");
    await writeFile(path.join(dir, "README.md"), "见 [本机才有](secret/note.md)\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const r = runGate(dir);
    assert.notEqual(r.code, 0, "指向被 ignore 的文件的引用没被判红");
    assert.match(r.out, /不在可发布集合/, "红了但没说明是 ignore/未 add 这一类：" + r.out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("应用 UI 的根绝对路径：web 根下的文件算落地，路由生成的走例外", async () => {
  const dir = await makeRepo();
  try {
    await mkdir(path.join(dir, "packages", "app", "web"), { recursive: true });
    await writeFile(path.join(dir, "packages", "app", "web", "app.css"), "body{}\n");
    await writeFile(
      path.join(dir, "packages", "app", "web", "index.html"),
      '<link rel="stylesheet" href="/app.css" /><link rel="icon" href="/favicon.svg" />\n',
    );
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const r = runGate(dir);
    assert.equal(r.code, 0, "web 根的静态资源与路由生成的 favicon 都不该被判红：" + r.out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wiki 页内链按页名判：对得上⇒绿，对不上或引用本仓库图片⇒红", async () => {
  const dir = await makeRepo();
  try {
    await mkdir(path.join(dir, "wiki"), { recursive: true });
    await writeFile(path.join(dir, "wiki", "Home.md"), "# 总览\n");
    await writeFile(path.join(dir, "wiki", "Architecture.md"), "# 架构\n");
    await writeFile(path.join(dir, "wiki", "_Sidebar.md"), "- [Home](Home)\n- [架构](Architecture.md)\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    assert.equal(runGate(dir).code, 0, "页名带不带 .md 都该认得，不该判红");

    await writeFile(path.join(dir, "wiki", "_Sidebar.md"), "- [缺页](NoSuchPage.md)\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const bad = runGate(dir);
    assert.notEqual(bad.code, 0, "wiki 指向不存在的页面没被判红");
    assert.match(bad.out, /NoSuchPage\.md/, "红了但没点名是哪条");

    await writeFile(path.join(dir, "wiki", "_Sidebar.md"), "![截图](docs/assets/screenshots/home.png)\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const img = runGate(dir);
    assert.notEqual(img.code, 0, "wiki 引用本仓库附件（wiki 是独立仓库）没被判红");
    assert.match(img.out, /独立仓库/, "红了但没说清是哪一类：" + img.out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
