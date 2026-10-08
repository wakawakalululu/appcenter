import { test } from "node:test";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import assert from "node:assert/strict";

import path from "node:path";
import { makeTrackedTmp } from "./util/tmp-dirs.ts";
import {
  ApprovalWorkflow,
  InstallOrchestrator,
  UNINSTALL_ROOTS,
  type AppDetail,
  type DownloadResult,
  type ExecutionRequest,
  type ExecutionResult,
  type InstalledApp,
  type OrchestratorDeps,
} from "@appcenter/core";

const BS = String.fromCharCode(92);
const okResult: ExecutionResult = { exitCode: 0, stdout: "", stderr: "", durationMs: 1, requiresReboot: false };

function detailWith(version: string, name = "逃逸应用"): AppDetail {
  return {
    id: "esc-app",
    name,
    searchKeys: ["esc"],
    publisher: "本机",
    categoryId: "other",
    iconUrl: "",
    latestVersion: version,
    downloadCount: 1,
    badge: "normal",
    tags: [],
    requiresApproval: false,
    sizeBytes: 4,
    description: "",
    screenshots: [],
    installMode: "silent",
    versions: [
      {
        version,
        releasedAt: "2026-01-01",
        sizeBytes: 4,
        sha256: "a".repeat(64),
        downloadUrl: "/dl/pkg.exe",
        releaseNotes: "",
        silent: { kind: "nsis", installArgs: ["/S", "{file}"], uninstallArgs: ["/S"], requiresAdmin: false },
      },
    ],
  };
}

function harness(options: { packageDir: string; version?: string; name?: string; installed?: InstalledApp[] }): { orch: InstallOrchestrator; targets: string[] } {
  const targets: string[] = [];
  const detail: AppDetail = detailWith(options.version ?? "1.0.0", options.name);
  const deps: OrchestratorDeps = {
    catalog: { detail: async (id: string) => (id === detail.id ? detail : null) },
    inventory: { installed: async () => options.installed ?? [] },
    downloader: {
      async download(req): Promise<DownloadResult> {
        targets.push(req.target);
        return { id: req.id, target: req.target, bytes: 4, sha256: "a".repeat(64), fromCache: false };
      },
    },
    runner: { async run(_req: ExecutionRequest): Promise<ExecutionResult> { return okResult; } },
    approvals: new ApprovalWorkflow("secret"),
    reg: { async readValue() { return null; }, async listKeys() { return []; }, async readKey() { return { name: "", values: [], subkeys: [] }; } } as never,
    fs: { async stat() { return { isDirectory: () => false, isFile: () => true, size: 0, mtimeMs: 0 }; }, async readDir() { return []; }, async readFile() { return ""; } } as never,
    env: { programData: "C:\\ProgramData", appData: "C:\\Users\\me\\AppData\\Roaming", commonStartMenu: "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", userStartMenu: "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs", temp: "C:\\Windows\\Temp", systemRoot: "C:\\Windows" },
    packageDir: options.packageDir,
    userId: "me",
    grantStore: { get: () => undefined, clear: () => undefined },
  };
  return { orch: new InstallOrchestrator(deps), targets };
}

/** drain 是 fire-and-forget，只能轮询到终态；超时就把当前状态报出来，不静默通过。 */
async function settle(orch: InstallOrchestrator, id: string, timeoutMs = 4000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = orch.get(id)?.state ?? "missing";
    if (state === "succeeded" || state === "failed" || state === "needs_reboot" || state === "awaiting_approval" || state === "cancelled") return state;
    if (Date.now() > deadline) return "timeout:" + state;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

test("应用名是目录给的字符串，含正斜杠时不得让安装包落到 packageDir 之外", async () => {
  const packageDir = await makeTrackedTmp("inst-pkg-");
  // safeName 的字符类替换了 `\` 却没替换 `/`，所以 `"x/../../escapee"` 会原样进文件名，
  // path.join 归一后真的跑出 packageDir（实测落到 %TEMP% 根）。
  const { orch, targets } = harness({ packageDir, name: "x/../../escapee" });
  const job = await orch.enqueue("esc-app");
  const state = await settle(orch, job.id);

  assert.ok(targets.length > 0, "下载器没被调用，断言无意义");
  const base = path.resolve(packageDir);
  for (const target of targets) {
    const abs = path.resolve(target);
    assert.ok(abs.startsWith(base + path.sep), "安装包目标逃出 packageDir：" + abs + "（状态 " + state + "）");
  }
});

test("卸载中途任何一步抛错：任务必须落终态，而不是留在非终态并把异常抛给调用方", async () => {
  // 现场：注册表项字段不全（真机常见，DisplayIcon/InstallLocation 缺失），
  // scanResidue 在 normPath 上抛 TypeError —— 实测旧实现把任务留在 "verifying"
  // 非终态，并把异常直接抛给 await uninstall() 的调用侧（UI 侧是 void 就是宿主猝死）。
  const same = "Universal CRT Redistributable";
  const installed: InstalledApp[] = [
    { displayName: same, displayVersion: "1.0.0", publisher: "Microsoft", regDir: (UNINSTALL_ROOTS[0]?.path ?? "") + "\\{guid-a}", uninstallString: "msiexec /x {guid-a} /qn", quietUninstallString: null, installLocation: "" } as unknown as InstalledApp,
  ];
  const { orch } = harness({ packageDir: await makeTrackedTmp("inst-pkg2-"), installed });
  const job = await orch.uninstall(installed[0]!.regDir);
  assert.ok(
    ["succeeded", "failed", "needs_reboot", "cancelled"].includes(job.state),
    "uninstall 必须落终态，实际停在 " + job.state + "（error=" + String(job.error) + "）",
  );
});
