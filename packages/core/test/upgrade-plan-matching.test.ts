import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUpgradePlan, defaultSilent, type AppDetail, type AppSummary, type InstalledApp, type UpgradePlanInput } from "@appcenter/core";

const BS = String.fromCharCode(92);

function installed(displayName: string, displayVersion: string, publisher: string): InstalledApp {
  return {
    regDir: displayName.replace(/\W+/g, "") || "X",
    registryPath: ["HKLM", "SOFTWARE", "Microsoft", "Windows", "CurrentVersion", "Uninstall", "k"].join(BS),
    hive: "HKLM",
    scope: "machine-64",
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

function planOf(list: InstalledApp[], name: string, latestVersion: string, publisher = "腾讯"): UpgradePlanInput {
  const summary: AppSummary = {
    id: "probe",
    name,
    searchKeys: [name],
    publisher,
    categoryId: "im",
    iconUrl: "",
    latestVersion,
    downloadCount: 0,
    badge: "normal",
    tags: [],
    requiresApproval: false,
    sizeBytes: 1,
  };
  const detail: AppDetail = {
    ...summary,
    description: "",
    screenshots: [],
    versions: [
      {
        version: latestVersion,
        releasedAt: "2026-01-01",
        sizeBytes: 1,
        sha256: "x",
        downloadUrl: "/dl/x.exe",
        releaseNotes: "",
        silent: defaultSilent("nsis"),
      },
    ],
  };
  return { installed: list, catalog: [summary], details: async (id) => (id === summary.id ? detail : null) };
}

/**
 * 真机 140 个显示名两两按旧 `bestMatch`（双向无界子串）量出 **98 对**误配，
 * 其中最刺眼的两组：`微信` ⊂ `企业微信`、`Microsoft Edge` ⊂ `Microsoft Edge WebView2 Runtime`。
 * 升级计划用的是它自己那套匹配，没走 #30 已经收口过的 `matchInstalled` ⇒ 目录里有微信、
 * 机器上只装了企业微信时，会造出一条「企业微信 5.0.11.6018 → 微信 9.x」的假可升级项。
 */
test("目录里的「微信」不得配到机器上的「企业微信」", async () => {
  const candidates = await buildUpgradePlan(planOf([installed("企业微信", "5.0.11.6018", "腾讯"), ], "微信", "9.0.0"));
  assert.equal(candidates.length, 0, "造出了假可升级项：" + JSON.stringify(candidates.map((c) => c.installedVersion + "→" + c.availableVersion)));
});

test("目录里的「Microsoft Edge」不得配到 WebView2 运行时", async () => {
  const candidates = await buildUpgradePlan(
    planOf([installed("Microsoft Edge WebView2 Runtime", "154.0.4258.62", "Microsoft")], "Microsoft Edge", "999.0.0", "Microsoft"),
  );
  assert.equal(candidates.length, 0, "WebView2 是另一个组件，不该被当成 Edge 的在装版本：" + JSON.stringify(candidates.map((c) => c.installedVersion)));
});

test("合法命中必须保留：带版本括号的 WPS 与短名紧跟数字的钉钉", async () => {
  const wps = await buildUpgradePlan(planOf([installed("WPS Office (12.1.0.28488)", "12.1.0.28488", "金山办公")], "WPS Office", "13.0.0", "金山办公"));
  assert.equal(wps.length, 1, "真机唯一的合法包含命中不能被一起砍掉");
  assert.equal(wps[0]?.installedVersion, "12.1.0.28488");

  const ding = await buildUpgradePlan(planOf([installed("钉钉6.5.0", "6.5.0", "钉钉")], "钉钉", "7.0.0", "钉钉"));
  assert.equal(ding.length, 1, "短名 + 紧跟版本号是合法关系（#30 已确认）");
  assert.equal(ding[0]?.installedVersion, "6.5.0");
});

test("架构是硬约束：x86 的目录项不得拿 x64 的在装版本比大小", async () => {
  // 真机上这类条目是成对存在的（Windows SDK Desktop Headers x86 / x64、Universal CRT Tools x86 / x64，
  // 实测 10 对）。共用的词根分支会剥掉尾部架构后缀，把它们并成同一产品 —— 升级侧不能跟。
  const wrong = await buildUpgradePlan(
    planOf([installed("Windows SDK Desktop Headers x64", "10.0.0", "Microsoft")], "Windows SDK Desktop Headers x86", "11.0.0", "Microsoft"),
  );
  assert.equal(wrong.length, 0, "把 x64 当成 x86 的在装版本了：" + JSON.stringify(wrong.map((c) => c.installedVersion)));

  const right = await buildUpgradePlan(
    planOf([installed("Windows SDK Desktop Headers x86", "10.0.0", "Microsoft")], "Windows SDK Desktop Headers x86", "11.0.0", "Microsoft"),
  );
  assert.equal(right.length, 1, "同架构的同名条目必须照常出候选");
  assert.equal(right[0]?.installedVersion, "10.0.0");
});

test("精确同名照旧可升，且空白版本仍不参与", async () => {
  const exact = await buildUpgradePlan(planOf([installed("微信", "8.0.0", "腾讯")], "微信", "9.0.0"));
  assert.equal(exact.length, 1, "同名的正常路径不能被收口误伤");

  const blank = await buildUpgradePlan(planOf([installed("微信", "", "腾讯")], "微信", "9.0.0"));
  assert.equal(blank.length, 0, "空白 DisplayVersion 不参与比较（#28 的收口）");
});
