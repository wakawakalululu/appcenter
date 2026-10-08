import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.join(import.meta.dirname, "../../../scripts/check-emoji.mjs");
const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

/**
 * HOME/USERPROFILE 指到临时目录：否则开发机上的全局 gitconfig（core.excludesFile 之类）
 * 会让「这个文件到底可不可见」随机器变，把用例变成环境红——正是要治的那类问题。
 */
const env = (dir: string) => ({ ...process.env, HOME: dir, USERPROFILE: dir });
const git = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: env(dir) });
const gate = (dir: string) => spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8", env: env(dir) });

async function fixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "emoji-gate-"));
  await writeFile(path.join(dir, ".gitignore"), "LOCAL-NOTES.md\n");
  await writeFile(path.join(dir, "tracked.md"), "# tracked\n");
  await writeFile(path.join(dir, "LOCAL-NOTES.md"), "# 本机笔记\n");
  git(dir, "init", "-q");
  git(dir, "add", ".gitignore", "tracked.md");
  return dir;
}

const options = gitAvailable ? {} : { skip: "门禁范围要用 git 才能判定，环境里没有 git" };

test("干净仓库是绿的（否则后面的绿只能说明脚本没跑起来）", options, async () => {
  const dir = await fixture();
  try {
    const run = gate(dir);
    assert.equal(run.status, 0, run.stdout + run.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("emoji 只出现在被 gitignore 的本机文件里：门禁必须绿", options, async () => {
  const dir = await fixture();
  try {
    await writeFile(path.join(dir, "LOCAL-NOTES.md"), "# 本机笔记 \u{1F600}\n");
    const run = gate(dir);
    // 收口前这里会是 exit 1：本地红、CI 里却没有这个文件，信号会让人开始无视门禁。
    assert.equal(run.status, 0, "被忽略的本机文件不该算公开面：" + run.stdout + run.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("emoji 在未入库但也没被忽略的文件里：门禁必须红（下一步就要提交）", options, async () => {
  const dir = await fixture();
  try {
    await writeFile(path.join(dir, "newcomer.md"), "# 新文件 \u{1F600}\n");
    const run = gate(dir);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, /newcomer\.md:1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("emoji 在已入库文件里：门禁必须红", options, async () => {
  const dir = await fixture();
  try {
    await writeFile(path.join(dir, "tracked.md"), "# tracked \u{1F600}\n");
    const run = gate(dir);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, /tracked\.md:1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 白名单漏一种扩展名＝静默盲区（emoji 写进 .rs/.svg/.toml 里没有任何门禁会抓）。
// 这条用例的存在本身才是"白名单等于可发布文本集合"这个判据的保证，而不是注释。
// 注意用 \u{1F600} 转义写：本文件自己就在门禁的扫描范围内，写字面 emoji 会把自己判红。
test("非主流文本扩展名也在扫描范围内：.rs / .svg / .toml 里的 emoji 必须红", options, async () => {
  const dir = await fixture();
  try {
    for (const [name, body] of [
      ["main.rs", "// \u{1F600}\nfn main() {}\n"],
      ["icon.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"><!-- \u{1F600} --></svg>\n"],
      ["Cargo.toml", "# \u{1F600}\n[package]\nname = \"x\"\n"],
    ] as Array<[string, string]>) {
      await writeFile(path.join(dir, name), body);
      const run = gate(dir);
      assert.equal(run.status, 1, name + " 里的 emoji 没被抓到，白名单又漏了：" + run.stdout + run.stderr);
      assert.match(run.stdout + run.stderr, new RegExp(name.replace(".", "\\.") + ":1"), "红了但没点名文件与行号");
      await rm(path.join(dir, name), { force: true });
    }
    assert.equal(gate(dir).status, 0, "移掉违规文件后应回到绿（否则这条用例自己就是恒真的）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 无扩展名的发布文本：.gitignore / LICENSE / docs/.nojekyll。
// 这三个是白名单的第二种漏法——不是少写一个扩展名，而是"扩展名"这个维度对它们根本不存在
// （path.extname(".gitignore") 与 path.extname("LICENSE") 都返回空串），所以按扩展名判的范围会静默放过。
test("无扩展名的发布文本（.gitignore/LICENSE/.nojekyll）也在emoji范围内", options, async () => {
  const dir = await fixture();
  try {
    await mkdir(path.join(dir, "docs"), { recursive: true });
    for (const [name, body] of [
      [".gitignore", "# \u{1F600}\nLOCAL-NOTES.md\n"],
      ["LICENSE", "MIT License \u{1F600}\n"],
      [path.join("docs", ".nojekyll"), "\u{1F600}\n"],
    ] as Array<[string, string]>) {
      const abs = path.join(dir, name);
      await writeFile(abs, body);
      const run = gate(dir);
      const out = run.stdout + run.stderr;
      assert.equal(run.status, 1, name + " 里的 emoji 没被抓到：按扩展名的白名单对无扩展名文件根本匹配不到");
      // 判"有没有点名"用字面量比较，不走正则：报告里的路径分隔符随平台变（Windows 是 docs\.nojekyll），
      // 而转义写法本身就是我这轮想防的那类错（同一份代码在两种引擎下结论相反）。
      assert.ok(out.includes(path.basename(name) + ":1"), "红了但没点名文件与行号：" + out);
      await rm(abs, { force: true });
    }
    // 收尾回到绿，同时也证明上面每一次红都只由那个违规文件造成。
    assert.equal(gate(dir).status, 0, "移掉违规文件后应回到绿：" + gate(dir).stdout + gate(dir).stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 变异对照：证明上面那次红确实是 TEXT_NAMES 造成的，而不是 fixture 里恰好还有别的违规。
// 做法是连正文复制真实脚本、只把名单掏空，再拿同一个 fixture 跑一遍——
// 在测试里重写一个判据等于测我自己的副本，那不算对照。
test("变异：掏空 TEXT_NAMES 之后，同一个违规 .gitignore 会静默变绿", options, async () => {
  const dir = await fixture();
  const blindDir = await mkdtemp(path.join(tmpdir(), "emoji-blind-"));
  const blind = path.join(blindDir, "check-emoji.mjs");
  try {
    const src = readFileSync(script, "utf8");
    const mutated = src.replace(
      'const TEXT_NAMES = new Set([".gitignore", ".nojekyll", "LICENSE"]);',
      "const TEXT_NAMES = new Set();",
    );
    assert.notEqual(mutated, src, "变异没生效：脚本里找不到那行名单，改了形状就要同步这里，不能放行");
    await writeFile(blind, mutated);
    await writeFile(path.join(dir, ".gitignore"), "# \u{1F600}\nLOCAL-NOTES.md\n");

    const real = gate(dir);
    assert.equal(real.status, 1, "真实脚本该红：" + real.stdout + real.stderr);
    const run = spawnSync(process.execPath, [blind], { cwd: dir, encoding: "utf8", env: env(dir) });
    assert.equal(run.status, 0, "掏空名单后仍然红 ⇒ 那次红不是名单造成的，对照无效：" + run.stdout + run.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(blindDir, { recursive: true, force: true });
  }
});
