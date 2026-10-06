import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAssetSummary, type AppSummary, type CatalogEntry, type InstallState } from "@appcenter/core";

const app = (over: Partial<AppSummary>): AppSummary => ({
  id: "a",
  name: "应用",
  searchKeys: [],
  publisher: "厂商",
  categoryId: "dev",
  iconUrl: "",
  latestVersion: "1.0.0",
  downloadCount: 0,
  badge: "normal",
  tags: [],
  requiresApproval: false,
  sizeBytes: 1,
  ...over,
});

function entry(id: string, installState: InstallState, installedVersion: string | null): CatalogEntry {
  const action = installState === "upgradable" ? "upgrade" : installState === "installed" ? "open" : installState === "needs-approval" ? "request" : "install";
  return {
    app: app({ id, name: id }),
    ratings: null,
    iconUrl: null,
    installState,
    action,
    installedVersion,
    otherVersions: [],
    categoryPath: [],
    matchQuality: installedVersion ? 3 : 0,
  };
}

test("buildAssetSummary derives install states and counts from the joined view", () => {
  const summary = buildAssetSummary({
    machineId: "pc-01",
    appVersion: "1.2.3",
    pendingApprovals: 2,
    reportedAt: "2026-10-06T00:00:00.000Z",
    entries: [
      entry("wps", "installed", "12.0.0"),
      entry("code", "upgradable", "3.0.0"),
      entry("vpn", "needs-approval", null),
      entry("music", "not-installed", null),
    ],
  });

  assert.equal(summary.machineId, "pc-01");
  assert.equal(summary.appVersion, "1.2.3");
  assert.equal(summary.reportedAt, "2026-10-06T00:00:00.000Z");
  // 只上报已装的（installed + upgradable），未装与待审批不进 installed 列表。
  assert.deepEqual(summary.installed, [
    { appId: "code", version: "3.0.0", upgradable: true },
    { appId: "wps", version: "12.0.0", upgradable: false },
  ]);
  assert.deepEqual(summary.needsApproval, ["vpn"]);
  assert.deepEqual(summary.counts, { installed: 2, upgradable: 1, needsApproval: 1, pendingApprovals: 2 });
});

test("buildAssetSummary defaults pendingApprovals and clamps negatives", () => {
  const summary = buildAssetSummary({ machineId: "m", appVersion: "0", entries: [], pendingApprovals: -5 });
  assert.equal(summary.counts.pendingApprovals, 0);
  assert.deepEqual(summary.installed, []);
  assert.deepEqual(summary.needsApproval, []);
  assert.ok(summary.reportedAt.length > 0, "reportedAt defaults to now");
});

test("asset payload stays within the software-inventory scope boundary", () => {
  const summary = buildAssetSummary({
    machineId: "pc-02",
    appVersion: "1.0.0",
    entries: [entry("wps", "installed", "12.0.0")],
  });
  // 上报面就是这几个字段，任何终端行为采集都不应出现在心跳里。
  assert.deepEqual(Object.keys(summary).sort(), ["appVersion", "counts", "installed", "machineId", "needsApproval", "reportedAt"]);
  assert.deepEqual(Object.keys(summary.counts).sort(), ["installed", "needsApproval", "pendingApprovals", "upgradable"]);
  for (const item of summary.installed) assert.deepEqual(Object.keys(item).sort(), ["appId", "upgradable", "version"]);
  const wire = JSON.stringify(summary).toLowerCase();
  for (const forbidden of ["process", "behavior", "screen", "browser", "window", "keystroke", "hostname", "path"]) {
    assert.ok(!wire.includes(forbidden), "心跳不得包含 " + forbidden + " 一类的终端行为字段");
  }
});
