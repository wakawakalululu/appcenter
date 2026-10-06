import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ApprovalWorkflow,
  AppCenterFacade,
  Downloader,
  InMemoryRegClient,
  InstallOrchestrator,
  SelfUpdater,
  SkinRegistry,
  UNINSTALL_ROOTS,
  WindowManager,
  buildPlan,
  classifyExit,
  defaultSilent,
  extensionOf,
  parseUninstallCommand,
  regKey,
  safeName,
  trayStatusFor,
  buildTrayMenu,
  type AppDetail,
  type DownloadResult,
  type ExecutionRequest,
  type ExecutionResult,
  type InstalledApp,
  type InstallerKind,
  type WindowHost,
} from "@appcenter/core";

test("approval needs a real reason and then issues a verifiable grant", () => {
  const wf = new ApprovalWorkflow("secret");
  assert.throws(() => wf.submit({ appId: "vpn", appVersion: "5.0.0", applicant: "me", reason: "x" }));
  const request = wf.submit({ appId: "vpn", appVersion: "5.0.0", applicant: "me", reason: "需要远程接入" });
  assert.equal(request.status, "pending");
  assert.throws(() => wf.issueGrant(request.id), /pending/);
  wf.decide(request.id, "approved", "admin");
  const grant = wf.issueGrant(request.id);
  const context = { appId: "vpn", userId: "me", appVersion: "5.0.0" };
  assert.equal(wf.verifyGrant(grant, context).ok, true);
  assert.equal(wf.verifyGrant({ ...grant, signature: "00".repeat(32) }, context).reason, "signature-invalid");
  assert.equal(wf.verifyGrant(grant, { ...context, userId: "other" }).reason, "user-mismatch");
  assert.equal(wf.verifyGrant(grant, context, new Date(Date.now() + 8 * 86400_000)).reason, "expired");
});

test("revoking a request blocks installs that used to be allowed", () => {
  const wf = new ApprovalWorkflow("secret");
  const request = wf.submit({ appId: "vpn", appVersion: "1.0.0", applicant: "me", reason: "工作所需" });
  wf.decide(request.id, "approved", "admin");
  const grant = wf.issueGrant(request.id);
  wf.revoke(request.id);
  assert.equal(wf.verifyGrant(grant, { appId: "vpn", userId: "me", appVersion: "1.0.0" }).reason, "revoked");
});

test("install plans follow each framework's silent convention", () => {
  const pkg = "C:\\downloads\\app.msi";
  const msi = buildPlan({ silent: defaultSilent("msi"), packagePath: pkg, targetDirectory: "C:\\target", phase: "install" });
  assert.equal(msi.program, "msiexec.exe");
  assert.deepEqual(msi.args.slice(0, 4), ["/i", pkg, "/qn", "/norestart"]);
  assert.equal(msi.requiresAdmin, true);
  assert.ok(msi.logPath?.endsWith(".install.log"));

  const nsis = buildPlan({ silent: defaultSilent("nsis"), packagePath: "C:\\setup.exe", targetDirectory: "C:\\Program Files\\Demo", phase: "install" });
  assert.equal(nsis.args.at(-1), "/D=C:\\Program Files\\Demo");

  const inno = buildPlan({ silent: defaultSilent("inno"), packagePath: "C:\\setup.exe", targetDirectory: "C:\\t", phase: "upgrade" });
  assert.ok(inno.args.includes("/DIR=C:\\t"));

  const msiUninstall = parseUninstallCommand("MsiExec.exe /X{GUID-1}", true);
  assert.deepEqual(msiUninstall.args, ["/x", "{GUID-1}", "/qn", "/norestart"]);
  const exeUninstall = parseUninstallCommand('"C:\\uninst.exe" /Current_user_only', true);
  assert.deepEqual(exeUninstall.args, ["/Current_user_only", "/S"]);
});

test("interactive plans drop silent switches but keep the installer entry", () => {
  const pkg = "C:\\downloads\\app.msi";
  const msi = buildPlan({ silent: defaultSilent("msi"), packagePath: pkg, targetDirectory: "C:\\t", phase: "install", interactive: true });
  assert.deepEqual(msi.args.slice(0, 2), ["/i", pkg], "交互 MSI 只留 /i 与包路径");
  assert.ok(!msi.args.includes("/qn"), "交互安装不再静默");
  assert.ok(msi.logPath?.endsWith(".install.log"), "交互安装仍要留安装日志");

  const nsis = buildPlan({ silent: defaultSilent("nsis"), packagePath: "C:\\setup.exe", targetDirectory: "C:\\t", phase: "install", interactive: true });
  assert.deepEqual(nsis.args, []);

  const inno = buildPlan({ silent: defaultSilent("inno"), packagePath: "C:\\setup.exe", targetDirectory: "C:\\t", phase: "upgrade", interactive: true });
  assert.deepEqual(inno.args, []);

  // 卸载不受 interactive 影响：静默卸载语义保持不变。
  const msiUninstall = buildPlan({ silent: defaultSilent("msi"), packagePath: pkg, targetDirectory: "C:\\t", phase: "uninstall", interactive: true });
  assert.deepEqual(msiUninstall.args.slice(0, 4), ["/x", pkg, "/qn", "/norestart"]);
});

test("msix plans use the Add-AppxPackage cmdlet and archive resolves 7z via injection", () => {
  const msix = buildPlan({ silent: defaultSilent("msix"), packagePath: "C:\\app.msix", targetDirectory: "C:\\t", phase: "install" });
  assert.equal(msix.program, "powershell.exe");
  assert.equal(msix.args[0], "Add-AppxPackage", "msix 必须用合法 cmdlet，原 Add 是无效命令");
  assert.equal(msix.args[1], "-PackagePath");
  const msixUninstall = buildPlan({ silent: defaultSilent("msix"), packagePath: "C:\\app.msix", targetDirectory: "C:\\t", phase: "uninstall" });
  assert.equal(msixUninstall.args[0], "Remove-AppxPackage");

  const archive = buildPlan({ silent: defaultSilent("archive"), packagePath: "C:\\app.7z", targetDirectory: "C:\\t", phase: "install" });
  assert.equal(archive.program, "7z.exe", "默认按 PATH 查找 7z");
  const archiveCustom = buildPlan({ silent: defaultSilent("archive"), packagePath: "C:\\app.7z", targetDirectory: "C:\\t", phase: "install", sevenZipPath: () => "C:\\tools\\7z.exe" });
  assert.equal(archiveCustom.program, "C:\\tools\\7z.exe", "可注入 7z 路径，不再只认 PATH");
});

test("script plans prepend the right interpreter for the file type", () => {
  const ps = buildPlan({ silent: defaultSilent("script"), packagePath: "C:\\setup.ps1", targetDirectory: "C:\\t", phase: "install" });
  assert.equal(ps.program, "powershell.exe");
  assert.deepEqual(ps.args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-File", "C:\\setup.ps1"]);

  const bat = buildPlan({ silent: defaultSilent("script"), packagePath: "C:\\setup.bat", targetDirectory: "C:\\t", phase: "install" });
  assert.equal(bat.program, "cmd.exe");
  assert.deepEqual(bat.args.slice(0, 2), ["/c", "C:\\setup.bat"]);

  const plain = buildPlan({ silent: defaultSilent("script"), packagePath: "C:\\setup.exe", targetDirectory: "C:\\t", phase: "install" });
  assert.equal(plain.program, "C:\\setup.exe", "非脚本扩展名直接当程序跑");
});

test("installer matrix: nsis / inno / archive / script each run their engine and report success", async () => {
  const cases = [
    { kind: "nsis" as const, url: "http://h/demo.exe" },
    { kind: "inno" as const, url: "http://h/demo.exe" },
    { kind: "archive" as const, url: "http://h/demo.7z" },
    { kind: "script" as const, url: "http://h/demo.exe" },
  ];
  for (const c of cases) {
    const { orch, runner } = await orchestratorWith({ detail: detailForKind(c.kind, c.url) });
    const job = await orch.enqueue("demo");
    await settle(orch);
    assert.equal(orch.get(job.id)?.state, "succeeded", c.kind + " 应成功");
    assert.equal(orch.get(job.id)?.installedVersion, "1.0.0", c.kind + " 应回读版本号");
    assert.equal(runner.calls.length, 1);
    if (c.kind === "archive") {
      assert.equal(runner.calls[0]?.program, "7z.exe", c.kind + " 引擎");
    } else {
      const expectedPkg = safeName("示例应用") + "-2.0.0" + extensionOf(c.url);
      assert.ok((runner.calls[0]?.program ?? "").endsWith(expectedPkg), c.kind + " 引擎 program=" + runner.calls[0]?.program);
    }
  }
});

test("catalog-declared manual install mode is honoured without an explicit option", async () => {
  const detail = detailForKind("msi", "http://h/demo.msi", { installMode: "manual" });
  const { orch, runner } = await orchestratorWith({ detail });
  const job = await orch.enqueue("demo");
  await settle(orch);
  assert.equal(job.mode, "manual", "目录声明 manual 应被编排器默认采纳");
  assert.deepEqual(runner.calls[0]?.args.slice(0, 2), ["/i", runner.calls[0]?.args[1]], "手动 MSI 只留 /i 与包路径");
  assert.ok(!runner.calls[0]?.args.includes("/qn"), "手动安装不应静默");
  assert.equal(orch.get(job.id)?.state, "succeeded");
});

test("a failed install removes the downloaded package only when cleanup is enabled", async () => {
  const cleanup = await orchestratorWith({ exitCode: 1603, installerCleanup: true });
  const job = await cleanup.orch.enqueue("demo");
  await settle(cleanup.orch);
  assert.equal(cleanup.orch.get(job.id)?.state, "failed");
  const pkg = path.join(cleanup.dir, safeName("示例应用") + "-2.0.0" + extensionOf("http://h/demo.msi"));
  await assert.rejects(() => stat(pkg), /ENOENT/);

  const keep = await orchestratorWith({ exitCode: 1603, installerCleanup: false });
  const job2 = await keep.orch.enqueue("demo");
  await settle(keep.orch);
  assert.equal(keep.orch.get(job2.id)?.state, "failed");
  await stat(path.join(keep.dir, safeName("示例应用") + "-2.0.0" + extensionOf("http://h/demo.msi")));
});

test("exit codes map onto reboot, failure and declared successes", () => {
  assert.deepEqual(classifyExit(0), { ok: true, requiresReboot: false, meaning: "success" });
  assert.equal(classifyExit(3010).requiresReboot, true);
  assert.equal(classifyExit(1603).ok, false);
  assert.equal(classifyExit(5, [5]).ok, true);
});

test("skins resolve through token fallbacks and stay valid", () => {
  const skins = new SkinRegistry();
  assert.deepEqual(skins.ids().sort(), ["cny", "dark", "default", "fresh"]);
  const dark = skins.setActive("dark");
  assert.equal(dark.tokens.color.textPrimary, "#F2F3F5");
  assert.equal(dark.tokens.color.success, "#1BA572");
  assert.ok(dark.fallbacks.includes("color.success"));
  assert.deepEqual(skins.resolve("default").errors, []);
  assert.equal(skins.applyFestival("cny", { from: "2026-01-01", to: "2026-01-03" }, new Date("2026-06-01")), null);
  assert.ok(skins.applyFestival("cny", { from: "2026-01-01", to: "2026-12-31" }, new Date("2026-06-01")));
  assert.throws(() => skins.setActive("nope"));
});

test("tray state and menu follow jobs and approval counts", () => {
  const job = (state: string) => ({ id: "j", appId: "a", appName: "a", version: "1", state: state as never, phase: "install" as const, history: [] });
  assert.equal(trayStatusFor({ jobs: [job("installing")], upgradeCount: 0, pendingApprovals: 0 }), "downloading");
  assert.equal(trayStatusFor({ jobs: [job("needs_reboot")], upgradeCount: 3, pendingApprovals: 0 }), "needs-reboot");
  assert.equal(trayStatusFor({ jobs: [], upgradeCount: 2, pendingApprovals: 0 }), "update-available");
  assert.equal(trayStatusFor({ jobs: [], upgradeCount: 0, pendingApprovals: 1 }), "awaiting-approval");
  assert.equal(trayStatusFor({ jobs: [], upgradeCount: 0, pendingApprovals: 0 }), "idle");
  const menu = buildTrayMenu({ jobs: [job("queued")], upgradeCount: 2, pendingApprovals: 0 });
  assert.ok(menu.some((m) => m.id === "pause"));
  assert.ok(menu.some((m) => m.action === "upgrade.all"));
  assert.ok(!menu.some((m) => m.id === "approvals"));
});

class FakeHost implements WindowHost {
  readonly log: string[] = [];
  async create(): Promise<string> {
    this.log.push("create");
    return "w" + String(this.log.length);
  }
  async show(id: string): Promise<void> {
    this.log.push("show " + id);
  }
  async hide(id: string): Promise<void> {
    this.log.push("hide " + id);
  }
  async close(id: string): Promise<void> {
    this.log.push("close " + id);
  }
  async focus(id: string): Promise<void> {
    this.log.push("focus " + id);
  }
}

test("single-instance roles reuse the window while detail windows stack", async () => {
  const host = new FakeHost();
  const wm = new WindowManager(host);
  const main = await wm.open("main");
  const again = await wm.open("main", { route: "/settings" });
  assert.equal(main.id, again.id);
  assert.equal(again.route, "/settings");
  assert.equal(host.log.filter((l) => l === "create").length, 1);
  await wm.open("detail", { route: "/app/wps", allowMultiple: true });
  await wm.open("detail", { route: "/app/code", allowMultiple: true });
  assert.equal(wm.list().length, 3);
  assert.equal((await wm.requestClose(main.id)).minimizedToTray, true);
  assert.equal(wm.get(main.id)?.visible, false);
  const detail = wm.list().find((w) => w.role === "detail");
  assert.equal((await wm.requestClose(detail?.id ?? "")).minimizedToTray, false);
});

test("downloader resumes with Range and only lands verified bytes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dl-"));
  const payload = Buffer.from("0123456789abcdefghijklmnop");
  const sha = createHash("sha256").update(payload).digest("hex");
  const target = path.join(dir, "pkg.bin");
  let served = 0;
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    served += 1;
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    if (range) {
      const from = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
      return new Response(payload.subarray(from), {
        status: 206,
        headers: {
          "content-range": "bytes " + String(from) + "-" + String(payload.length - 1) + "/" + String(payload.length),
          "content-length": String(payload.length - from),
        },
      });
    }
    return new Response(payload.subarray(0, 10), { status: 200, headers: { "content-length": "10" } });
  }) as typeof fetch;

  const truncated = new Downloader({ fetchImpl, attempts: 1 });
  await assert.rejects(
    () => truncated.download({ id: "x", url: "http://h/pkg", target, expectedSize: payload.length }),
    /size-mismatch/,
  );
  assert.equal(await readFile(target + ".part", "utf8"), "0123456789");

  const resumable = new Downloader({ fetchImpl, attempts: 2 });
  const result: DownloadResult = await resumable.download({
    id: "x",
    url: "http://h/pkg",
    target,
    expectedSize: payload.length,
    expectedSha256: sha,
  });
  assert.equal(result.bytes, payload.length);
  assert.equal(result.sha256, sha);
  assert.equal(served, 2);
  assert.deepEqual(await readFile(target), payload);
  await assert.rejects(() => stat(target + ".part"), /ENOENT/);
});

test("downloader refuses a package whose checksum does not match the catalog", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dl-"));
  const payload = Buffer.from("good bytes");
  const fetchImpl = (async () =>
    new Response(payload, { status: 200, headers: { "content-length": String(payload.length) } })) as typeof fetch;
  const dl = new Downloader({ fetchImpl, attempts: 1 });
  await assert.rejects(
    () => dl.download({ id: "y", url: "http://h/p", target: path.join(dir, "p.bin"), expectedSha256: "00".repeat(32) }),
    /checksum-mismatch/,
  );
});

const appDetail = (over: Partial<AppDetail> = {}): AppDetail => ({
  id: "demo",
  name: "示例应用",
  searchKeys: ["demo"],
  publisher: "示例厂商",
  categoryId: "dev",
  iconUrl: "",
  latestVersion: "2.0.0",
  downloadCount: 10,
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
      downloadUrl: "http://h/demo.msi",
      releaseNotes: "",
      silent: defaultSilent("msi"),
    },
  ],
  ...over,
});

function fakeRunner(exitCode = 0): { run(req: ExecutionRequest): Promise<ExecutionResult>; calls: ExecutionRequest[] } {
  const calls: ExecutionRequest[] = [];
  return {
    calls,
    async run(req: ExecutionRequest): Promise<ExecutionResult> {
      calls.push(req);
      return { exitCode, stdout: "", stderr: "", durationMs: 1, requiresReboot: exitCode === 3010 };
    },
  };
}

const fakeDownloadPort = (payload: string): { download: (r: unknown) => Promise<DownloadResult>; dir: Promise<string> } => {
  let dirPromise: Promise<string> | null = null;
  return {
    dir: (dirPromise ??= mkdtemp(path.join(tmpdir(), "orch-"))),
    async download(req: unknown): Promise<DownloadResult> {
      const request = req as { id: string; target: string };
      const buffer = Buffer.from(payload);
      await writeFile(request.target, buffer);
      return {
        id: request.id,
        target: request.target,
        bytes: buffer.length,
        sha256: createHash("sha256").update(buffer).digest("hex"),
        fromCache: false,
      };
    },
  };
};

const installedApp = (over: Partial<InstalledApp> = {}): InstalledApp => ({
  regDir: "demo",
  registryPath: (UNINSTALL_ROOTS[0]?.path ?? "") + "\\demo",
  hive: "HKLM",
  scope: "machine-64",
  displayName: "示例应用",
  displayVersion: "1.0.0",
  publisher: "示例厂商",
  installLocation: "C:\\Program Files\\demo",
  uninstallString: "C:\\Program Files\\demo\\uninst.exe",
  quietUninstallString: null,
  displayIcon: null,
  isMsi: false,
  estimatedSizeKb: 100,
  installDate: null,
  systemComponent: false,
  needsElevation: true,
  ...over,
});

async function orchestratorWith(options: { detail?: AppDetail; grant?: import("@appcenter/core").Grant | null; exitCode?: number; installerCleanup?: boolean }) {
  const dir = await mkdtemp(path.join(tmpdir(), "orch-"));
  const approvals = new ApprovalWorkflow("secret");
  const grants = new Map<string, import("@appcenter/core").Grant>();
  const runner = fakeRunner(options.exitCode ?? 0);
  const detail = options.detail ?? appDetail();
  const port = fakeDownloadPort("good");
  const orch = new InstallOrchestrator({
    catalog: { detail: async (id) => (id === detail.id ? detail : null) },
    inventory: { installed: async () => [installedApp()] },
    downloader: port as never,
    runner,
    approvals,
    reg: new InMemoryRegClient([]),
    fs: { exists: async () => false, readDir: async () => [], readText: async () => null },
    env: { programData: dir, appData: dir, commonStartMenu: dir, userStartMenu: dir, temp: dir, systemRoot: ["C:", "Windows"].join(String.fromCharCode(92)) },
    packageDir: dir,
    installerCleanup: options.installerCleanup === undefined ? undefined : () => Boolean(options.installerCleanup),
    userId: "me",
    grantStore: {
      get: () => options.grant ?? grants.get(detail.id),
      clear: () => grants.clear(),
    },
  });
  return { orch, runner, detail, dir };
}

const versionFor = (kind: InstallerKind, url: string) => ({
  version: "2.0.0",
  releasedAt: "2026-09-01",
  sizeBytes: 4,
  sha256: createHash("sha256").update("good").digest("hex"),
  downloadUrl: url,
  releaseNotes: "",
  silent: defaultSilent(kind),
});

const detailForKind = (kind: InstallerKind, url: string, over: Partial<AppDetail> = {}): AppDetail =>
  appDetail({ versions: [versionFor(kind, url)], ...over });

test("install runs download then silent execution and reports success", async () => {
  const { orch, runner } = await orchestratorWith({});
  const seen: string[] = [];
  orch.onJob((job) => seen.push(job.state));
  const job = await orch.enqueue("demo");
  await settle(orch);
  assert.equal(orch.get(job.id)?.state, "succeeded");
  assert.ok(seen.includes("downloading"));
  assert.ok(seen.includes("installing"));
  assert.equal(runner.calls[0]?.program, "msiexec.exe");
  assert.equal(orch.get(job.id)?.installedVersion, "1.0.0", "装后从注册表回读真实版本号");
});

test("a failing installer exit code lands the job in failed", async () => {
  const { orch } = await orchestratorWith({ exitCode: 1603 });
  const job = await orch.enqueue("demo");
  await settle(orch);
  assert.equal(orch.get(job.id)?.state, "failed");
  assert.match(orch.get(job.id)?.error ?? "", /1603/);
});

test("approval-gated apps stop before download until a grant is attached", async () => {
  const detail = appDetail({ requiresApproval: true });
  const blocked = await orchestratorWith({ detail, grant: null });
  const job = await blocked.orch.enqueue("demo");
  await settle(blocked.orch);
  assert.equal(blocked.orch.get(job.id)?.state, "awaiting_approval");
  assert.equal(blocked.runner.calls.length, 0);

  const approvals = new ApprovalWorkflow("secret");
  const request = approvals.submit({ appId: "demo", appVersion: "2.0.0", applicant: "me", reason: "工作需要" });
  approvals.decide(request.id, "approved", "admin");
  const grant = approvals.issueGrant(request.id);
  const allowed = await orchestratorWith({ detail, grant });
  const second = await allowed.orch.enqueue("demo");
  await settle(allowed.orch);
  assert.equal(allowed.orch.get(second.id)?.state, "succeeded");
});

test("self update stages, then rolls back when the new build never reported healthy", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "self-"));
  const port = fakeDownloadPort("payload");
  const staging = path.join(dir, "staging");
  const appDir = path.join(dir, "app");
  await mkdir(appDir, { recursive: true });
  await writeFile(path.join(appDir, "AppCenter.exe"), "old", "utf8");
  const updater = new SelfUpdater({ downloader: port as never, appDir, stagingDir: staging, currentVersion: "1.0.0" });
  const manifest = {
    version: "1.2.0",
    url: "http://h/new.exe",
    sha256: createHash("sha256").update("payload").digest("hex"),
    sizeBytes: 7,
    releaseNotes: "修复",
  };
  assert.deepEqual(updater.check(manifest), { state: "available", version: "1.2.0", mandatory: false });
  assert.equal(updater.check({ ...manifest, version: "0.9.0" }).state, "up-to-date");
  assert.equal(updater.check({ ...manifest, version: "1.2.0", minCurrentVersion: "2.0.0" }).state, "too-old");

  const staged = await updater.stage(manifest);
  assert.equal(staged.version, "1.2.0");
  assert.equal((await updater.readPending())?.packagePath, staged.packagePath);

  // 没有备份可用时不能假装回滚成功
  const noBackup = await updater.recover();
  assert.equal(noBackup.rolledBack, false);

  // 模拟 apply 已经写好备份、换版后新版从未上报健康
  const backup = path.join(staging, "update-backup", "AppCenter-1.0.0.exe");
  await mkdir(path.dirname(backup), { recursive: true });
  await writeFile(backup, "old", "utf8");
  await writeFile(path.join(staging, "update-health.json"), JSON.stringify({ expectedVersion: "1.2.0", startedAt: new Date().toISOString(), healthy: false }), "utf8");
  const rolledBack = await updater.recover();
  assert.equal(rolledBack.rolledBack, true);
  assert.equal(await readFile(path.join(appDir, "AppCenter.exe"), "utf8"), "old");
  assert.equal(await updater.readPending(), null);

  // 正常路径：commit 之后 pending 清除，recover 不再回滚
  await updater.stage(manifest);
  await updater.commit();
  assert.equal(await updater.readPending(), null);
  assert.equal((await updater.recover()).rolledBack, false);
});

async function settle(orch: InstallOrchestrator, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const busy: string[] = ["queued", "downloading", "verifying", "installing"];
  while (Date.now() < deadline) {
    if (!orch.list().some((job) => busy.includes(job.state))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
