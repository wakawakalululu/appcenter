import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.join(import.meta.dirname, "../../../scripts/check-coverage.mjs");
const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

const env = (dir: string) => ({ ...process.env, HOME: dir, USERPROFILE: dir });
const git = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: env(dir) });
const gate = (dir: string) => spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8", env: env(dir) });
const options = gitAvailable ? {} : { skip: "跨提交比较要靠 git 才能判定，环境里没有 git" };

/** 判据读的是 package.json 里那条 test glob，所以临时仓库必须带一份同形状的 package.json。 */
async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "coverage-gate-"));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({
    name: "fixture", scripts: { test: "node --test packages/**/test/*.test.ts" },
  }) + "\n");
  git(dir, "init", "-q");
  return dir;
}

async function put(dir: string, rel: string, body: string): Promise<void> {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body);
}

const commit = (dir: string, message: string) => {
  git(dir, "add", "-A");
  const r = git(dir, "-c", "user.email=gate@example.invalid", "-c", "user.name=gate", "commit", "-q", "-m", message);
  if (r.status !== 0) throw new Error("fixture 提交失败：" + (r.stderr || r.stdout));
};

const T = (name: string) => "packages/core/test/" + name + ".test.ts";

const cleanup = (dir: string) => rm(dir, { recursive: true, force: true });

test("测试文件只增不减：绿", options, async () => {
  const dir = await repo();
  try {
    await put(dir, T("a"), "// a\n");
    await put(dir, "packages/core/src/index.ts", "export const a = 1;\n");
    commit(dir, "seed");
    await put(dir, T("b"), "// b\n");
    commit(dir, "add tests");
    const run = gate(dir);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, /覆盖门禁通过：测试文件数 父提交 1 -> 当前 2/);
  } finally {
    await cleanup(dir);
  }
});

test("测试集合打开了，但非测试文件被删：不该红（判据只管覆盖，别过度修正）", options, async () => {
  const dir = await repo();
  try {
    await put(dir, T("a"), "// a\n");
    await put(dir, "packages/core/src/gone.ts", "export const x = 1;\n");
    commit(dir, "seed");
    await rm(path.join(dir, "packages/core/src/gone.ts"));
    commit(dir, "drop one source file");
    const run = gate(dir);
    assert.equal(run.status, 0, run.stdout + run.stderr);
  } finally {
    await cleanup(dir);
  }
});

test("少了一个测试文件（总数下降）：必须红，并且点名到文件", options, async () => {
  const dir = await repo();
  try {
    await put(dir, T("a"), "// a\n");
    await put(dir, T("b"), "// b\n");
    commit(dir, "seed");
    await put(dir, T("c"), "// c\n");
    await rm(path.join(dir, T("a")));
    commit(dir, "net zero: add one remove one");
    // 新增一个、删掉一个 => 总数不变，这条判据不管；但"文件消失"这件事仍要提示出来。
    const run = gate(dir);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, /仍有文件消失/);
    assert.match(run.stdout + run.stderr, /core\/test\/a\.test\.ts/);

    await rm(path.join(dir, T("b")));
    commit(dir, "really shrinking");
    const red = gate(dir);
    assert.equal(red.status, 1, "总数下降必须红：" + red.stdout + red.stderr);
    assert.match(red.stdout + red.stderr, /测试文件数 父提交 2 -> 当前 1/);
    assert.match(red.stdout + red.stderr, /core\/test\/b\.test\.ts/);
  } finally {
    await cleanup(dir);
  }
});

test("反向对照：同一批删除，提交信息写 coverage-drop 就放行", options, async () => {
  const dir = await repo();
  try {
    await put(dir, T("a"), "// a\n");
    await put(dir, T("b"), "// b\n");
    commit(dir, "seed");
    await rm(path.join(dir, T("a")));
    commit(dir, "consolidate a into b, coverage-drop: merged, 用例数不减");
    const run = gate(dir);
    assert.equal(run.status, 0, "显式豁免应当放行：" + run.stdout + run.stderr);
    // 豁免不等于隐身：被删的文件仍要出现在输出里。
    assert.match(run.stdout + run.stderr, /移除 packages\/core\/test\/a\.test\.ts/);
  } finally {
    await cleanup(dir);
  }
});

test("浅克隆里拿不到父提交：红，不能静默当成绿", options, async () => {
  const dir = await repo();
  try {
    await put(dir, T("a"), "// a\n");
    commit(dir, "seed");
    await put(dir, T("b"), "// b\n");
    commit(dir, "second");

    // 这条用例原来靠 `git clone --no-local --depth 1 file://` 造浅克隆，那是**真 transport**：
    // 并发负载下 git 会以 "invalid index-pack output" 随机失败（整链里量到过一次红，隔离 3/3 绿）。
    // 判据本身没错（它宁可红），但一个会随机红的门禁会把人训练成"重跑一次算了"。
    //
    // 现在本地构造同样的形状，不碰网络也不碰 transport。浅克隆的语义是：
    // `.git/shallow` 记的是**当前存在的那个边界提交**（不是缺失的父），且父对象真的不在库里。
    // 这两件事我先用探针验过再写进用例：只写 shallow 而不删父对象时，`rev-list` 仍然给出 2、
    // `HEAD^` 仍可解析——也就是说只写一半的"浅克隆"是假的，判据会绿着通过。
    const head = git(dir, "rev-parse", "HEAD").stdout.trim();
    const parent = git(dir, "rev-parse", "HEAD^").stdout.trim();
    assert.equal(git(dir, "rev-list", "--count", "HEAD").stdout.trim(), "2", "构造前这条链必须完整，否则「阳性对照」没有意义");

    await writeFile(path.join(dir, ".git", "shallow"), head + "\n", "utf8");
    const parentObj = path.join(dir, ".git", "objects", parent.slice(0, 2), parent.slice(2));
    await rm(parentObj, { force: true });

    // 正面确认载荷真的生效（不是"我写了个文件所以它存在"这种自证）：
    assert.equal(git(dir, "rev-list", "--count", "HEAD").stdout.trim(), "1", "浅克隆边界没生效，这条用例就没有判据");
    assert.notEqual(git(dir, "rev-parse", "--verify", "HEAD^").status, 0, "父提交仍可解析 ⇒ 这不是浅克隆");
    assert.ok(!existsSync(parentObj), "父对象还在库里，边界就不是真的");

    const run = gate(dir);
    // 浅克隆的 HEAD^ 不可解析，和「仓库首个提交」在 git 里长得一样；靠 .git/shallow 区分。
    assert.equal(run.status, 1, "判据不可用时必须红：" + run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, /浅克隆/);
    assert.match(run.stdout + run.stderr, /fetch-depth/);
  } finally {
    await cleanup(dir);
  }
});

test("仓库首个提交（无父可比、非浅克隆）：绿并说明基线还没有", options, async () => {
  const dir = await repo();
  try {
    await put(dir, T("a"), "// a\n");
    commit(dir, "first");
    const run = gate(dir);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, /首个提交/);
  } finally {
    await cleanup(dir);
  }
});

test("当前提交里一个测试文件都没有：红（集合根本没打开）", options, async () => {
  const dir = await repo();
  try {
    await put(dir, "packages/core/src/index.ts", "export const a = 1;\n");
    commit(dir, "no tests at all");
    const run = gate(dir);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, /测试集合根本没打开/);
  } finally {
    await cleanup(dir);
  }
});
