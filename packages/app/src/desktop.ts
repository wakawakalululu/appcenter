import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installProcessGuardrails } from "@appcenter/core";
import { startUi } from "./bridge.ts";

/**
 * 桌面壳：让应用中心以「真正的桌面窗口」运行，而不是浏览器标签页。
 *
 * 分层迁移路线（本轮落地第 2 层）：
 *   1. 浏览器开发模式 —— `npm run ui`，给开发与自动化用；
 *   2. 桌面应用窗口 —— Edge/Chrome `--app` 独立窗口：独立任务栏图标、无标签页/地址栏、
 *      favicon 作窗口图标，窗口初始几何取工作区的 60.4% × 66.1%（最小 900×600）；
 *   3. Tauri 完整打包 —— `src-tauri/` 骨架已入库，待 Rust + MSVC 工具链就绪后 `npm run tauri build`。
 *
 * 选 `--app` 而不是 Tauri 先行，是因为它零工具链依赖（Edge 恒在），且 UI 里自绘的
 * 最小化/最大化/关闭按钮在独立窗口里交给 OS 标题条（`?shell=app` 时 UI 自动隐藏自绘按钮），
 * 不会出现双份窗口控制。
 */

export interface WorkareaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 初始几何按固定比例取窗口：工作区的 60.4% × 66.1%，下限 900×600，在工作区内居中。 */
export function geometryFor(workarea: WorkareaRect): WorkareaRect {
  const width = Math.max(900, Math.round(workarea.width * 0.604));
  const height = Math.max(600, Math.round(workarea.height * 0.661));
  return {
    width,
    height,
    x: workarea.x + Math.round((workarea.width - width) / 2),
    y: workarea.y + Math.round((workarea.height - height) / 2),
  };
}

/** 从候选里挑第一个真实存在的浏览器；候选可为 undefined（未配置的环境变量）。 */
export async function findShellExecutable(
  candidates: readonly (string | undefined)[],
  exists: (file: string) => Promise<boolean> = (file) => access(file).then(() => true).catch(() => false),
): Promise<string | null> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (await exists(candidate)) return candidate;
  }
  return null;
}

/** 独立应用窗口的启动参数：app 模式 + 几何 + 隔离 profile，绝不复用用户日常浏览器会话。 */
export function buildShellArgs(url: string, geometry: WorkareaRect, profileDir: string): string[] {
  return [
    "--app=" + url,
    "--window-size=" + String(geometry.width) + "," + String(geometry.height),
    "--window-position=" + String(geometry.x) + "," + String(geometry.y),
    "--user-data-dir=" + profileDir,
    "--no-first-run",
    "--no-default-browser-check",
  ];
}

/** 读主屏工作区（去掉任务栏）。PowerShell 只在 Windows 有；非 Windows 返回保守默认。 */
export async function getWorkarea(): Promise<WorkareaRect> {
  if (process.platform !== "win32") return { x: 0, y: 0, width: 1920, height: 1040 };
  const { execFile } = await import("node:child_process");
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $wa=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; \"$($wa.X),$($wa.Y),$($wa.Width),$($wa.Height)\""],
      (err, out) => (err ? reject(err) : resolve(out)),
    );
  });
  const [x, y, width, height] = stdout.trim().split(",").map(Number);
  if ([x, y, width, height].some((n) => !Number.isFinite(n))) throw new Error("unparsable workarea: " + stdout.trim());
  return { x: x!, y: y!, width: width!, height: height! };
}

export interface DesktopOptions {
  catalogPort?: number;
  uiPort?: number;
  shellPath?: string;
  /** 覆盖目录服务入口（测试用假服务）；默认 packages/server/src/main.ts。 */
  serverEntry?: string;
  /** 直接给定工作区就跳过 PowerShell 探测（非 Windows、或要固定几何时）。 */
  workarea?: WorkareaRect;
  /** 追加给目录服务子进程的环境变量。 */
  envExtras?: Record<string, string>;
}

export interface DesktopSession {
  uiUrl: string;
  /** 这次真正在用的目录服务端口（父进程分配的临时号码），调用方与测试要靠它证明没复用到别人的服务。 */
  catalogPort: number;
  shell: ChildProcess | null;
  catalogServer: ChildProcess;
  /** 本次为浏览器建的隔离 profile 目录；close() 负责回收，别把它们留在 %TEMP%。 */
  profileDirs: string[];
  close(): Promise<void>;
}

/**
 * TCP 层就绪探测。旧实现是「等 stdout 里出现 listening 字样」——那是把日志措辞当协议用：
 * 措辞一改、输出被缓冲、或分块切在单词中间，就绪判定就假阴性；反过来服务没起来但
 * 别的进程占着这个端口时又成了假阳性。端口能不能连上才是事实。
 */
export async function waitForPort(port: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      const done = (value: boolean): void => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(500, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
    if (open) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function exists(file: string): Promise<boolean> {
  return access(file).then(() => true).catch(() => false);
}

/**
 * 向系统要一个当前空闲的临时端口，然后立刻放开，把这个号码交给子进程去绑。
 * 为什么不直接用 0 让子进程自己挑：那要求父进程读懂子进程打印的端口，而「日志措辞当协议用」
 * 是本文件里已经被一条用例明确否掉的判据（见 desktop-lifecycle.test.ts 的静默服务）。
 * 中间的窄竞态是有归宿的：号码被别人抢走时子进程 bind 失败会退出，watchDeath 会把这次失败兜出来，
 * 不会退回「端口能连上就算就绪」。
 */
async function allocatePort(): Promise<number> {
  const srv = net.createServer();
  const port = await new Promise<number>((resolve) => srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port)));
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/**
 * 端口持有者的 PID；拿不到（平台不支持/查询失败）返回 null，调用方据此跳过身份核对而不是当成通过。
 * 「端口能连上」不含身份信息：开发机上常驻的另一个实例（包括正在扫真机注册表那台）完全可能占着同一个号码，
 * 于是这份就绪判据会指到别人的服务上去——本仓库已在 smoke、demo 截图两处踩过，判据统一到「是我起的进程」。
 */
export async function listenerOwnerPid(port: number): Promise<number | null> {
  if (process.platform !== "win32") return null;
  const r = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "(Get-NetTCPConnection -LocalPort " + String(port) + " -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess",
  ], { encoding: "utf8", timeout: 8000 });
  const digits = (r.stdout ?? "").replace(/\D/g, "");
  if (r.status !== 0 || digits === "") return null;
  return Number(digits);
}

/** 起目录服务 + 引擎 + 桥，再开独立桌面窗口；窗口关闭即整场退出（托盘常驻走 tray.ts）。 */
export async function runDesktop(options: DesktopOptions = {}): Promise<DesktopSession> {
  // 不再默认那个 everyone 都会去占的固定号码（7991）：占着它的不一定是这次起的服务。
  // 显式传了 catalogPort 仍然尊重（测试与部署会用），没传就向系统要一个临时端口。
  const requested = options.catalogPort ?? Number(process.env.CATALOG_PORT ?? 0);
  const catalogPort = requested > 0 ? requested : await allocatePort();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverEntry = options.serverEntry ?? path.join(here, "..", "..", "server", "src", "main.ts");
  const profileDirs: string[] = [];
  let catalogServer: ChildProcess | undefined;
  let ui: Awaited<ReturnType<typeof startUi>> | undefined;

  /** 失败与正常退出共用同一个回收口：先关连接再删目录，任何一步都不许留下活口。 */
  const teardown = async (): Promise<void> => {
    const child = catalogServer;
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    const bridge = ui;
    if (bridge) {
      bridge.server.closeAllConnections();
      await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
    }
    for (const dir of profileDirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    const dbFile = process.env.DB_FILE ?? "smoke-catalog.db";
    // desktop 会带 --seed 起服务。若 DB_FILE 指向一个已存在的库（真目录工作流的常态），
    // seed 就是往真库里灌演示应用并覆写体积/校验值——库已存在就不再 seed。
    const shouldSeed = (await exists(dbFile)) ? [] : ["--seed"];

    // spawn 失败（ENOENT/EACCES）在本机 Node 上是**异步 'error' 事件**，try/catch 包不住；
    // 没有监听就是 Unhandled 'error' → 宿主进程直接 exit 1。所以先挂监听，再用事件驱动判定。
    catalogServer = spawn(
      process.execPath,
      ["--experimental-transform-types", serverEntry, ...shouldSeed],
      {
        env: {
          ...process.env,
          ...options.envExtras,
          CATALOG_PORT: String(catalogPort),
          DB_FILE: dbFile,
          PACKAGE_ROOT: process.env.PACKAGE_ROOT ?? "smoke-packages",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    catalogServer.stdout?.on("data", (chunk: Buffer) => process.stdout.write("[server] " + chunk));
    catalogServer.stderr?.on("data", (chunk: Buffer) => process.stderr.write("[server] " + chunk));

    let earlyFailure: Error | null = null;
    const child = catalogServer as ChildProcess;
    const watchDeath = new Promise<"failed">((resolve) => {
      child.on("error", (err) => {
        earlyFailure = new Error("catalog server spawn failed: " + err.message);
        resolve("failed");
      });
      child.on("exit", (code) => {
        earlyFailure = new Error("catalog server exited early: " + String(code));
        resolve("failed");
      });
    });
    const outcome = await Promise.race([waitForPort(catalogPort).then((ready) => (ready ? "ready" : "timeout")), watchDeath]);
    if (outcome !== "ready") throw earlyFailure ?? new Error("catalog server did not listen on " + String(catalogPort) + " within 15s");
    // 就绪之后还要问「监听这个端口的是不是我起的那个进程」。查不到持有者就跳过并说明——
    // 跳过是可见的，不能把「查不到」当成「核对通过」。
    const owner = await listenerOwnerPid(catalogPort);
    if (owner === null) console.log("identity check (port owner) unavailable on " + process.platform + " — relying on the parent-allocated ephemeral port");
    else if (owner !== catalogServer.pid) throw new Error("端口 " + String(catalogPort) + " 由 PID " + String(owner) + " 持有，不是本次起的目录服务（PID " + String(catalogServer.pid ?? "?") + "）——拒绝把别人的服务当成就绪");

    ui = await startUi({
      serverUrl: "http://127.0.0.1:" + String(catalogPort),
      userId: process.env.APPCENTER_USER ?? "desktop",
      dataDir: process.env.APPCENTER_DATA ?? path.join(tmpdir(), "appcenter-desktop"),
      appVersion: "1.0.0",
      port: options.uiPort ?? Number(process.env.UI_PORT ?? 0),
    });
    console.log("ui bridge on " + ui.url);

    const workarea = options.workarea ?? (await getWorkarea());
    const geometry = geometryFor(workarea);
    const profileDir = await mkdtemp(path.join(tmpdir(), "appcenter-shell-"));
    profileDirs.push(profileDir);
    const target = ui.url + "/?shell=app#/home";
    const shellPath = options.shellPath ?? (await findShellExecutable(shellCandidates())) ?? "";
    if (!shellPath) {
      console.log("no Edge/Chrome found — open " + target + " manually");
      return { uiUrl: target, catalogPort, shell: null, catalogServer, profileDirs, close: teardown };
    }
    const shell = spawn(shellPath, buildShellArgs(target, geometry, profileDir), { detached: false, stdio: "ignore" });
    // 浏览器启动失败同样只发 'error' 事件；不挂监听就是猝死宿主。
    shell.on("error", (err) => {
      console.log("desktop window failed: " + err.message + " — open " + target + " manually");
    });
    console.log("desktop window: " + shellPath + " " + JSON.stringify(geometry));
    return { uiUrl: target, catalogPort, shell, catalogServer, profileDirs, close: teardown };
  } catch (err) {
    // 到这一步之前起的任何东西都得收掉，否则就是一次失败换一个占着端口的孤儿进程。
    await teardown();
    throw err;
  }
}

/**
 * 常见安装位置的探测顺序；CHROME_PATH/SHELL_PATH 可覆盖。
 * 位置要从环境变量推，不能写死 C: —— 云电脑/换系统盘的机器上程序目录不在 C:，
 * 写死的结果是「找不到浏览器」，界面直接退回「请自己打开 URL」。
 */
export function shellCandidates(env: NodeJS.ProcessEnv = process.env): (string | undefined)[] {
  const pf = env.ProgramFiles ?? "C:\\Program Files";
  const pf86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = env.LOCALAPPDATA;
  return [
    env.SHELL_PATH,
    pf + "\\Google\\Chrome\\Application\\chrome.exe",
    pf86 + "\\Google\\Chrome\\Application\\chrome.exe",
    // 用户级安装的 Chrome 不进 Program Files。
    local ? local + "\\Google\\Chrome\\Application\\chrome.exe" : undefined,
    pf86 + "\\Microsoft\\Edge\\Application\\msedge.exe",
    pf + "\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].replace(/\\/g, "/").endsWith("desktop.ts");
if (invokedDirectly) {
  // 桌面宿主是长驻进程：装护栏只为了「死因要留痕」，不改变崩溃语义。
  installProcessGuardrails({ log: (_level, message) => console.error("[guard] " + message) });
  const session = await runDesktop().catch((err: unknown) => {
    console.error("desktop failed: " + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
  let closing = false;
  const quit = (): void => {
    if (closing || !session) return;
    closing = true;
    void session.close().finally(() => process.exit(0));
  };
  if (session.shell) session.shell.on("exit", quit);
  else quit();
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}
