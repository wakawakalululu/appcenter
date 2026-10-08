import { test } from "node:test";
import assert from "node:assert/strict";
import { matchInstalledProgram } from "../src/localrepo/discover.ts";

type InstalledArg = Parameters<typeof matchInstalledProgram>[2];
type App = InstalledArg[number];

const app = (displayName: string, displayVersion: string, regDir = "HKLM\\X"): App =>
  ({ displayName, displayVersion, regDir, publisher: "Microsoft" }) as unknown as App;

const installedOf = (...rows: Array<[string, string]>): InstalledArg =>
  rows.map(([n, v]) => app(n, v)) as unknown as InstalledArg;

// 真机量到的危害形状（2026-10-07，85 个安装包 × 141 条已装）：8 对唯一配对里，
// 目录侧认领的是**同族不同子组件**，而目录视图与升级计划用的同一套判据给它们打 0 分。
// 两边判据不一致，就会给这些包写上别人的显示名与版本号（界面据此显示"已装 X"）。
test("子组件尾巴不是限定词时不认领：WACK 基础包不该认领 SupportedApiList 那条", () => {
  const installed = installedOf(["Windows App Certification Kit SupportedApiList x86", "10.1.26100.7705"]);
  assert.equal(matchInstalledProgram("Windows App Certification Kit", "10.1.26100.4000", installed, "x86"), null);
});

test("同族子组件一律不认领：DirectX / Desktop Headers / SDK 缩写三例", () => {
  const cases: Array<[string, string]> = [
    ["Windows SDK Direct X", "Windows SDK DirectX x86 Remote"],
    ["Windows SDK", "Windows SDK Desktop Headers x86"],
    ["SDK", "Windows SDK Desktop Headers x86"],
    ["Application Verifier", "Application Verifier x64 External Package (DesktopEditions)"],
  ];
  for (const [name, displayName] of cases) {
    assert.equal(matchInstalledProgram(name, "10.1.1", installedOf([displayName, "10.1.26100.7705"]), "x64"), null, name + " 不该认领 " + displayName);
  }
});

test("合法形状照常配对：精确同名与带限定词的尾巴不受影响", () => {
  const exact = matchInstalledProgram("Ditto", "3.24.246.0", installedOf(["Ditto", "3.24.246.0"]));
  assert.ok(exact, "精确同名必须照常认领");
  assert.equal(exact?.sameVersion, true);

  const qualified = matchInstalledProgram("演示应用", "2.0.0", installedOf(["演示应用 (x64) 2.0.0", "2.0.0"]));
  assert.ok(qualified, "尾巴是括号限定词时仍是同一款");
  assert.equal(qualified?.displayName, "演示应用 (x64) 2.0.0");
});

test("尾巴是普通词时不认领，但精确同名照常（真机的 Git 形状）", () => {
  assert.equal(matchInstalledProgram("Git", "1.0.0", installedOf(["Git Credential Manager", "2.44.0"])), null, "尾巴是普通词，不是限定词");
  const exact = matchInstalledProgram("Git", "2.44.0", installedOf(["Git", "2.44.0"]));
  assert.equal(exact?.displayName, "Git");
  assert.equal(exact?.sameVersion, true);
});
