import { test } from "node:test";
import assert from "node:assert/strict";
import { toPackage, type InstalledApp, type InstallerCandidate, type PeVersionInfo } from "@appcenter/core";

const BS = String.fromCharCode(92);

function app(displayName: string, displayVersion = "1.0.0"): InstalledApp {
  return {
    regDir: displayName.replace(/\W+/g, "") || "X",
    registryPath: ["HKLM", "SOFTWARE", "Microsoft", "Windows", "CurrentVersion", "Uninstall", "k"].join(BS),
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

function candidate(fileName: string): InstallerCandidate {
  const file = "C:" + BS + "dl" + BS + fileName;
  return { file, sizeBytes: 1024, modifiedAt: "2026-01-01T00:00:00.000Z", root: "downloads", rootDir: "C:" + BS + "dl", extension: ".exe" };
}

const pe = (over: Partial<PeVersionInfo>): PeVersionInfo => ({
  fileDescription: "",
  originalFilename: "",
  productName: "",
  productVersion: "",
  fileVersion: "",
  companyName: "",
  ...over,
});

const fromFile = (fileName: string, installed: InstalledApp[]) => toPackage(candidate(fileName), null, installed);

test("已装清单里有权威拼写时，发布名要用注册表的显示名而不是我们猜的断词", () => {
  // 三个夹具文件名先由 parseInstallerName 实测过：分别被切成
  // `Win RTIntellisense UAPOther Languages`、`Windows Io TExtension SDK`、`Win App Deploy`。
  const installed = [app("WinRT Intellisense UAP - Other Languages"), app("Windows IoT Extension SDK"), app("WinAppDeploy")];
  assert.equal(fromFile("WinRTIntellisenseUAPOtherLanguagesv10.1.0.exe", installed).name, "WinRT Intellisense UAP - Other Languages");
  assert.equal(fromFile("WindowsIoTExtensionSDK-10.1.0.exe", installed).name, "Windows IoT Extension SDK");
  assert.equal(fromFile("WinAppDeploy-10.1.0.exe", installed).name, "WinAppDeploy");
});

test("前置事实：没有已装项可参照时，名字仍然是被切坏的（证明上一条替换确实起作用）", () => {
  const alone = fromFile("WinRTIntellisenseUAPOtherLanguagesv10.1.0.exe", []);
  assert.match(alone.name, /Win RT/, "驼峰拆分不再产生这种断词了，本用例的前提要重新评估（实际 " + alone.name + "）");
});

test("只在拼写等价时替换：带版本尾巴的匹配不得改写名字", () => {
  const pkg = fromFile("Ditto-3.24.246.0.exe", [app("Ditto 3.24.246.0", "3.24.246.0")]);
  assert.ok(pkg.installed, "先该能配上，否则这条护栏没测到东西");
  assert.equal(pkg.name, "Ditto", "去空格后不等价 ⇒ 不该换成带版本的显示名，实际 " + pkg.name);
});

test("对照：PE 资源给的名字优先，不被已装拼写覆盖", () => {
  const pkg = toPackage(
    candidate("codebuddy-cn-setup-1.106.1.exe"),
    pe({ productName: "CodeBuddy CN", productVersion: "1.106.1", companyName: "Tencent Technology (Shenzhen) Company Limited" }),
    [app("CodeBuddy CN (User)")],
  );
  assert.equal(pkg.naming, "pe-version");
  assert.equal(pkg.name, "CodeBuddy CN", "PE 已给权威产品名，不该再被注册表拼写改写");
});
