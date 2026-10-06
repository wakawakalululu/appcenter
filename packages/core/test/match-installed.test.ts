import { test } from "node:test";
import assert from "node:assert/strict";
import { matchInstalled, type AppSummary, type InstalledApp } from "@appcenter/core";

const BS = String.fromCharCode(92);

function item(displayName: string, publisher = "某厂商"): InstalledApp {
  return {
    regDir: "K",
    registryPath: ["HKLM", "SOFTWARE", "Microsoft", "Windows", "CurrentVersion", "Uninstall", "K"].join(BS),
    hive: "HKLM",
    scope: "machine",
    displayName,
    displayVersion: "1.0.0",
    publisher,
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

const app = (name: string, publisher = "某厂商"): AppSummary =>
  ({ id: "a", name, searchKeys: [], publisher, categoryId: "c", iconUrl: "", latestVersion: "1.0.0", downloadCount: 0, badge: "normal", tags: [], requiresApproval: false, sizeBytes: 0 }) as AppSummary;

const quality = (name: string, installedName: string): number => matchInstalled(app(name), [item(installedName)]).quality;

test("回归：短名字不再以「串在中间/末尾」的方式误配（真机两例）", () => {
  // 旧写法是无界 includes 双向匹配：`git` 是 `vsgithubprotocolhandlermsi` 的子串就算命中。
  // 这里故意给不同厂商， isolating 名称这条判据。
  assert.equal(matchInstalled(app("Git", "GitHub 项目组"), [item("vs_githubprotocolhandlermsi", "Microsoft")]).quality, 0, "Git 不该被认成 GitHub 协议处理组件");
  // `微信` 是 `企业微信` 的结尾子串，同样不该命中
  assert.equal(matchInstalled(app("微信", "腾讯科技"), [item("企业微信", "腾讯企业")]).quality, 0, "微信 与 企业微信 是两款不同产品");
  assert.equal(matchInstalled(app("企业微信", "腾讯企业"), [item("微信", "腾讯科技")]).quality, 0, "反向同样不该成立");

  // 同厂商时最多只能到 quality 1；而视图里 installedVersion 只认 quality>=2，
  // 所以厂商这一支不会把「没装」显示成「已装」。
  assert.equal(quality("Git", "vs_githubprotocolhandlermsi"), 1, "厂商同名时只给 1 分，不足以翻转安装态");
});

test("合法的前缀型命中保持有效（含短名 + 紧跟版本号）", () => {
  assert.equal(quality("WPS Office", "WPS Office (12.1.0.28488)"), 2, "这是真机上唯一的合法子串命中，必须留住");
  assert.equal(quality("钉钉", "钉钉6.5.0"), 2, "短名产品后跟版本号时仍要认出来");
  assert.equal(quality("Ditto", "DittoX64"), 2, "≥5 字符的前缀按同一产品处理");
  assert.equal(quality("演示应用", "演示应用"), 3, "完全同名仍是精确命中");
});

test("带版本的显示名现在能被 stem 分支接住（旧正则里的点号分支是死代码）", () => {
  // normalizeName 先把点号删掉，旧 `(…|\d+(\.\d+)+)$` 永远匹配不上；现在按尾部裸数字剥。
  assert.equal(quality("Zoom", "Zoom 5.17.5 (28887)"), 2);
  assert.equal(quality("Adobe Reader", "Adobe Reader XI"), 2);
});
