import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { CatalogDb, createApi, seedDemo } from "../src/server.ts";
import { makeTrackedTmp } from "../../core/test/util/tmp-dirs.ts";
import {
  AppCenterFacade,
  UNINSTALL_ROOTS,
  defaultSilent,
  regKey,
  type ExecutionRequest,
  type ExecutionResult,
  type ProcessRunner,
  type WindowHost,
} from "@appcenter/core";

class NoopHost implements WindowHost {
  async create(): Promise<string> {
    return "win-b";
  }
  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async close(): Promise<void> {}
  async focus(): Promise<void> {}
}

const adminToken = "admin-token";
const packageRoot = await makeTrackedTmp("bundle-pkgs-");
const db = CatalogDb.memory("bundle-secret");
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

/** 轮询等待条件成立；并发跑测试时比固定 sleep 可靠得多。 */
async function waitFor(predicate: () => boolean, limitMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > limitMs) throw new Error("waitFor timed out after " + String(limitMs) + "ms");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function postJson<T>(pathname: string, payload: unknown, admin = true): Promise<{ status: number; body: T }> {
  const response = await fetch(base + pathname, {
    method: "POST",
    headers: { "content-type": "application/json", ...(admin ? { authorization: "Bearer " + adminToken } : {}) },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function getJson<T>(pathname: string): Promise<{ status: number; body: T }> {
  const response = await fetch(base + pathname);
  return { status: response.status, body: (await response.json()) as T };
}

test("bundle entity publishes, lists and resolves by id", async () => {
  const empty = await getJson<unknown[]>("/api/bundles");
  assert.deepEqual(empty.body, []);

  const created = await postJson<{ id: string; appIds: string[] }>("/api/admin/bundles", {
    id: "office-kit",
    title: "办公装机套装",
    subtitle: "文档 + 输入法 + 浏览器",
    appIds: ["wps-office", "code-ide"],
    sortOrder: 1,
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.appIds, ["wps-office", "code-ide"]);

  const listed = await getJson<{ id: string; appIds: string[]; active: boolean }[]>("/api/bundles");
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0]?.id, "office-kit");

  const one = await getJson<{ title: string }>("/api/bundles/office-kit");
  assert.equal(one.body.title, "办公装机套装");
  assert.equal((await getJson("/api/bundles/nope")).status, 404);

  // 空套装与越权都要挡住
  assert.equal((await postJson("/api/admin/bundles", { id: "x", title: "空套装", appIds: [] })).status, 400);
  assert.equal((await postJson("/api/admin/bundles", { title: "越权", appIds: ["wps-office"] }, false)).status, 403);

  // 同 id 再发一次是覆盖而不是报错
  const again = await postJson<{ id: string }>("/api/admin/bundles", { id: "office-kit", title: "办公装机套装 v2", appIds: ["wps-office"] });
  assert.equal(again.status, 201);
  assert.equal((await getJson<{ title: string }>("/api/bundles/office-kit")).body.title, "办公装机套装 v2");
});

/** 整包安装用的应用：一个已装到最新版、一个需要审批、一个正常安装。 */
async function seedBundleCatalog(): Promise<string> {
  const uninstallRoot = UNINSTALL_ROOTS[0]?.path ?? "";
  db.upsertCategory({ id: "kit", name: "套装", parentId: null, sortOrder: 20 });
  const specs = [
    { id: "kit-installed", name: "已装应用", requiresApproval: false },
    { id: "kit-approval", name: "受控应用", requiresApproval: true },
    { id: "kit-fresh", name: "新应用", requiresApproval: false },
  ];
  for (const spec of specs) {
    const payload = Buffer.from("pkg-" + spec.id);
    await writeFile(path.join(packageRoot, spec.id + ".msi"), payload);
    db.upsertApp(
      {
        id: spec.id,
        name: spec.name,
        searchKeys: [spec.id],
        publisher: "本机",
        categoryId: "kit",
        iconUrl: "",
        latestVersion: "1.0.0",
        downloadCount: 1,
        badge: "normal",
        tags: [],
        requiresApproval: spec.requiresApproval,
        sizeBytes: payload.length,
        description: "",
        screenshots: [],
        versions: [],
      },
      [
        {
          version: "1.0.0",
          releasedAt: "2026-10-01",
          sizeBytes: payload.length,
          sha256: createHash("sha256").update(payload).digest("hex"),
          downloadUrl: base + "/dl/" + spec.id + ".msi",
          releaseNotes: "",
          silent: defaultSilent("msi"),
        },
      ],
    );
  }
  const published = await postJson<{ id: string }>("/api/admin/bundles", {
    id: "full-kit",
    title: "全套",
    appIds: ["kit-installed", "kit-approval", "kit-fresh", "kit-gone"],
  });
  assert.equal(published.status, 201);
  return uninstallRoot + "\\kit-installed";
}

async function facadeWithRunner(installedPath: string, calls: ExecutionRequest[]): Promise<AppCenterFacade> {
  const runner: ProcessRunner = {
    async run(req: ExecutionRequest): Promise<ExecutionResult> {
      calls.push(req);
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, requiresReboot: false };
    },
  };
  const dataDir = await makeTrackedTmp("bundle-data-");
  return new AppCenterFacade(
    {
      serverUrl: base,
      userId: "kit-user",
      dataDir,
      appVersion: "1.0.0",
      token: adminToken,
      runner,
      registryKeys: [regKey(installedPath, { DisplayName: "已装应用", DisplayVersion: "1.0.0", Publisher: "本机" })],
    },
    new NoopHost(),
  );
}

test("installBundle skips what is current, queues the rest and never blocks on approval", async () => {
  const installedPath = await seedBundleCatalog();
  const calls: ExecutionRequest[] = [];
  const facade = await facadeWithRunner(installedPath, calls);

  assert.equal(await facade.refreshCatalog(), 21); // seedDemo 18 + 套装测试自灌 3 个 kit 应用
  const run = await facade.installBundle("full-kit");
  // 已装到最新版的跳过，目录里没有的记下来，剩下两个入队。
  assert.deepEqual(run.skipped, ["kit-installed"]);
  assert.deepEqual(run.unknown, ["kit-gone"]);
  assert.equal(run.jobIds.length, 2);

  // 并发跑测试时固定 sleep 会偶发超时，改为轮询到整包收敛再断言。
  await waitFor(() => facade.bundleProgress(run.id)?.percent === 100);
  const progress = facade.bundleProgress(run.id);
  assert.ok(progress, "进度要能按 runId 查到");
  assert.equal(progress.total, 2);
  assert.equal(progress.done, 1, "新应用应当装完");
  assert.equal(progress.awaitingApproval, 1, "受控应用停在等待审批，不拖累整包");
  assert.equal(progress.failed, 0);
  assert.equal(progress.percent, 100);
  assert.equal(calls.length, 1, "只有免审批的那个真的执行了安装器");
  assert.equal(calls[0]?.program, "msiexec.exe");

  const runs = facade.bundleRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.title, "全套");
  assert.equal(facade.bundleProgress("bundle@nope#0"), null);
});
