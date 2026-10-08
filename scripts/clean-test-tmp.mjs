// 测试套件的临时目录清扫器。默认只报告，不删任何东西；要真删必须显式 --apply。
//
// 为什么存在：实测本机 %TEMP% 有 8571 条，其中绝大多数是测试跑出来的目录
// （orch 955、swap 618、selfupd 515、guard-child 510、desktop-fake 408…），
// 而整条 `npm run ci` 链 414/414 全绿——泄漏不会让任何断言变红，所以它永远不会被"测出来"。
//
// 为什么前缀是从仓库里现扫的，而不是写死一份名单：
// 写死的名单会腐烂，且**名字越短越危险**（"dl-xxxxxxx" 这种形状用户自己也可能有）。
// 这里只删满足全部三条的东西：① 前缀字面量确实出现在本仓库测试/脚本的 mkdtemp 调用里；
// ② 后缀形状是 mkdtemp 的随机段（`-` 加 6~10 位字母数字）；③ mtime 比阈值老（默认 30 分钟，
// 给并行跑的套件留出活目录）。任何一条不满足就只统计不动手。
//
// 刻意不进 `npm run ci`：CI 的工作树与临时目录都是全新的，那一步在 CI 必然什么都找不到＝空判据。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");

/** 从仓库源码里把 mkdtemp 用的前缀字面量抠出来。 */
export function collectPrefixes(root = ROOT) {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|mts|mjs)$/.test(e.name)) files.push(full);
    }
  };
  for (const p of ["packages", "scripts"]) {
    const full = path.join(root, p);
    try {
      walk(full);
    } catch {
      /* 目录不存在就算了，但下面的空名单会让整个脚本变成"什么都不删"，不会误伤 */
    }
  }
  const prefixes = new Set();
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/mkdtemp\(\s*path\.join\(\s*[^,]+,\s*["']([^"']+)["']/g)) {
      prefixes.add(m[1].replace(/-$/, ""));
    }
  }
  return [...prefixes].sort();
}

/**
 * 在 `dir` 里挑候选。返回 { doomed, tooFresh, matched }。
 * 三个条件缺一不可：前缀字面量来自仓库、后缀是 mkdtemp 的随机段形状、mtime 老于阈值。
 * `now` 可注入是为了让测试能造出"刚好新/刚好老"的样本，而不是靠 sleep 猜时间。
 */
export function selectCandidates(dir, prefixes, { now = Date.now(), minAgeMs = 30 * 60 * 1000 } = {}) {
  const doomed = [];
  const tooFresh = [];
  let scanned = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    scanned += 1;
    if (!e.isDirectory()) continue;
    const hit = prefixes.find((p) => e.name.startsWith(p + "-"));
    if (!hit) continue;
    const suffix = e.name.slice(hit.length + 1);
    if (!/^[A-Za-z0-9]{6,10}$/.test(suffix)) continue;
    const full = path.join(dir, e.name);
    let age;
    try {
      age = now - statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (age < minAgeMs) tooFresh.push(full);
    else doomed.push(full);
  }
  return { doomed, tooFresh, scanned };
}

// 只有"直接被当脚本跑"才动作；被测试 import 时只导出函数（否则测试一 import 就会去动真的 %TEMP%）。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(name);
    return i === -1 || i + 1 >= process.argv.length ? dflt : process.argv[i + 1];
  };
  const APPLY = process.argv.includes("--apply");
  // --dir / --min-age-ms / --root 是给测试开的缝：判据要能在**沙箱目录**上跑红绿，
  // 而不是靠跑真的 %TEMP%（那既是破坏性操作，也让"这条测了什么"说不清）。
  const dir = arg("--dir", tmpdir());
  const minAgeMs = Number(arg("--min-age-ms", String(30 * 60 * 1000)));
  const root = arg("--root", ROOT);
  const prefixes = collectPrefixes(root);
  if (prefixes.length === 0) {
    console.error("一个 mkdtemp 前缀都没扫到——判定为扫描失效，直接退出，绝不带着空规则去删东西。");
    process.exit(2);
  }
  const { doomed, tooFresh, scanned } = selectCandidates(dir, prefixes, { minAgeMs });
  console.log("扫描目录 " + dir);
  console.log("前缀来源：仓库里扫到 " + String(prefixes.length) + " 个 mkdtemp 前缀；条目共 " + String(scanned) + " 条");
  console.log("结果：候选 " + String(doomed.length) + " 个；太新（可能正被并行跑的套件用）" + String(tooFresh.length) + " 个；阈值 " + String(minAgeMs) + " ms");
  console.log("模式：" + (APPLY ? "--apply（真的删）" : "干跑（只报告，一个都不删）"));
  for (const d of doomed.slice(0, 8)) console.log("  " + d);
  if (doomed.length > 8) console.log("  …其余 " + String(doomed.length - 8) + " 个");
  if (APPLY) {
    const { rmSync } = await import("node:fs");
    let removed = 0;
    const failed = [];
    for (const d of doomed) {
      try {
        rmSync(d, { recursive: true, force: true });
        removed += 1;
      } catch (err) {
        failed.push(d + " → " + String(err.code ?? err.message));
      }
    }
    console.log("已删除 " + String(removed) + " 个；失败 " + String(failed.length) + " 个（EPERM/EBUSY 说明有东西还在用，绝不重试硬删）");
    for (const f of failed.slice(0, 5)) console.log("  " + f);
  }
}
