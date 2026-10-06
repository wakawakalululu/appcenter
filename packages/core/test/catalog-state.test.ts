import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatalogEntries, essentialStrip } from "../src/catalog/view.ts";
import type { AppSummary } from "../src/catalog/types.ts";
import type { InstalledApp } from "../src/inventory/inventory.ts";

function app(overrides: Partial<AppSummary> = {}): AppSummary {
  return {
    id: "demo-app",
    name: "演示应用",
    searchKeys: ["demo"],
    publisher: "演示厂商",
    categoryId: "office",
    iconUrl: "/icons/demo.svg",
    latestVersion: "2.0.0",
    downloadCount: 100,
    badge: "normal",
    tags: ["demo"],
    requiresApproval: false,
    sizeBytes: 1024,
    ...overrides,
  };
}

function installed(displayVersion: string, displayName = "演示应用"): InstalledApp {
  return {
    regDir: "DemoApp",
    registryPath: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DemoApp",
    hive: "HKLM",
    scope: "machine",
    displayName,
    displayVersion,
    publisher: "演示厂商",
    installLocation: "C:\\Program Files\\DemoApp",
    uninstallString: "C:\\Program Files\\DemoApp\\uninstall.exe",
    quietUninstallString: null,
    displayIcon: null,
    isMsi: false,
    estimatedSizeKb: 1024,
    installDate: null,
    systemComponent: false,
    needsElevation: false,
  };
}

const entry = (input: Parameters<typeof buildCatalogEntries>[0]) => buildCatalogEntries(input)[0]!;

test("审批门禁只挡写入动作：未装时是「需审批」，已装且已是最新时正常「打开」", () => {
  const gated = app({ requiresApproval: true });
  const fresh = entry({ apps: [gated], installed: [] });
  assert.equal(fresh.installState, "needs-approval");
  assert.equal(fresh.action, "request");

  const current = entry({ apps: [gated], installed: [installed("2.0.0")] });
  assert.equal(current.installState, "installed", "已装到最新版不该继续挂「需审批」——没有要安装的东西");
  assert.equal(current.action, "open");
});

test("回归：审批门禁应用「已装旧版 + 有新版」不得伪装成可直接升级", () => {
  const gated = app({ requiresApproval: true });
  const result = entry({ apps: [gated], installed: [installed("1.0.0")] });
  // 旧实装状态是 upgradable/upgrade：点下去后 install() 会在 passesApprovalGate 处直接转 awaiting_approval，
  // 界面无端冒出一个注定失败的安装任务。
  assert.equal(result.installState, "needs-approval");
  assert.equal(result.action, "request");

  // 拿到凭证后同一台机器就该恢复成真正的可升级。
  const granted = entry({ apps: [gated], installed: [installed("1.0.0")], granted: new Set(["demo-app"]) });
  assert.equal(granted.installState, "upgradable");
  assert.equal(granted.action, "upgrade");
});

test("回归：DisplayVersion 为空串或空白时不得永远显示可升级", () => {
  for (const blank of ["", "   ", "\t"]) {
    const result = entry({ apps: [app()], installed: [installed(blank)] });
    assert.equal(result.installState, "installed", `空白版本 "${JSON.stringify(blank)}" 应视为已装、版本未知`);
    assert.equal(result.action, "open");
    assert.equal(result.installedVersion, null, "版本未知要在视图里明确成 null，而不是拿空串参与比较");
    assert.equal(result.matchQuality, 3, "名称精确命中，匹配质量不受版本缺失影响");
  }
});

test("空版本的应用仍能被 essentialStrip 选为必备，审批门禁的升级项则被排除", () => {
  const strip = essentialStrip(
    buildCatalogEntries({
      apps: [app({ id: "plain", name: "普通应用" }), app({ id: "gated", name: "审批应用", requiresApproval: true })],
      installed: [installed("1.0.0", "普通应用"), installed("1.0.0", "审批应用")],
    }),
  );
  assert.deepEqual(
    strip.map((e) => e.app.id),
    ["plain"],
    "有新版待装但未获审批的应用不该出现在「必备应用」横条里诱导安装",
  );
});

test("四段版本号仍然按数值比较：12.1.0.28488 < 12.1.0.30100", () => {
  const result = entry({ apps: [app({ latestVersion: "12.1.0.30100" })], installed: [installed("12.1.0.28488")] });
  assert.equal(result.installState, "upgradable");
  assert.equal(result.action, "upgrade");
});
