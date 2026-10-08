import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { CatalogDb, createApi, seedDemo } from "../src/server.ts";
import { makeTrackedTmp } from "../../core/test/util/tmp-dirs.ts";
import {
  AppCenterFacade,
  UNINSTALL_ROOTS,
  regKey,
  defaultSilent,
  type ExecutionRequest,
  type ExecutionResult,
  type ProcessRunner,
  type WindowDescriptor,
  type WindowHost,
} from "@appcenter/core";

class FakeHost implements WindowHost {
  async create(): Promise<string> {
    return "win-1";
  }
  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async close(): Promise<void> {}
  async focus(): Promise<void> {}
}

const packageRoot = await makeTrackedTmp("api-pkgs-");
const dataDir = await makeTrackedTmp("api-data-");
const db = CatalogDb.memory("test-secret");
const adminToken = "admin-token";
const server = createApi({ db, packageRoot, adminToken });
let base = "";

before(async () => {
  seedDemo(db);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + String((server.address() as AddressInfo).port);
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function api<T>(pathname: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(base + pathname, init);
  const body = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, body };
}

/** 轮询等待条件成立；并发跑测试时比固定 sleep 可靠得多。 */
async function waitFor(predicate: () => boolean, limitMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > limitMs) throw new Error("waitFor timed out after " + String(limitMs) + "ms");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("catalog lists apps, categories and app detail", async () => {
  const apps = await api<{ id: string }[]>("/api/apps");
  assert.equal(apps.status, 200);
  assert.equal(apps.body.length, 18, "seedDemo 已去除移动云系 3 个应用");
  const categories = await api<{ id: string }[]>("/api/categories");
  assert.equal(categories.body.length, 9, "已删除 mobile 移动专区分类");
  const detail = await api<{ versions: unknown[]; installMode?: string }>("/api/apps/enterprise-im");
  assert.equal(detail.body.versions.length, 1);
  assert.equal(detail.body.installMode, "manual", "目录里声明的手动安装模式要透传");
  assert.equal((await api("/api/apps/nope")).status, 404);
});

test("ratings aggregate into a distribution", async () => {
  const before = await api<{ count: number }>("/api/apps/code-ide/rating");
  assert.equal(before.body.count, 1);
  const posted = await api<{ count: number; mean: number }>("/api/apps/code-ide/rating", {
    method: "POST",
    body: JSON.stringify({ userId: "u9", stars: 3, verifiedInstall: true, comment: "还行" }),
  });
  assert.equal(posted.body.count, 2);
  assert.equal(posted.body.mean, 4);
});

test("approval round trip ends in a signed grant", async () => {
  const created = await api<{ requestId: string }>("/api/approvals", {
    method: "POST",
    body: JSON.stringify({ appId: "vpn-client", appVersion: "5.0.1", applicant: "me", reason: "需要接入内网" }),
  });
  assert.equal(created.status, 201);
  const tooEarly = await api(`/api/approvals/${created.body.requestId}/grant`, { method: "POST" });
  assert.equal(tooEarly.status, 409);

  const denied = await fetch(base + `/api/approvals/${created.body.requestId}/decide`, {
    method: "POST",
    headers: { authorization: "Bearer wrong" },
    body: JSON.stringify({ decision: "approved" }),
  });
  assert.equal(denied.status, 403);

  const decided = await api<{ ok: boolean }>(`/api/approvals/${created.body.requestId}/decide`, {
    method: "POST",
    headers: { authorization: "Bearer " + adminToken },
    body: JSON.stringify({ decision: "approved", decidedBy: "admin" }),
  });
  assert.equal(decided.body.ok, true);
  const grant = await api<{ signature: string; appId: string }>(`/api/approvals/${created.body.requestId}/grant`, { method: "POST" });
  assert.equal(grant.body.appId, "vpn-client");
  assert.equal(grant.body.signature.length, 64);
  const replay = await api(`/api/approvals/${created.body.requestId}/grant`, { method: "POST" });
  assert.equal(replay.status, 409);
});

test("self update manifest is published through the admin route", async () => {
  const empty = await api("/api/self-update");
  assert.equal(empty.status, 404);
  const published = await api("/api/admin/self-update", {
    method: "POST",
    headers: { authorization: "Bearer " + adminToken },
    body: JSON.stringify({ version: "1.1.0", url: base + "/dl/client.exe", sha256: "f".repeat(64), sizeBytes: 10, releaseNotes: "托盘图标修复" }),
  });
  assert.equal(published.status, 201);
  const manifest = await api<{ version: string; mandatory: boolean }>("/api/self-update");
  assert.equal(manifest.body.version, "1.1.0");
  assert.equal(manifest.body.mandatory, false);
});

test("package downloads honour Range requests so the client can resume", async () => {
  const payload = Buffer.from("0123456789ABCDEFGHIJ");
  await writeFile(path.join(packageRoot, "range.bin"), payload);
  const full = await fetch(base + "/dl/range.bin");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal((await full.arrayBuffer()).byteLength, payload.length);
  const partial = await fetch(base + "/dl/range.bin", { headers: { range: "bytes=6-" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 6-19/20");
  assert.equal(Buffer.from(await partial.arrayBuffer()).toString(), "6789ABCDEFGHIJ");
  const bad = await fetch(base + "/dl/range.bin", { headers: { range: "bytes=999-" } });
  assert.equal(bad.status, 416);
  assert.equal((await fetch(base + "/dl/missing.bin")).status, 404);
});

test("download counter feeds the popularity ranking", async () => {
  const bumped = await api<{ downloadCount: number }>("/api/apps/code-ide/downloaded", { method: "POST" });
  assert.ok(bumped.body.downloadCount > 1290);
});

test("facade drives search, upgrade planning and an approval-gated install end to end", async () => {
  const payload = Buffer.from("package-bytes");
  const sha = createHash("sha256").update(payload).digest("hex");
  await writeFile(path.join(packageRoot, "local-demo.msi"), payload);
  db.upsertCategory({ id: "local", name: "本地", parentId: null, sortOrder: 9 });
  db.upsertApp(
    {
      id: "local-demo",
      name: "本地示例",
      searchKeys: ["local demo", "bendi"],
      publisher: "本机",
      categoryId: "local",
      iconUrl: "",
      latestVersion: "1.0.1",
      downloadCount: 5,
      badge: "recommend",
      tags: [],
      requiresApproval: true,
      sizeBytes: payload.length,
      description: "",
      screenshots: [],
      versions: [],
    },
    [
      {
        version: "1.0.1",
        releasedAt: "2026-10-01",
        sizeBytes: payload.length,
        sha256: sha,
        downloadUrl: base + "/dl/local-demo.msi",
        releaseNotes: "",
        silent: defaultSilent("msi"),
      },
    ],
  );
  db.upsertApp(
    {
      id: "wps-office",
      name: "WPS Office",
      searchKeys: ["wps"],
      publisher: "金山办公",
      categoryId: "office-doc",
      iconUrl: "",
      latestVersion: "12.1.0",
      downloadCount: 5000,
      badge: "recommend",
      tags: ["文档"],
      requiresApproval: false,
      sizeBytes: 1,
      description: "",
      screenshots: [],
      versions: [],
    },
    [
      {
        version: "12.1.0",
        releasedAt: "2026-09-20",
        sizeBytes: 1,
        sha256: "a".repeat(64),
        downloadUrl: base + "/dl/wps-12.1.0.msi",
        releaseNotes: "",
        silent: defaultSilent("msi"),
      },
    ],
  );

  const calls: ExecutionRequest[] = [];
  const runner: ProcessRunner = {
    async run(req: ExecutionRequest): Promise<ExecutionResult> {
      calls.push(req);
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, requiresReboot: false };
    },
  };
  const uninstallRoot = UNINSTALL_ROOTS[0]?.path ?? "";
  // 共享运行配置：这条用例要先留下安装包，才能校验下载落盘的字节。
  await writeFile(path.join(dataDir, "runtime-config.json"), JSON.stringify({ installerCleanup: false }), "utf8");
  const facade = new AppCenterFacade(
    {
      serverUrl: base,
      userId: "me",
      dataDir,
      appVersion: "1.0.0",
      token: adminToken,
      runner,
      registryKeys: [regKey(uninstallRoot + "\\wps", { DisplayName: "WPS Office", DisplayVersion: "12.0.0", Publisher: "金山办公" })],
    },
    new FakeHost(),
  );

  assert.equal(await facade.refreshCatalog(), 19); // seedDemo 18 + 本测试自灌的 local-demo
  const hits = await facade.search({ text: "bendi" });
  assert.ok(hits.length > 0);

  const blocked = await facade.install("local-demo");
  // 并发跑测试时 CPU/IO 可能被挤满，固定 sleep 会偶发超时；改成轮询等终态。
  await waitFor(() => facade.jobs().find((j) => j.id === blocked.id)?.state === "awaiting_approval");
  assert.equal(facade.jobs().find((j) => j.id === blocked.id)?.state, "awaiting_approval");
  assert.equal(calls.length, 0);
  assert.equal(facade.trayView().status, "awaiting-approval");

  const ticket = await api<{ requestId: string }>("/api/approvals", {
    method: "POST",
    body: JSON.stringify({ appId: "local-demo", appVersion: "1.0.1", applicant: "me", reason: "验证审批链路需要" }),
  });
  await api(`/api/approvals/${ticket.body.requestId}/decide`, {
    method: "POST",
    headers: { authorization: "Bearer " + adminToken },
    body: JSON.stringify({ decision: "approved", decidedBy: "admin" }),
  });
  await facade.attachGrant(ticket.body.requestId);

  const retry = await facade.install("local-demo");
  await waitFor(() => facade.jobs().find((j) => j.id === retry.id)?.state === "succeeded");
  assert.equal(facade.jobs().find((j) => j.id === retry.id)?.state, "succeeded");
  assert.equal(calls[0]?.program, "msiexec.exe");
  const landed = facade.jobs().find((j) => j.id === retry.id)?.packagePath ?? "";
  assert.equal(await readFile(landed, "utf8"), "package-bytes");

  // 打开 installer_cleanup 后再装一次，安装包应当在成功终态前被删掉。
  const second = await api<{ requestId: string }>("/api/approvals", {
    method: "POST",
    body: JSON.stringify({ appId: "local-demo", appVersion: "1.0.1", applicant: "me", reason: "验证清理开关需要" }),
  });
  await api(`/api/approvals/${second.body.requestId}/decide`, {
    method: "POST",
    headers: { authorization: "Bearer " + adminToken },
    body: JSON.stringify({ decision: "approved", decidedBy: "admin" }),
  });
  await facade.attachGrant(second.body.requestId);
  const flipped = await facade.updateRuntimeConfig({ installerCleanup: true });
  assert.equal(flipped.config.installerCleanup, true);
  const settled = new Promise<void>((resolve, reject) => {
    const off = facade.onJob((job) => {
      if (job.id !== retry.id) return;
      if (job.state === "succeeded") {
        off();
        resolve();
      }
      if (job.state === "failed") {
        off();
        reject(new Error(job.error ?? "install failed"));
      }
    });
  });
  await facade.install("local-demo");
  await settled;
  await assert.rejects(readFile(landed, "utf8"), /ENOENT/);

  // 回执是终态时异步上报的，轮询等到两条都落库再断言。
  let receipted: Awaited<ReturnType<typeof facade.receipts>> = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    receipted = await facade.receipts("local-demo");
    if (receipted.length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(receipted.length >= 2);
  assert.equal(receipted[0]?.result, "success");

  const upgrades = await facade.upgrades();
  assert.equal(upgrades.candidates[0]?.name, "WPS Office");
  assert.equal(upgrades.candidates[0]?.installedVersion, "12.0.0");
  assert.equal(upgrades.summary.total, 1);

  const tree = await facade.categories();
  assert.ok(tree.some((node) => node.name === "本地"));
  assert.equal(facade.skin("dark").tokens.color.background, "#121418");
  const win: WindowDescriptor = (await facade.openWindow("main")) as WindowDescriptor;
  assert.equal(win.role, "main");
});
