import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildUpgradePlan,
  defaultSilent,
  type AppDetail,
  type AppSummary,
  type InstalledApp,
  type UpgradeCandidate,
  type UpgradePlanInput,
} from "@appcenter/core";

const BS = String.fromCharCode(92);
const NAME = "Universal CRT Redistributable";

/** 同名不同实例：真机上就是两条不同 GUID、两个版本的卸载项。 */
function installed(displayVersion: string, regDir: string): InstalledApp {
  return {
    regDir,
    registryPath: ["HKLM", "SOFTWARE", "Microsoft", "Windows", "CurrentVersion", "Uninstall", regDir].join(BS),
    hive: "HKLM",
    scope: "machine-64",
    displayName: NAME,
    displayVersion,
    publisher: "Microsoft",
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

function summary(latestVersion: string): AppSummary {
  return {
    id: "crt",
    name: NAME,
    searchKeys: [NAME],
    publisher: "Microsoft",
    categoryId: "runtime",
    iconUrl: "",
    latestVersion,
    downloadCount: 0,
    badge: "normal",
    tags: [],
    requiresApproval: false,
    sizeBytes: 10,
  };
}

function planInput(list: InstalledApp[], latestVersion: string, minUpgradeFrom?: string): UpgradePlanInput {
  const summaryApp = summary(latestVersion);
  const detail: AppDetail = {
    ...summaryApp,
    description: "",
    screenshots: [],
    versions: [
      {
        version: latestVersion,
        releasedAt: "2026-01-01",
        sizeBytes: summaryApp.sizeBytes,
        sha256: "x",
        downloadUrl: "/dl/crt.exe",
        releaseNotes: "",
        silent: defaultSilent("nsis"),
        ...(minUpgradeFrom ? { minUpgradeFrom } : {}),
      },
    ],
  };
  return {
    installed: list,
    catalog: [summaryApp],
    details: async (id) => (id === summaryApp.id ? detail : null),
  };
}

const run = (input: UpgradePlanInput): Promise<UpgradeCandidate[]> => buildUpgradePlan(input);

test("同名不同实例时，低版本那条不许被高版本兄弟遮挡掉", async () => {
  // 清单里先出现 3.0.0（排序碰到的第一条），另有 1.0.0 一条；目录最新 2.0.0。
  const candidates = await run(planInput([installed("3.0.0", "{HIGH}"), installed("1.0.0", "{LOW}")], "2.0.0"));
  assert.equal(candidates.length, 1, "过时的 1.0.0 实例被藏起来了（旧实现 find 取到 3.0.0，判成已是最新）");
  assert.equal(candidates[0]?.installedVersion, "1.0.0", "候选要按那条真正过时的实例报版本");
});

test("action 要按最需要谨慎的那条实例定，而不是按排序碰到的第一条", async () => {
  // 1.0.0 低于 minUpgradeFrom=2.0.0 ⇒ 必须先卸载再装；若按 4.0.0 那条算就会报「可直接覆盖」。
  const candidates = await run(planInput([installed("4.0.0", "{NEW}"), installed("1.0.0", "{OLD}")], "5.0.0", "2.0.0"));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.installedVersion, "1.0.0", "参与决策的应是最低那条");
  assert.equal(candidates[0]?.action, "uninstall-then-install", "实际给出的动作是 " + String(candidates[0]?.action) + "（可直接覆盖是错的）");
});

test("多实例时把全部在装版本暴露出来，界面才不能说谎", async () => {
  const candidates = await run(planInput([installed("3.0.0", "{HIGH}"), installed("1.0.0", "{LOW}")], "4.0.0"));
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0]?.installedVariants, ["1.0.0", "3.0.0"], "同名两条的版本都要能被看见，实际 " + JSON.stringify(candidates[0]?.installedVariants));
});

test("对照：单实例的正常路径不许被改动", async () => {
  const outdated = await run(planInput([installed("1.0.0", "{SOLO}")], "2.0.0"));
  assert.equal(outdated.length, 1, "单实例过时要出候选");
  assert.equal(outdated[0]?.action, "overwrite", "没有 minUpgradeFrom 约束时可直接覆盖");
  assert.equal(outdated[0]?.installedVariants, undefined, "单实例不该冒出「多实例」标记");

  const upToDate = await run(planInput([installed("2.0.0", "{SOLO}")], "2.0.0"));
  assert.equal(upToDate.length, 0, "已是最新不该造出候选");
});

test("对照：全空白 DisplayVersion 仍不参与比较（别把 #28 的收口改回去）", async () => {
  const candidates = await run(planInput([installed("", "{BLANK}"), installed("   ", "{SPACES}")], "9.0.0"));
  assert.equal(candidates.length, 0, "空白版本参与比较会造出永远升不完的候选");
});
