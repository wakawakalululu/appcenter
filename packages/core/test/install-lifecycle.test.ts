import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ApprovalWorkflow,
  InstallOrchestrator,
  InMemoryRegClient,
  defaultSilent,
  type AppDetail,
  type InstalledApp,
  type InstallJob,
} from "@appcenter/core";

/** 本文件要证的就是「不该有未处理拒绝」，所以先把它们收下来，再断言为空。 */
const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));

const TERMINAL = new Set(["succeeded", "failed", "needs_reboot", "awaiting_approval", "cancelled"]);

const detail: AppDetail = {
  id: "demo",
  name: "演示应用",
  searchKeys: ["demo"],
  publisher: "演示厂商",
  categoryId: "office",
  iconUrl: "/icons/demo.svg",
  latestVersion: "2.0.0",
  downloadCount: 1,
  badge: "normal",
  tags: [],
  requiresApproval: false,
  sizeBytes: 4,
  description: "",
  screenshots: [],
  versions: [
    {
      version: "2.0.0",
      releasedAt: "2026-09-01",
      sizeBytes: 4,
      sha256: createHash("sha256").update("good").digest("hex"),
      downloadUrl: "/dl/demo.exe",
      releaseNotes: "",
      silent: defaultSilent("nsis"),
    },
  ],
};

function installedApp(): InstalledApp {
  return {
    regDir: "DemoApp",
    registryPath: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DemoApp",
    hive: "HKLM",
    scope: "machine",
    displayName: "演示应用",
    displayVersion: "2.0.0",
    publisher: "演示厂商",
    installLocation: "C:\\Program Files\\DemoApp",
    uninstallString: null,
    quietUninstallString: null,
    displayIcon: null,
    isMsi: false,
    estimatedSizeKb: 1,
    installDate: null,
    systemComponent: false,
    needsElevation: false,
  };
}

async function build(options: {
  detailImpl?: (id: string) => Promise<AppDetail | null>;
  installedImpl?: () => Promise<InstalledApp[]>;
  packageDirImpl?: () => Promise<string>;
  exitCode?: number;
}): Promise<{ orch: InstallOrchestrator; dir: string; installedCalls: { n: number } }> {
  const dir = await mkdtemp(path.join(tmpdir(), "lifecycle-"));
  const installedCalls = { n: 0 };
  const orch = new InstallOrchestrator({
    catalog: { detail: options.detailImpl ?? (async (id) => (id === detail.id ? detail : null)) },
    inventory: {
      installed:
        options.installedImpl ??
        (async () => {
          installedCalls.n += 1;
          return [installedApp()];
        }),
    },
    downloader: {
      async download(request: { id: string; target: string }) {
        const body = Buffer.from("good");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(request.target, body);
        return { id: request.id, target: request.target, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), fromCache: false };
      },
    } as never,
    runner: { async run() { return { exitCode: options.exitCode ?? 0, stdout: "", stderr: "", durationMs: 1 }; } } as never,
    approvals: new ApprovalWorkflow("secret"),
    reg: new InMemoryRegClient([]),
    fs: { exists: async () => false, readDir: async () => [], readText: async () => null },
    env: {
      programData: dir,
      appData: dir,
      commonStartMenu: dir,
      userStartMenu: dir,
      temp: dir,
      systemRoot: ["C:", "Windows"].join(String.fromCharCode(92)),
    },
    packageDir: options.packageDirImpl ?? dir,
    userId: "me",
    grantStore: { get: () => undefined, clear: () => undefined },
  });
  return { orch, dir, installedCalls };
}

async function settle(orch: InstallOrchestrator, job: InstallJob): Promise<InstallJob> {
  for (let i = 0; i < 400; i++) {
    const current = orch.get(job.id);
    if (current && TERMINAL.has(current.state)) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job never reached a terminal state: " + String(orch.get(job.id)?.state));
}

test("回归：暂存目录解析失败必须把任务落成终态，而不是留下半截任务并抛出未处理拒绝", async () => {
  // execute() 里 `resolvePackageDir(this.deps.packageDir)` 过去在 try 之外 await：
  // 一旦它拒绝，任务永远停在 queued，而调用侧是 `void this.execute(job)` ⇒ 未处理拒绝 ⇒ 本机 Node 24 直接 exit 1。
  const { orch } = await build({ packageDirImpl: async () => { throw new Error("package dir unavailable"); } });
  const job = await orch.enqueue("demo");
  const done = await settle(orch, job);
  assert.equal(done.state, "failed", "任务必须落终态，不能永远停在 queued");
  assert.match(done.error ?? "", /package dir unavailable/);
  assert.deepEqual(unhandled, [], "不得有未处理拒绝：本机 Node 24 下它等于进程 exit 1");
});

test("回归：装前清单刷新失败同样要落终态", async () => {
  const { orch } = await build({ installedImpl: async () => { throw new Error("inventory boom"); } });
  const job = await orch.enqueue("demo");
  const done = await settle(orch, job);
  assert.equal(done.state, "failed");
  assert.match(done.error ?? "", /inventory boom/);
  assert.deepEqual(unhandled, []);
});

test("回归：安装成功后回读版本失败，不得把任务改判为失败", async () => {
  let calls = 0;
  const { orch } = await build({
    installedImpl: async () => {
      calls += 1;
      if (calls === 1) return [installedApp()]; // 装前的版本下限检查
      throw new Error("readback boom"); // 装完之后的回读
    },
  });
  const job = await orch.enqueue("demo");
  const done = await settle(orch, job);
  assert.equal(done.state, "succeeded", "安装器已经退出 0，回读失败只应让版本号缺失，不该反判失败");
  assert.equal(done.installedVersion, undefined);
  assert.deepEqual(unhandled, []);
});
