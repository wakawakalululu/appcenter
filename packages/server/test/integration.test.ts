import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { CatalogDb, createApi } from "@appcenter/server";
import { createBridge } from "@appcenter/app";
import { makeTrackedTmp } from "../../core/test/util/tmp-dirs.ts";
import {
  AppCenterFacade,
  Downloader,
  defaultSilent,
  type AppDetail,
  type AppVersion,
  type WindowHost,
} from "@appcenter/core";

class NullHost implements WindowHost {
  async create(): Promise<string> {
    return "win-1";
  }
  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async close(): Promise<void> {}
  async focus(): Promise<void> {}
}

const sha = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");

async function bootCatalog(): Promise<{ base: string; db: CatalogDb; packageRoot: string; close: () => Promise<void> }> {
  const packageRoot = await makeTrackedTmp("itg-pkgs-");
  const db = CatalogDb.memory("itg-secret");
  const api = createApi({ db, packageRoot, adminToken: "admin" });
  const port = await new Promise<number>((resolve) => api.listen(0, "127.0.0.1", () => resolve((api.address() as AddressInfo).port)));
  return {
    base: "http://127.0.0.1:" + String(port),
    db,
    packageRoot,
    close: async () => {
      api.closeAllConnections();
      await new Promise<void>((resolve, reject) => api.close((err: unknown) => (err ? reject(err) : resolve())));
    },
  };
}

test("resumed download against the real Range endpoint lands the exact package", async () => {
  const { base, db, packageRoot, close } = await bootCatalog();
  try {
    const payload = Buffer.alloc(4096);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) % 251;
    await writeFile(path.join(packageRoot, "big.bin"), payload);

    const silent = defaultSilent("msi");
    const version: AppVersion = {
      version: "1.0.0",
      releasedAt: "2026-10-01",
      sizeBytes: payload.length,
      sha256: sha(payload),
      downloadUrl: base + "/dl/big.bin",
      releaseNotes: "",
      silent,
    };
    const detail: AppDetail = {
      id: "resumable",
      name: "续传测试包",
      searchKeys: ["resume"],
      publisher: "本机",
      categoryId: "dev",
      iconUrl: "",
      latestVersion: version.version,
      downloadCount: 0,
      badge: "normal",
      tags: [],
      requiresApproval: false,
      sizeBytes: payload.length,
      description: "",
      screenshots: [],
      versions: [version],
    };
    db.upsertCategory({ id: "dev", name: "开发", parentId: null, sortOrder: 1 });
    db.upsertApp(detail, [version]);

    const rangeRequests: string[] = [];
    let firstCall = true;
    const flakyFetch = (async (input: string | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers.Range) rangeRequests.push(headers.Range);
      const response = await fetch(input, init);
      if (!firstCall) return response;
      firstCall = false;
      const full = Buffer.from(await response.arrayBuffer());
      // 第一次只给前 1000 字节然后掐断，模拟网络中断。
      // 注意必须在 pull 里报错：start 里 error 会丢弃已 enqueue 的数据，等于一个字节都没收到。
      let pulled = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            if (pulled === 1) controller.enqueue(full.subarray(0, 1000));
            else controller.error(new Error("simulated connection reset"));
          },
        }),
        { status: 200, headers: { "content-length": String(full.length), "accept-ranges": "bytes" } },
      );
    }) as typeof fetch;

    const dir = await makeTrackedTmp("itg-dl-");
    const target = path.join(dir, "big.bin");
    const downloader = new Downloader({ fetchImpl: flakyFetch, attempts: 3, baseDelayMs: 1, sidecarFlushBytes: 512 });
    const result = await downloader.download({
      id: "resumable",
      url: version.downloadUrl,
      target,
      expectedSha256: version.sha256,
      expectedSize: version.sizeBytes,
    });

    assert.equal(result.bytes, payload.length);
    assert.equal(result.sha256, version.sha256);
    assert.deepEqual(await readFile(target), payload);
    assert.ok(rangeRequests.length >= 1, "续传必须带上 Range 请求头");
    assert.equal(rangeRequests[0], "bytes=1000-");
    await assert.rejects(() => stat(target + ".part"), /ENOENT/);
  } finally {
    await close();
  }
});

test("self update publishes, checks, stages and commits through the bridge", async () => {
  const catalog = await bootCatalog();
  const closeCatalog = catalog.close;
  try {
    const dataDir = await makeTrackedTmp("itg-ui-");
    const facade = new AppCenterFacade(
      { serverUrl: catalog.base, userId: "me", dataDir, appVersion: "1.0.0" },
      new NullHost(),
    );
    const bridge = createBridge({ facade, webRoot: path.join(process.cwd(), "packages", "app", "web") });
    const port = await new Promise<number>((resolve) => bridge.listen(0, "127.0.0.1", () => resolve((bridge.address() as AddressInfo).port)));
    const rpc = async (method: string, params?: Record<string, unknown>) => {
      const response = await fetch("http://127.0.0.1:" + String(port) + "/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, params }),
      });
      return (await response.json()) as { ok: boolean; result?: unknown; error?: string };
    };

    const clientPackage = Buffer.concat([Buffer.from("MZ"), Buffer.from("appcenter-client-payload-".repeat(40))]);
    await writeFile(path.join(catalog.packageRoot, "client-1.2.0.exe"), clientPackage);
    const published = await fetch(catalog.base + "/api/admin/self-update", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin" },
      body: JSON.stringify({
        version: "1.2.0",
        url: catalog.base + "/dl/client-1.2.0.exe",
        sha256: sha(clientPackage),
        sizeBytes: clientPackage.length,
        releaseNotes: "托盘与断点续传",
      }),
    });
    assert.equal(published.status, 201);

    const check = await rpc("selfupdate.check");
    assert.equal(check.ok, true);
    assert.equal((check.result as { result: { state: string } }).result.state, "available");

    const manifest = (check.result as { manifest: unknown }).manifest;
    const staged = await rpc("selfupdate.stage", { manifest });
    assert.equal(staged.ok, true);
    const stagedInfo = staged.result as { version: string; packagePath: string };
    assert.equal(stagedInfo.version, "1.2.0");
    assert.deepEqual(await readFile(stagedInfo.packagePath), clientPackage);

    const pending = await rpc("selfupdate.pending");
    assert.equal((pending.result as { version: string }).version, "1.2.0");

    // 备份还不存在时不能谎报回滚成功
    const recovered = await rpc("selfupdate.recover");
    assert.equal((recovered.result as { rolledBack: boolean }).rolledBack, false);

    await rpc("selfupdate.commit");
    const afterCommit = await rpc("selfupdate.pending");
    assert.equal(afterCommit.result, null);

    bridge.closeAllConnections();
    await new Promise<void>((resolve, reject) => bridge.close((err: unknown) => (err ? reject(err) : resolve())));
  } finally {
    await closeCatalog();
  }
});
