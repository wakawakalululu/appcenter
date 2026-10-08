import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

const line = (s: string): void => { process.stdout.write(s + "\n"); };
const tasksRoot = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "Tasks");

interface Stats {
  files: number;
  dirs: number;
  bytes: number;
  utf8HasTask: number;   // readText('utf8') 能命中 <Task（现状检测路径）
  utf16HasTask: number;  // 解码 UTF-16LE 后含 <Task（真实任务文件常见编码）
  bomUtf16: number;      // 以 FF FE 开头
  readFail: number;
}

async function walk(dir: string, stats: Stats, depth: number): Promise<void> {
  if (depth > 6) return;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      stats.dirs++;
      await walk(full, stats, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    stats.files++;
    let buf: Buffer;
    try {
      buf = await fs.readFile(full);
    } catch {
      stats.readFail++;
      continue;
    }
    stats.bytes += buf.byteLength;
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) stats.bomUtf16++;
    // 现状：readText 用 utf8 解码
    if (buf.toString("utf8").includes("<Task")) stats.utf8HasTask++;
    // 若按 UTF-16LE 解码能否命中
    const asU16 = buf.toString("utf16le").replace(/^/, "");
    if (asU16.includes("<Task")) stats.utf16HasTask++;
  }
}

const stats: Stats = { files: 0, dirs: 0, bytes: 0, utf8HasTask: 0, utf16HasTask: 0, bomUtf16: 0, readFail: 0 };
const t0 = performance.now();
await walk(tasksRoot, stats, 0);
const ms = Math.round(performance.now() - t0);

line(`根: ${tasksRoot}`);
line(`遍历文件 ${stats.files} / 目录 ${stats.dirs} / 读取失败 ${stats.readFail}，总字节 ${(stats.bytes / 1048576).toFixed(1)}MB，耗时 ${ms}ms`);
line(`以 UTF-8 解码命中 "<Task"（现状检测）: ${stats.utf8HasTask}`);
line(`以 UTF-16LE 解码命中 "<Task": ${stats.utf16HasTask}`);
line(`带 UTF-16 BOM(FF FE) 的文件: ${stats.bomUtf16}`);

// 取一个样本看真实前字节
try {
  const top = await fs.readdir(tasksRoot, { withFileTypes: true });
  const firstFile = top.find((e) => e.isFile());
  if (firstFile) {
    const buf = await fs.readFile(path.join(tasksRoot, firstFile.name));
    line(`\n样本「${firstFile.name}」前 16 字节: ${Array.from(buf.subarray(0, 16)).map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
  }
} catch {
  /* ignore */
}
