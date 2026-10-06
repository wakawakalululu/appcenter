#!/usr/bin/env node
/**
 * 零依赖生成 .ico 资源：手写 PNG（zlib + CRC32），再按 Vista+ 的 ICO 规范
 * 把 PNG 字节直接嵌进 ICONDIRENTRY。这样无需任何第三方库即可产出合法图标。
 *
 * 用法：
 *   node packages/app/scripts/gen-icons.mjs [--out <dir>] [--color <name>=#RRGGBB]
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 主色取自 core/src/theme/skin.ts 的 BASE_TOKENS.color.primary，改色请同步那边。 */
const PRIMARY = "#3C5CFE";

export const STATUS_COLORS = {
  idle: PRIMARY,
  progress: "#2F9EFF",
  update: "#22A06B",
  pending: "#D29922",
  reboot: "#8B5CF6",
  error: "#E5484D",
};

/** 6 个状态图标的文件名必须与 core/src/tray/state.ts 的 ICONS 表逐字一致。 */
export const TRAY_ICONS = ["idle", "progress", "update", "pending", "reboot", "error"];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error("bad color: " + hex);
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

/**
 * 画一个圆角实心图标（圆角矩形内嵌），size×size RGBA。
 * 用圆角矩形而不是纯圆，是为了在小尺寸下也能看清边界。
 */
export function buildPng(size, hex) {
  const { r, g, b } = parseHex(hex);
  const radius = Math.max(2, Math.round(size * 0.22));
  const inset = size <= 20 ? 1 : Math.max(1, Math.round(size * 0.06));
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const inside =
        x >= inset && y >= inset && x < size - inset && y < size - inset && roundedInside(x, y, size, inset, radius);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = inside ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function roundedInside(x, y, size, inset, radius) {
  const left = inset;
  const top = inset;
  const right = size - inset - 1;
  const bottom = size - inset - 1;
  const cx = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
  const cy = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** 组装 ICO：条目内直接放 PNG 字节（Vista+ 支持），256 时尺寸字节写 0。 */
export function writeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dirSize = 16 * entries.length;
  let dataOffset = 6 + dirSize;
  const dir = [];
  const blobs = [];
  for (const { size, png } of entries) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    // ICONDIRENTRY 布局：8..11 = 图像字节数，12..15 = 图像数据偏移。
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(dataOffset, 12);
    dir.push(entry);
    blobs.push(png);
    dataOffset += png.length;
  }
  return Buffer.concat([header, ...dir, ...blobs]);
}

export function generateIcons(colors = STATUS_COLORS) {
  const app = writeIco([16, 20, 24, 32, 48, 64, 256].map((size) => ({ size, png: buildPng(size, colors.idle ?? PRIMARY) })));
  const tray = {};
  for (const name of TRAY_ICONS) {
    tray[name] = writeIco(
      [16, 32].map((size) => ({ size, png: buildPng(size, colors[name] ?? PRIMARY) })),
    );
  }
  return { app, tray };
}

export function defaultOutDir() {
  return resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "icons"));
}

/** Tauri 打包需要的 PNG/ICO 图标集（tauri.conf.json 的 bundle.icon 会引用）。 */
export const TAURI_ICONS = [
  { file: "32x32.png", size: 32 },
  { file: "128x128.png", size: 128 },
  { file: "128x128@2x.png", size: 256 },
  { file: "icon.png", size: 512 },
];

function main(argv) {
  let out = defaultOutDir();
  let tauriOut = null;
  const colors = { ...STATUS_COLORS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = resolve(argv[i + 1] ?? out);
    if (argv[i] === "--tauri") tauriOut = resolve(argv[i + 1] ?? "");
    if ((argv[i] ?? "").startsWith("--color=")) {
      const pair = (argv[i] ?? "").slice("--color=".length);
      const [name, hex] = pair.split("=");
      if (name && hex) colors[name] = hex;
    }
  }
  const { app, tray } = generateIcons(colors);
  mkdirSync(join(out, "tray"), { recursive: true });
  writeFileSync(join(out, "app.ico"), app);
  for (const [name, buf] of Object.entries(tray)) writeFileSync(join(out, "tray", name + ".ico"), buf);
  if (tauriOut) {
    mkdirSync(tauriOut, { recursive: true });
    for (const { file, size } of TAURI_ICONS) writeFileSync(join(tauriOut, file), buildPng(size, colors.idle ?? PRIMARY));
    writeFileSync(join(tauriOut, "icon.ico"), app);
  }
  process.stdout.write("icons written to " + out + (tauriOut ? " and " + tauriOut : "") + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
