import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 公开配图只能从「虚构已装清单 + 路径脱敏显示」里来。installed.png 曾经直接截真机演示实例，
// 把对照对象的厂商名与安装目录一起带进了 README/Pages；而旧版 `npm run shots` 写死
// http://127.0.0.1:8080/（那往往是别人常驻的、扫真机的实例）、不带 ?mask=1、还把图写进仓库根。
// 所以把安全配方钉成代码，而不是靠人记笔记。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 顺序有讲究：click 步骤沿用前一步所在的视图，所以紧跟 home 才能截到「首页 + 详情抽屉」，
// 放在最后会截成「搜索页 + 抽屉」，和已跟踪的那张对不上。
// 点开的抽屉必须显式关掉：抽屉是覆盖在内容区之上的 aside，不关的话后面每一张
// （分类/已装/升级/搜索）右半边都会被它挡住 —— 实测过，installed.png 会带着抽屉落盘。
const VIEWS = "skin:fresh,home,click:.app-main,js:document.getElementById('detail-close').click(),categories,installed,upgrade,search";
const SIZE = "1237x762";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(cmd: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.setEncoding("utf8");
    p.stderr.setEncoding("utf8");
    p.stdout.on("data", (chunk: string) => {
      out += chunk;
      process.stdout.write(chunk);
    });
    p.stderr.on("data", (chunk: string) => {
      err += chunk;
      process.stderr.write(chunk);
    });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

const scratch = await mkdtemp(path.join(os.tmpdir(), "appcenter-reshoot-"));
const outDir = path.join(scratch, "shots");
const demoLog: string[] = [];
const demo = spawn(process.execPath, ["--experimental-transform-types", path.join(repoRoot, "scripts", "ui-demo.mts")], {
  cwd: scratch,
  env: {
    ...process.env,
    UI_DEMO_FAKE_INVENTORY: "1",
    CATALOG_PORT: "0",
    UI_PORT: "0",
    TMP: scratch,
    TEMP: scratch,
    UI_DEMO_DATA_DIR: path.join(scratch, "data"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
// Node 24 上 spawn 失败不是同步抛出：没有 error 监听就是未处理拒绝，进程会带着半截状态死掉。
let spawnError = "";
demo.on("error", (err) => {
  spawnError = String(err);
});
for (const stream of [demo.stdout, demo.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => demoLog.push(chunk));
}

function portOf(re: RegExp): number {
  return Number((re.exec(demoLog.join("")) ?? [null, null])[1] ?? 0);
}

const deadline = Date.now() + 60000;
let uiPort = 0;
for (;;) {
  const catalogPort = portOf(/catalog api on http:\/\/127\.0\.0\.1:(\d+)/);
  uiPort = portOf(/ui on http:\/\/127\.0\.0\.1:(\d+)/);
  if (catalogPort > 0 && uiPort > 0) break;
  if (spawnError || demo.exitCode !== null) {
    throw new Error("ui-demo 起不来（提前退出，exit=" + String(demo.exitCode) + "）：" + demoLog.join("").slice(-800));
  }
  if (Date.now() > deadline) {
    throw new Error("ui-demo 未在 60s 内 announce 自己的端口：" + demoLog.join("").slice(-800));
  }
  await sleep(500);
}

// 「端口能连上」不等于「是我的服务」：这里既认端口（来自我们自己子进程的 stdout），
// 也认持有者 PID 必须就是这个子进程 —— 别的实例（包括别人常驻的、扫真机的那台）不可能同时满足两条。
if (process.platform === "win32") {
  const ownerProbe = await run("powershell.exe", [
    "-NoProfile",
    "-Command",
    "(Get-NetTCPConnection -LocalPort " + String(uiPort) + " -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess",
  ]);
  const owner = Number(ownerProbe.out.replace(/\D/g, ""));
  if (!Number.isFinite(owner) || owner <= 0) {
    throw new Error("查不到端口 " + String(uiPort) + " 的持有者：" + ownerProbe.err.slice(0, 300));
  }
  if (owner !== demo.pid) {
    throw new Error("端口 " + String(uiPort) + " 由 PID " + String(owner) + " 持有，不是本次起的 ui-demo（" + String(demo.pid) + "）——拒绝截别人的服务");
  }
  console.log("identity ok: ui port " + String(uiPort) + " owned by our own pid " + String(owner));
} else {
  console.log("identity check (port owner) is Windows-only; on " + process.platform + " relying on the announced ephemeral port from our own child");
}

const shot = await run(process.execPath, [
  "--experimental-transform-types",
  path.join(repoRoot, "scripts", "ui-shot.mts"),
  "http://127.0.0.1:" + String(uiPort) + "/?mask=1",
  outDir,
  VIEWS,
  SIZE,
]);
demo.kill();
if (shot.code !== 0) {
  throw new Error("ui-shot 退出码 " + String(shot.code) + "，图不可信（" + outDir + "）");
}
console.log("\n图落在 " + outDir + "（仓库之外）。");
console.log("更新公开配图前请逐张目视，再手动复制进 docs/assets/screenshots/ —— 复制这一步有意留给人做。");
