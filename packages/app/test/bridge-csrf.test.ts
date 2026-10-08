import { test } from "node:test";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import path from "node:path";
import type { AddressInfo } from "node:net";
import { CatalogDb, createApi, seedDemo } from "@appcenter/server";
import { createBridge } from "../src/bridge.ts";
import { AppCenterFacade, UNINSTALL_ROOTS, regKey, type WindowHost } from "@appcenter/core";
import { makeTrackedTmp } from "../../core/test/util/tmp-dirs.ts";

class NullHost implements WindowHost {
  async create(): Promise<string> { return "win-1"; }
  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async close(): Promise<void> {}
  async focus(): Promise<void> {}
}

const webRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..", "web");

/**
 * 起一个桥：目录服务与注册表都走内存/注入，绝不碰真机。
 * 返回桥地址与一个「带任意头的 /rpc 调用」助手，方便构造浏览器侧的简单请求。
 */
async function startBridge(): Promise<{ base: string; close: () => Promise<void>; rpc: (init?: RequestInit) => Promise<{ status: number; body: string }> }> {
  const db = CatalogDb.memory("csrf-secret");
  seedDemo(db);
  const catalogApi = createApi({ db, packageRoot: await makeTrackedTmp("csrf-pkgs-"), adminToken: "admin" });
  const catalogPort = await new Promise<number>((resolve) => catalogApi.listen(0, "127.0.0.1", () => resolve((catalogApi.address() as AddressInfo).port)));
  const facade = new AppCenterFacade(
    {
      serverUrl: "http://127.0.0.1:" + String(catalogPort),
      userId: "me",
      dataDir: await makeTrackedTmp("csrf-data-"),
      appVersion: "1.0.0",
      registryKeys: [regKey((UNINSTALL_ROOTS[0]?.path ?? "") + "\\Wps", { DisplayName: "WPS Office", DisplayVersion: "12.0.0", Publisher: "金山办公" })],
    },
    new NullHost(),
  );
  const bridge = createBridge({ facade, webRoot });
  const port = await new Promise<number>((resolve) => bridge.listen(0, "127.0.0.1", () => resolve((bridge.address() as AddressInfo).port)));
  const base = "http://127.0.0.1:" + String(port);
  const rpc = async (init: RequestInit = {}) => {
    const response = await fetch(base + "/rpc", init);
    return { status: response.status, body: await response.text() };
  };
  const close = async () => {
    // SSE 会挂着长连接，不先掐掉连接 bridge.close() 永不返回（表现为测试被 timeout 掐死而非失败）。
    bridge.closeAllConnections();
    await new Promise<void>((resolve, reject) => bridge.close((err) => (err ? reject(err) : resolve())));
    catalogApi.closeAllConnections();
    await new Promise<void>((resolve, reject) => catalogApi.close((err) => (err ? reject(err) : resolve())));
  };
  return { base, close, rpc };
}

const jsonBody = JSON.stringify({ method: "ui.skin", params: { id: "cny" } });

test("跨源 text/plain 简单请求不得被 /rpc 执行", async () => {
  const { base, close, rpc } = await startBridge();
  try {
    // 浏览器 CORS「简单请求」：POST + text/plain 不触发预检，任何网页都能发出来。
    const crossSite = await rpc({
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://evil.example.com", host: new URL(base).host },
      body: jsonBody,
    });
    assert.equal(crossSite.status, 403, "跨源简单请求必须被拒（实际 " + String(crossSite.status) + " / " + crossSite.body.slice(0, 120) + "）");
    assert.doesNotMatch(crossSite.body, /春节|"cny"/, "被拒的请求不能已经把皮肤切掉");

    // 表单编码同样是简单请求，也在被拒之列。
    const formEncoded = await rpc({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example.com" },
      body: jsonBody,
    });
    assert.equal(formEncoded.status, 403, "x-www-form-urlencoded 同样不得执行");
  } finally {
    await close();
  }
});

test("同源 JSON 调用与无 Origin 的本地客户端仍然放行", async () => {
  const { base, close, rpc } = await startBridge();
  try {
    const sameOrigin = await rpc({
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: jsonBody,
    });
    assert.equal(sameOrigin.status, 200, "自家 UI 不能被误伤：" + sameOrigin.body.slice(0, 120));
    assert.match(sameOrigin.body, /春节/);

    // CLI / curl 一类非浏览器客户端不发 Origin，保持可用。
    const noOrigin = await rpc({ method: "POST", headers: { "content-type": "application/json" }, body: jsonBody });
    assert.equal(noOrigin.status, 200, "无 Origin 的本地客户端不能被误伤：" + noOrigin.body.slice(0, 120));

    // 纵深防御：内容类型闸独立于来源闸——同源但走简单请求也拦。
    const sameOriginSimple = await rpc({
      method: "POST",
      headers: { "content-type": "text/plain", origin: base },
      body: jsonBody,
    });
    assert.equal(sameOriginSimple.status, 415, "同源的非 JSON 请求体也应被内容类型闸拦下");
  } finally {
    await close();
  }
});

test("SSE /events 不向跨源请求泄露本地状态", async () => {
  const { base, close } = await startBridge();
  try {
    const crossSite = await fetch(base + "/events", { headers: { origin: "https://evil.example.com" } });
    assert.equal(crossSite.status, 403, "跨源 EventSource 不得拿到托盘/窗口/任务状态");
    const sameOrigin = await fetch(base + "/events", { headers: { origin: base } });
    assert.equal(sameOrigin.status, 200, "自家 UI 的 SSE 不能被误伤");
    await sameOrigin.body?.cancel();
  } finally {
    await close();
  }
});

test("预检与跨站标记都不给出放行信号", async () => {
  const { base, close, rpc } = await startBridge();
  try {
    const preflight = await fetch(base + "/rpc", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example.com", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    assert.ok(preflight.status === 403 || preflight.status === 405, "OPTIONS 不应被当作放行：" + String(preflight.status));
    assert.equal(preflight.headers.get("access-control-allow-origin"), null, "绝不能回 allow-origin");

    // 浏览器总会带 Origin；只带 Sec-Fetch-Site: cross-site 的构造请求也按跨站处理。
    const secFetch = await rpc({
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: jsonBody,
    });
    assert.equal(secFetch.status, 403, "Sec-Fetch-Site: cross-site 应被拒");
  } finally {
    await close();
  }
});
