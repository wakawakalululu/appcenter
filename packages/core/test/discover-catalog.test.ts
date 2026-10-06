import { test } from "node:test";
import assert from "node:assert/strict";
import { guessCategory, packageToCatalogApp, parseInstallerName, type DiscoveredPackage } from "@appcenter/core";

const BS = String.fromCharCode(92);

function pkg(fields: { file: string; extension: string; appVersion?: string; name?: string; publisher?: string }): DiscoveredPackage {
  const candidate = { file: "C:" + BS + "pkgs" + BS + fields.file, extension: fields.extension, sizeBytes: 1024, modifiedAt: "2026-09-01T00:00:00.000Z" };
  return {
    candidate,
    version: null,
    name: fields.name ?? fields.file.replace(/\.[^.]+$/, ""),
    publisher: fields.publisher ?? "本机厂商",
    appVersion: fields.appVersion ?? "0.0.0",
    architecture: null,
    installed: null,
    naming: "filename",
    notes: [],
    installerScore: 4,
  } as unknown as DiscoveredPackage;
}

test("文件名里写着版本号时，PE 探测不到也不该落成占位的 0.0.0", () => {
  const detail = packageToCatalogApp(pkg({ file: "DittoSetup_64bit_3_24_246_0.exe", extension: ".exe", appVersion: "0.0.0" }), "ab".repeat(32));
  assert.equal(detail.latestVersion, "3.24.246.0", "旧写法 `appVersion === \"0.0.0\" ? \"0.0.0\" : appVersion` 两个分支同值，等于没兜底");
  assert.equal(detail.versions[0]?.version, "3.24.246.0");
  assert.match(detail.id, /^local-/, "同一台机器重复发现不该产生新 id");
});

test("PE 给到真实版本时以它为准，文件名不反过来覆盖", () => {
  const detail = packageToCatalogApp(pkg({ file: "QuarkPC_V6.9.1.868_pc_setup.exe", extension: ".exe", appVersion: "6.9.1.868" }), "cd".repeat(32));
  assert.equal(detail.latestVersion, "6.9.1.868");
});

test("三种扩展名各按自己的静默约定，.msp 不再被套上 NSIS 参数", () => {
  const exe = packageToCatalogApp(pkg({ file: "app-setup.exe", extension: ".exe" }), "ef".repeat(32));
  assert.deepEqual(exe.versions[0]?.silent.installArgs, ["/S", "/D={target}"]);

  const msi = packageToCatalogApp(pkg({ file: "tool.msi", extension: ".msi" }), "f0".repeat(32));
  assert.equal(msi.versions[0]?.silent.kind, "msi");
  assert.deepEqual(msi.versions[0]?.silent.installArgs, ["/i", "{file}", "/qn", "/norestart"]);

  const msp = packageToCatalogApp(pkg({ file: "patch-1.2.3.msp", extension: ".msp", appVersion: "1.2.3" }), "f1".repeat(32));
  assert.equal(msp.versions[0]?.silent.kind, "msi", "补丁仍走 msiexec");
  assert.deepEqual(msp.versions[0]?.silent.installArgs, ["/p", "{file}", "/qn", "REBOOT=ReallySuppress"], "旧实现给 .msp 传 NSIS 的 /S /D=");
  assert.equal(msp.versions[0]?.silent.requiresAdmin, true, "打补丁需要提权");
});

test("分类短词要有边界：image 不等于 IM、docker 不等于文档", () => {
  assert.equal(guessCategory(pkg({ file: "ImageComposerSetup.exe", extension: ".exe", name: "Image Composer" })), "other", "旧规则的裸 `im` 把 image 判成通讯/IM");
  assert.equal(guessCategory(pkg({ file: "DockerDesktopInstaller.exe", extension: ".exe", name: "Docker Desktop" })), "other", "旧规则的裸 `doc` 把 docker 判成办公软件");

  assert.equal(guessCategory(pkg({ file: "wps-office-setup.exe", extension: ".exe", name: "WPS Office" })), "office-doc");
  assert.equal(guessCategory(pkg({ file: "team-im-client.msi", extension: ".msi", name: "Team IM Client" })), "office-doc", "真正的 IM 产品仍要认出来");
  assert.equal(guessCategory(pkg({ file: "note-taker.exe", extension: ".exe", name: "Note Taker" })), "office-doc");
  assert.equal(guessCategory(pkg({ file: "vc_redist.x64.exe", extension: ".exe", name: "Microsoft Visual C++ 2022 Redistributable" })), "dev");
});

test("parseInstallerName 仍是版本兜底的来源（不改它的既有语义）", () => {
  assert.equal(parseInstallerName("DittoSetup_64bit_3_24_246_0.exe").version, "3.24.246.0");
  assert.equal(parseInstallerName("QuarkPC_V6.9.1.868_pc_setup.exe").version, "6.9.1.868");
  assert.equal(parseInstallerName("plain-installer.exe").version, null);
});
