import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface RegistryValue {
  name: string;
  type: string;
  data: string;
}

export interface RegistryKey {
  path: string;
  values: RegistryValue[];
}

/** 注册表访问抽象成接口：真实实现走 reg.exe，测试与离线演示走内存实现。 */
export interface RegClient {
  queryTree(rootPath: string): Promise<RegistryKey[]>;
  /** 只取直接子键路径，用于先窄后宽的探测。 */
  queryChildren(rootPath: string): Promise<string[]>;
  /** 只取单个键自身的键值（不带 /s），用于按点查替代整棵递归。 */
  readKey(path: string): Promise<RegistryKey | null>;
}

export type Hive = "HKLM" | "HKCU" | "HKCR";

const SEP = "\\";

export interface UninstallRoot {
  hive: Hive;
  path: string;
  label: string;
}

export const UNINSTALL_ROOTS: UninstallRoot[] = [
  { hive: "HKLM", path: ["HKLM", "SOFTWARE", "Microsoft", "Windows", "CurrentVersion", "Uninstall"].join(SEP), label: "machine-64" },
  { hive: "HKLM", path: ["HKLM", "SOFTWARE", "WOW6432Node", "Microsoft", "Windows", "CurrentVersion", "Uninstall"].join(SEP), label: "machine-32" },
  { hive: "HKCU", path: ["HKCU", "SOFTWARE", "Microsoft", "Windows", "CurrentVersion", "Uninstall"].join(SEP), label: "user" },
];

export const RUN_ROOTS: string[] = [
  ["HKCU", "Software", "Microsoft", "Windows", "CurrentVersion", "Run"].join(SEP),
  ["HKCU", "Software", "Microsoft", "Windows", "CurrentVersion", "RunOnce"].join(SEP),
  ["HKLM", "Software", "Microsoft", "Windows", "CurrentVersion", "Run"].join(SEP),
  ["HKLM", "Software", "WOW6432Node", "Microsoft", "Windows", "CurrentVersion", "Run"].join(SEP),
];

export const SERVICES_ROOT = ["HKLM", "SYSTEM", "CurrentControlSet", "Services"].join(SEP);
export const SOFTWARE_ROOT = "HKLM" + SEP + "SOFTWARE";

/** reg.exe 在中文 Windows 上以 GBK 输出，UTF-8 解码出现替换符时回退。 */
export function decodeRegistryOutput(buf: Buffer): string {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (!utf8.includes("\ufffd")) return utf8;
  try {
    return new TextDecoder("gbk").decode(buf);
  } catch {
    return utf8;
  }
}

/** reg.exe 输出用全名（HKEY_LOCAL_MACHINE），内部统一收敛成短名（HKLM）。 */
const HIVE_ALIASES: Record<string, string> = {
  HKLM: "HKEY_LOCAL_MACHINE",
  HKCU: "HKEY_CURRENT_USER",
  HKCR: "HKEY_CLASSES_ROOT",
  HKU: "HKEY_USERS",
  HKCC: "HKEY_CURRENT_CONFIG",
};

export function canonicalHive(path: string): string {
  const segments = path.split(SEP);
  const head = (segments[0] ?? "").toUpperCase();
  const short = Object.keys(HIVE_ALIASES).find((key) => HIVE_ALIASES[key] === head);
  if (short) return [short, ...segments.slice(1)].join(SEP);
  return path;
}

export function expandHive(path: string): string {
  const segments = path.split(SEP);
  const head = (segments[0] ?? "").toUpperCase();
  const long = HIVE_ALIASES[head];
  if (long) return [long, ...segments.slice(1)].join(SEP);
  return path;
}

const KEY_LINE = /^[A-Z][A-Z0-9_]*\\/;
/**
 * 值行形如 `    DisplayName    REG_SZ    演示应用`。
 * 值名不能再写成 `(\S+)`：真机上大量 `Inno Setup: App Path`、`AuthorizedInstances`之类带空格的值名
 * 会被整行丢弃（实测 HKLM64 丢 28/727、WOW6432 丢 14/2210、HKCU 丢 21/156、Fonts 丢 167/167），
 * 残留扫描因此少报。改成懒惰匹配到第一个 `REG_<类型>` 词元为止；数据段允许为空。
 */
const VALUE_LINE = /^\s{4}(.+?)\s+(REG_[A-Z_]+)(?:\s+(.*))?$/;

export function parseRegQuery(output: string): RegistryKey[] {
  const keys: RegistryKey[] = [];
  let current: RegistryKey | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (KEY_LINE.test(line)) {
      current = { path: canonicalHive(line.trim()), values: [] };
      keys.push(current);
      continue;
    }
    if (!current) continue;
    const m = VALUE_LINE.exec(line);
    if (!m) continue;
    const name = m[1] ?? "";
    const type = m[2] ?? "";
    let data = m[3] ?? "";
    if (type === "REG_MULTI_SZ") {
      data = data
        .replace(/\\+$/, "")
        .split("\\0")
        .filter(Boolean)
        .join("\n");
    }
    if (type === "REG_DWORD" || type === "REG_QWORD") {
      // reg.exe 把整型打成 `0x1` 这种十六进制文本。上层是直接字符串比较的
      // （如 `readValue(key,"WindowsInstaller") === "1"`），归一成十进制才不会永远判不中。
      const hex = /^0x([0-9a-f]+)$/i.exec(data.trim());
      if (hex) data = BigInt("0x" + (hex[1] ?? "0")).toString();
    }
    current.values.push({ name, type, data });
  }
  return keys;
}

export class RegExeClient implements RegClient {
  private readonly timeoutMs: number;

  constructor(timeoutMs = 30000) {
    this.timeoutMs = timeoutMs;
  }

  async queryTree(rootPath: string): Promise<RegistryKey[]> {
    try {
      const { stdout } = await run("reg.exe", ["query", rootPath, "/s"], {
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        timeout: this.timeoutMs,
        encoding: "buffer",
      });
      return parseRegQuery(decodeRegistryOutput(stdout as unknown as Buffer));
    } catch (err) {
      const failure = err as { code?: number | string; stdout?: Buffer | string };
      if (failure.code === 2) return [];
      if (typeof failure.stdout === "string" && failure.stdout.trim()) return parseRegQuery(failure.stdout);
      if (failure.stdout) return parseRegQuery(decodeRegistryOutput(failure.stdout as Buffer));
      return [];
    }
  }

  /** 不带 /s 的单层查询，避免递归整棵服务树。 */
  async queryChildren(rootPath: string): Promise<string[]> {
    const root = canonicalHive(rootPath).toLowerCase();
    try {
      const { stdout } = await run("reg.exe", ["query", rootPath], {
        windowsHide: true,
        maxBuffer: 16000000,
        timeout: this.timeoutMs,
        encoding: "buffer",
      });
      return parseRegQuery(decodeRegistryOutput(stdout as unknown as Buffer))
        .map((k) => canonicalHive(k.path))
        .filter((p) => p.toLowerCase() !== root);
    } catch {
      return [];
    }
  }

  /** 只取单个键自身的键值（不带 /s）。 */
  async readKey(path: string): Promise<RegistryKey | null> {
    try {
      const { stdout } = await run("reg.exe", ["query", path], {
        windowsHide: true,
        maxBuffer: 16000000,
        timeout: this.timeoutMs,
        encoding: "buffer",
      });
      const keys = parseRegQuery(decodeRegistryOutput(stdout as unknown as Buffer));
      const target = canonicalHive(path).toLowerCase();
      return keys.find((k) => canonicalHive(k.path).toLowerCase() === target) ?? keys[0] ?? null;
    } catch {
      return null;
    }
  }
}

async function childrenOf(keys: readonly RegistryKey[], rootPath: string): Promise<string[]> {
  const root = canonicalHive(rootPath).toLowerCase();
  return keys
    .map((k) => canonicalHive(k.path))
    .filter((p) => {
      const parent = p.split(SEP).slice(0, -1).join(SEP).toLowerCase();
      return parent === root && p.toLowerCase() !== root;
    })
    .filter((p, index, all) => all.indexOf(p) === index);
}

export class InMemoryRegClient implements RegClient {
  private readonly keys: readonly RegistryKey[];

  constructor(keys: readonly RegistryKey[]) {
    this.keys = keys;
  }

  async queryTree(rootPath: string): Promise<RegistryKey[]> {
    const prefix = canonicalHive(rootPath).toLowerCase().replace(/\\+$/, "");
    // 必须按**键边界**匹配：`...\Run` 是 `...\RunOnce` 的字符串前缀，裸 startsWith 会把兄弟键
    // 当成自己的子树返回，而真机 `reg.exe query <root> /s` 只返回该键自己与其子键。
    // 桩比真实实现宽，测试就会出现「读到了根上并不存在的项」，足以把按根隔离这类判据糊成假绿。
    return this.keys.filter((k) => {
      const key = canonicalHive(k.path).toLowerCase();
      return key === prefix || key.startsWith(prefix + "\\");
    });
  }

  async queryChildren(rootPath: string): Promise<string[]> {
    return childrenOf(this.keys, rootPath);
  }

  async readKey(path: string): Promise<RegistryKey | null> {
    const target = canonicalHive(path).toLowerCase();
    return this.keys.find((k) => canonicalHive(k.path).toLowerCase() === target) ?? null;
  }
}

export function readValue(key: RegistryKey, name: string): string | undefined {
  const lowered = name.toLowerCase();
  const hit = key.values.find((v) => v.name.toLowerCase() === lowered);
  if (!hit) return undefined;
  const data = hit.data.trim();
  return data === "" ? undefined : data;
}

/** 便捷构造，供种子数据与测试使用。 */
export function regKey(path: string, values: Record<string, string>): RegistryKey {
  return {
    path,
    values: Object.entries(values).map(([name, data]) => ({ name, type: "REG_SZ", data })),
  };
}
