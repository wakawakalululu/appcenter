import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import net from "node:net";
import { RegExeClient, scanInstalledApps, defaultScanEnv, trayStatusFor, buildTrayMenu } from "../packages/core/src/index.ts";

const label = (tag: string) => (chunk: Buffer) => process.stdout.write("[" + tag + "] " + chunk);

/** 失败要么走 process.exitCode，要么直接抛；不再让「子进程非零退出」悄悄溜过去。 */
const failures: string[] = [];

/** TCP 层就绪探测：不依赖服务端的日志措辞，也不靠固定 sleep。 */
async function waitForPort(port: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      const done = (value: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(500, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
    if (open) return true;
    await wait(150);
  }
  return false;
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
 * 这里两个变量都设，并默认换到 7999 避开常驻 demo。
 */
const PORT = process.env.SMOKE_PORT ?? "7999";
const server = spawn(process.execPath, ["--experimental-transform-types", "packages/server/src/main.ts", "--seed"], {
  env: { ...process.env, PORT, CATALOG_PORT: PORT, DB_FILE: "smoke-catalog.db", PACKAGE_ROOT: "smoke-packages" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", label("server"));
server.stderr.on("data", label("server!"));
server.on("error", (err) => failures.push("server spawn failed: " + err.message));

let serverExitedEarly = false;
server.on("exit", (code) => {
  if (code !== 0 && code !== null) serverExitedEarly = true;
});

const listening = await waitForPort(Number(PORT));
if (!listening) {
  failures.push("catalog server never listened on " + PORT + " within 15s");
  server.kill();
} else {
  console.log("[smoke] server listening on " + PORT);
  const demo = await runChild(process.execPath, ["--experimental-transform-types", "packages/cli/src/main.ts", "demo"], { APPCENTER_API: "http://127.0.0.1:" + PORT }, "demo");
  if (demo.code !== 0) failures.push("cli demo exited " + String(demo.code));

  const search = await runChild(
    process.execPath,
    ["--experimental-transform-types", "packages/cli/src/main.ts", "search", "wps"],
    { APPCENTER_API: "http://127.0.0.1:" + PORT },
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
  const shell = await runChild(process.execPath, ["--experimental-transform-types", "packages/cli/src/main.ts", "shell"], { APPCENTER_API: "http://127.0.0.1:" + PORT }, "shell", shellInput);
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

if (failures.length > 0) {
  console.error("SMOKE FAILED:");
  for (const line of failures) console.error("  - " + line);
  process.exitCode = 1;
} else {
  console.log("smoke done");
}
