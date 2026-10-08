#!/usr/bin/env node
/**
 * 用法：node scripts/check-coverage.mjs [父提交]
 *
 * 为什么要有这条：`node --test` 的 glob 匹配不到文件时也 exit 0，所以「用例数下限」断言管的是**退化**；
 * 而「这次提交把测试文件删掉了」是另一类事故——实测过一次只提交已跟踪文件、漏 add 32 个测试文件，
 * 全套从 362 掉到 223（少 139 条），下限 100 完全无感，整条流水线照样全绿。
 * 本地那条 check:delivery 在 CI 里必然绿（CI 的工作树恒等于提交内容），所以 CI 侧要换成
 * **跨提交比较**：测试文件数只许升不许降，降了就点名少了哪些。
 *
 * 判据不可用时一律红，绝不静默放行：浅克隆里 HEAD^ 不可解析与「仓库首个提交」在 git 里长得一样，
 * 靠 .git/shallow 区分。前者是环境没给够历史（checkout 需要 fetch-depth >= 2），必须让人看见。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const git = (args) => {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || "").split(/\r?\n/).filter(Boolean), err: String(r.stderr || "").trim() };
};

// 测试文件的判据必须与 package.json 里 test 脚本那条 glob 同源，否则「跑不跑」与「数不数」会分叉。
const globFromPackageJson = () => {
  const body = JSON.parse(readFileSync("package.json", "utf8")).scripts.test;
  const hit = body.match(/([^\s"']*test[^\s"']*\.test\.ts)/);
  if (!hit) throw new Error("没从 package.json 的 test 脚本里解析出 glob，这条判据就没有意义：" + body);
  return hit[1];
};
const globToRegExp = (glob) => new RegExp(
  "^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*/g, "[^/]*") + "$"
);

const parentRef = process.argv[2] || "HEAD^";
const pattern = globToRegExp(globFromPackageJson());

const treeOf = (ref) => {
  const r = git(["ls-tree", "-r", "--name-only", ref]);
  if (!r.ok) return null;
  return r.out.filter((f) => pattern.test(f));
};

const current = treeOf("HEAD");
if (current === null) fail("HEAD 的树都列不出来（工作目录不是仓库根？），判据无法执行");

if (current.length === 0) {
  fail("当前提交里匹配测试 glob 的文件数为 0——测试集合根本没打开。" +
    "要么 glob/目录改名了，要么测试文件没被提交；这两种都不能算绿。");
}

const parent = treeOf(parentRef);
if (parent === null) {
  const shallow = existsSync(path.join(".git", "shallow"));
  const isRoot = git(["rev-list", "--max-count=1", "HEAD"]).ok &&
    git(["rev-parse", "--verify", parentRef]).ok === false;
  if (shallow) {
    fail("拿不到 " + parentRef + " 的树，而且这是浅克隆（.git/shallow 存在）。" +
      "跨提交比较需要至少 2 层历史：actions/checkout 的 fetch-depth 要设成 2 以上。判据不可用时不放行。");
  }
  if (isRoot) {
    console.log("当前是仓库首个提交（无父提交可比）：本轮只证明测试集合打开了，" + String(current.length) + " 个测试文件。下一次提交起才有基线。");
    process.exit(0);
  }
  fail("拿不到 " + parentRef + " 的树，跨提交比较无法执行（历史不足或 ref 写错）。不静默放行。");
}

const message = git(["log", "-1", "--format=%B", "HEAD"]).out.join("\n");
const waived = /\bcoverage-drop\b/i.test(message);
const removed = parent.filter((f) => !current.includes(f));
const added = current.filter((f) => !parent.includes(f));

const summary = "测试文件数 父提交 " + String(parent.length) + " -> 当前 " + String(current.length) +
  "（新增 " + String(added.length) + "、移除 " + String(removed.length) + "）";

if (current.length < parent.length) {
  if (waived) {
    console.log("覆盖下降已被提交信息显式豁免（coverage-drop）：" + summary);
    for (const f of removed) console.log("  移除 " + f);
    process.exit(0);
  }
  console.error("覆盖门禁未通过：" + summary);
  for (const f of removed) console.error("  少了 " + f);
  console.error("用例数是「文件里的用例」之和，少一个文件往往少的不止一条（实测过：漏 32 个文件＝少 139 条）。");
  console.error("确实是有意删/合并测试的话，在提交信息里写 coverage-drop 并说明去向；不要靠调低下限解决。");
  process.exit(1);
}

console.log("覆盖门禁通过：" + summary);
if (removed.length > 0) console.log("  注意：总数没降但仍有文件消失，确认是改名或合并：" + removed.join(", "));
process.exit(0);

function fail(msg) {
  console.error("覆盖门禁无法执行：" + msg);
  process.exit(1);
}
