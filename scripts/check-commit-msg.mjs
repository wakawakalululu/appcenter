#!/usr/bin/env node
/**
 * 用法：node scripts/check-commit-msg.mjs [区间]   （区间默认 HEAD~1..HEAD）
 *
 * 为什么要单独一条：公开面的门禁（ci.yml 里那步）判的是 `git grep ... HEAD`，那是**文件内容**——
 * 提交信息不是文件，所以结构上查不到它。实测过一次：远程 16 条公开提交信息逐条过词表命中 1 条
 * （某条 docs 提交的首行点到了具体手段），而那时所有文件级门禁都是绿的。
 * 已发布的历史要不要改写是单独一件需要授权的事；这条脚本管的是**别再往公开历史上加新的**。
 *
 * 词表只有一份定义：scripts/banned-words.mjs；它与 ci.yml 那一步的 shell 字面量是否同一把尺子，
 * 由 packages/core/test/commit-msg-gate.test.ts 钉住。
 */
import { spawnSync } from "node:child_process";
import { PATTERNS } from "./banned-words.mjs";

const git = (args) => {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return r.stdout;
};

// 判据范围必须等于"它该管的那个集合"：本地默认要审的是「还没公开的那批提交」，不是写死一条。
// 写死 HEAD~1..HEAD 时实测漏过：本仓库当时有 3 个未推送提交，含公开面禁词的那条在 HEAD~1，
// 默认范围只看 HEAD，于是在我自己建的那张单（待 reword 的提交）上绿着放行。
// CI 那边由 ci.yml 显式传 "$base..$sha"（fetch-depth: 0），本来就是全区间，不受这条影响。
const explicit = process.argv[2];
// 用 for-each-ref 直接列出 refs/remotes 再判空——不要写 `--count refs/remotes`：
// 那个选项的值必须是条数，把 pattern 喂给它会让整条命令报错，于是"有 remote"被误判成"没有"，
// 范围就悄悄退回旧默认（我第一次就是这么把自己的新分支测过去的）。
const remoteRefs = (git(["for-each-ref", "refs/remotes/"]) ?? "").trim();
const unpushedMode = explicit === undefined && remoteRefs !== "";
const revList = explicit !== undefined
  ? ["rev-list", "-z", "--reverse", explicit]
  : unpushedMode
    ? ["rev-list", "-z", "--reverse", "HEAD", "--not", "--remotes"]
    : ["rev-list", "-z", "--reverse", "HEAD~1..HEAD"];
// 拿不到 remote 引用（导出 tarball、fresh clone）时才退回旧默认，并把"这是猜的"说出来。
const range = explicit ?? (unpushedMode
  ? "未推送到任何 remote 的提交"
  : "HEAD~1..HEAD（树里没有 remote 引用，无法界定哪些提交尚未公开，只审最后一条）");
const ids = git(revList);
if (ids === null) {
  console.error("提交信息门禁无法执行：区间 " + range + " 解析不了。");
  console.error("常见原因是浅克隆或 fetch-depth 不够。判据不可用时一律红，不静默放行。");
  process.exit(1);
}
const shas = ids.split("\0").filter(Boolean);
if (shas.length === 0) {
  // 空区间（force push 前后同值、PR 已与基线同步等）：没什么可审，但要把这件事说出来而不是假装通过。
  console.log("提交信息门禁：区间 " + range + " 内没有提交，本轮无内容可审。");
  process.exit(0);
}

const problems = [];
for (const sha of shas) {
  const body = git(["log", "-1", "--format=%B", sha]);
  if (body === null) { problems.push(sha.slice(0, 7) + " 的提交信息取不到（历史不完整？）"); continue; }
  for (const [label, re] of PATTERNS) {
    const hit = re.exec(body);
    if (hit) problems.push(sha.slice(0, 7) + " 的提交信息含" + label + "命中 " + JSON.stringify(hit[0]) +
      "，首行：" + body.split(/\r?\n/)[0]);
  }
}

if (problems.length > 0) {
  console.error("提交信息门禁未通过（区间 " + range + "，共 " + String(shas.length) + " 条）：");
  for (const p of problems) console.error("  " + p);
  console.error("提交信息一旦推上去就是公开面，改写已发布历史要单独决策——所以拦在 push 之前。");
  process.exit(1);
}
console.log("提交信息门禁通过：区间 " + range + " 内 " + String(shas.length) + " 条提交信息均无禁用标识。");
process.exit(0);
