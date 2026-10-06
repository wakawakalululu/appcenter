import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShellLink, taskExecutables } from "@appcenter/core";

const BS = String.fromCharCode(92);

function buildLink(options: { target: string; icon?: string; unicode?: boolean }): Buffer {
  const unicode = options.unicode ?? true;
  const header = Buffer.alloc(76);
  header.writeUInt32LE(76, 0);
  Buffer.from("0114020000000000c000000000000046", "hex").copy(header, 4);
  let flags = 0x00000002 | 0x00000040 | 0x00008000;
  if (!unicode) flags = 0x00000002 | 0x00000040;
  header.writeUInt32LE(flags, 20);

  const localPath = Buffer.from(options.target, "latin1");
  const linkInfoSize = 0x14 + localPath.length + 1;
  const linkInfo = Buffer.alloc(0x14);
  linkInfo.writeUInt32LE(linkInfoSize, 0);
  linkInfo.writeUInt32LE(0x14, 4);
  linkInfo.writeUInt16LE(0x14, 0x10);

  const iconChars = options.icon ?? "";
  const iconBuf = unicode ? Buffer.from(iconChars, "utf16le") : Buffer.from(iconChars, "latin1");
  const iconLen = Buffer.alloc(2);
  iconLen.writeUInt16LE(iconChars.length, 0);

  return Buffer.concat([header, linkInfo, localPath, Buffer.alloc(1), iconLen, iconBuf]);
}

test("parses the local base path and the icon location out of a shell link", () => {
  const target = ["C:", "Demo", "app.exe"].join(BS);
  const icon = ["C:", "Demo", "app.ico"].join(BS);
  const link = parseShellLink(buildLink({ target, icon }));
  assert.equal(link?.target, target);
  assert.equal(link?.icon, icon);
});

test("rejects buffers that are not shell links", () => {
  assert.equal(parseShellLink(Buffer.alloc(0)), null);
  const junk = Buffer.alloc(76);
  junk.writeUInt32LE(76, 0);
  assert.equal(parseShellLink(junk), null);
  const wrongHeader = buildLink({ target: ["C:", "Demo", "app.exe"].join(BS) });
  wrongHeader.writeUInt32LE(72, 0);
  assert.equal(parseShellLink(wrongHeader), null);
});

test("a truncated length field cannot leak garbage into the target", () => {
  const link = parseShellLink(buildLink({ target: "not-a-path-at-all" }));
  assert.equal(link?.target, null);
  const relativeOnly = buildLink({ target: ["C:", "Demo", "app.exe"].join(BS) });
  relativeOnly.writeUInt32LE(0x00000040 | 0x00008000, 20);
  const parsed = parseShellLink(relativeOnly);
  assert.ok(parsed);
  assert.equal(parsed?.workingDirectory, null);
});

test("scheduled task xml yields every executable and argument", () => {
  const xml =
    "<?xml version=\"1.0\"?><Task><Actions Context=\"Author\"><Exec>" +
    "<Command>C:" + BS + "Demo" + BS + "app.exe</Command><Arguments>--silent</Arguments>" +
    "</Exec></Actions></Task>";
  assert.deepEqual(taskExecutables(xml), [["C:", "Demo", "app.exe"].join(BS), "--silent"]);
  assert.deepEqual(taskExecutables("<Task><Nothing/></Task>"), []);
});

/**
 * 真机取证：`measure:lnk-targets` 对本机开始菜单 69 个带 LinkInfo 的 .lnk 逐一验证，
 * 本地基路径偏移实际落在 LINKINFO +0x10 处的字段（实测样本该字段=45，路径真字节恰在 +45），
 * 而非教科书直觉的 +0x08。这里用与真实文件同构的字节布局（含 VolumeID 前置块）锁定该契约，
 * 防止日后按“规范偏移”改动反而把真机解析改坏。
 */
test("parses the local base path from a real-shaped LINKINFO (VolumeID block + offset field at +0x10)", () => {
  const target = ["C:", "Program Files (x86)", "Ecloud AI Assist", "aiassistant.exe"].join(BS);
  const localPath = Buffer.from(target, "latin1");
  const pathOffset = 45; // 相对 LINKINFO 起点；真机样本实测值
  const header = Buffer.alloc(76);
  header.writeUInt32LE(76, 0);
  Buffer.from("0114020000000000c000000000000046", "hex").copy(header, 4);
  header.writeUInt32LE(0x00000002, 20); // HAS_LINK_INFO（无 IDList，起点即 76）

  const linkInfo = Buffer.alloc(pathOffset);
  linkInfo.writeUInt32LE(pathOffset + localPath.length + 1, 0x00); // Length
  linkInfo.writeUInt32LE(28, 0x04); // VolumeIDOffset（前置块，真机=28）
  linkInfo.writeUInt32LE(1, 0x08); // 真机该处为 1，不是本地路径偏移
  linkInfo.writeUInt32LE(28, 0x0c);
  linkInfo.writeUInt16LE(pathOffset, 0x10); // 解析器据此取本地基路径

  const link = parseShellLink(Buffer.concat([header, linkInfo, localPath, Buffer.alloc(1)]));
  assert.equal(link?.target, target);
});
