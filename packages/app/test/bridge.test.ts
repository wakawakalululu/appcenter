import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { CatalogDb, createApi, seedDemo } from "@appcenter/server";
import { createBridge } from "../src/bridge.ts";
import { readStatic, resolveStatic } from "../src/dispatch.ts";
import { AppCenterFacade, UNINSTALL_ROOTS, regKey, type WindowHost } from "@appcenter/core";

class NullHost implements WindowHost {
  async create(): Promise<string> { return "win-1"; }
  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async close(): Promise<void> {}
  async focus(): Promise<void> {}
}

const webRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..", "web");

test("static resolution refuses to escape the web root", () => {
  assert.equal(resolveStatic(webRoot, "/app.js")?.endsWith(path.join("web", "app.js")), true);
  assert.equal(resolveStatic(webRoot, "/../../etc/passwd"), null);
  assert.equal(resolveStatic(webRoot, "/%2e%2e/%2e%2e/server.js"), null);
});

test("bridge serves the UI and routes RPC to the facade", async () => {
  const db = CatalogDb.memory("bridge-secret");
  seedDemo(db);
  const catalogApi = createApi({ db, packageRoot: await mkdtemp(path.join(tmpdir(), "bridge-pkgs-")), adminToken: "admin" });
  const catalogPort = await new Promise<number>((resolve) => catalogApi.listen(0, "127.0.0.1", () => resolve((catalogApi.address() as AddressInfo).port)));

  const dataDir = await mkdtemp(path.join(tmpdir(), "bridge-data-"));
  const facade = new AppCenterFacade(
    {
      serverUrl: "http://127.0.0.1:" + String(catalogPort),
      userId: "me",
      dataDir,
      appVersion: "1.0.0",
      registryKeys: [regKey((UNINSTALL_ROOTS[0]?.path ?? "") + "\Wps", { DisplayName: "WPS Office", DisplayVersion: "12.0.0", Publisher: "金山办公" })],
    },
    new NullHost(),
  );
  const bridge = createBridge({ facade, webRoot });
  const port = await new Promise<number>((resolve) => bridge.listen(0, "127.0.0.1", () => resolve((bridge.address() as AddressInfo).port)));
  const base = "http://127.0.0.1:" + String(port);

  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await page.text(), /应用中心/);
  assert.equal((await fetch(base + "/app.css")).status, 200);
  assert.equal((await fetch(base + "/missing.txt")).status, 404);
  const genIcon = await fetch(base + "/icons/gen/wps-office.svg");
  assert.equal(genIcon.status, 200);
  assert.match(genIcon.headers.get("content-type") ?? "", /image\/svg/);
  assert.match(await genIcon.text(), /<svg/);
  assert.equal((await fetch(base + "/icons/gen/bad%2Fseed.svg")).status, 404, "seed 不允许带路径字符");
  const favicon = await fetch(base + "/favicon.svg");
  assert.equal(favicon.status, 200);
  assert.match(await favicon.text(), /<svg/, "独立应用窗口用品牌 favicon 当窗口/任务栏图标");

  const call = async (method: string, params?: Record<string, unknown>) => {
    const response = await fetch(base + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
    return { status: response.status, payload: await response.json() as { ok: boolean; result?: unknown; error?: string } };
  };

  // 演示目录规模随 seedDemo 演进，断言按实际库内容算，不写死数量。
  const seededApps = db.summaries().length;
  const refreshed = (await call("catalog.refresh")).payload.result;
  assert.equal(refreshed, seededApps);
  const search = await call("catalog.search", { text: "wps" });
  const first = (search.payload.result as { app: { name: string; ratings?: { count: number } } }[])[0];
  assert.equal(first?.app.name, "WPS Office");
  assert.equal(typeof first?.app.ratings, "object");

  const categories = await call("catalog.categories");
  assert.ok(Array.isArray(categories.payload.result));
  const upgrades = await call("upgrade.plan");
  assert.equal((upgrades.payload.result as { summary: { total: number } }).summary.total, 1);
  const skin = await call("ui.setSkin", { id: "cny" });
  // 春节皮肤主色为设计选定的色值。
  assert.equal((skin.payload.result as { tokens: { color: { primary: string } } }).tokens.color.primary, "#DA3E3D");
  const fresh = await call("ui.setSkin", { id: "fresh" });
  const freshColors = (fresh.payload.result as { tokens: { color: Record<string, string> } }).tokens.color;
  assert.equal(freshColors.navFrom, "#6FE3E1");
  assert.equal(freshColors.navTo, "#8EF2AC");
  assert.equal(freshColors.primary, "#27D47B");
  assert.equal((await call("ui.window", { role: "settings" })).payload.ok, true);
  assert.equal((await call("ui.windows")).payload.ok, true);
  const tray = await call("ui.tray");
  assert.ok(["idle", "update-available", "downloading", "awaiting_approval", "needs-reboot", "error"].includes((tray.payload.result as { status: string }).status));
  assert.equal((await call("nope.nothing")).status, 400);
  assert.match((await call("nope.nothing")).payload.error ?? "", /unknown method/);

  const events = await fetch(base + "/events");
  const reader = events.body?.getReader();
  const head = await reader?.read();
  assert.match(new TextDecoder().decode(head?.value ?? new Uint8Array()), /event: hello/);

  await reader?.cancel();
  bridge.closeAllConnections();
  catalogApi.closeAllConnections();
  await new Promise<void>((resolve, reject) => bridge.close((err: unknown) => (err ? reject(err) : resolve())));
  await new Promise<void>((resolve, reject) => catalogApi.close((err: unknown) => (err ? reject(err) : resolve())));
  void writeFile;
});

test("tray menu actions route back through the engine and register windows", async () => {
  const db = CatalogDb.memory("tray-secret");
  seedDemo(db);
  const catalogApi = createApi({ db, packageRoot: await mkdtemp(path.join(tmpdir(), "tray-pkgs-")), adminToken: "admin" });
  const catalogPort = await new Promise<number>((resolve) => catalogApi.listen(0, "127.0.0.1", () => resolve((catalogApi.address() as AddressInfo).port)));
  const facade = new AppCenterFacade(
    { serverUrl: "http://127.0.0.1:" + String(catalogPort), userId: "me", dataDir: await mkdtemp(path.join(tmpdir(), "tray-data-")), appVersion: "1.0.0" },
    new NullHost(),
  );
  const bridge = createBridge({ facade, webRoot });
  const port = await new Promise<number>((resolve) => bridge.listen(0, "127.0.0.1", () => resolve((bridge.address() as AddressInfo).port)));
  const call = async (method: string, params?: Record<string, unknown>) => {
    const response = await fetch("http://127.0.0.1:" + String(port) + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
    return (await response.json()) as { ok: boolean; result?: unknown };
  };

  const view = await call("ui.tray");
  const menu = (view.result as { menu: { action?: string }[] }).menu;
  const openAction = menu.find((m) => (m.action ?? "").startsWith("window.open"))?.action ?? "window.open:main";
  const handled = await call("ui.trayAction", { action: openAction });
  assert.equal((handled.result as { handled: boolean }).handled, true);
  const windows = await call("ui.windows");
  assert.equal((windows.result as unknown[]).length, 1);
  const unknown = await call("ui.trayAction", { action: "download.pauseAll" });
  assert.equal((unknown.result as { handled: boolean }).handled, false);

  bridge.closeAllConnections();
  catalogApi.closeAllConnections();
  await new Promise<void>((resolve, reject) => bridge.close((err: unknown) => (err ? reject(err) : resolve())));
  await new Promise<void>((resolve, reject) => catalogApi.close((err: unknown) => (err ? reject(err) : resolve())));
});
