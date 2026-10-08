import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeTrackedTmp } from "../../core/test/util/tmp-dirs.ts";

// 这条判据管的是"公开配图的取景入口"。曾经它的缺省是 http://127.0.0.1:8080/，
// 而 8080 上常驻的往往是别人那台扫真机的实例——按构造就能把本机已装清单截进 README/Pages（#89 那次就是这么发生的）。
// 现在参数不全就在起浏览器之前退出；这里钉的正是"不再有猜出来的默认"。
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const script = path.join(repoRoot, "scripts", "ui-shot.mts");
const run = (args: string[], timeoutMs = 120000) =>
  spawnSync(process.execPath, ["--experimental-transform-types", script, ...args], { cwd: repoRoot, encoding: "utf8", timeout: timeoutMs });
const out = (r: { stdout?: string; stderr?: string }) => String(r.stdout ?? "") + String(r.stderr ?? "");

test("缺 URL 或缺输出目录：不起浏览器，直接红并给出用法", async () => {
  for (const args of [[], ["http://127.0.0.1:1/"]]) {
    const r = run(args);
    assert.equal(r.status, 1, "参数不全必须非零退出，args=" + JSON.stringify(args) + " 输出=" + out(r));
    assert.match(out(r), /用法/);
    assert.ok(out(r).includes("拒绝默认值"), "要说清为什么不留默认值：" + out(r));
    assert.ok(!out(r).includes("8080/ saved") && !out(r).includes("own chrome"), "不该已经起了浏览器：" + out(r));
  }
});

test("对照：参数齐了就不再拦（守卫不是一句永远红）", async () => {
  const dir = await makeTrackedTmp("ui-shot-args-");
  // 端口 1 上没有服务：工具会走完参数校验、去起浏览器，然后以非零退出。
  // 这里只判"没有再吐用法/拒绝默认值"，不判它怎么失败——失败原因是环境相关的。
  const r = run(["http://127.0.0.1:1/", dir], 120000);
  const text = out(r);
  assert.ok(!text.includes("拒绝默认值"), "参数齐全时不该被守卫拦住：" + text.slice(0, 400));
  assert.notEqual(r.status, null, "子进程应当有归宿（既不是永不返回也不是被超时以外方式带走）");
});

// 第二道护栏：未脱敏的截图不许直接落进公开配图目录（#89 那次泄露就是这个形状——
// 状态栏与已装列表会把对照对象厂商名与本机用户名一起烤进图）。
// 本地目视仍然放行：不脱敏写到仓库外是拿它验收的唯一手段。
test("未脱敏 URL + 公开配图目录：起浏览器之前就拒，且不碰目录里的现有图", () => {
  const r = run(["http://127.0.0.1:1/", "docs/assets/screenshots"]);
  assert.equal(r.status, 1, "这个组合必须红：" + out(r));
  assert.ok(out(r).includes("公开配图目录"), "要说清拒的是「公开目录 + 未脱敏」这个组合：" + out(r));
  assert.ok(!out(r).includes("own chrome"), "应当在起浏览器之前就退出：" + out(r));
  assert.ok(!out(r).includes("saved "), "不该写出任何图：" + out(r));
  const files = spawnSync("git", ["-C", repoRoot, "status", "--short", "--", "docs/assets/screenshots"], { encoding: "utf8" });
  // 公开目录里只允许有本轮之前就在的那些改动（三张重截的 PNG），护栏命中时不该新增或删除。
  assert.ok(!files.stdout.includes("??"), "护栏命中却往公开目录里加了东西：" + files.stdout);
});

test("对照：同名目录在仓库外就不算公开面（护栏不是一句永远红）", async () => {
  const dir = await makeTrackedTmp("ui-shot-public-");
  const outside = path.join(dir, "docs", "assets", "screenshots");
  const r = run(["http://127.0.0.1:1/", outside], 120000);
  assert.ok(!out(r).includes("公开配图目录"), "仓库外的同名目录不该被拒：" + out(r).slice(0, 400));
});

test("仓库里两个真实调用方都传满了必需参数", () => {
  const ci = readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const line = ci.split(/\r?\n/).find((l) => l.includes("scripts/ui-shot.mts"));
  assert.ok(line, "ci.yml 里找不到调用 ui-shot 的那一步（被改名或删掉就要同步这条判据）");
  const tail = line.slice(line.indexOf("ui-shot.mts") + "ui-shot.mts".length).trim();
  // "$URL" .shots "<views>" 1237x762 —— 至少要有 URL 与输出目录两个实参
  assert.ok(tail.split(/\s+/).length >= 2, "ci.yml 的调用没有两个必需实参：" + line);
  assert.ok(tail.includes("mask=1"), "CI 截图必须走脱敏显示（?mask=1）：" + line);

  const reshoot = readFileSync(path.join(repoRoot, "scripts", "reshoot.mts"), "utf8");
  assert.ok(reshoot.includes('path.join(repoRoot, "scripts", "ui-shot.mts")'), "reshoot 不再这样调 ui-shot，判据要同步");
  const callBlock = reshoot.slice(reshoot.indexOf('path.join(repoRoot, "scripts", "ui-shot.mts")'));
  const args = callBlock.slice(0, callBlock.indexOf("]);")).split(",").map((s) => s.trim()).filter(Boolean);
  assert.ok(args.length >= 4, "reshoot 传给 ui-shot 的实参不足（url、outDir、视图、尺寸）：" + String(args.length));
});
