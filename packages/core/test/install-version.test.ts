import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UNINSTALL_ROOTS,
  regKey,
  toInstalledApp,
  resolveInstalledVersion,
  selectPriorInstall,
  type InstalledApp,
} from "@appcenter/core";

const BS = String.fromCharCode(92);
const root = UNINSTALL_ROOTS[0]?.path ?? "";

/** 用卸载注册表键构造一条真实的已装记录，避免手写十几个字段。 */
function app(displayName: string, displayVersion: string, regDir: string): InstalledApp {
  const built = toInstalledApp(
    regKey(root + BS + regDir, { DisplayName: displayName, DisplayVersion: displayVersion }),
    "machine-64",
    "HKLM",
    false,
  );
  if (!built) throw new Error("failed to build InstalledApp fixture");
  return built;
}

const crt = [app("Universal CRT Redistributable", "10.0.26624", "crt-a"), app("Universal CRT Redistributable", "10.1.26100.7705", "crt-b")];

test("装后回读：无同名候选判为未命中", () => {
  assert.equal(resolveInstalledVersion("Ghost", undefined, []), undefined);
});

test("装后回读：唯一同名候选如实返回其实际版本（即便与请求不同）", () => {
  const single = [app("Demo", "1.2.3", "demo")];
  assert.equal(resolveInstalledVersion("Demo", "9.9.9", single), "1.2.3");
  assert.equal(resolveInstalledVersion("Demo", undefined, single), "1.2.3");
});

test("装后回读：同名多条时用请求版本唯一定位", () => {
  assert.equal(resolveInstalledVersion("Universal CRT Redistributable", "10.1.26100.7705", crt), "10.1.26100.7705");
});

test("装后回读：同名多条且无法用请求版本定位时判未命中，绝不取首条的错误版本", () => {
  assert.equal(resolveInstalledVersion("Universal CRT Redistributable", "7.0.0", crt), undefined);
  assert.equal(resolveInstalledVersion("Universal CRT Redistributable", undefined, crt), undefined);
});

test("前置检查：同名多条取版本最高的一条，与入参顺序无关", () => {
  assert.equal(selectPriorInstall("Universal CRT Redistributable", crt)?.displayVersion, "10.1.26100.7705");
  assert.equal(selectPriorInstall("Universal CRT Redistributable", [...crt].reverse())?.displayVersion, "10.1.26100.7705");
  assert.equal(selectPriorInstall("Missing", crt), undefined);
});
