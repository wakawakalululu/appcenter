import { test } from "node:test";
import assert from "node:assert/strict";
import { matchInstalledProgram, type InstalledApp } from "@appcenter/core";

const BS = String.fromCharCode(92);

function app(displayName: string, displayVersion: string): InstalledApp {
  return {
    regDir: displayName.replace(/\W+/g, "") || "X",
    registryPath: ["HKLM", "SOFTWARE", "Microsoft", "Windows", "CurrentVersion", "Uninstall", displayName].join(BS),
    hive: "HKLM",
    scope: "machine-64",
    displayName,
    displayVersion,
    publisher: "Microsoft",
    installLocation: null,
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

/** 真机 141 项里的原样形状：泛用条目在清单里排在前面。 */
const sdkSet = (): InstalledApp[] => [
  app("Windows SDK", "10.1.26100.7705"),
  app("Windows SDK Desktop Headers arm64", "10.1.26100.7705"),
  app("Windows SDK Desktop Headers x64", "10.1.26100.7705"),
  app("Windows SDK Desktop Headers x86", "10.1.26100.7705"),
];

test("安装包要配到最具体的那条已装项，而不是清单里第一条能对上的", () => {
  const hit = matchInstalledProgram("Windows SDK Desktop Headers", "10.1.26100", sdkSet());
  assert.ok(hit, "该配上的");
  assert.ok(
    /Desktop Headers/.test(hit.displayName),
    "配到了泛用条目 " + hit.displayName + "：真机上 `Windows SDK Desktop Headers/Libs/Direct X` 三个名字都被并到 `Windows SDK`，而具体条目就在同一份清单里",
  );
});

test("同具体度时用安装包自己的架构决胜", () => {
  const hit = matchInstalledProgram("Windows SDK Desktop Headers", "10.1.26100", sdkSet(), "x64");
  assert.equal(hit?.displayName, "Windows SDK Desktop Headers x64", "实际配到 " + String(hit?.displayName));

  const arm = matchInstalledProgram("Windows SDK Desktop Headers", "10.1.26100", sdkSet(), "arm64");
  assert.equal(arm?.displayName, "Windows SDK Desktop Headers arm64", "架构换了就必须跟着换，实际 " + String(arm?.displayName));
});

test("对照：只有一个候选时照旧命中，无关名字仍然不配", () => {
  const single = [app("CodeBuddy CN (User)", "1.106.1")];
  const hit = matchInstalledProgram("CodeBuddy CN", "1.106.1", single);
  assert.equal(hit?.displayName, "CodeBuddy CN (User)", "真机这一条是合法的限定词尾巴，不能被收口弄丢");
  assert.equal(hit?.sameVersion, true, "版本一致要如实标出来");

  assert.equal(matchInstalledProgram("NothingLikeThis", "1.0", single), null, "不相干的名字不该配上");
});

test("对照：最具体匹配不改写版本判定，取到谁的版本就说谁", () => {
  const set = [app("Windows SDK", "10.1.11111"), app("Windows SDK Desktop Libs x64", "10.1.26100.7705")];
  // 安装包版本写的是 10.1.26100，与选中的那条（…7705）不同串 ⇒ sameVersion 必须为 false。
  const hit = matchInstalledProgram("Windows SDK Desktop Libs", "10.1.26100", set, "x64");
  assert.equal(hit?.displayName, "Windows SDK Desktop Libs x64");
  assert.equal(hit?.displayVersion, "10.1.26100.7705", "认领的版本必须来自被选中的那条，而不是泛用条目");
  assert.equal(hit?.sameVersion, false, "版本串不同却标成同版本，就会把可升级说成已安装同款");

  const same = matchInstalledProgram("Windows SDK Desktop Libs", "10.1.26100.7705", set, "x64");
  assert.equal(same?.sameVersion, true, "字面相同才算同款同版本");
});
