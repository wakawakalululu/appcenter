#!/usr/bin/env node
/**
 * 依赖许可证自审（P8 的"定期自审合规：License、依赖许可"落成的可执行判据）。
 * 用法：node scripts/check-licenses.mjs [仓库根]
 *
 * 判据是"白名单 + 缺证即拒"，不是"黑名单"：
 *  - 黑名单要穷举所有 copyleft 变体（GPL-2.0-or-later、AGPL-3.0-with…、SSPL、QPL…），一定漏；
 *  - 解析不到许可证字段时按不合格处理 —— "不知道能不能用"在合规上就等于不能用。
 * 另外会断言"确实看到了包"，否则依赖没装（node_modules 缺失）会让这条门禁静默通过。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? process.cwd());

const PERMISSIVE = new Set([
  "MIT", "MIT-0", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD",
  "CC0-1.0", "Unlicense", "Zlib", "Python-2.0", "MPL-2.0", "BlueOak-1.0.0",
]);

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 工作区自身的包名（它们的 license 由仓库自己的 LICENSE 决定，不参与依赖判定）。 */
function workspaceNames() {
  const names = new Set();
  const rootPkg = readJson(path.join(root, "package.json"));
  for (const glob of rootPkg?.workspaces ?? []) {
    const dir = String(glob).replace(/\/\*$/, "");
    const pj = readJson(path.join(root, dir, "package.json"));
    if (pj?.name) names.add(pj.name);
  }
  if (rootPkg?.name) names.add(rootPkg.name);
  return names;
}

function directDeps() {
  const own = workspaceNames();
  const deps = new Set();
  const manifests = [path.join(root, "package.json")];
  const rootPkg = readJson(path.join(root, "package.json"));
  for (const ws of rootPkg?.workspaces ?? []) {
    const dir = path.join(root, String(ws).replace(/\/\*$/, ""));
    if (existsSync(path.join(dir, "package.json"))) manifests.push(path.join(dir, "package.json"));
  }
  for (const m of manifests) {
    const j = readJson(m);
    for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, spec] of Object.entries(j?.[key] ?? {})) {
        if (String(spec).startsWith("workspace:")) continue;
        if (own.has(name)) continue;
        deps.add(name);
      }
    }
  }
  return [...deps].sort();
}

function licenseOf(name) {
  const pj = readJson(path.join(root, "node_modules", name, "package.json"));
  if (!pj) return { license: null, installed: false };
  const raw = typeof pj.license === "string" ? pj.license
    : typeof pj.license?.type === "string" ? pj.license.type
    : Array.isArray(pj.licenses) ? String((pj.licenses[0] ?? {}).type ?? "")
    : null;
  return { license: raw ? raw.trim() : null, installed: true };
}

const deps = directDeps();
const problems = [];
const seen = [];

if (deps.length === 0) {
  problems.push("一个直接依赖都没解析到 —— 清单读错了或依赖没装，这条门禁不能算通过");
}
if (!existsSync(path.join(root, "node_modules"))) {
  problems.push("node_modules 不存在：先 npm ci 再跑本检查，否则所有依赖都会被误判成缺失");
}

for (const name of deps) {
  const { license, installed } = licenseOf(name);
  if (!installed) {
    problems.push(name + " 未安装，无法确认许可证");
    continue;
  }
  if (!license) {
    problems.push(name + " 的 package.json 没有 license 字段（缺证即拒）");
    continue;
  }
  seen.push(name + "=" + license);
  // 复合表达式（如 "(MIT OR Apache-2.0)"）里只要有一段不在白名单，就按不合格处理。
  const parts = license.replace(/[()]/g, "").split(/\s+(?:OR|and)\s+/i).map((s) => s.trim()).filter(Boolean);
  const bad = parts.filter((p) => !PERMISSIVE.has(p));
  if (bad.length > 0) problems.push(name + " 的许可证 " + license + " 不在允许清单（待核：" + bad.join(", ") + "）");
}

console.log("依赖许可证自审：" + String(deps.length) + " 个直接依赖；合格 " + String(deps.length - problems.length) + " 个");
console.log("  " + seen.join("  "));
if (problems.length > 0) {
  console.error("许可证检查未通过：\n  - " + problems.join("\n  - "));
  process.exit(1);
}
console.log("全部直接依赖的许可证都在允许清单内。");
