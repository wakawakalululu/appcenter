import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, utimes, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 钉的是 `scripts/clean-test-tmp.mjs` 的**选择规则**。这个脚本有一个会删文件的能力，
 * 判据写错时后果不是红，而是别人系统临时目录里的东西不见了，所以全部用例都跑在沙箱目录上
 * （脚本开了 `--dir` 这条缝），从不拿真的 %TEMP% 当被测对象。
 *
 * 走 spawn 而不是 import：与仓库里其它门禁用例同一个形状（测的是真实入口的行为，含 CLI 参数解析），
 * 也避开"测试模块解析不到 .mjs"那类脚手架红——脚手架红会伪装成行为红，得先排除。
 */
const SCRIPT = path.resolve(import.meta.dirname, "../../../scripts/clean-test-tmp.mjs");

async function sandbox(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "tmpclean-scope-"));
}

async function put(dir: string, name: string, ageMs: number): Promise<string> {
  const full = path.join(dir, name);
  await mkdir(full, { recursive: true });
  await writeFile(path.join(full, "x.txt"), "x", "utf8");
  const t = new Date(Date.now() - ageMs);
  await utimes(full, t, t);
  return full;
}

const HOUR = 1000 * 60 * 60;

function run(dir: string, extra: string[] = []): { code: number; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, "--dir", dir, ...extra], { encoding: "utf8" });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function candidates(out: string): number {
  const m = /候选 (\d+) 个/.exec(out);
  if (!m) throw new Error("输出里没有「候选 N 个」，说明脚本换了措辞或没跑到判据：" + out);
  return Number(m[1]);
}

function tooFresh(out: string): number {
  const m = /太新（[^）]*）(\d+) 个/.exec(out);
  if (!m) throw new Error("输出里没有「太新 N 个」：" + out);
  return Number(m[1]);
}

test("阳性对照：仓库里出现过的 mkdtemp 前缀 + 随机后缀 + 超龄 ⇒ 进候选，但干跑不删", async () => {
  const dir = await sandbox();
  try {
    const victim = await put(dir, "desktop-fake-Old1old", 2 * HOUR);
    const r = run(dir);
    assert.equal(r.code, 0, r.out);
    assert.equal(candidates(r.out), 1, "老的那个必须被选中，否则整个脚本是哑的");
    assert.ok(r.out.includes("干跑"), "默认必须是干跑");
    const still = await readdir(dir);
    assert.ok(still.includes("desktop-fake-Old1old"), "干跑却删了东西＝把安全默认写反了");
    assert.ok(victim.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("前缀不在仓库名单里的目录绝不进候选，哪怕形状一模一样", async () => {
  const dir = await sandbox();
  try {
    await put(dir, "not-a-repo-prefix-AbC123", 2 * HOUR);
    const r = run(dir);
    assert.equal(r.code, 0, r.out);
    assert.equal(candidates(r.out), 0, "陌生前缀被选中＝会删到别人的东西");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("后缀不是 mkdtemp 随机段形状时不选：前缀撞上也不能删", async () => {
  const dir = await sandbox();
  try {
    // 同前缀但名字是人起的（含额外横杠，或短到 3 位）——这类目录若被删就是用户数据事故。
    await put(dir, "dl-my-important-notes", 2 * HOUR);
    await put(dir, "dl-abc", 2 * HOUR);
    const r = run(dir);
    assert.equal(r.code, 0, r.out);
    assert.equal(candidates(r.out), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("年龄判据在起作用：新鲜的留给并行跑的套件", async () => {
  const dir = await sandbox();
  try {
    await put(dir, "desktop-fake-Old2old", 45 * 60 * 1000);
    await put(dir, "desktop-fake-New1new", 1000);
    const r = run(dir, ["--min-age-ms", String(30 * 60 * 1000)]);
    assert.equal(r.code, 0, r.out);
    assert.equal(candidates(r.out), 1, "只该选中超龄的那个");
    assert.equal(tooFresh(r.out), 1, "新鲜的那个必须记在太新里");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("变异对照：阈值归零后新鲜目录也进候选（证明上一条不是样本造错）", async () => {
  const dir = await sandbox();
  try {
    await put(dir, "desktop-fake-Old3old", 45 * 60 * 1000);
    await put(dir, "desktop-fake-New2new", 1000);
    const r = run(dir, ["--min-age-ms", "0"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(candidates(r.out), 2);
    assert.equal(tooFresh(r.out), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("扫不到任何前缀时退出码必须是 2，且一个都不删（规则退化时宁可不动手）", async () => {
  const dir = await sandbox();
  const emptyRoot = await sandbox();
  try {
    await put(dir, "desktop-fake-Old4old", 2 * HOUR);
    const r = run(dir, ["--root", path.join(emptyRoot, "no-such-dir")]);
    assert.equal(r.code, 2, "空前缀名单必须拒绝执行：" + r.out);
    assert.ok(/一个 mkdtemp 前缀都没扫到/.test(r.out), r.out);
    assert.ok((await readdir(dir)).includes("desktop-fake-Old4old"), "拒绝执行时不该顺手删东西");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(emptyRoot, { recursive: true, force: true });
  }
});

test("--apply 只删候选，非候选留在原地", async () => {
  const dir = await sandbox();
  try {
    await put(dir, "desktop-fake-Old5old", 2 * HOUR);
    await put(dir, "not-a-repo-prefix-AbC124", 2 * HOUR);
    await put(dir, "desktop-fake-New3new", 1000);
    const r = run(dir, ["--apply"]);
    assert.equal(r.code, 0, r.out);
    assert.ok(/已删除 1 个；失败 0 个/.test(r.out), r.out);
    const left = await readdir(dir);
    assert.ok(!left.includes("desktop-fake-Old5old"), "候选没被删说明 --apply 没真跑");
    assert.ok(left.includes("not-a-repo-prefix-AbC124"), "陌生前缀被误删");
    assert.ok(left.includes("desktop-fake-New3new"), "新鲜目录被误删");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
