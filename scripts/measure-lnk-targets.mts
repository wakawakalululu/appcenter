import fs from "node:fs/promises";
import path from "node:path";
import { parseShellLink } from "../packages/core/src/index.ts";

const line = (s: string): void => process.stdout.write(s + "\n");
const u16 = (b: Buffer, o: number): number => (o + 2 <= b.length ? b.readUInt16LE(o) : 0);
const u32 = (b: Buffer, o: number): number => (o + 4 <= b.length ? b.readUInt32LE(o) : 0);
function ansiZ(b: Buffer, o: number): string {
  let e = o;
  while (e < b.length && b[e] !== 0) e++;
  return o < b.length ? b.toString("latin1", o, e) : "";
}
const looksPath = (s: string): boolean => /^[a-z]:\\/i.test(s) || /^\\\\/i.test(s);

async function findLnks(dir: string, acc: string[], depth: number): Promise<void> {
  if (depth > 6) return;
  let entries: Awaited<ReturnType<typeof fs.readdir<{ withFileTypes: true }>>>;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await findLnks(full, acc, depth + 1);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".lnk")) acc.push(full);
  }
}

const roots = [
  process.env.ALLUSERSPROFILE ? path.join(process.env.ALLUSERSPROFILE, "Microsoft", "Windows", "Start Menu", "Programs") : "",
  path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs"),
].filter(Boolean);

const files: string[] = [];
for (const r of roots) await findLnks(r, files, 0);

let total = files.length;
let withLinkInfo = 0;
let currentParserTarget = 0;   // 现状 parseShellLink 拿到 target
let specOffsetTarget = 0;      // 按 LocalBasePathOffset(0x08) 读取能拿到路径
let wrongOffsetTarget = 0;     // 按代码现用的 0x10(u16) 能拿到路径
let dumped = false;
const samples: string[] = [];

for (const file of files) {
  let bytes: Buffer;
  try { bytes = await fs.readFile(file); } catch { continue; }
  const parsed = parseShellLink(bytes);
  if (parsed?.target) currentParserTarget++;

  if (bytes.length < 76 || u32(bytes, 0) !== 76) continue;
  const flags = u32(bytes, 20);
  const HAS_IDLIST = 1, HAS_LINK_INFO = 2;
  if (!(flags & HAS_IDLIST)) continue; // 简化：只看有 idlist 的常规链接
  let pos = 76;
  const idSize = u16(bytes, pos);
  pos += 2 + idSize;
  if (!(flags & HAS_LINK_INFO)) continue;
  withLinkInfo++;
  const liStart = pos;
  const liSize = u32(bytes, liStart);
  if (liSize < 0x14) continue;
  const specLocalOff = u32(bytes, liStart + 0x08); // 规范：LocalBasePathOffset
  const codeOff = u16(bytes, liStart + 0x10);       // 代码：误用 ColorTableOffset 低 16 位
  const specPath = ansiZ(bytes, liStart + specLocalOff);
  const codePath = ansiZ(bytes, liStart + codeOff);
  const specGood = looksPath(specPath);
  const codeGood = looksPath(codePath);
  if (specGood) specOffsetTarget++;
  if (codeGood) wrongOffsetTarget++;
  if (samples.length < 5 && specGood && !codeGood) {
    samples.push(`${path.basename(file)}: 规范0x08->"${specPath}" 代码0x10->"${codeGood ? codePath : "(空/非路径)"}" parsed.target=${parsed?.target ?? "null"}`);
  }
  if (codeGood && !dumped && specPath !== codePath) {
    dumped = true;
    const at = (o: number): string => ansiZ(bytes, liStart + o);
    line(`\n[布局取证] ${path.basename(file)} 的 LINKINFO 头部（liStart=${liStart}）:`);
    line(`  @0x00 Length(u32)=${u32(bytes, liStart)}  @0x04 VolumeIDOffset(u32)=${u32(bytes, liStart + 4)}  @0x08 (u32)=${u32(bytes, liStart + 8)}  @0x0C (u32)=${u32(bytes, liStart + 12)}  @0x10 (u32)=${u32(bytes, liStart + 16)}`);
    line(`  u16@0x10=${codeOff} -> 该偏移处字符串="${codePath}"  (代码用它, 得到路径)`);
    line(`  u32@0x08=${specLocalOff} -> 该偏移处字符串="${specPath}"  (规范理论 LocalBasePathOffset)`);
    // 真正路径字符串在结构里的字节位置
    const realIdx = bytes.indexOf(codePath + "\0", liStart);
    line(`  真实路径字节相对 liStart 的位置=+${realIdx >= 0 ? realIdx - liStart : "?"}`);
  }
}

line(`真机开始菜单 .lnk 总数 ${total}（只读，不执行）`);
line(`含 LinkInfo 且有 IDList 的链接: ${withLinkInfo}`);
line(`按代码现用偏移(0x10/u16)能解出路径: ${wrongOffsetTarget}`);
line(`按规范偏移(LocalBasePathOffset@0x08)能解出路径: ${specOffsetTarget}`);
line(`当前 parseShellLink 实际拿到 target: ${currentParserTarget}`);
if (samples.length) line(`\n样本(规范偏移可解、代码偏移不可解):\n  ${samples.join("\n  ")}`);
