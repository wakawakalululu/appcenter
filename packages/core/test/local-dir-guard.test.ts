import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * 钉的是 `ci.yml` 里「本地专属目录不得入库」那条守卫。
 *
 * 为什么要单独钉：这条守卫守的是**不可逆**的公开面（一次顺手 `git add -A` 就把 `re/`、`recon/`、
 * `behavior/`、`local-repo/`、原始安装包推上去），而它此前是六道公开面门禁里**唯一没有行为用例**的一条
 * ——词表、死链、许可证、用例数都有测试，这条只有一条规则文本。规则文本自己坏掉时，不会有任何东西变红。
 *
 * 判据引擎：把正则原文交给 **`grep -E`** 执行，也就是 CI 用的那个引擎，而不是在测试里另抄一份
 * 或用 Node 的 RegExp。理由有两条现成的教训：① 曾经因为"测试里写的等价正则与 yml 不是同一份"，
 * yml 改了测试还在绿；② `git grep` 的字符类按字节处理，与 GNU grep / Node 不一致，跨引擎复核会骗人。
 * 这里的正则是纯 ASCII（路径与扩展名），两个引擎结论一致，但判据仍然只认 CI 那一套。
 */
const CI = readFileSync(path.join(import.meta.dirname, "../../../.github/workflows/ci.yml"), "utf8");

/** 从 yml 里抠出守卫用的那条正则原文；抠不到就红——"解析失败"绝不能当成"没有违规"。 */
function extractPattern(): string {
  const line = CI.split("\n").find((l) => /git ls-files \| grep -E '/.test(l));
  if (!line) throw new Error("ci.yml 里找不到「git ls-files | grep -E」这条守卫，判据已移位，必须同步改这个测试");
  const m = /grep -E '(\^\([^']*\))'/.exec(line);
  if (!m || !m[1]) throw new Error("守卫那条正则没能从 ci.yml 原文里解析出来，这一轮等于没测：" + line.trim().slice(0, 120));
  return m[1];
}

/** 用 CI 同款引擎问：这一批路径里，守卫会不会抓到？返回被抓到的行。 */
function caught(pattern: string, lines: string[]): string[] {
  const r = spawnSync("grep", ["-E", pattern], { input: lines.join("\n") + "\n", encoding: "utf8" });
  if (r.status === 0) return (r.stdout ?? "").split("\n").filter(Boolean);
  if (r.status === 1) return [];
  throw new Error("grep 本身失败了（status=" + String(r.status) + "）：" + (r.stderr ?? ""));
}

const CATEGORY: Array<{ label: string; sample: string; token: string }> = [
  { label: "P0/P1 分析目录 re/", sample: "re/scope.md", token: "re/" },
  { label: "P1 侦察目录 recon/", sample: "recon/static.md", token: "recon/" },
  { label: "P3 行为目录 behavior/", sample: "behavior/timing.md", token: "behavior/" },
  { label: "内部说明 _internal/", sample: "_internal/notes.md", token: "_internal/" },
  { label: "本地笔记 LOCAL-NOTES.md", sample: "LOCAL-NOTES.md", token: "LOCAL-NOTES\\.md" },
  { label: "合规闸门输出", sample: "compliance-checklist.md", token: "compliance-checklist\\.md" },
  { label: "本机镜像 local-repo/", sample: "local-repo/apps.json", token: "local-repo/" },
  { label: "冒烟包目录 smoke-packages/", sample: "smoke-packages/a.bin", token: "smoke-packages/" },
  { label: "截图暂存 .shots/", sample: ".shots/x.png", token: "\\.shots/" },
  { label: "原始安装包扩展名 msi", sample: "vendor/setup.msi", token: "msi" },
  { label: "原始安装包扩展名 exe", sample: "vendor/setup.exe", token: "exe" },
];

const ALLOWED = ["README.md", "spec/srs.md", "packages/core/src/index.ts", "docs/index.html", ".github/workflows/ci.yml"];

test("阳性对照：每一类「只留本地」的东西都必须被抓到", () => {
  const pattern = extractPattern();
  const missed: string[] = [];
  for (const c of CATEGORY) {
    if (caught(pattern, [c.sample]).length === 0) missed.push(c.label + " → " + c.sample);
  }
  assert.deepEqual(missed, [], "守卫漏掉了这些类别（公开面不可逆）：" + missed.join("、"));
});

test("阴性对照：正常入库的文件不许被抓（否则门禁第一天就红，会被当噪音关掉）", () => {
  const pattern = extractPattern();
  assert.deepEqual(caught(pattern, ALLOWED), [], "公开文件被误判成本地专属：" + caught(pattern, ALLOWED).join("、"));
});

test("逐项变异：摘掉某一项，它的样本必须正好不再被抓（证明每一项都在承重，不是摆设）", () => {
  const full = extractPattern();
  for (const c of CATEGORY) {
    // 变异必须把**分隔符一起摘掉**。我第一版只删 token，留下 `||` —— 空分支匹配一切，
    // 于是"re/ 被摘掉后 re/scope.md 仍然被抓"，看着像守卫有问题，其实是变异体自己造了个万能匹配。
    // 这类"判据的假阳性来自测试自己"的形状，比守卫坏掉更常见，也更难发现。
    let mutated = full.replace(c.token + "|", "");
    if (mutated === full) mutated = full.replace("|" + c.token, "");
    if (mutated === full) throw new Error("变异没生效：正则原文里找不到片段 " + c.token + "（守卫改过措辞，这个测试得同步）");
    assert.ok(!mutated.includes("||"), c.label + " 的变异留下了空分支（会匹配一切），这条变异本身失效了");
    assert.deepEqual(caught(mutated, [c.sample]), [], c.label + " 被摘掉后仍能被抓 ⇒ 这项是冗余或样本选错，判据不可信");
    assert.ok(caught(mutated, [".github/workflows/ci.yml"]).length === 0, c.label + " 的变异把正则改坏了（误报公开文件）");
  }
});

test("锚点与过度匹配：判据必须锚在行首，且不能退化成「什么都抓」", () => {
  const pattern = extractPattern();
  assert.ok(pattern.startsWith("^("), "守卫正则没有锚在行首：" + pattern.slice(0, 40));
  assert.ok(!/\^\(\.\*\)/.test(pattern), "首项变成 .* ⇒ 门禁会抓下一切，第一天就被当噪音关掉");
  // 路径出现在中间时不该被抓（^ 锚点必须真的起作用）
  assert.deepEqual(caught(pattern, ["docs/recon-guide.md", "src/behavior/keystore.ts"]), [],
    "^ 锚点没生效：正文里含这些字样的普通文件被误抓");
});
