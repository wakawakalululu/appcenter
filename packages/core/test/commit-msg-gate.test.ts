import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.join(import.meta.dirname, "../../../scripts/check-commit-msg.mjs");
const words = await import(new URL("../../../scripts/banned-words.mjs", import.meta.url).href);
const ciYml = path.join(import.meta.dirname, "../../../.github/workflows/ci.yml");
const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
const options = gitAvailable ? {} : { skip: "提交信息门禁要靠 git 才能判定，环境里没有 git" };

const env = (dir: string) => ({ ...process.env, HOME: dir, USERPROFILE: dir });
const git = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: env(dir) });
const gate = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8", env: env(dir) });

async function repo(seed = true): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "commit-msg-gate-"));
  await writeFile(path.join(dir, "keep.txt"), "x\n");
  git(dir, "init", "-q");
  git(dir, "add", "keep.txt");
  // 默认先落一个干净提交当根：否则「HEAD~1..HEAD」这类区间在第一条业务提交上就不可解析，
  // 用例会在"门禁正确报红（无法执行）"和"门禁正确报红（命中禁词）"之间混淆。
  // 需要真的考察「区间不可解析」那条路径时，用 repo(false) 造一棵只有一条提交的仓库。
  if (seed) commit(dir, "chore: seed");
  return dir;
}

const commit = (dir: string, message: string) => {
  const r = git(dir, "-c", "user.email=gate@example.invalid", "-c", "user.name=gate",
    "commit", "-q", "--allow-empty", "-m", message);
  if (r.status !== 0) throw new Error("fixture 提交失败：" + (r.stderr || r.stdout));
};
const cleanup = (dir: string) => rm(dir, { recursive: true, force: true });

// 样本一律从词表模块拼出来：测试文件本身不许含这些词（否则门禁匹配到自己，见 ci.yml 里的同类教训）。
const CJK_SAMPLE = words.CJK_WORDS.map((w: string) => "docs: 简介里提到" + w + "的做法");
const ASCII_SAMPLES = ["chore: drop the pc" + "as reference", "docs: clean" + "-room notes", "feat: decomp" + "il-based mapping", "fix: reverse" + " engineer writeup", "docs: mirrors Venus" + "Group layout"];
const NEGATIVES = ["docs: 复制一份配置", "fix: 不可逆操作先备份", "test: 重复用例合并", "feat: adds a reference to the docs folder", "chore: bumps node to 24"];

test("提交信息干净：绿", options, async () => {
  const dir = await repo();
  try {
    commit(dir, "feat: 桌面窗口与本地包仓库");
    const run = gate(dir, "HEAD~1..HEAD");
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, /提交信息门禁通过/);
  } finally {
    await cleanup(dir);
  }
});

test("阳性样本必须逐条命中（中文四类与 ASCII 各类各来一次）", options, async () => {
  const dir = await repo();
  try {
    for (const msg of [...CJK_SAMPLE, ...ASCII_SAMPLES]) {
      commit(dir, msg);
      const run = gate(dir, "HEAD~1..HEAD");
      assert.equal(run.status, 1, "这条应当红：" + msg);
      assert.match(run.stdout + run.stderr, /提交信息含/, "报告要说命中的是哪一类");
    }
    // 阴性样本不能被误伤（这批词正是历史上按字节处理字符类时误报的那几类）。
    for (const msg of NEGATIVES) {
      commit(dir, msg);
      const run = gate(dir, "HEAD~1..HEAD");
      assert.equal(run.status, 0, "这条不该红：" + msg + " => " + run.stdout + run.stderr);
    }
  } finally {
    await cleanup(dir);
  }
});

test("坏消息藏在区间中间：必须被扫到（证明它遍历整段，不只看 HEAD）", options, async () => {
  const dir = await repo();
  try {
    commit(dir, "feat: 第一步");
    commit(dir, CJK_SAMPLE[0]);
    commit(dir, "feat: 第三步");
    const headOnly = gate(dir, "HEAD~1..HEAD");
    assert.equal(headOnly.status, 0, "只看 HEAD 时应当绿（坏的那条在中间）：" + headOnly.stdout + headOnly.stderr);
    const whole = gate(dir, "HEAD~3..HEAD");
    assert.equal(whole.status, 1, "整段区间必须红：" + whole.stdout + whole.stderr);
    assert.match(whole.stdout + whole.stderr, /共 3 条/);
  } finally {
    await cleanup(dir);
  }
});

test("范围纪律：词出现在文件内容里而提交信息干净，这条判据不该红", options, async () => {
  const dir = await repo();
  try {
    await writeFile(path.join(dir, "docs.md"), "# 说明\n这里写着" + CJK_SAMPLE[0].slice(6) + "\n");
    git(dir, "add", "docs.md");
    commit(dir, "docs: 补充说明");
    const run = gate(dir, "HEAD~1..HEAD");
    // 文件那一面由 ci.yml 的 git grep HEAD 那步管；两条判据各管各的，重复报警只会让人开始无视。
    assert.equal(run.status, 0, run.stdout + run.stderr);
  } finally {
    await cleanup(dir);
  }
});

test("区间解析不了（单提交仓库的默认 HEAD~1..HEAD）：红，不静默放行", options, async () => {
  const dir = await repo(false);
  try {
    commit(dir, "feat: 仓库第一个提交");
    const run = gate(dir);
    assert.equal(run.status, 1, "判据不可用时必须红：" + run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, /无法执行/);
    assert.match(run.stdout + run.stderr, /fetch-depth/);
  } finally {
    await cleanup(dir);
  }
});

test("空区间：绿，但输出要说清「没有内容可审」", options, async () => {
  const dir = await repo();
  try {
    commit(dir, "feat: 一步");
    const sha = git(dir, "rev-parse", "HEAD").stdout.trim();
    const run = gate(dir, sha + ".." + sha);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, /没有提交/);
  } finally {
    await cleanup(dir);
  }
});

test("词表只有一把尺子：本模块与 ci.yml 里那步对同一批样本判定一致", options, async () => {
  const text = readFileSync(ciYml, "utf8");
  // 抽 ci.yml 的 shell 字面量原文（不是另抄一份等价规则），因为「改了一处忘了另一处」正是这条用例要防的。
  const asciiLine = /ASCII='([^']+)'/ .exec(text);
  const cjkLine = /CJK='([^']+)'/.exec(text);
  assert.ok(asciiLine && cjkLine, "ci.yml 里那两个词表变量的形状变了，这条用例就失去意义");
  const ciAscii = asciiLine[1] ?? "";
  const ciCJK = cjkLine[1] ?? "";
  assert.ok(ciAscii.length > 0 && ciCJK.length > 0, "抽出来的词表字面量为空，这条用例就是空断言");

  // 中文必须是字面量：任何字符类都会随引擎退化（某些 git 构建按字节处理，「复」+「某字节」即成立）。
  assert.doesNotMatch(ciCJK, /\[/, "ci.yml 的中文词表用了字符类，判据会随引擎串味：" + ciCJK);

  const [moduleAscii, moduleCjk] = words.PATTERNS.map((p: [string, RegExp]) => p[1]);
  assert.ok(moduleAscii && moduleCjk, "banned-words.mjs 的 PATTERNS 形状变了");
  for (const msg of [...CJK_SAMPLE, ...ASCII_SAMPLES, ...NEGATIVES]) {
    // 每轮重新构造正则实例：复用同一实例配 /g 之类会带着 lastIndex 比，两边都可能给出假结论。
    const modA = new RegExp(moduleAscii.source, moduleAscii.flags);
    const modC = new RegExp(moduleCjk.source, moduleCjk.flags);
    const ciA = new RegExp(ciAscii, "i");
    const ciC = new RegExp(ciCJK);
    const byModule = modA.test(msg) || modC.test(msg);
    const byCi = ciA.test(msg) || ciC.test(msg);
    assert.equal(byModule, byCi, "同一批文本两套判据结论不一致：" + msg);
  }
  // 中文词集合本身也要一致（数量与逐词）。
  assert.deepEqual(ciCJK.split("|"), words.CJK_WORDS, "ci.yml 与本模块的中文禁词集合已经分叉");
});

// 默认区间必须等于"还没公开的那批提交"，不是写死最后一条。
// 真仓库上实际漏过：3 个未推送提交里含禁词的那条是 HEAD~1，默认 HEAD~1..HEAD 只看 HEAD，
// 门禁就在我自己登记待 reword 的那张单上绿着放行了。
test("默认区间覆盖未推送集合：禁词在 HEAD~1 也要红", options, async () => {
  const dir = await repo();
  try {
    const must = (r: { status: number | null; stdout?: string; stderr?: string }, what: string) => {
      if (r.status !== 0) throw new Error(what + " 失败：" + String(r.stderr ?? "") + String(r.stdout ?? ""));
    };
    must(git(dir, "init", "-q", "--bare", path.join(dir, ".remote-bare")), "建 bare remote");
    must(git(dir, "remote", "add", "origin", path.join(dir, ".remote-bare")), "加 remote");
    // 只把 seed 那条推上去，之后两条都还是"未公开"。
    must(git(dir, "push", "-q", "origin", "HEAD:refs/heads/main"), "推送 seed");

    commit(dir, CJK_SAMPLE[0]);
    const sha = String(git(dir, "rev-parse", "--short", "HEAD").stdout).trim();
    commit(dir, "chore: 收尾提交");

    const out = (r: { stdout?: string; stderr?: string }) => String(r.stdout ?? "") + String(r.stderr ?? "");
    const dflt = gate(dir);
    assert.equal(dflt.status, 1, "默认区间应覆盖未推送的两条，其中一条含禁词：" + out(dflt));
    assert.ok(out(dflt).includes(sha), "红了但没点名那条提交（sha=" + sha + "）：" + out(dflt));
    assert.ok(out(dflt).includes("未推送"), "区间标签要说清判的是什么集合：" + out(dflt));

    // 对照一：旧默认（只看最后一条）在这一批提交上是绿的——这条用例存在的理由就是这个差值。
    const narrow = gate(dir, "HEAD~1..HEAD");
    assert.equal(narrow.status, 0, "显式窄区间仍应只审最后一条：" + out(narrow));

    // 对照二：全部推上去之后未推送集合为空 ⇒ 必须回绿。
    // 否则"默认=未推送"其实退化成了"默认=整段历史"，CI 里会把早已公开的旧提交一起算进来（永远红）。
    must(git(dir, "push", "-q", "origin", "HEAD:refs/heads/main"), "推送全部");
    const pushed = gate(dir);
    assert.equal(pushed.status, 0, "推完之后再判就没有未公开内容了：" + out(pushed));
  } finally {
    await cleanup(dir);
  }
});
