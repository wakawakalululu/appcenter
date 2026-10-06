import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
}

export interface DesktopSession {
  uiUrl: string;
  shell: ChildProcess | null;
  catalogServer: ChildProcess;
}

/** 起目录服务 + 引擎 + 桥，再开独立桌面窗口；窗口关闭即整场退出（托盘常驻走 tray.ts）。 */
export async function runDesktop(options: DesktopOptions = {}): Promise<DesktopSession> {
  const catalogPort = options.catalogPort ?? Number(process.env.CATALOG_PORT ?? 7991);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverMain = path.join(here, "..", "..", "server", "src", "main.ts");

  const catalogServer = spawn(
    process.execPath,
    ["--experimental-transform-types", serverMain, "--seed"],
    {
      env: {
        ...process.env,
        CATALOG_PORT: String(catalogPort),
        DB_FILE: process.env.DB_FILE ?? "smoke-catalog.db",
        PACKAGE_ROOT: process.env.PACKAGE_ROOT ?? "smoke-packages",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  catalogServer.stderr?.on("data", (chunk: Buffer) => process.stderr.write("[server] " + chunk));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("catalog server did not listen in 15s")), 15000);
    catalogServer.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write("[server] " + chunk);
      if (String(chunk).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    catalogServer.on("exit", (code) => reject(new Error("catalog server exited early: " + String(code))));
  });

  const ui = await startUi({
    serverUrl: "http://127.0.0.1:" + String(catalogPort),
    userId: process.env.APPCENTER_USER ?? "desktop",
    dataDir: process.env.APPCENTER_DATA ?? path.join(tmpdir(), "appcenter-desktop"),
    appVersion: "1.0.0",
    port: options.uiPort ?? Number(process.env.UI_PORT ?? 0),
  });
  console.log("ui bridge on " + ui.url);

  const workarea = await getWorkarea();
  const geometry = geometryFor(workarea);
  const profileDir = await mkdtemp(path.join(tmpdir(), "appcenter-shell-"));
  const target = ui.url + "/?shell=app#/home";
  const shellPath = options.shellPath ?? (await findShellExecutable(shellCandidates())) ?? "";
  if (!shellPath) {
    console.log("no Edge/Chrome found — open " + target + " manually");
    return { uiUrl: target, shell: null, catalogServer };
  }
  const shell = spawn(shellPath, buildShellArgs(target, geometry, profileDir), { detached: false, stdio: "ignore" });
  console.log("desktop window: " + shellPath + " " + JSON.stringify(geometry));
  return { uiUrl: target, shell, catalogServer };
}

/** 常见安装位置的探测顺序；CHROME_PATH/SHELL_PATH 可覆盖。 */
export function shellCandidates(): (string | undefined)[] {
  return [
    process.env.SHELL_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].replace(/\\/g, "/").endsWith("desktop.ts");
if (invokedDirectly) {
  const session = await runDesktop();
  const quit = (): void => {
    session.catalogServer.kill();
    process.exit(0);
  };
  if (session.shell) session.shell.on("exit", quit);
  else quit();
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}
