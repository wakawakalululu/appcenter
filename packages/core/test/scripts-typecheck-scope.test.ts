import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { makeTrackedTmp } from "./util/tmp-dirs.ts";

// 这条判据要防的是「typecheck 全绿，而 README 里写的 npm run shots 入口一跑就死」这件事本身：
// 主 tsconfig 的 include 只有 packages/*/src 与 packages/*/test，scripts/ 整个目录不在任何编译器眼里，
// scripts/reshoot.mts 因此可以带着 `mkdtemp is not defined` 存活若干轮。
// 光加一个 check:scripts 不够 —— 它的范围如果被手工列成文件清单，新增脚本就会静默落网外，
// 而那正是上面这个缺陷的形状。所以这里钉的是「范围 = glob」与「glob 展开后确实覆盖树上每一个 .mts」。
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const tscBin = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");

/** tsc 的 --showConfig 会把 include 解析成具体 files，且不进类型检查（实测 0.2s），所以能拿来量范围。 */
function resolvedFiles(configRel: string): { include: string[]; files: string[]; exit: number } {
  const r = spawnSync(process.execPath, [tscBin, "--showConfig", "-p", configRel], {
    cwd: repoRoot, encoding: "utf8",
  });
  if (r.status !== 0) throw new Error("--showConfig " + configRel + " 失败（exit=" + String(r.status) + "）：" + (r.stdout + r.stderr).slice(0, 400));
  const cfg = JSON.parse(r.stdout) as { include?: string[]; files?: string[] };
  return {
    include: cfg.include ?? [],
    files: (cfg.files ?? []).map((f) => f.replace(/^\.\//, "").replace(/\\/g, "/")),
    exit: r.status,
  };
}

function walkMts(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(repoRoot, dir, rel)).sort()) {
    const relPath = rel ? rel + "/" + name : name;
    const abs = path.join(repoRoot, dir, relPath);
    if (statSync(abs).isDirectory()) out.push(...walkMts(dir, relPath));
    else if (name.endsWith(".mts")) out.push(dir + "/" + relPath);
  }
  return out.sort();
}

const difference = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));

test("scripts 的类型检查范围是 glob，不是手工挑出来的文件清单", () => {
  const cfg = JSON.parse(readFileSync(path.join(repoRoot, "tsconfig.scripts.json"), "utf8")) as {
    extends?: string; include?: string[]; files?: string[];
  };
  assert.equal(cfg.extends, "./tsconfig.json", "必须复用主配置的严格度，否则这条判据比 typecheck 还松");
  assert.deepEqual(cfg.include, ["scripts/**/*.mts"]);
  // files 一旦存在就会盖掉 glob 的自适应语义，等于把范围重新变成快照。
  assert.ok(!("files" in cfg), "tsconfig.scripts.json 不许出现 files 字段：它会绕过 glob");
});

test("glob 展开后覆盖 scripts 树下每一个 .mts（双向）", () => {
  const { files } = resolvedFiles("tsconfig.scripts.json");
  const onDisk = walkMts("scripts");
  assert.ok(onDisk.length >= 15, "scripts 下应当至少还有 15 个 .mts，实测 " + String(onDisk.length));
  const missed = difference(onDisk, files);
  const ghost = difference(files, onDisk);
  assert.deepEqual(missed, [], "这些脚本在树上却没进类型检查程序：" + missed.join("、"));
  assert.deepEqual(ghost, [], "类型检查程序里有磁盘上不存在的脚本（include 被改成字面清单的痕迹）：" + ghost.join("、"));
});

test("主配置确实看不见 scripts——这就是坏脚本能活下来的根因", () => {
  const main = JSON.parse(readFileSync(path.join(repoRoot, "tsconfig.json"), "utf8")) as { include?: string[] };
  assert.ok((main.include ?? []).every((s) => !s.startsWith("scripts")), "主 include 一旦收进 scripts，第二个配置就该合并掉而不是并存");
  const { files } = resolvedFiles("tsconfig.json");
  assert.deepEqual(files.filter((f) => f.startsWith("scripts/")), [], "主配置里出现了 scripts 文件，说明这条根因断言已经过期");
});

test("check:scripts 存在且被写进整链，而不是只存在于文档里", () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};
  assert.equal(scripts["check:scripts"], "tsc -p tsconfig.scripts.json");
  assert.ok((scripts.ci ?? "").includes("check:scripts"), "npm run ci 必须串上它：" + String(scripts.ci));
});

test("ci.yml 的 Windows 与 Linux 两个作业各自真跑了这一步", () => {
  const yml = readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const hits = yml.split(/\r?\n/).filter((line) => line.trim() === "run: npm run check:scripts");
  assert.equal(hits.length, 2, "预期两个作业各一条 `run: npm run check:scripts`，实测 " + String(hits.length) + " 条");
});

// 机制对照：证明上面「范围 = glob」的断言不是空断言。临时目录里造同一个形状——
// glob 会把坏文件一起收进程序并 exit 非 0；换成字面清单则静默放行同一个坏文件。
// 这一步刻意不碰本仓库工作树：并行跑测试时往 scripts/ 塞坏文件会串扰别的用例。
test("对照：glob 范围能抓住坏脚本，字面清单会静默放过", async () => {
  const dir = await makeTrackedTmp("scripts-scope-ctl-");
  const mts = path.join(dir, "scripts");
  mkdirSync(mts, { recursive: true });
  writeFileSync(path.join(mts, "good.mts"), "export const n: number = 1;\n");
  writeFileSync(path.join(mts, "bad.mts"), "export const m: number = \"x\";\n");
  const base = { strict: true, noEmit: true, target: "ES2023", lib: ["ES2023"], types: [] };
  const run = (include: string[]) => {
    writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: base, include }, null, 2));
    const r = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.json", "--pretty", "false"], { cwd: dir, encoding: "utf8" });
    return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  const byGlob = run(["scripts/**/*.mts"]);
  assert.notEqual(byGlob.status, 0, "glob 范围必须让坏脚本 exit 非 0，实测 " + String(byGlob.status));
  assert.ok(byGlob.out.includes("bad.mts"), "报错要点名坏文件：" + byGlob.out.slice(0, 300));

  const byList = run(["scripts/good.mts"]);
  assert.equal(byList.status, 0, "字面清单会放过同一批代码里的坏文件——这条正是本判据要防的失败模式：" + byList.out.slice(0, 300));
});
