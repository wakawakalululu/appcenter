#!/usr/bin/env node
/**
 * Emoji 基线检查：仓库文本源码里禁止出现 emoji（含变体选择符）；
 * Web UI 源码额外禁止「字符图形当图标」——图标一律用内联 SVG（静态写在 index.html，
 * 动态渲染取自 app.js 的 ICONS）。
 *
 * 用法：node scripts/check-emoji.mjs   # 检查，发现违规退出码 1 并逐条列出
 */
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".shots", "smoke-packages", "data", "local-repo",
  "_internal", "packages/app/src-tauri/target", "packages/app/src-tauri/gen",
]);
// 白名单要等于"可发布的文本文件"这个集合本身，少一种扩展名就是一个静默盲区：
// 早先漏了 .rs/.toml/.svg/.py（这些都在发布树里），emoji 写进去既不会被本门禁抓到，也不会有别的门禁抓。
const TEXT_EXT = new Set([".md", ".html", ".css", ".js", ".mjs", ".cjs", ".mts", ".ts", ".tsx", ".json", ".ps1", ".py", ".rb", ".sh", ".bash", ".zsh", ".rs", ".toml", ".ini", ".env", ".yml", ".yaml", ".svg", ".txt", ".xml", ".csv"]);
// 按名字收进来的发布文本。这里有过一次真盲区：白名单里写着 ".gitignore"，
// 但 path.extname(".gitignore") 返回空串（点文件没有"扩展名"），那条永远匹配不到；
// 实测发布树里 extname 为空的文本共三个——.gitignore、LICENSE、docs/.nojekyll——一个都没被查过。
// LICENSE 尤其不该漏：它是公开面上最显眼的人读文本之一。
const TEXT_NAMES = new Set([".gitignore", ".nojekyll", "LICENSE"]);
const inScope = (file) => TEXT_EXT.has(path.extname(file)) || TEXT_NAMES.has(path.basename(file));

// emoji 与变体选择符：任何文本源都不允许。
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F900}-\u{1F9FF}]/u;
// Web UI 源码里禁止的「字符图形当图标」码点；箭头 2192（→）用于文案（如版本 1.0 → 2.0），不在禁列。
const UI_GLYPH_BLACKLIST = /[\u2190\u2191\u21E7\u2261\u2315\u2500\u25A0\u25A2\u25A6\u2601\u2605\u2606\u2713\u2715\u2717\u2718\u2913]/u;
const UI_FILES = ["packages/app/web/index.html", "packages/app/web/app.js", "packages/app/web/app.css"];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (inScope(entry.name)) yield full;
  }
}

/**
 * 门禁只对「会进公开面」的文件负责：已入库的，加上没入库但也没被 .gitignore 的（作者打算提交的）。
 * 直接遍历工作树会把 `LOCAL-NOTES.md`、`discover-report.json` 这类只在本机存在的文件算进来——
 * 第三方应用名里冒出一个 emoji 就让本地门禁变红，而 CI 的 checkout 里根本没有这个文件，
 * 「本地红 / CI 绿」会让人开始无视门禁，所以按 git 的可见集合收口。
 * 拿不到 git（导出 tarball、极简镜像）时退回遍历：宁可多查，不可漏查。
 */
function publishableScope() {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0 || !top.stdout.trim()) return null;
  const root = top.stdout.trim();
  const listed = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  );
  if (listed.status !== 0) return null;
  return {
    root,
    files: listed.stdout
      .split("\0")
      .filter((f) => f && inScope(f))
      .map((f) => path.join(root, ...f.split("/"))),
  };
}

function codepointName(ch) {
  const cp = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
  return "U+" + cp;
}

const scope = publishableScope() ?? { root: process.cwd(), files: [...walk(process.cwd())] };
const violations = [];
for (const file of scope.files) {
  const rel = path.relative(scope.root, file).replace(/\\/g, "/");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const isUi = UI_FILES.includes(rel);
  text.split("\n").forEach((line, index) => {
    for (const pattern of [EMOJI, ...(isUi ? [UI_GLYPH_BLACKLIST] : [])]) {
      for (const match of line.matchAll(new RegExp(pattern.source, "gu"))) {
        violations.push({ file: rel, line: index + 1, char: match[0], code: codepointName(match[0]) });
      }
    }
  });
}

if (violations.length > 0) {
  console.error("emoji 基线检查未通过（基线：零 emoji；Web UI 零字符图形图标，请改用内联 SVG）：\n");
  for (const v of violations) console.error("  " + v.file + ":" + v.line + "  " + v.char + " " + v.code);
  console.error("\n共 " + String(violations.length) + " 处。图标请使用内联 SVG（参考 app.js 的 ICONS 或 index.html 顶栏）。");
  process.exit(1);
}
console.log("emoji 基线检查通过：0 处违规。");
