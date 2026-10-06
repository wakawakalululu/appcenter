import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUpgradePlan, defaultSilent, summarizePlan, type AppDetail, type AppSummary, type InstalledApp, type UpgradePlanInput } from "@appcenter/core";

const BS = String.fromCharCode(92);

function installed(displayName: string, displayVersion: string, publisher: string): InstalledApp {
  return {
    regDir: displayName.replace(/\W+/g, "") || "X",
    registryPath: ["HKLM", "SOFTWARE", "Microsoft", "Windows", "CurrentVersion", "Uninstall", "k"].join(BS),
    hive: "HKLM",
    scope: "machine",
    displayName,
    displayVersion,
    publisher,
    installLocation: ["C:", "Program Files", "x"].join(BS),
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

function app(id: string, name: string, publisher: string, latestVersion: string): AppSummary {
  return {
    id,
    name,
    searchKeys: [name],
    publisher,
    categoryId: "office",
    iconUrl: "",
    latestVersion,
    downloadCount: 0,
    badge: "normal",
    tags: [],
    requiresApproval: false,
    sizeBytes: 10,
  };
}

const details = (summary: AppSummary): AppDetail => ({
  ...summary,
  description: "",
  screenshots: [],
  versions: [
    {
      version: summary.latestVersion,
      releasedAt: "2026-01-01",
      sizeBytes: summary.sizeBytes,
      sha256: "x",
      downloadUrl: "/dl/" + summary.id + ".exe",
      releaseNotes: "",
      silent: defaultSilent("nsis"),
    },
  ],
});

function plan(input: { installed: InstalledApp[]; catalog: AppSummary[] }): Promise<import("@appcenter/core").UpgradeCandidate[]> {
  const byId = new Map(input.catalog.map((a) => [a.id, details(a) as unknown as AppDetail]));
  const cfg: UpgradePlanInput = {
    installed: input.installed,
    catalog: input.catalog,
    details: async (id) => byId.get(id) ?? null,
  };
  return buildUpgradePlan(cfg);
}

test("回归：只共享厂商不得配成升级对（VC++ 不该被升级成 Diagnostics Hub）", async () => {
  const candidates = await plan({
    installed: [installed("Microsoft Visual C++ 2015-2022 Redistributable (x64)", "14.30.30705", "Microsoft Corporation")],
    catalog: [app("diag-hub", "Microsoft Diagnostics Hub Center", "Microsoft Corporation", "16.0.0")],
  });
  assert.deepEqual(candidates, [], "旧实现第三支 `publisher` 相等就返回 true，会把 A 软件升成完全不同的 B 软件");
});

test("回归：DisplayVersion 为空白的安装不参与升级计划", async () => {
  for (const blank of ["", "  "]) {
    const candidates = await plan({
      installed: [installed("演示应用", blank, "演示厂商")],
      catalog: [app("demo", "演示应用", "演示厂商", "2.0.0")],
    });
    assert.equal(candidates.length, 0, `空白版本 "${blank}" 不该造出永远升不完的候选`);
  }
});

test("正常名字关系与已是最新的情形保持不变", async () => {
  const upgrade = await plan({
    installed: [installed("演示应用", "1.0.0", "演示厂商")],
    catalog: [app("demo", "演示应用", "演示厂商", "2.0.0")],
  });
  assert.equal(upgrade.length, 1);
  assert.equal(upgrade[0]?.installedVersion, "1.0.0");
  assert.equal(upgrade[0]?.action, "overwrite");

  const current = await plan({
    installed: [installed("演示应用", "2.0.0", "演示厂商")],
    catalog: [app("demo", "演示应用", "演示厂商", "2.0.0")],
  });
  assert.deepEqual(current, []);

  const contained = await plan({
    installed: [installed("演示应用 (x64) 2.0.0", "1.0.0", "演示厂商")],
    catalog: [app("demo", "演示应用", "演示厂商", "2.0.0")],
  });
  assert.equal(contained.length, 1, "目录名是本机名的子串时仍应命中（这一支有真机支撑）");
  assert.equal(summarizePlan(contained).total, 1);
});
