#!/usr/bin/env node
/**
 * 用法：node scripts/check-delivery.mjs
 *
 * 为什么要有这条：CI 的判据只能看见「已经进仓库的东西」。实测过一次——只提交已跟踪文件时，
 * 全套用例从 362 掉到 223（少 139 条，占 38%），而「用例数下限」门禁的下限是 100，于是整条流水线照样全绿。
 * 也就是说：新写的测试/脚本/资产没 `git add`，本地看是绿的，别人和 CI 拿到的却是**少一大截覆盖的树**，
 * 而且没有任何一道门禁会为此报错。这条脚本把这个盲区变成本地红（跑在 push 之前，不是 CI 里）。
 *
 * 它主要回答一个问题：现在工作树里有哪些文件「还没进下一次提交」。
 * 另外标出一类静态可见的入边——被 package.json 的脚本或 ci.yml 的命令行点名的文件（见 commandEdges）：
 * 这类边漏掉时，别人拿到的是"命令还在、目标没了"的树，而 CI 判不出"缺了"这件事，所以只有本地能拦。
 * 但它仍然不是完备的「必须同批」集合：跨包成员级依赖（如 `@appcenter/core` 少一个导出成员）只有真编译才会暴露，解析器看不见。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const git = (...args) => {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error("git " + args.join(" ") + " 失败：" + String(r.stderr || "").trim());
    process.exit(2);
  }
  // -z：文件名按 NUL 分隔。CJK、空格、引号都能原样出来；不加的话一次换行就把一个文件劈成两个。
  return r.stdout.split("\0").filter(Boolean);
};

const KINDS = [
  ["测试", /(^|\/)test\/|\.test\.(ts|mts|js|mjs)$/],
  ["源码", /^packages\/.*\/src\/.*\.(ts|mts|js|mjs|css|html)$/],
  ["脚本", /^scripts\/.*\.(mjs|mts|cjs|js|ts|py|ps1|sh)$/],
  ["规格与文档", /^(spec|docs|wiki)\//],
  ["资产", /\.(svg|png|jpg|jpeg|gif|ico|webp)$/],
];
const kindOf = (rel) => (KINDS.find(([, re]) => re.test(rel)) || ["其他"])[0];

// 命令串里点名的路径也是入边。package.json 的 scripts 与 ci.yml 的 run 行都是"提交进仓库的文本"，
// 它们指向一个还没入库（或干脆被 gitignore）的文件时，别人 checkout 下来那条命令就是悬空的——
// 而这类边静态可见、只有本地能看见：CI 的树里根本没有那个文件，所以它连"缺了"都判不出来。
// 注意这仍然不是完备的同批集合（成员级依赖照旧看不见），只是补上一类确实看得见的边。
const CMD_FILE = /(?:^|[\s"'=(/])([A-Za-z0-9_./@-]+\.(?:mjs|cjs|mts|cts|ts|js|json|py|ps1|sh|yml|yaml))(?=$|[\s"'());,])/g;
const read = (rel) => {
  try { return readFileSync(rel, "utf8"); } catch { return ""; }
};
function commandEdges() {
  const edges = new Map();
  const note = (rel, label) => {
    if (!edges.has(rel)) edges.set(rel, new Set());
    edges.get(rel).add(label);
  };
  const feed = (text, label) => {
    for (const m of text.matchAll(CMD_FILE)) {
      const rel = m[1];
      // 相对路径、且在工作树里真的存在，才算一条边：glob 字面量（packages/**/test/*.test.ts）、
      // 绝对路径、CI 里的表达式都不该被判成"引用了某个文件"。
      if (rel.startsWith("/") || rel.includes("://") || rel.includes("*")) continue;
      if (!existsSync(rel)) continue;
      note(rel, label);
    }
  };
  const pkg = read("package.json");
  if (pkg) {
    try {
      for (const [name, cmd] of Object.entries(JSON.parse(pkg).scripts ?? {})) feed(String(cmd), "package.json:" + name);
    } catch { /* package.json 坏了自己的工具会报，这里不替它兜 */ }
  }
  const yml = read(".github/workflows/ci.yml");
  // 只认真正执行命令的那几行。整份 yml 一起扫会走进"注释里提了个文件名"的陷阱——
  // 本仓库的 ci.yml 在注释里点名了若干 gate 的测试文件，那些不是入边，把它们算成"必须同批"是虚报。
  if (yml) {
    for (const line of yml.split(/\r?\n/)) {
      if (/\b(?:npm run |npm -w |node |npx |python3? |pwsh |bash )/.test(line) && !/^\s*#/.test(line)) feed(line, "ci.yml");
    }
  }
  return edges;
}
const edges = commandEdges();
// 被命令点名却被 gitignore 的文件：本地能跑、CI 永远拿不到，是最坏的一种悬空（红的时候也没人看得见）。
const ignoredRefs = [...edges.keys()].filter((rel) => {
  const r = spawnSync("git", ["check-ignore", "-q", rel], { encoding: "utf8" });
  return r.status === 0;
});

const untracked = git("ls-files", "--others", "--exclude-standard", "-z");
const modified = git("ls-files", "--modified", "-z");

const groups = new Map();
for (const rel of untracked) {
  const k = kindOf(rel);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(rel);
}

if (untracked.length === 0 && modified.length === 0 && ignoredRefs.length === 0) {
  console.log("交付卫生门禁通过：工作树里没有未入库文件（未入库未跟踪 0 个，已跟踪但工作树改动 0 个，命令点名的 gitignored 文件 0 个）");
  process.exit(0);
}

if (ignoredRefs.length > 0) {
  console.error("交付卫生门禁未通过：下面这些文件被提交进仓库的命令点名，却被 .gitignore 排除——CI 永远拿不到它们。");
  for (const rel of ignoredRefs.sort()) {
    console.error("    " + rel + "  ← " + [...edges.get(rel)].sort().join("、"));
  }
} else {
  console.error("交付卫生门禁未通过：下面的东西 CI 和其他人拿不到。");
}
for (const [k, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.error("  [" + k + "] " + String(list.length) + " 个：");
  for (const rel of list.sort()) {
    const by = edges.get(rel);
    console.error("    ?? " + rel + (by ? "  ← 被已提交的命令点名（" + [...by].sort().join("、") + "），必须同批提交" : ""));
  }
}
if (modified.length > 0) {
  console.error("  [已跟踪但工作树里有改动] " + String(modified.length) + " 个（部分提交会把它们留在本地）：");
  for (const rel of modified.sort()) console.error("    M  " + rel);
}
console.error(
  "合计：未入库未跟踪 " + String(untracked.length) + " 个；已跟踪未提交改动 " + String(modified.length) + " 个。" +
    "（gitignore 的本机文件不计——它们本来就不该进公开面。）"
);
console.error("注意：不要指望「用例数下限」门禁兜住这件事。实测漏 32 个测试文件＝少 139 条用例，362 掉到 223，仍高于下限 100 而放行。");
process.exit(1);
