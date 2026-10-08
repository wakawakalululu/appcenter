import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApprovalWorkflow,
  InstallOrchestrator,
  type AppDetail,
  type DownloadResult,
  type ExecutionRequest,
  type ExecutionResult,
  type InstalledApp,
  type OrchestratorDeps,
} from "@appcenter/core";

const okResult: ExecutionResult = { exitCode: 0, stdout: "", stderr: "", durationMs: 1, requiresReboot: false };

const NAME = "Universal CRT Redistributable";

/**
 * 真机实测的就是一组同名不同实例：本机 141 个已装应用里 `Universal CRT Redistributable` 有两条
 * （10.0.26624 / 10.1.26100.7705，两个不同的 GUID 卸载项）。dedupeInstalled 的身份含版本与安装路径，
 * 所以它们在清单里是两行，卸载必须能各卸各的。
 */
function instance(regDir: string, version: string): InstalledApp {
  return {
    regDir,
    registryPath: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + regDir,
    hive: "HKLM",
    scope: "machine-64",
    displayName: NAME,
    displayVersion: version,
    publisher: "Microsoft",
    installLocation: null,
    uninstallString: "MsiExec.exe /X" + regDir,
    quietUninstallString: null,
    displayIcon: null,
    isMsi: true,
    estimatedSizeKb: 1024,
    installDate: null,
    systemComponent: false,
    needsElevation: true,
  };
}

const A = "{0460C87B-7F4C-3170-FAC9-B7A6AE5CE4E9}";
const B = "{368E4D03-5983-1C2C-B42E-1C0C51A935A5}";
const VA = "10.0.26624";
const VB = "10.1.26100.7705";

function harness(installed: InstalledApp[], detail?: AppDetail): { orch: InstallOrchestrator; requests: ExecutionRequest[] } {
  const requests: ExecutionRequest[] = [];
  const deps: OrchestratorDeps = {
    catalog: { detail: async (id: string) => (detail && id === detail.id ? detail : null) },
    inventory: { installed: async () => installed },
    downloader: {
      async download(req): Promise<DownloadResult> {
        return { id: req.id, target: req.target, bytes: 4, sha256: "a".repeat(64), fromCache: false };
      },
    },
    runner: {
      async run(req: ExecutionRequest): Promise<ExecutionResult> {
        requests.push(req);
        return okResult;
      },
    },
    approvals: new ApprovalWorkflow("secret"),
    reg: { async readValue() { return null; }, async listKeys() { return []; }, async readKey() { return { name: "", values: [], subkeys: [] }; } } as never,
    fs: { async stat() { return { isDirectory: () => false, isFile: () => true, size: 0, mtimeMs: 0 }; }, async readDir() { return []; }, async readFile() { return ""; } } as never,
    env: { programData: "C:\\ProgramData", appData: "C:\\Users\\me\\AppData\\Roaming", commonStartMenu: "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", userStartMenu: "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs", temp: "C:\\Windows\\Temp", systemRoot: "C:\\Windows" },
    packageDir: "C:\\ProgramData\\appcenter\\packages",
    userId: "me",
    grantStore: { get: () => undefined, clear: () => undefined },
  };
  return { orch: new InstallOrchestrator(deps), requests };
}

/** 桩 reg/fs 让残留扫描这段本就取不到东西，这里只要求任务落终态；卸的是哪条由 job 字段判。 */
const TERMINAL = ["succeeded", "failed", "needs_reboot", "cancelled"];
const terminal = (state: string, where: string): void => {
  assert.ok(TERMINAL.includes(state), "任务必须落终态，实际停在 " + state + "（" + where + "）");
};
const uninstallJobs = (orch: InstallOrchestrator) => orch.list().filter((j) => j.kind === "uninstall");

test("卸载必须打在用户点的那一行：同名不同实例要按 regDir 取目标", async () => {
  const { orch } = harness([instance(A, VA), instance(B, VB)]);
  // 旧实现按 displayName find，只会命中排序靠前的那条 ⇒ 点 b 行卸掉的是 a。
  const job = await orch.uninstall(NAME, B);
  terminal(job.state, "点 b 行");
  assert.equal(job.version, VB, "任务记录的应是 b 那条实例的版本，实际 " + job.version);
  assert.ok(job.id.toLowerCase().includes(B.toLowerCase()), "任务 id 要带上选中的那条 regDir，实际 " + job.id);
});

test("同名不同实例的两个卸载任务不能互相顶掉：任务 id 必须按实例区分", async () => {
  const { orch } = harness([instance(A, VA), instance(B, VB)]);
  const first = await orch.uninstall(NAME, A);
  const second = await orch.uninstall(NAME, B);
  terminal(first.state, "第一条");
  terminal(second.state, "第二条");
  assert.notEqual(first.id, second.id, "两条不同实例共用一个任务 id，后一个会把前一个从任务表里顶掉");
  const jobs = uninstallJobs(orch);
  assert.equal(jobs.length, 2, "任务表里该留下两个卸载任务，实际 " + String(jobs.length) + " 个（" + JSON.stringify(jobs.map((j) => j.id)) + "）");
  assert.deepEqual(
    jobs.map((j) => j.version).sort(),
    [VA, VB].sort(),
    "每个任务要带着自己那一条实例的版本，UI 才不会显示串台",
  );
});

test("只给名字且有歧义时必须显式拒绝，而不是默默挑第一条", async () => {
  const { orch, requests } = harness([instance(A, VA), instance(B, VB)]);
  await assert.rejects(
    () => orch.uninstall(NAME),
    /ambiguous/i,
    "破坏性操作不能靠「排序碰到的第一条」决定卸谁",
  );
  assert.equal(uninstallJobs(orch).length, 0, "拒绝必须发生在建任务、跑卸载器之前");
  assert.equal(requests.length, 0, "拒绝后不该已经跑过卸载器");
});

test("没有同名冲突时按名字卸载照旧可用（别把常见路径一起挡掉）", async () => {
  const { orch } = harness([instance(A, VA)]);
  const job = await orch.uninstall(NAME);
  terminal(job.state, "单实例按名字");
  assert.equal(job.version, VA, "单实例按名字应命中那条唯一实例");
});

test("按 regDir 直接卸载仍要成立（CLI 与既有测试的调用形态，大小写不敏感）", async () => {
  const { orch } = harness([instance(A, VA), instance(B, VB)]);
  const job = await orch.uninstall("{368e4d03-5983-1c2c-b42e-1c0c51a935a5}");
  terminal(job.state, "按 regDir");
  assert.equal(job.version, VB, "只给 regDir 也要精确命中那条，实际 " + job.version);
});

test("目录 id 解析出的名字与安装清单同名时，仍按 regDir 选实例", async () => {
  const detail = { id: "crt", name: NAME } as unknown as AppDetail;
  const { orch } = harness([instance(A, VA), instance(B, VB)], detail);
  const job = await orch.uninstall("crt", A);
  terminal(job.state, "按 id + regDir");
  assert.equal(job.version, VA, "regDir 优先于目录名匹配");
  assert.equal(job.appId, "crt", "任务仍要记回目录 id，回执与审批都按它找");
});
