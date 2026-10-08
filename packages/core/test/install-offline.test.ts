import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import {
  ApprovalWorkflow,
  InstallOrchestrator,
  InMemoryRegClient,
  localFileDownloader,
  defaultSilent,
  type AppDetail,
  type InstalledApp,
  type DownloadPort,
  type DownloadResult,
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

async function build(options: { localHit: boolean }): Promise<{ orch: InstallOrchestrator; dir: string; httpCalls: string[] }> {
  const dir = await mkdtemp(path.join(tmpdir(), "offline-"));
  const httpCalls: string[] = [];
  const localFile = path.join(dir, "mirror", "demo", "2.0.0.exe");
  await mkdir(path.dirname(localFile), { recursive: true });
  await writeFile(localFile, Buffer.from("good"));
  const expectedSha = createHash("sha256").update("good").digest("hex");
  const orch = new InstallOrchestrator({
    catalog: { detail: async (id) => (id === detail.id ? detail : null) },
    inventory: { installed: async () => [installedApp()] },
    downloader: {
      async download(req: { id: string; url: string; target: string }): Promise<DownloadResult> {
        httpCalls.push(req.url);
        const body = Buffer.from("good");
        await writeFile(req.target, body);
        return { id: req.id, target: req.target, bytes: body.length, sha256: expectedSha, fromCache: false };
      },
    } as unknown as DownloadPort,
    runner: { async run() { return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 }; } } as never,
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
    packageDir: dir,
    userId: "me",
    grantStore: { get: () => undefined, clear: () => undefined },
    resolveLocalPackage: async () =>
      options.localHit ? { file: localFile, sha256: expectedSha, size: Buffer.from("good").length } : null,
    fileDownloader: localFileDownloader,
  });
  return { orch, dir, httpCalls };
}

async function settle(orch: InstallOrchestrator, job: InstallJob): Promise<InstallJob> {
  for (let i = 0; i < 400; i++) {
    const current = orch.get(job.id);
    if (current && TERMINAL.has(current.state)) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job never reached a terminal state: " + String(orch.get(job.id)?.state));
}

test("命中本地镜像时跳过网络下载", async () => {
  const { orch, dir, httpCalls } = await build({ localHit: true });
  const job = await orch.enqueue("demo");
  const done = await settle(orch, job);
  assert.equal(done.state, "succeeded");
  assert.equal(httpCalls.length, 0, "命中本地包不应触发任何 HTTP 下载");
  assert.deepEqual(unhandled, [], "不得有未处理拒绝");
  await rm(dir, { recursive: true, force: true });
});

test("未命中本地镜像时回退网络下载", async () => {
  const { orch, dir, httpCalls } = await build({ localHit: false });
  const job = await orch.enqueue("demo");
  const done = await settle(orch, job);
  assert.equal(done.state, "succeeded");
  assert.equal(httpCalls.length, 1, "未命中时应回退到网络下载器");
  assert.deepEqual(unhandled, [], "不得有未处理拒绝");
  await rm(dir, { recursive: true, force: true });
});
