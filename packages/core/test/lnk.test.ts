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
