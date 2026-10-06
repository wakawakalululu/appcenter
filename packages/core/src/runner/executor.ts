import { spawn } from "node:child_process";
import type { InstallerKind, SilentSpec } from "../catalog/types.ts";

export interface ExecutionRequest {
  program: string;
  args: string[];
  cwd?: string;
  requiresAdmin: boolean;
  timeoutMs?: number;
  logPath?: string;
  env?: Record<string, string>;
}

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  requiresReboot: boolean;
}

export interface ProcessRunner {
  run(request: ExecutionRequest): Promise<ExecutionResult>;
}

/** msiexec 与常见安装框架的退出码语义。 */
export const EXIT_CODE_MEANING: Record<number, string> = {
  0: "success",
  1601: "msi service unavailable",
  1602: "user cancelled",
  1603: "fatal error during installation",
  1618: "another installation already in progress",
  1619: "installation package could not be opened",
  1641: "restart required",
  3010: "restart required",
};

const REBOOT_CODES = [3010, 1641];

export function classifyExit(code: number, extraSuccess: readonly number[] = []): { ok: boolean; requiresReboot: boolean; meaning: string } {
  const meaning = EXIT_CODE_MEANING[code] ?? (extraSuccess.includes(code) ? "declared as success by package spec" : code === 0 ? "success" : "unspecified failure");
  if (code === 0) return { ok: true, requiresReboot: false, meaning };
  if (REBOOT_CODES.includes(code)) return { ok: true, requiresReboot: true, meaning };
  if (extraSuccess.includes(code)) return { ok: true, requiresReboot: false, meaning };
  return { ok: false, requiresReboot: false, meaning };
}

export type InstallPhase = "install" | "upgrade" | "uninstall";

/** 各安装框架的静默参数约定。 */
export function defaultSilent(kind: InstallerKind): SilentSpec {
  switch (kind) {
    case "msi":
      return { kind, installArgs: ["/i", "{file}", "/qn", "/norestart"], uninstallArgs: ["/x", "{file}", "/qn", "/norestart"], requiresAdmin: true };
    case "msix":
      return { kind, installArgs: ["Add-AppxPackage", "-PackagePath", "{file}", "-ForceUpdateShutdownAppsOnClose"], uninstallArgs: ["Remove-AppxPackage", "-Package", "{name}"], requiresAdmin: false };
    case "nsis":
      return { kind, installArgs: ["/S", "/D={target}"], uninstallArgs: ["/S"], upgradeArgs: ["/S", "/D={target}"], extraSuccessExitCodes: REBOOT_CODES };
    case "inno":
      return { kind, installArgs: ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/DIR={target}"], uninstallArgs: ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], extraSuccessExitCodes: REBOOT_CODES };
    case "archive":
      return { kind, installArgs: ["x", "{file}", "-o{target}", "-y"], uninstallArgs: [], targetDirectory: "{target}", requiresAdmin: false };
    case "script":
      return { kind, installArgs: [], uninstallArgs: [], requiresAdmin: false };
  }
}

export interface PlanInput {
  silent: SilentSpec;
  packagePath: string;
  targetDirectory: string;
  phase: InstallPhase;
  appDisplayName?: string;
  /** 手动安装：去掉静默开关，让安装向导露出来给用户点完。 */
  interactive?: boolean;
  /** archive 解压工具路径；不注入时回退到 PATH 上的 7z.exe。 */
  sevenZipPath?: () => string;
}

export interface ExecutionPlan extends ExecutionRequest {
  phase: InstallPhase;
}

function expand(token: string, input: PlanInput): string {
  return token
    .replaceAll("{file}", input.packagePath)
    .replaceAll("{target}", input.targetDirectory)
    .replaceAll("{name}", input.appDisplayName ?? "");
}

function programFor(spec: SilentSpec, input: PlanInput): string {
  switch (spec.kind) {
    case "msi":
      return "msiexec.exe";
    case "msix":
      return "powershell.exe";
    case "archive":
      return input.sevenZipPath?.() || "7z.exe";
    case "script":
      return input.packagePath;
    case "nsis":
    case "inno":
      return input.packagePath;
  }
}

/**
 * 脚本类安装包需要解释器前缀：.ps1 走 PowerShell，.bat/.cmd 走 cmd。
 * 其余扩展名（或裸可执行文件）直接作为程序运行，避免「不是可执行程序」错误。
 */
function scriptInterpreter(packagePath: string): { program: string; prefix: string[] } {
  const lower = packagePath.toLowerCase();
  if (lower.endsWith(".ps1")) return { program: "powershell.exe", prefix: ["-NoProfile", "-NonInteractive", "-File"] };
  if (lower.endsWith(".bat") || lower.endsWith(".cmd")) return { program: "cmd.exe", prefix: ["/c"] };
  return { program: packagePath, prefix: [] };
}

/**
 * 把目录里声明的静默参数展开成一次可执行的调用计划。
 * NSIS 的 /D= 必须位于最后一个参数且不能加引号，这里按框架约定重排。
 */
export function buildPlan(input: PlanInput): ExecutionPlan {
  const spec = input.silent;
  let template = input.phase === "upgrade" ? (spec.upgradeArgs ?? spec.installArgs) : input.phase === "uninstall" ? spec.uninstallArgs : spec.installArgs;
  if (input.interactive && input.phase !== "uninstall") template = interactiveArgs(spec.kind, template);
  const args = template.map((token) => expand(token, input));

  if (spec.kind === "nsis") {
    const index = args.findIndex((a) => a.startsWith("/D="));
    if (index >= 0 && index !== args.length - 1) {
      const [dirArg] = args.splice(index, 1);
      if (dirArg) args.push(dirArg);
    }
  }
  if (spec.kind === "msi") {
    args.push("/l*v", input.packagePath + "." + input.phase + ".log");
  }

  const plan: ExecutionPlan = {
    program: programFor(spec, input),
    args,
    requiresAdmin: spec.requiresAdmin ?? false,
    phase: input.phase,
  };
  if (spec.kind === "archive" || spec.kind === "script") plan.cwd = input.targetDirectory;
  if (spec.kind === "msi") plan.logPath = input.packagePath + "." + input.phase + ".log";
  if (spec.kind === "script") {
    const interp = scriptInterpreter(input.packagePath);
    plan.program = interp.program;
    plan.args = [...interp.prefix, input.packagePath, ...args];
  }
  return plan;
}

/**
 * 交互安装的参数裁剪：MSI 只留 /i 与包路径；NSIS/Inno 直接运行安装包弹向导。
 * msix、archive、script 本来就没有静默/交互之分，原样保留。
 */
function interactiveArgs(kind: InstallerKind, template: readonly string[]): string[] {
  if (kind === "msi") {
    const index = template.indexOf("/i");
    return index >= 0 ? template.slice(0, index + 2) : ["/i"];
  }
  if (kind === "nsis" || kind === "inno") return [];
  return [...template];
}

/** 卸载串通常长这样：解析出可执行文件与参数，避免走 shell 拼接。 */
export function parseUninstallCommand(raw: string, quiet: boolean): ExecutionRequest {
  const stripped = raw.replace(/"/g, "").trim();
  const segments = stripped.split(/\s+/).filter(Boolean);
  const head = segments[0] ?? "";
  const isMsi = /msiexec/i.test(head);
  if (isMsi) {
    const product = (segments[segments.length - 1] ?? "").replace(/^\/[XY]/i, "");
    return { program: "msiexec.exe", args: ["/x", product, "/qn", "/norestart"], requiresAdmin: true };
  }
  const args = segments.slice(1);
  if (quiet && !args.some((a) => /^\/[sq]$/i.test(a))) args.push("/S");
  return { program: head, args, requiresAdmin: true };
}

export class ChildProcessRunner implements ProcessRunner {
  private readonly elevate: (request: ExecutionRequest) => Promise<ExecutionResult>;

  constructor(elevate?: (request: ExecutionRequest) => Promise<ExecutionResult>) {
    this.elevate = elevate ?? elevateViaPowerShell;
  }

  run(request: ExecutionRequest): Promise<ExecutionResult> {
    if (request.requiresAdmin) return this.elevate(request);
    return spawnCaptured(request.program, request.args, request.cwd, request.timeoutMs, request.env);
  }
}

function spawnCaptured(
  program: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number | undefined,
  env: Record<string, string> | undefined,
): Promise<ExecutionResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, windowsHide: true, shell: false, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timer = timeoutMs ? setTimeout(() => child.kill("SIGTERM"), timeoutMs) : null;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const exitCode = code ?? -1;
      resolve({ exitCode, stdout, stderr, durationMs: Date.now() - started, requiresReboot: REBOOT_CODES.includes(exitCode) });
    });
  });
}

/**
 * 提权执行：把请求编码为 base64 后交给 PowerShell 组装 ProcessStartInfo，
 * 参数不经过 shell 解析，避免命令注入。
 */
export async function elevateViaPowerShell(request: ExecutionRequest): Promise<ExecutionResult> {
  const started = Date.now();
  const payload = { program: request.program, args: request.args, cwd: request.cwd ?? process.cwd() };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const script =
    "$j=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "'));$p=$j|ConvertFrom-Json;" +
    "$psi=New-Object Diagnostics.ProcessStartInfo($p.program,$p.args);" +
    "$psi.WorkingDirectory=$p.cwd;$psi.UseShellExecute=$false;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;" +
    "$proc=[Diagnostics.Process]::Start($psi);$out=$proc.StandardOutput.ReadToEnd();$err=$proc.StandardError.ReadToEnd();$proc.WaitForExit();" +
    "Write-Output ('EXIT={0} OUT={1} ERR={2}' -f $proc.ExitCode,$out,$err)";
  const result = await spawnCaptured("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], undefined, request.timeoutMs, request.env);
  const declared = /EXIT=(-?\d+)/.exec(result.stdout)?.[1];
  const exitCode = declared !== undefined ? Number(declared) : result.exitCode;
  return { ...result, exitCode, requiresReboot: REBOOT_CODES.includes(exitCode) };
}
