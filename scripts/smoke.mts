import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RegExeClient, scanInstalledApps, defaultScanEnv, trayStatusFor, buildTrayMenu } from "../packages/core/src/index.ts";

const label = (tag: string) => (chunk: Buffer) => process.stdout.write("[" + tag + "] " + chunk);

/** 失败要么走 process.exitCode，要么直接抛；不再让「子进程非零退出」悄悄溜过去。 */
const failures: string[] = [];

/**
 * 就绪判据必须绑定「我自己那个子进程」：端口能连上只证明那个端口上有东西，不证明是本次起的服务。
 * main.ts 打印的是 `address()` 的实际值，所以从自己子进程的 stdout 里取端口才是身份可证的。
 */
function announcedPort(log: string): number | null {
  const hit = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(log);
  return hit ? Number(hit[1]) : null;
}

function runChild(program: string, args: string[], env: Record<string, string>, tag: string, stdin?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      label(tag)(chunk);
    });
    child.stderr.on("data", label(tag + "!"));
    child.on("error", (err) => {
      failures.push(tag + " spawn failed: " + err.message);
      resolve({ code: -1, out });
    });
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
    if (stdin !== undefined) {
      // 必须立刻 end：CLI 的 shell 模式读到 EOF 才会退出，留到 close 之后再关就死锁了。
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
  });
}

/**
 * 端口可由 env 覆盖。注意真凶：`server/src/main.ts:4` 读的是 **CATALOG_PORT**，
 * 而旧 smoke 只设了 `PORT`——所以它起的那个服务从来没绑到自己以为的端口上，
 * CLI 子进程全部是打到「碰巧在 7991 上的任何东西」（开发机上通常就是 ui-demo）。
 * 这里两个变量都设，并且默认给 0（临时端口）：写死 7999 时两个 smoke 并行，绑不上的那一个
 * 照样打印「server listening on 7999」，然后把 CLI 全部打到**别人的服务**上——实测 A 红 B 绿，
 * 而 A 的红来自子进程退出码这条旁路，就绪判据本身是绿的。
 * catalog 与演示包也放每次唯一的临时目录：并发跑不该共享同一份 smoke-catalog.db。
 */
const scratch = await mkdtemp(path.join(os.tmpdir(), "appcenter-smoke-"));
const requestedPort = process.env.SMOKE_PORT ?? "0";
const server = spawn(process.execPath, ["--experimental-transform-types", "packages/server/src/main.ts", "--seed"], {
  env: {
    ...process.env,
    PORT: requestedPort,
    CATALOG_PORT: requestedPort,
    DB_FILE: path.join(scratch, "smoke-catalog.db"),
    PACKAGE_ROOT: path.join(scratch, "smoke-packages"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk: Buffer) => {
  serverLog += chunk.toString("utf8");
  label("server")(chunk);
});
server.stderr.on("data", label("server!"));
server.on("error", (err) => failures.push("server spawn failed: " + err.message));

let serverExitedEarly = false;
server.on("exit", (code) => {
  if (code !== 0 && code !== null) serverExitedEarly = true;
});

let port = announcedPort(serverLog);
const deadline = Date.now() + 15000;
while (port === null && Date.now() < deadline && !serverExitedEarly) {
  await wait(100);
  port = announcedPort(serverLog);
}
if (port === null) {
  failures.push(
    "catalog server never announced its own port within 15s（请求端口 " + requestedPort + "）；输出尾部：" + serverLog.slice(-200),
  );
  server.kill();
} else {
  console.log("[smoke] own server announced port " + String(port));
  const api = "http://127.0.0.1:" + String(port);
  const demo = await runChild(process.execPath, ["--experimental-transform-types", "packages/cli/src/main.ts", "demo"], { APPCENTER_API: api }, "demo");
  if (demo.code !== 0) failures.push("cli demo exited " + String(demo.code));

  const search = await runChild(
    process.execPath,
    ["--experimental-transform-types", "packages/cli/src/main.ts", "search", "wps"],
    { APPCENTER_API: api },
    "search",
  );
  if (search.code !== 0) failures.push("cli search exited " + String(search.code));
  if (!/wps/i.test(search.out)) failures.push("cli search returned no hit for a seeded app");

  const shellInput = [
    { id: 1, method: "catalog.search", params: { text: "wps" } },
    { id: 2, method: "ui.skin", params: { id: "cny" } },
    { id: 3, method: "ui.window", params: { role: "settings" } },
    { id: 4, method: "ui.tray" },
  ]
    .map((line) => JSON.stringify(line) + "\n")
    .join("");
  const shell = await runChild(process.execPath, ["--experimental-transform-types", "packages/cli/src/main.ts", "shell"], { APPCENTER_API: api }, "shell", shellInput);
  if (shell.code !== 0) failures.push("cli shell exited " + String(shell.code));
  server.kill();
}

if (serverExitedEarly) failures.push("catalog server exited with a non-zero code");

const started = Date.now();
const apps = await scanInstalledApps(new RegExeClient());
console.log("[real-registry] " + String(apps.length) + " installed apps listed in " + String(Date.now() - started) + "ms");
for (const app of apps.slice(0, 8)) {
  console.log("[real-registry]  - " + app.displayName + " | " + app.displayVersion + " | " + (app.installLocation ?? app.regDir));
}
console.log("[real-registry] scan roots: " + JSON.stringify(defaultScanEnv()));
console.log("[real-registry] tray: " + JSON.stringify(buildTrayMenu({ jobs: [], upgradeCount: 2, pendingApprovals: 0 }).map((m) => m.label).filter(Boolean)));
console.log("[real-registry] status: " + trayStatusFor({ jobs: [], upgradeCount: 2, pendingApprovals: 0 }));
if (apps.length === 0) failures.push("real-registry scan listed 0 apps — reg.exe path or hive roots unavailable");

await rm(scratch, { recursive: true, force: true });

if (failures.length > 0) {
  console.error("SMOKE FAILED:");
  for (const line of failures) console.error("  - " + line);
  process.exitCode = 1;
} else {
  console.log("smoke done");
}
