#!/usr/bin/env node
/**
 * Emoji 基线检查：仓库文本源码里禁止出现 emoji（含变体选择符）；
 * Web UI 源码额外禁止「字符图形当图标」——图标一律用内联 SVG（静态写在 index.html，
 * 动态渲染取自 app.js 的 ICONS）。
 *
 * 用法：
 *   node scripts/check-emoji.mjs            # 检查，发现违规退出码 1 并逐条列出
 *   node scripts/check-emoji.mjs --fix-doc  # 顺手清掉 Markdown 里的 emoji（谨慎：按映射表替换）
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".shots", "smoke-packages", "data", "local-repo",
  "_internal", "packages/app/src-tauri/target", "packages/app/src-tauri/gen",
]);
const TEXT_EXT = new Set([".md", ".html", ".css", ".js", ".mjs", ".cjs", ".mts", ".ts", ".json", ".ps1", ".yml", ".yaml"]);

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
    else if (TEXT_EXT.has(path.extname(entry.name))) yield full;
  }
}

function codepointName(ch) {
  const cp = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
  return "U+" + cp;
}

const violations = [];
for (const file of walk(process.cwd())) {
  const rel = path.relative(process.cwd(), file).replace(/\\/g, "/");
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
