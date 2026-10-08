#!/usr/bin/env node
/**
 * 用法：node scripts/check-test-count.mjs <下限> <npm test 的输出文件>
 *
 * 为什么要这条：`node --test "<glob>"` 在 glob 一个文件都没匹配上时**退出码是 0**，
 * 汇总里写 `tests 0`（本机实测，Node 24；目录不存在也一样）。所以「CI 上 npm test 绿」
 * 并不等于「测试跑过了」——测试目录改名、模式写错、文件没 checkout 出来，都会安静地变成零用例全绿，
 * 而且整作业只要十几秒，跟真的快跑完长得一样。
 */
import { readFileSync } from "node:fs";

const floor = Number(process.argv[2]);
const file = process.argv[3];
if (!Number.isFinite(floor) || !file) {
  console.error("用法：node scripts/check-test-count.mjs <下限> <输出文件>");
  process.exit(2);
}

const text = readFileSync(file, "utf8");
// 汇总行两种形态都认：spec/tap 报告里的 `ℹ tests 318` 与 `# tests 318`。
const number = (label) => {
  const hit = new RegExp("^\\s*(?:ℹ|#)\\s*" + label + "\\s+(\\d+)", "m").exec(text);
  return hit ? Number(hit[1]) : null;
};

const tests = number("tests");
const passed = number("pass");
const failed = number("fail");
const problems = [];
if (tests === null || passed === null || failed === null) {
  problems.push("没解析到测试汇总（tests/pass/fail 行）——输出格式变了就该同步改这里，不能放行");
} else {
  if (failed !== 0) problems.push("fail=" + String(failed));
  if (tests < floor) problems.push("用例数 " + String(tests) + " 低于下限 " + String(floor) + "（glob 退化或测试文件没跑起来？）");
  if (passed !== tests - (number("cancelled") ?? 0) - (number("skipped") ?? 0) - (number("todo") ?? 0)) {
    problems.push("pass=" + String(passed) + " 与 tests=" + String(tests) + " 的差不等于 cancelled+skipped+todo");
  }
}

if (problems.length > 0) {
  console.error("用例数门禁未通过：" + problems.join("；"));
  console.error("汇总原文：\n" + text.split(/\r?\n/).filter((l) => /^\s*(?:ℹ|#)\s/.test(l)).slice(0, 12).join("\n"));
  process.exit(1);
}
console.log("用例数门禁通过：tests=" + String(tests) + " pass=" + String(passed) + " fail=0（下限 " + String(floor) + "）");
