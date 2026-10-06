import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { trayIconFor, type TrayStatus } from "@appcenter/core";

const ICON_DIR = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "icons"));

const STATUSES: TrayStatus[] = ["idle", "downloading", "update-available", "awaiting-approval", "needs-reboot", "error"];

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** ICONDIR: 保留字 0、类型 1(icon)、条目数。 */
function readIcoHeader(buf: Buffer): { reserved: number; type: number; count: number } {
  return { reserved: buf.readUInt16LE(0), type: buf.readUInt16LE(2), count: buf.readUInt16LE(4) };
}

function icoEntries(buf: Buffer): { width: number; height: number; size: number; offset: number }[] {
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const base = 6 + i * 16;
    entries.push({
      width: (buf[base] ?? 0) === 0 ? 256 : buf[base] ?? 0,
      height: (buf[base + 1] ?? 0) === 0 ? 256 : buf[base + 1] ?? 0,
      size: buf.readUInt32LE(base + 8),
      offset: buf.readUInt32LE(base + 12),
    });
  }
  return entries;
}

test("every tray status has a real .ico on disk", async () => {
  for (const status of STATUSES) {
    const relative = trayIconFor(status).file;
    const buf = await readFile(join(ICON_DIR, ...relative.split("/")));
    const header = readIcoHeader(buf);
    assert.equal(header.reserved, 0, status + " reserved");
    assert.equal(header.type, 1, status + " type must be icon");
    assert.ok(header.count >= 1, status + " must contain at least one image");
    const entries = icoEntries(buf);
    assert.deepEqual(
      entries.map((e) => e.width),
      [16, 32],
      status + " 应含 16 与 32 两档",
    );
    const first = entries[0];
    assert.ok(first, status + " 第一个条目");
    if (first) {
      const png = buf.subarray(first.offset, first.offset + first.size);
      assert.ok(png.subarray(0, 8).equals(PNG_MAGIC), status + " 条目内应是 PNG 数据");
    }
  }
});

test("the app icon is a multi-size ICO including a 256 frame", async () => {
  const buf = await readFile(join(ICON_DIR, "app.ico"));
  assert.equal(readIcoHeader(buf).type, 1);
  const entries = icoEntries(buf);
  assert.deepEqual(entries.map((e) => e.width), [16, 20, 24, 32, 48, 64, 256]);
  for (const entry of entries) {
    assert.equal(entry.width, entry.height, "图标应为正方形");
    const png = buf.subarray(entry.offset, entry.offset + entry.size);
    assert.ok(png.subarray(0, 8).equals(PNG_MAGIC), "每档都应是 PNG");
  }
});
