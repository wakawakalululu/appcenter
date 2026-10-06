import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface TrayHostOptions {
  rpcUrl: string;
  uiUrl: string;
  /** 无交互自检时长，真实使用时给 0 表示常驻。 */
  seconds?: number;
  statusColor?: string;
  logFile?: string;
}

export interface TrayHostResult {
  code: number;
  log: string;
  stderr: string;
}

function scriptPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "host", "tray-host.ps1");
}

/**
 * 启动系统托盘与窗口宿主（Windows 自带 WinForms，不引入 Electron/Tauri）。
 * 宿主只负责图标、菜单与窗口，业务状态全部来自引擎的 ui.tray / ui.trayAction。
 */
export function runTrayHost(options: TrayHostOptions): Promise<TrayHostResult> {
  const logFile = options.logFile ?? path.join(path.dirname(scriptPath()), "tray-host.log");
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath(),
    "-RpcUrl",
    options.rpcUrl,
    "-UiUrl",
    options.uiUrl,
    "-Seconds",
    String(options.seconds ?? 0),
    "-LogFile",
    logFile,
  ];
  if (options.statusColor) args.push("-StatusColor", options.statusColor);

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", args, { windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      void readFile(logFile, "utf8")
        .then((log) => resolve({ code: code ?? -1, log, stderr }))
        .catch(() => resolve({ code: code ?? -1, log: "", stderr }));
    });
  });
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith("tray.ts");
if (invokedDirectly) {
  const uiPort = Number(process.env.UI_PORT ?? 8090);
  const result = await runTrayHost({
    rpcUrl: "http://127.0.0.1:" + String(uiPort) + "/rpc",
    uiUrl: "http://127.0.0.1:" + String(uiPort) + "/",
    seconds: Number(process.env.TRAY_SECONDS ?? 6),
    statusColor: process.env.TRAY_COLOR ?? "#2F6BFF",
  });
  console.log("tray host exit code " + String(result.code));
  console.log(result.log);
  if (result.stderr.trim()) console.log("stderr: " + result.stderr.trim().slice(0, 400));
}
