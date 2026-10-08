import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { makeTrackedTmp } from "./util/tmp-dirs.ts";

// check:delivery 新加的那类边：被「已提交的命令」点名的文件。
// 判它的范围必须是"真正执行命令的文本"，不是"整份配置里出现过这个字符串"——
// 本仓库的 ci.yml 在注释里点名了好几个 gate 的测试文件，把它们也算成同批依赖就是虚报（实测一次标出 11 条，
// 其中两条是注释造成的假边，收窄到命令行之后是 9 条条条可复核）。
const script = path.join(import.meta.dirname, "../../../scripts/check-delivery.mjs");
const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
const options = gitAvailable ? {} : { skip: "交付卫生要靠 git 才能判定，环境里没有 git" };

const env = (dir: string) => ({ ...process.env, HOME: dir, USERPROFILE: dir });
const git = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: env(dir) });
const gate = (dir: string) => spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8", env: env(dir) });
const must = (r: { status: number | null; stdout?: string; stderr?: string }, what: string) => {
  if (r.status !== 0) throw new Error(what + " 失败：" + String(r.stderr ?? "") + String(r.stdout ?? ""));
};

/**
 * 造一个干净的小仓库：一个已提交的 scripts/tool.mjs 与一个 package.json。
 * `opts.ref` 决定"命令里点名谁"，`opts.extra` 决定往 ci.yml 里塞什么正文。
 */
async function repo(opts: { pkgScript?: string; ciRun?: string; ciComment?: string; ignore?: string } = {}): Promise<string> {
  const dir = await makeTrackedTmp("delivery-edges-");
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await mkdir(path.join(dir, ".github", "workflows"), { recursive: true });
  must(git(dir, "init", "-q"), "git init");
  await writeFile(path.join(dir, "scripts", "tool.mjs"), "console.log(\"tool\");\n");
  if (opts.ignore) await writeFile(path.join(dir, "scripts", "hidden.mjs"), "console.log(\"hidden\");\n");
  await writeFile(path.join(dir, "package.json"), JSON.stringify({
    name: "fixture",
    scripts: { tool: opts.pkgScript ?? "node scripts/tool.mjs" },
  }) + "\n");
  const yml = [
    "name: CI",
    "on: push",
    "jobs:",
    "  a:",
    "    steps:",
    "      - run: " + (opts.ciRun ?? "node scripts/tool.mjs"),
    "",
    ...(opts.ciComment ? ["      # " + opts.ciComment] : []),
  ].join("\n");
  await writeFile(path.join(dir, ".github", "workflows", "ci.yml"), yml + "\n");
  await writeFile(path.join(dir, ".gitignore"), (opts.ignore ?? "ignored.txt") + "\n");
  if (opts.ignore) await writeFile(path.join(dir, "keep.txt"), "x\n");
  must(git(dir, "add", "package.json", ".github/workflows/ci.yml", ".gitignore", "scripts/tool.mjs"), "git add");
  must(git(dir, "-c", "user.email=edges@example.invalid", "-c", "user.name=edges", "commit", "-q", "-m", "chore: seed"), "git commit");
  return dir;
}

const out = (r: { stdout?: string; stderr?: string }) => String(r.stdout ?? "") + String(r.stderr ?? "");

test("对照：命令点名的文件已提交 ⇒ 不该有「必须同批」标注", options, async () => {
  const dir = await repo();
  try {
    const run = gate(dir);
    assert.equal(run.status, 0, "干净的 fixture 应当绿（否则后面的绿只说明脚本没跑起来）：" + out(run));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("被 package.json 命令点名却未入库的文件，要标成必须同批", options, async () => {
  const dir = await repo({ pkgScript: "node scripts/tool.mjs && node scripts/helper.mjs" });
  try {
    await writeFile(path.join(dir, "scripts", "helper.mjs"), "console.log(\"helper\");\n");
    const run = gate(dir);
    assert.equal(run.status, 1, out(run));
    const line = out(run);
    assert.ok(line.includes("scripts/helper.mjs"), "没点名缺的那个文件：" + line);
    assert.ok(line.includes("package.json:tool"), "标注要给出是哪条命令引的：" + line);
    assert.ok(!line.includes("scripts/tool.mjs  ←"), "已入库的文件不该被标注：" + line);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ci.yml 的命令行算入边，但注释里提到文件名不算", options, async () => {
  // 只让 ci.yml 的执行行指向 helper.mjs，package.json 不引它；另在注释里提一个不存在的名字。
  const dir = await repo({ ciRun: "node scripts/helper.mjs" });
  try {
    await writeFile(path.join(dir, "scripts", "helper.mjs"), "console.log(\"helper\");\n");
    const run = gate(dir);
    assert.equal(run.status, 1, out(run));
    assert.ok(out(run).includes("ci.yml"), "命令行引用的来源要标出来：" + out(run));

    // 注释里提 tool2.mjs（文件存在但既没被命令行引用，也不该被标注）
    await writeFile(path.join(dir, "scripts", "tool2.mjs"), "console.log(2);\n");
    const yml = path.join(dir, ".github", "workflows", "ci.yml");
    await writeFile(yml, "name: CI\non: push\njobs:\n  a:\n    steps:\n      - run: node scripts/tool.mjs\n      # 判据由 scripts/tool2.mjs 钉住\n");
    must(git(dir, "add", ".github/workflows/ci.yml"), "add yml");
    must(git(dir, "-c", "user.email=edges@example.invalid", "-c", "user.name=edges", "commit", "-q", "-m", "chore: mention in comment"), "commit");
    const second = gate(dir);
    const text = out(second);
    const annotated = text.split(/\r?\n/).filter((l) => l.includes("←") && l.includes("tool2.mjs"));
    assert.deepEqual(annotated, [], "注释里提到的文件名被当成入边了（虚报）：" + text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("命令点名的文件被 gitignore：单独报一条红", options, async () => {
  const dir = await repo({ pkgScript: "node scripts/hidden.mjs", ignore: "scripts/hidden.mjs" });
  try {
    // 让 hidden.mjs 存在于工作树、被忽略、且被 package.json 的命令点名（fixture 里已写出该文件）。
    const run = gate(dir);
    assert.equal(run.status, 1, "被命令点名却被忽略的文件必须红：" + out(run));
    assert.ok(out(run).includes("gitignore 排除"), "要说清这是「CI 永远拿不到」而不是「忘了 add」：" + out(run));
    assert.ok(out(run).includes("scripts/hidden.mjs"), "要点名文件：" + out(run));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
