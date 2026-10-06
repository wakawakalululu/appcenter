import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { CatalogDb, createApi, materializeDemoPackages, seedDemo } from "../src/server.ts";
import { AppCenterFacade, type WindowHost } from "@appcenter/core";

class NoopHost implements WindowHost {
  async create(): Promise<string> {
    return "win-repo";
  }
  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async close(): Promise<void> {}
  async focus(): Promise<void> {}
}

const packageRoot = await mkdtemp(path.join(tmpdir(), "repo-pkgs-"));
const db = CatalogDb.memory("repo-secret");
const server = createApi({ db, packageRoot, adminToken: "admin-token" });
let base = "";
let appCount = 0;
let versionCount = 0;

before(async () => {
  seedDemo(db);
  appCount = db.summaries().length;
  versionCount = db.summaries().reduce((sum, summary) => {
    const detail = db.detail(summary.id);
    return sum + (detail?.versions.length ?? 0);
  }, 0);
  // 物化后每个版本都有真实文件与真 sha256，下载校验链路可以端到端跑通。
  const materialized = materializeDemoPackages(db, packageRoot);
  assert.equal(materialized.files, versionCount, "每个版本都要物化出一个安装包文件");
  assert.ok(materialized.bytes > 1024 * 1024);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + String((server.address() as AddressInfo).port);
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function facadeFor(userId: string): Promise<AppCenterFacade> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "repo-data-"));
  return new AppCenterFacade({ serverUrl: base, userId, dataDir, appVersion: "1.0.0", token: "admin-token", registryKeys: [] }, new NoopHost());
}

test("sync mirrors the whole catalog to disk with a self-describing manifest", async () => {
  const facade = await facadeFor("repo-user");
  assert.equal(await facade.refreshCatalog(), appCount);

  const report = await facade.syncLocalRepo({});
  assert.equal(report.saved.length, appCount, "每个应用的最新版都要落盘");
  assert.equal(report.failed.length, 0);
  assert.ok(report.totalBytes > 1024 * 1024, "物化的演示包合计超过 1MB");

  const manifest = JSON.parse(await readFile(report.manifestFile, "utf8")) as {
    catalog: { apps: { id: string }[]; categories: { id: string }[] };
    items: { appId: string; relativePath: string; sha256: string; sizeBytes: number; url: string }[];
  };
  assert.equal(manifest.catalog.apps.length, appCount, "清单携带目录快照");
  assert.ok(manifest.catalog.categories.length > 0);
  const wps = manifest.items.find((item) => item.appId === "wps-office") ?? manifest.items[0];
  assert.ok(wps);
  assert.match(wps.url, /^http:\/\/127\.0\.0\.1:\d+\/dl\//, "相对路径要补全成绝对 URL");

  const landed = await readFile(path.join(report.root, ...wps.relativePath.split("/")));
  assert.equal(landed.length, wps.sizeBytes);
  assert.equal(createHash("sha256").update(landed).digest("hex"), wps.sha256);

  const status = await facade.localRepoStatus();
  assert.equal(status.saved, appCount);
  assert.equal(status.pending, 0);
  assert.equal(status.failed, 0);

  const again = await facade.syncLocalRepo({});
  assert.equal(again.cached.length, appCount, "第二次同步全部命中缓存");
  assert.equal(again.saved.length, 0);
});

test("allVersions mirrors every published version", async () => {
  const facade = await facadeFor("repo-all");
  await facade.refreshCatalog();
  const report = await facade.syncLocalRepo({ allVersions: true });
  assert.equal(report.saved.length, versionCount, "全部版本落盘");
  const status = await facade.localRepoStatus();
  assert.equal(status.saved, versionCount);
});
