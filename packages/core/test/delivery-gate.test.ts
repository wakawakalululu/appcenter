import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.join(import.meta.dirname, "../../../scripts/check-delivery.mjs");
const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

/**
 * HOME/USERPROFILE 指到临时目录：否则开发机上的全局 gitconfig（core.excludesFile 之类）
 * 会让「这个文件算不算未入库」随机器变——正是要治的那类环境红。
 */
const env = (dir: string) => ({ ...process.env, HOME: dir, USERPROFILE: dir });
const git = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: env(dir) });
const gate = (dir: string) => spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8", env: env(dir) });
const options = gitAvailable ? {} : { skip: "交付卫生要靠 git 才能判定，环境里没有 git" };

/** 一棵「有 HEAD、有跟踪内容」的最小仓库，并且带一个被 gitignore 的本机文件。 */
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "delivery-gate-"));
  await writeFile(path.join(dir, ".gitignore"), "LOCAL-NOTES.md\n");
  await writeFile(path.join(dir, "index.ts"), "export const a = 1;\n");
  await writeFile(path.join(dir, "LOCAL-NOTES.md"), "# 本机笔记\n");
  git(dir, "init", "-q");
  git(dir, "add", ".gitignore", "index.ts");
  // 身份用 -c 现场给（临时仓库、不写任何 config 文件）：否则「这台机器有没有全局 user.email」
  // 会决定这一步成不成功，而这个判据本身跟提交历史无关——HEAD 缺缺也不影响 ls-files 的两条查询。
  git(dir, "-c", "user.email=gate@example.invalid", "-c", "user.name=gate", "commit", "-q", "-m", "seed");
  return dir;
}

/** 往临时树里写一个文件，需要时先把父目录建出来。 */
async function put(dir: string, rel: string, body: string): Promise<void> {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body);
}

const drop = (dir: string) => rm(dir, { recursive: true, force: true });

test("干净树是绿的：被 gitignore 的本机文件不该算未入库", options, async () => {
  const dir = await fixture();
  try {
    const run = gate(dir);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, /交付卫生门禁通过/);
  } finally {
    await drop(dir);
  }
});

test("新增测试文件没 git add：必须红，并且点名到具体文件", options, async () => {
  const dir = await fixture();
  try {
    await put(dir, "packages/core/test/new-guard.test.ts", "// 新用例\n");
    const run = gate(dir);
    // 这一条是整个门禁存在的理由：CI 只看得到进仓库的文件，红在这里才拦得住「本地绿、别人少覆盖」。
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, /packages\/core\/test\/new-guard\.test\.ts/);
    assert.match(run.stdout + run.stderr, /\[测试\] 1 个/);
    assert.match(run.stdout + run.stderr, /用例数下限/);
  } finally {
    await drop(dir);
  }
});

test("未入库文件的名字带中文和空格：仍然逐个原样点名，数量不劈开", options, async () => {
  const dir = await fixture();
  try {
    await put(dir, "docs/spec 说明.md", "# x\n");
    await put(dir, "docs/规格 附录.md", "# y\n");
    const run = gate(dir);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    // 不用 NUL 分隔的话这里会变成 4 条或路径被截；「恰好 2 个」本身就是这一条的判据。
    assert.match(run.stdout + run.stderr, /\[规格与文档\] 2 个/);
    assert.match(run.stdout + run.stderr, /spec 说明\.md/);
    assert.match(run.stdout + run.stderr, /规格 附录\.md/);
  } finally {
    await drop(dir);
  }
});

test("已跟踪文件在工作树里有改动：单独报出来（部分提交会把它留在本地）", options, async () => {
  const dir = await fixture();
  try {
    await put(dir, "index.ts", "export const a = 2;\n");
    const run = gate(dir);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, /已跟踪未提交改动 1 个/);
    // 只有改动、没有新文件时，「测试/源码」那几组不该冒出来——否则红得说不清原因。
    assert.doesNotMatch(run.stdout + run.stderr, /\[测试\]/);
    assert.doesNotMatch(run.stdout + run.stderr, /未入库未跟踪 [1-9]/);
  } finally {
    await drop(dir);
  }
});

test("反向对照：同一棵树 git add 之后必须从红转绿", options, async () => {
  const dir = await fixture();
  try {
    await put(dir, "scripts/check-new-thing.mjs", "// 新门禁\n");
    const before = gate(dir);
    assert.equal(before.status, 1, "入库前应当红：" + before.stdout + before.stderr);
    assert.match(before.stdout + before.stderr, /\[脚本\] 1 个/);
    git(dir, "add", "scripts/check-new-thing.mjs");
    const after = gate(dir);
    // 已 stage 就等于会进下一次提交，不该再报——否则红会一直挂着，人会开始无视它。
    assert.equal(after.status, 0, "git add 之后应当绿：" + after.stdout + after.stderr);
  } finally {
    await drop(dir);
  }
});
