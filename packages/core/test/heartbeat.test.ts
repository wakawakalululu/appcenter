import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAssetSummary, stalenessOf, DEFAULT_STALE_AFTER_MS, type AppSummary, type CatalogEntry, type InstallState } from "@appcenter/core";

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

test("stalenessOf flags offline machines by age against the threshold", () => {
  const now = Date.parse("2026-10-06T12:00:00.000Z");
  const fresh = new Date(now - 60_000).toISOString(); // 1 分钟前
  const old = new Date(now - DEFAULT_STALE_AFTER_MS - 1000).toISOString(); // 刚过 24h

  const f = stalenessOf(fresh, now);
  assert.equal(f.stale, false);
  assert.equal(f.ageMs, 60_000);

  const o = stalenessOf(old, now);
  assert.equal(o.stale, true);
  assert.ok(o.ageMs > DEFAULT_STALE_AFTER_MS);

  // 自定义阈值：同一时间戳在 0.5h 阈值下算离线，在 48h 阈值下算在线。
  const half = stalenessOf(new Date(now - 3600_000).toISOString(), now, 1800_000);
  assert.equal(half.stale, true, "1 小时前 > 0.5h 阈值 → 离线");
  const wide = stalenessOf(new Date(now - 3600_000).toISOString(), now, 48 * 3600_000);
  assert.equal(wide.stale, false, "1 小时前 < 48h 阈值 → 在线");
});

test("stalenessOf treats an unparseable or future timestamp defensively", () => {
  const now = Date.parse("2026-10-06T12:00:00.000Z");
  const junk = stalenessOf("not-a-date", now);
  assert.equal(junk.stale, true, "解析不出来宁可判离线，不谎报在线");
  assert.equal(junk.ageMs, Number.POSITIVE_INFINITY);

  // 未来时间（时钟漂移）机龄夹到 0，不算离线。
  const future = stalenessOf(new Date(now + 3600_000).toISOString(), now);
  assert.equal(future.ageMs, 0);
  assert.equal(future.stale, false);
});
