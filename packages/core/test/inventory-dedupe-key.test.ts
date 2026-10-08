import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeInstalled } from "../src/inventory/inventory.ts";

type App = Parameters<typeof dedupeInstalled>[0][number];
const app = (over: Partial<App>): App =>
  ({
    regDir: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\X",
    registryPath: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\X",
    hive: "HKLM",
    scope: "machine-64",
    displayName: "示例程序",
    displayVersion: "1.0.0",
    publisher: "厂商",
    installLocation: "C:\\Program Files\\X",
    uninstallString: "MsiExec.exe /X{AAA}",
    estimatedSizeKb: 100,
    systemComponent: false,
    ...over,
  }) as unknown as App;

// 真机 141 条（machine-64 31 / machine-32 100 / user 10）实测合并数为 0，
// 所以这条键目前只是「行为契约」——没有测试钉着，改动它不会有任何信号。
test("同名同版本但装在不同位置：是两个实例，必须都留着", () => {
  const rows = dedupeInstalled([
    app({ installLocation: "C:\\Program Files\\X", regDir: "HKLM\\...\\Uninstall\\X", scope: "machine-64" }),
    app({ installLocation: "C:\\Program Files (x86)\\X", regDir: "HKLM\\...\\WOW6432Node\\Uninstall\\X", scope: "machine-32" }),
  ]);
  assert.equal(rows.length, 2);
});

test("同名同版本、跨 hive 且没有 InstallLocation：靠 regDir 区分，不能并成一条", () => {
  // 这里必须是 null 而不是 ""：dedupe 键用 `installLocation ?? regDir` 回退，
  // 而生产路径的值来自 `readValue(...) ?? null`（空字符串在 readValue 里就归成 undefined 了）。
  // 如果哪天有人让缺失的位置变成 ""，这个回退会静默失效——两条不同注册表键被并成一条。
  const rows = dedupeInstalled([
    app({ installLocation: null, regDir: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Y", scope: "machine-64" }),
    app({ installLocation: null, regDir: "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Y", scope: "user" }),
  ]);
  assert.equal(rows.length, 2, "两条指向不同注册表键，卸载时必须各自可选");
});

test("同一个 InstallLocation 在两个 hive 里重复登记：这才算同一次安装，合并", () => {
  const rows = dedupeInstalled([
    app({ regDir: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Z", scope: "machine-64" }),
    app({ regDir: "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Z", scope: "machine-32" }),
  ]);
  assert.equal(rows.length, 1);
});

test("版本不同永不合并（升级前的旧登记不会被当成同一个）", () => {
  const rows = dedupeInstalled([app({ displayVersion: "1.0.0" }), app({ displayVersion: "1.0.1" })]);
  assert.equal(rows.length, 2);
});

test("大小写差异算同一条（注册表显示名不可信）", () => {
  const rows = dedupeInstalled([app({ displayName: "Some App" }), app({ displayName: "SOME app" })]);
  assert.equal(rows.length, 1);
});
