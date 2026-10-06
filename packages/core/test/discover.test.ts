import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultInstallerRoots,
  installerScore,
  matchInstalledProgram,
  packageId,
  packageToCatalogApp,
  parseInstallerName,
  guessCategory,
  toPackage,
  type DiscoveredPackage,
  type InstallerCandidate,
  type InstalledApp,
  type PeVersionInfo,
} from "@appcenter/core";

const BS = String.fromCharCode(92);

function candidate(file: string, overrides: Partial<InstallerCandidate> = {}): InstallerCandidate {
  const rootDir = overrides.rootDir ?? ["C:", "Users", "me", "Downloads"].join(BS);
  return {
    file,
    sizeBytes: 1024 * 1024,
    modifiedAt: "2026-10-06T00:00:00.000Z",
    root: overrides.root ?? "user-downloads",
    rootDir,
    extension: overrides.extension ?? ".exe",
  };
}

test("defaultInstallerRoots 从环境变量推目录，不写死盘符", () => {
  const roots = defaultInstallerRoots(
    { USERPROFILE: ["C:", "Users", "me"].join(BS), SystemRoot: ["C:", "Windows"].join(BS), ProgramData: ["C:", "ProgramData"].join(BS), LOCALAPPDATA: ["C:", "Users", "me", "AppData", "Local"].join(BS), PublicProfile: ["C:", "Users", "Public"].join(BS) },
    ["C:", "Users", "me"].join(BS),
  );
  const ids = roots.map((r) => r.id);
  assert.deepEqual(ids, ["user-downloads", "public-downloads", "package-cache", "wu-downloads", "local-temp-downloads"]);
  // 没有任何硬编码 C:\\ 或 D:\\ 字面量出现在推导逻辑里——所有路径都来自 env。
  for (const root of roots) assert.ok(root.dir.includes("Users") || root.dir.includes("Windows") || root.dir.includes("ProgramData"));
});

test("parseInstallerName 从厂商构建命名里认出版本与架构", () => {
  const quark = parseInstallerName("QuarkPC_V6.9.1.868_pc_pf30002_(zh-cn)_wpnoshortcut_(Build3021942-1001-x64).exe");
  assert.equal(quark.version, "6.9.1.868");
  assert.equal(quark.architecture, "x64");
  assert.equal(quark.locale, "zh-cn");
  assert.ok(quark.tokens.some((t) => t.startsWith("build@")));

  const ditto = parseInstallerName("DittoSetup_64bit_3_24_246_0.exe");
  assert.equal(ditto.version, "3.24.246.0");
  assert.equal(ditto.architecture, "64bit");
  assert.ok(ditto.name.toLowerCase().includes("ditto"));
});

test("installerScore 把解压目录里的应用本体/卸载器挡在目录之外", () => {
  const appBinary = installerScore(candidate(["C:", "Temp", "~nsu.tmp", "Au_.exe"].join(BS), { root: "local-temp-downloads" }), null, "Au_.exe");
  assert.ok(appBinary.score < 2, "NSIS 临时壳不应进目录");

  const uninstaller = installerScore(candidate(["C:", "Program Files", "Foo", "uninst.exe"].join(BS), { root: "user-downloads" }), null, "uninst.exe");
  assert.ok(uninstaller.score < 2, "卸载器不应进目录");

  const setup = installerScore(candidate(["C:", "Users", "me", "Downloads", "DittoSetup_64bit_3_24_246_0.exe"].join(BS)), null, "DittoSetup_64bit_3_24_246_0.exe");
  assert.ok(setup.score >= 2, "下载目录根下的 setup 应进目录");
});

function installedApp(displayName: string, displayVersion: string, regDir: string): InstalledApp {
  return {
    regDir,
    registryPath: ["SOFTWARE", "Microsoft", "Windows", "CurrentVersion", "Uninstall", regDir].join("\\"),
    hive: "HKLM",
    scope: "machine",
    displayName,
    displayVersion,
    publisher: "",
    installLocation: null,
    uninstallString: null,
    quietUninstallString: null,
    displayIcon: null,
    isMsi: false,
    estimatedSizeKb: 0,
    installDate: null,
    systemComponent: false,
    needsElevation: false,
  };
}

test("matchInstalledProgram 按归一化显示名模糊联本机清单", () => {
  const installed: InstalledApp[] = [installedApp("Ditto 3.24.246.0", "3.24.246.0", "Ditto_is1")];
  const hit = matchInstalledProgram("Ditto", "3.24.246.0", installed);
  assert.ok(hit);
  assert.equal(hit?.displayName, "Ditto 3.24.246.0");
  assert.equal(hit?.sameVersion, true);

  const miss = matchInstalledProgram("NothingLikeThis", "1.0", installed);
  assert.equal(miss, null);
});

test("toPackage 优先用文件名版本而非打包器 PE 版本", () => {
  const pe: PeVersionInfo = { productName: "Quark Installer", productVersion: "4.0.0.4", fileVersion: "4.0.0.4", companyName: "Quark", fileDescription: "", originalFilename: "setup.exe" };
  const pkg = toPackage(candidate(["C:", "Users", "me", "Downloads", "QuarkPC_V6.9.1.868.exe"].join(BS)), pe, []);
  assert.equal(pkg.appVersion, "6.9.1.868", "文件名里的真实版本应覆盖打包器版本");
  assert.equal(pkg.naming, "pe-version");
});

test("packageId 给出稳定、本机唯一的 id", () => {
  const a = candidate(["C:", "x", "QuarkPC_V6.9.1.868.exe"].join(BS));
  const pkg: DiscoveredPackage = { candidate: a, version: null, name: "Quark PC", publisher: "Quark", appVersion: "6.9.1.868", architecture: "x64", installed: null, naming: "filename", notes: [], installerScore: 3 };
  const id = packageId(pkg);
  assert.ok(id.startsWith("local-"));
  assert.ok(id.includes("quark"));
});

test("guessCategory 把线索映射到已存在的分类 id", () => {
  const make = (name: string): DiscoveredPackage => ({ candidate: candidate("x.exe"), version: null, name, publisher: "", appVersion: "1.0", architecture: null, installed: null, naming: "basename", notes: [], installerScore: 3 });
  assert.equal(guessCategory(make("Visual Studio Code")), "dev");
  assert.equal(guessCategory(make("WPS Office")), "office-doc");
  assert.equal(guessCategory(make("网易云音乐")), "media");
  assert.equal(guessCategory(make("终端安全防护")), "security");
  assert.equal(guessCategory(make("Some Unknown Thing")), "other");
});

test("packageToCatalogApp 用 file:// 指回原文件并带上真实大小/校验", () => {
  const pkg: DiscoveredPackage = {
    candidate: candidate(["C:", "Users", "me", "Downloads", "DittoSetup_64bit_3_24_246_0.exe"].join(BS)),
    version: null,
    name: "Ditto",
    publisher: "Ditto",
    appVersion: "3.24.246.0",
    architecture: "64bit",
    installed: null,
    naming: "filename",
    notes: ["version@3.24.246.0"],
    installerScore: 3,
  };
  const app = packageToCatalogApp(pkg, "a".repeat(64));
  assert.ok(app.versions[0]?.downloadUrl.startsWith("file:///"));
  assert.equal(app.sizeBytes, pkg.candidate.sizeBytes);
  assert.equal(app.versions[0]?.sha256, "a".repeat(64));
  assert.equal(app.versions[0]?.silent.kind, "nsis");
});
