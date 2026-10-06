import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRegQuery, readValue } from "@appcenter/core";
import { parseUninstallCommand, tokenizeCommandLine } from "@appcenter/core";

const BS = String.fromCharCode(92);

test("值名里的空格不再让整行被丢弃（真机测得 63 条被救回）", () => {
  const output = [
    `HKEY_LOCAL_MACHINE${BS}SOFTWARE${BS}Microsoft${BS}Windows${BS}CurrentVersion${BS}Uninstall${BS}Ditto_is1`,
    "    DisplayName    REG_SZ    Ditto (x64) 0.28.0",
    "    Inno Setup: App Path    REG_SZ    C:\\Program Files\\Ditto",
    "    Inno Setup: Selected Tasks    REG_SZ    runatstartup",
    "    MajorVersion    REG_DWORD    0x1c",
    "    NullValue    REG_SZ",
    "",
  ].join("\r\n");

  const values = parseRegQuery(output)[0]!.values;
  const names = values.map((v) => v.name);
  assert.deepEqual(names, ["DisplayName", "Inno Setup: App Path", "Inno Setup: Selected Tasks", "MajorVersion", "NullValue"]);
  assert.equal(readValue(parseRegQuery(output)[0]!, "Inno Setup: App Path"), "C:\\Program Files\\Ditto");
});

test("REG_DWORD/QWORD 的 0x 文本归一成十进制，WindowsInstaller 才比较得上", () => {
  const key = parseRegQuery([
    `HKEY_LOCAL_MACHINE${BS}SOFTWARE${BS}Foo`,
    "    WindowsInstaller    REG_DWORD    0x1",
    "    EstimatedSize    REG_DWORD    0x64000",
    "    BigThing    REG_QWORD    0x10",
    "    Zero    REG_DWORD    0x0",
  ].join("\r\n"))[0]!;
  assert.equal(readValue(key, "WindowsInstaller"), "1");
  assert.equal(Number(readValue(key, "EstimatedSize") ?? 0), 409600);
  assert.equal(readValue(key, "BigThing"), "16");
  assert.equal(readValue(key, "Zero"), "0");
});

test("卸载串分词：引号内整体成段，未加引号时只在开关处断开", () => {
  assert.deepEqual(tokenizeCommandLine("C:\\Program Files\\Ditto\\unins000.exe /SILENT"), [
    "C:\\Program Files\\Ditto\\unins000.exe",
    "/SILENT",
  ]);
  assert.deepEqual(tokenizeCommandLine('"C:\\Program Files\\Some App\\unins000.exe" /SILENT /ALLUSERS'), [
    "C:\\Program Files\\Some App\\unins000.exe",
    "/SILENT",
    "/ALLUSERS",
  ]);
  assert.deepEqual(tokenizeCommandLine("C:\\Users\\me\\AppData\\Local\\Programs\\x\\uninstall.exe --uninstall -s"), [
    "C:\\Users\\me\\AppData\\Local\\Programs\\x\\uninstall.exe",
    "--uninstall",
    "-s",
  ]);
});

test("回归：不剥引号也不按空白乱切，程序名不再是 C:\\Program", () => {
  const inno = parseUninstallCommand("C:\\Program Files\\Ditto\\unins000.exe /SILENT", false);
  assert.equal(inno.program, "C:\\Program Files\\Ditto\\unins000.exe");
  assert.deepEqual(inno.args, ["/SILENT"]);

  const quoted = parseUninstallCommand('"C:\\Program Files\\Some App\\unins000.exe" /ALLUSERS', true);
  assert.equal(quoted.program, "C:\\Program Files\\Some App\\unins000.exe");
  assert.deepEqual(quoted.args, ["/ALLUSERS", "/S"]);

  const msi = parseUninstallCommand("C:\\Windows\\System32\\msiexec.exe /X{12345678-1234-1234-1234-123456789012}", true);
  assert.equal(msi.program, "msiexec.exe");
  assert.deepEqual(msi.args, ["/x", "{12345678-1234-1234-1234-123456789012}", "/qn", "/norestart"]);

  // 中文程序名 + 空格：旧实现同样折断
  const cjk = parseUninstallCommand('"C:\\Program Files\\哔哩哔哩\\卸载哔哩哔哩.exe"', true);
  assert.equal(cjk.program, "C:\\Program Files\\哔哩哔哩\\卸载哔哩哔哩.exe");
});

test("已知残余形态：未加引号且参数不以开关开头时仍会连成一段（不假装解决）", () => {
  const awkward = tokenizeCommandLine("C:\\Tools\\uninst.exe purge all");
  assert.equal(awkward.length, 1, "这条记录的是当前分词的边界，不是期望行为");
});
