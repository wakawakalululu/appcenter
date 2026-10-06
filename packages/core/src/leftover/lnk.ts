import { readFile } from "node:fs/promises";

/**
 * MS-SHLLINK（.lnk）最小解析：只取判定残留所需的两个字段——目标路径与图标路径。
 * 纯本地字节解析，不依赖 Shell COM，便于测试且不会加载第三方二进制。
 */
export interface ShellLink {
  target: string | null;
  icon: string | null;
  workingDirectory: string | null;
  name: string | null;
}

const HEADER_SIZE = 76;
const HAS_IDLIST = 0x00000001;
const HAS_LINK_INFO = 0x00000002;
const HAS_NAME = 0x00000004;
const HAS_RELATIVE = 0x00000008;
const HAS_WORKDIR = 0x00000010;
const HAS_ARGS = 0x00000020;
const HAS_ICON = 0x00000040;
const IS_UNICODE = 0x00008000;

function u16(view: Buffer, offset: number): number {
  return offset + 2 <= view.length ? view.readUInt16LE(offset) : 0;
}

function u32(view: Buffer, offset: number): number {
  return offset + 4 <= view.length ? view.readUInt32LE(offset) : 0;
}

function readUnicodeZ(view: Buffer, offset: number): string {
  let end = offset;
  while (end + 1 < view.length && view.readUInt16LE(end) !== 0) end += 2;
  return view.toString("utf16le", offset, end);
}

function readAnsiZ(view: Buffer, offset: number): string {
  let end = offset;
  while (end < view.length && view[end] !== 0) end += 1;
  return view.toString("latin1", offset, end);
}

function readCountedString(view: Buffer, offset: number, unicode: boolean, chars: number): { value: string; next: number } {
  const room = view.length - offset;
  if (room <= 0) return { value: "", next: offset };
  if (unicode) {
    const safe = Math.min(chars, Math.floor(room / 2));
    return { value: view.toString("utf16le", offset, offset + safe * 2), next: offset + safe * 2 };
  }
  const safe = Math.min(chars, room);
  return { value: view.toString("latin1", offset, offset + safe), next: offset + safe };
}

function cleanPath(value: string): string | null {
  const trimmed = value.replace(/\0/g, "").trim();
  if (trimmed.length < 3) return null;
  if (/[\u0001-\u001f\u007f"<>|]/.test(trimmed)) return null;
  const looksLikePath = /^[a-z]:\\/i.test(trimmed) || /^\\\\/i.test(trimmed) || /\.(exe|lnk|msi|bat|cmd)$/i.test(trimmed);
  if (!looksLikePath) return null;
  return trimmed;
}

export function parseShellLink(bytes: Buffer): ShellLink | null {
  if (bytes.length < HEADER_SIZE) return null;
  if (u32(bytes, 0) !== HEADER_SIZE) return null;
  const clsid = bytes.subarray(4, 20);
  if (!clsid.equals(Buffer.from("0114020000000000c000000000000046", "hex"))) return null;

  const flags = u32(bytes, 20);
  const unicode = (flags & IS_UNICODE) !== 0;
  let pos = HEADER_SIZE;

  if (flags & HAS_IDLIST) {
    const size = u16(bytes, pos);
    pos += 2 + size;
  }

  let target: string | null = null;
  if (flags & HAS_LINK_INFO) {
    const linkInfoStart = pos;
    const size = u32(bytes, linkInfoStart);
    const localBasePathOffset = u16(bytes, linkInfoStart + 0x10);
    if (size >= 0x14 && localBasePathOffset > 0) {
      const raw = readAnsiZ(bytes, linkInfoStart + localBasePathOffset);
      if (raw) target = raw;
    }
    pos += Math.max(size, 0x14);
  }

  let name: string | null = null;
  let workingDirectory: string | null = null;
  let icon: string | null = null;

  const strings: Array<{ flag: number; field: "name" | "relative" | "workdir" | "args" | "icon" }> = [
    { flag: HAS_NAME, field: "name" },
    { flag: HAS_RELATIVE, field: "relative" },
    { flag: HAS_WORKDIR, field: "workdir" },
    { flag: HAS_ARGS, field: "args" },
    { flag: HAS_ICON, field: "icon" },
  ];
  let relative: string | null = null;
  for (const entry of strings) {
    if (!(flags & entry.flag)) continue;
    const chars = u16(bytes, pos);
    pos += 2;
    const { value, next } = readCountedString(bytes, pos, unicode, chars);
    pos = next;
    if (entry.field === "name") name = value;
    if (entry.field === "relative") relative = value;
    if (entry.field === "workdir") workingDirectory = value;
    if (entry.field === "icon") icon = value;
  }

  const resolved = cleanPath(target ?? "") ?? cleanPath(relative ?? "");
  return {
    target: resolved,
    icon: cleanPath(icon ?? ""),
    workingDirectory: cleanPath(workingDirectory ?? ""),
    name: cleanPath(name ?? ""),
  };
}

export async function readShellLink(file: string): Promise<ShellLink | null> {
  try {
    return parseShellLink(await readFile(file));
  } catch {
    return null;
  }
}

/** 计划任务 XML 里的可执行文件与参数，用于任务类残留判定。 */
export function taskExecutables(xml: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(/<(?:Command|ProgramArguments|Executable)>([^<]+)<\/(?:Command|ProgramArguments|Executable)>/gi)) {
    const value = (match[1] ?? "").trim();
    if (value) out.push(value);
  }
  for (const match of xml.matchAll(/<Arguments>([^<]*)<\/Arguments>/gi)) {
    const value = (match[1] ?? "").trim();
    if (value) out.push(value);
  }
  return out;
}
