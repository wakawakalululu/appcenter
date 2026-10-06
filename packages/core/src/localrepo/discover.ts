import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AppDetail, Category, InstallerKind } from "../catalog/types.ts";
import type { InstalledApp } from "../inventory/inventory.ts";

/**
 * 真实安装包的自动发现：不写死目录，从环境变量推出本机常见的安装包落点，
 * 扫出候选后用 PE 版本资源认出"这是哪个程序的哪个版本"，再和本机已安装清单对上。
 * 目的是把演示目录换成真程序，并把包镜像到本地仓库（见 repo.ts）。
 */

export interface DiscoverFs {
  stat(file: string): Promise<{ sizeBytes: number; modifiedAt: string; isFile: boolean } | null>;
  readDir(dir: string): Promise<{ name: string; isDirectory: boolean }[]>;
}

export interface InstallerCandidate {
  file: string;
  sizeBytes: number;
  modifiedAt: string;
  /** 命中哪个来源根，用于展示"从哪儿认出来的"。 */
  root: string;
  /** 该来源根的绝对路径，用来判断文件是不是直接躺在根下（而非解压目录里）。 */
  rootDir: string;
  extension: string;
}

export interface PeVersionInfo {
  productName: string;
  productVersion: string;
  fileVersion: string;
  companyName: string;
  fileDescription: string;
  originalFilename: string;
}

export interface DiscoveredPackage {
  candidate: InstallerCandidate;
  version: PeVersionInfo | null;
  /** 目录语义：优先 PE 资源，退到文件名解析。 */
  name: string;
  publisher: string;
  appVersion: string;
  /** 文件名里带架构信息时用它挑已安装应用的同名条目。 */
  architecture: string | null;
  /** 与本机注册表清单的匹配结果；没匹配上说明这台机器上还没装。 */
  installed: { displayName: string; displayVersion: string; sameVersion: boolean } | null;
  /** 语义来源，便于在界面上说明"这个名字是认出来的还是猜的"。 */
  naming: "pe-version" | "filename" | "basename";
  /** 从文件名里认出的发行商线索（如 _zh-cn、wpnoshortcut 之类的厂商构建标记）。 */
  notes: string[];
  /** 它有多像"一个安装包"而不是解压目录里的应用本体；<2 的不进目录。 */
  installerScore: number;
}

export interface DiscoverRoot {
  id: string;
  label: string;
  dir: string;
}

const INSTALLER_EXTENSIONS = [".exe", ".msi", ".msp"];
const MIN_PACKAGE_BYTES = 64 * 1024;
const MAX_DEPTH = 4;
const MAX_CANDIDATES = 400;

/**
 * 来源根从环境变量推导：换台机器、换用户、换系统盘都能用。
 * 不列已安装应用自身的安装目录——其中的二进制不能当作安装包镜像。
 */
export function defaultInstallerRoots(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): DiscoverRoot[] {
  const programData = env.ProgramData ?? path.join(env.SystemRoot ?? "C:\\", "..", "ProgramData");
  const publicProfile = env.PublicProfile ?? path.join(env.SystemRoot ?? "C:\\", "Users", "Public");
  const localAppData = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  const candidates: DiscoverRoot[] = [
    { id: "user-downloads", label: "下载", dir: path.join(home, "Downloads") },
    { id: "public-downloads", label: "公共下载", dir: path.join(publicProfile, "Downloads") },
    { id: "package-cache", label: "Windows 安装程序缓存", dir: path.join(programData, "Package Cache") },
    { id: "wu-downloads", label: "系统更新下载缓存", dir: path.join(env.SystemRoot ?? "C:\\Windows", "SoftwareDistribution", "Downloads") },
    { id: "local-temp-downloads", label: "本地缓存", dir: path.join(localAppData, "Temp") },
  ];
  return candidates.filter((root) => Boolean(root.dir));
}

/** 目录里明显不是安装包的东西，早点跳过省时间。 */
function skipDir(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "$recycle.bin" || lower === "node_modules" || lower === ".git" || skipTempDir(lower);
}

/**
 * 解压器/安装器留下的临时壳：`~nsu.tmp`、NSIS 的 `$PLUGINSDIR`、
 * WinRAR/7z 的 `Rar$xx` 之类。里面的 exe 是壳或应用本体，不是可复用的安装包。
 */
function skipTempDir(lower: string): boolean {
  return (lower.startsWith("~") && (lower.endsWith(".tmp") || lower.startsWith("~ns"))) || lower === "$pluginsdir" || /^rar\$\w/.test(lower) || lower.startsWith("tmp7z");
}

/**
 * 一个 .exe 到底是安装包还是应用本体？
 * 光看扩展名不够（真机上 TrafficMonitor 解压目录里的本体就会被抓到），
 * 所以综合路径、文件名与 PE 资源打分，低于阈值的不进目录。
 */
export function installerScore(candidate: InstallerCandidate, version: PeVersionInfo | null, fileName: string): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const lowerName = fileName.toLowerCase();
  const lowerPath = candidate.file.toLowerCase();
  const text = ((version?.productName ?? "") + " " + (version?.fileDescription ?? "") + " " + (version?.originalFilename ?? "") + " " + lowerName).toLowerCase();

  if (candidate.extension === ".msi" || candidate.extension === ".msp") {
    score += 3;
    reasons.push("msi");
  }
  if (/(setup|install|installer|unattend|bootstrapper)/.test(text)) {
    score += 3;
    reasons.push("installable-name");
  }
  if (candidate.root === "package-cache") {
    score += 2;
    reasons.push("burn-cache");
  }
  if (candidate.root === "user-downloads" || candidate.root === "public-downloads") {
    // 下载目录根下的一律当安装包看待；子目录里的大多是解压出来的。
    score += path.dirname(candidate.file).toLowerCase() === candidate.rootDir?.toLowerCase() ? 2 : 0;
  }
  if (/(^|[_\-.])(x64|win64|64bit|full|offline|standalone)(_|$|\d|\.)/.test(lowerName)) {
    score += 1;
    reasons.push("distribution-flavor");
  }
  if (version?.originalFilename && version.originalFilename.toLowerCase() !== fileName.toLowerCase()) {
    score -= 1;
    reasons.push("original-name-differs");
  }
  if (/(app|application|client|engine|service|helper)\.exe$/.test(lowerName) && !/setup|install/.test(text)) {
    score -= 2;
    reasons.push("looks-like-app-binary");
  }
  // 卸载器不是可分发的安装包，镜像到仓库里没有意义。
  if (/^uninst|_uninst|uninstaller/.test(lowerName) || /uninstall/.test(text)) {
    score -= 4;
    reasons.push("uninstaller");
  }
  return { score, reasons };
}

export async function scanInstallers(
  roots: readonly DiscoverRoot[],
  fsProbe: DiscoverFs,
  options: { minBytes?: number; maxCandidates?: number; maxDepth?: number } = {},
): Promise<InstallerCandidate[]> {
  const minBytes = options.minBytes ?? MIN_PACKAGE_BYTES;
  const limit = options.maxCandidates ?? MAX_CANDIDATES;
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const found: InstallerCandidate[] = [];

  const walk = async (dir: string, root: DiscoverRoot, depth: number): Promise<void> => {
    if (found.length >= limit || depth > maxDepth) return;
    const entries = await fsProbe.readDir(dir).catch(() => [] as { name: string; isDirectory: boolean }[]);
    for (const entry of entries) {
      if (found.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory) {
        if (!skipDir(entry.name)) await walk(full, root, depth + 1);
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (!INSTALLER_EXTENSIONS.includes(extension)) continue;
      const stat = await fsProbe.stat(full);
      if (!stat || !stat.isFile || stat.sizeBytes < minBytes) continue;
      found.push({ file: full, sizeBytes: stat.sizeBytes, modifiedAt: stat.modifiedAt, root: root.id, rootDir: root.dir, extension });
    }
  };

  for (const root of roots) {
    const stat = await fsProbe.stat(root.dir);
    if (stat) await walk(root.dir, root, 1);
  }
  return found;
}

/**
 * 从文件名里认语义：`DittoSetup_64bit_3_24_246_0.exe`、
 * `QuarkPC_V6.9.1.868_pc_pf30002_(zh-cn)_wpnoshortcut_(Build3021942-1001-x64).exe` 这类
 * 厂商构建命名，版本号/架构/语言都写在名字里。
 */
export function parseInstallerName(fileName: string): { name: string; version: string | null; architecture: string | null; locale: string | null; tokens: string[] } {
  const stem = path.basename(fileName, path.extname(fileName));
  const tokens: string[] = [];
  let version: string | null = null;
  let architecture: string | null = null;
  let locale: string | null = null;

  const versionMatch = stem.match(/(?:^|[^0-9a-zA-Z])(v|version)?(\d+(?:[._]\d+){1,5})(?![0-9])/i);
  if (versionMatch?.[2]) version = versionMatch[2].replace(/[._]/g, ".");
  const archMatch = stem.match(/(^|[_\-.(])(64bit|32bit|x64|x86[_-]?64|amd64|arm64|x86|win32)([_.\-)]|$)/i);
  if (archMatch?.[2]) architecture = archMatch[2].toLowerCase();
  const localeMatch = stem.match(/\((zh-cn|en-us|zh_cn|en_us)\)/i);
  if (localeMatch?.[1]) locale = localeMatch[1].toLowerCase().replace("_", "-");

  // 名字主体：截到第一个版本/架构/下划线分隔的修饰词之前。
  let name = stem;
  const cut = name.search(/[_-]?(?:v?\d+(?:[._]\d+){1,5}|64bit|32bit|x64|x86|amd64|arm64|setup|installer|win\d+)/i);
  if (cut > 2) name = name.slice(0, cut);
  name = name.replace(/[_.]+$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  if (/(setup|installer)/i.test(stem) && !/setup|installer/i.test(name)) name = (name + " Setup").trim();

  if (version) tokens.push("version@" + version);
  if (architecture) tokens.push("arch@" + architecture);
  if (locale) tokens.push("locale@" + locale);
  const buildMatch = stem.match(/\(build[^)]*\)/i);
  if (buildMatch) tokens.push("build@" + buildMatch[0].slice(1, -1));

  return { name: name || stem, version, architecture, locale, tokens };
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^0-9a-z一-龥]+/g, "");
}

/** 版本相等才算同一款；名字近似但版本不同要标出来，界面上说清"可升级"。 */
export function matchInstalledProgram(name: string, version: string | null, installed: readonly InstalledApp[]): DiscoveredPackage["installed"] {
  const needle = normalize(name);
  if (needle.length < 3) return null;
  const byName = installed.find((app) => normalize(app.displayName).includes(needle) || needle.includes(normalize(app.displayName))) ??
    installed.find((app) => app.regDir && normalize(app.regDir).includes(needle));
  if (!byName) return null;
  return { displayName: byName.displayName, displayVersion: byName.displayVersion, sameVersion: version ? normalize(byName.displayVersion) === normalize(version) : false };
}

/** PE 资源优先，其次文件名，最后文件名去后缀——三种来源在界面上要区分开。 */
export function toPackage(candidate: InstallerCandidate, version: PeVersionInfo | null, installed: readonly InstalledApp[]): DiscoveredPackage {
  const fileName = path.basename(candidate.file);
  const parsed = parseInstallerName(fileName);
  const fromPe = version && version.productName && !/^\s*$/.test(version.productName) ? version : null;
  const name = fromPe?.productName?.trim() || parsed.name || path.basename(candidate.file, path.extname(candidate.file));
  // NSIS/Inno 的壳会把"Quark Installer 4.0.0.4"这类打包器版本写进 PE 资源，
  // 产品真实版本在文件名里（V6.9.1.868），这种时候文件名优先。
  const peLooksLikePackager = /installer|setup|nsis|inno|burn|bootstrapper/i.test(fromPe?.productName ?? "");
  const appVersion = (peLooksLikePackager && parsed.version ? parsed.version : fromPe?.productVersion?.trim()) || parsed.version || "0.0.0";
  const publisher = fromPe?.companyName?.trim() || "未知发行者";
  const notes = [...parsed.tokens];
  if (candidate.extension === ".msi") notes.push("msi");
  if (candidate.root === "package-cache") notes.push("burn-cache");
  const scored = installerScore(candidate, version, fileName);
  for (const reason of scored.reasons) if (!notes.includes(reason)) notes.push(reason);
  return {
    candidate,
    version,
    name,
    publisher,
    appVersion,
    architecture: parsed.architecture,
    installed: matchInstalledProgram(name, appVersion === "0.0.0" ? null : appVersion, installed),
    naming: fromPe ? "pe-version" : parsed.version || parsed.architecture ? "filename" : "basename",
    notes,
    installerScore: scored.score,
  };
}

function scriptPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "probe-version.ps1");
}

/** 一次 PowerShell 调用批量读版本资源，参数走文件（命令行会被超长路径撑爆）。 */
export async function readPeVersions(files: readonly string[]): Promise<Map<string, PeVersionInfo | null>> {
  const result = new Map<string, PeVersionInfo | null>();
  if (files.length === 0) return result;
  const dir = await mkdtemp(path.join(os.tmpdir(), "pe-probe-"));
  const manifestFile = path.join(dir, "manifest.json");
  const resultFile = path.join(dir, "result.json");
  const jobs = files.map((file, index) => ({ key: String(index), file }));
  await writeFile(manifestFile, JSON.stringify(jobs), "utf8");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath(), "-ManifestFile", manifestFile, "-ResultFile", resultFile],
        { windowsHide: true },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("probe-version exit " + String(code) + " " + stderr.slice(0, 400)))));
    });
    const raw = (await readFile(resultFile, "utf8")).replace(/^﻿/, "");
    const rows = JSON.parse(raw === "" ? "[]" : raw) as {
      key: string;
      ok: boolean;
      productName?: string;
      productVersion?: string;
      fileVersion?: string;
      companyName?: string;
      fileDescription?: string;
      originalFilename?: string;
    }[];
    files.forEach((file, index) => {
      const row = rows.find((r) => r.key === String(index));
      result.set(file, row?.ok ? {
        productName: row.productName ?? "",
        productVersion: row.productVersion ?? "",
        fileVersion: row.fileVersion ?? "",
        companyName: row.companyName ?? "",
        fileDescription: row.fileDescription ?? "",
        originalFilename: row.originalFilename ?? "",
      } : null);
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  return result;
}

export interface DiscoverReport {
  roots: { id: string; label: string; dir: string; exists: boolean }[];
  scanned: number;
  /** 扫到但不像安装包（解压目录里的应用本体、临时壳）的数量。 */
  rejected: number;
  packages: DiscoveredPackage[];
  durationMs: number;
}

/**
 * 发现结果 → 目录条目。sha256 必须由调用方先算好（镜像时要按它校验），
 * downloadUrl 用 file:// 指回真实文件，配合 localFileDownloader 就能离线复用。
 */
export function packageToCatalogApp(pkg: DiscoveredPackage, sha256: string, silentKind?: string): AppDetail {
  const id = packageId(pkg);
  /**
   * PE 探测拿不到版本时 appVersion 是占位的 "0.0.0"，而厂商文件名里往往就写着版本号
   * （`DittoSetup_64bit_3_24_246_0.exe` → 3.24.246.0）。旧写法是
   * `pkg.appVersion === "0.0.0" ? "0.0.0" : pkg.appVersion`——两个分支同一个值，等于没兜底。
   */
  const fileNameVersion = parseInstallerName(pkg.candidate.file).version;
  const version = pkg.appVersion && pkg.appVersion !== "0.0.0" ? pkg.appVersion : fileNameVersion ?? pkg.appVersion ?? "0.0.0";
  const isMsi = pkg.candidate.extension === ".msi";
  // .msp 是 Windows Installer 补丁：既不能按 NSIS 传 `/S /D=`，也不能用 msi 的 `/i`（打补丁是 /p）。
  const isMsp = pkg.candidate.extension === ".msp";
  return {
    id,
    name: pkg.name,
    searchKeys: [pkg.name, path.basename(pkg.candidate.file, path.extname(pkg.candidate.file)), pkg.architecture ?? ""].filter(Boolean),
    publisher: pkg.publisher,
    categoryId: guessCategory(pkg),
    iconUrl: "",
    latestVersion: version,
    downloadCount: pkg.installed ? 1 : 0,
    badge: "normal",
    tags: pkg.notes.slice(0, 4),
    requiresApproval: false,
    sizeBytes: pkg.candidate.sizeBytes,
    description: "本机自动发现的真实安装包（" + (pkg.naming === "pe-version" ? "PE 版本资源识别" : "文件名识别") + "）",
    screenshots: [],
    versions: [
      {
        version,
        releasedAt: pkg.candidate.modifiedAt.slice(0, 10),
        sizeBytes: pkg.candidate.sizeBytes,
        sha256,
        downloadUrl: pathToFileURL(pkg.candidate.file).href,
        releaseNotes: pkg.installed ? `本机已装 ${pkg.installed.displayName} ${pkg.installed.displayVersion}` : "",
        silent: {
          kind: (silentKind ?? (isMsi || isMsp ? "msi" : "nsis")) as InstallerKind,
          installArgs: isMsp
            ? ["/p", "{file}", "/qn", "REBOOT=ReallySuppress"]
            : isMsi
              ? ["/i", "{file}", "/qn", "/norestart"]
              : ["/S", "/D={target}"],
          // 补丁没有「单独卸载这个 .msp」的命令入口，回退由系统更新列表负责，这里不给参数而不是硬套 msi 的 /x。
          uninstallArgs: isMsp ? [] : isMsi ? ["/x", "{file}", "/qn"] : ["/S"],
          requiresAdmin: isMsi || isMsp,
        },
      },
    ],
  };
}

/** 稳定 id：同一台机器上重复发现不会不断产生新应用。 */
export function packageId(pkg: DiscoveredPackage): string {
  const base = pkg.name.toLowerCase().replace(/[^0-9a-z一-龥]+/g, "-").replace(/^-|-$/g, "") || path.basename(pkg.candidate.file).toLowerCase();
  return "local-" + base.slice(0, 40);
}

/**
 * 分类靠线索猜：装包语义里没有分类字段，认不出来就归到"其他"。
 * id 对齐到服务端 seedDemo 的分类表，避免界面上出现孤岛分类。
 */
export function guessCategory(pkg: DiscoveredPackage): string {
  const text = (pkg.name + " " + (pkg.version?.fileDescription ?? "") + " " + pkg.candidate.file).toLowerCase();
  if (/(sdk|driver|redist|visual c\+\+|runtime|framework)/.test(text)) return "dev";
  if (/(ide|code|editor|git|debug)/.test(text)) return "dev";
  // 短词必须带边界，否则 `im` 会把 "image" 判成通讯、`doc` 会把 "docker" 判成办公软件。
  if (/(office|wps|pdf|\bdocs?\b|\bdocument|\bnote|笔记)/.test(text)) return "office-doc";
  if (/(player|music|video|monitor|traffic|游戏|影音|音乐)/.test(text)) return "media";
  if (/(安全|防护|antivirus|security|guard|远程|remote|vpn)/.test(text)) return "security";
  if (/(输入法|\binput|cloud|盘|\bmail\b|通讯|\bim\b)/.test(text)) return "office-doc";
  return "other";
}

export const FALLBACK_CATEGORY: Category = { id: "other", name: "其他", parentId: null, sortOrder: 90 };

/** 端到端发现：认位置 → 扫包 → 读版本 → 联已安装清单。 */
export async function discoverPackages(deps: {
  roots?: readonly DiscoverRoot[];
  fsProbe: DiscoverFs;
  installed: readonly InstalledApp[];
  probeVersions?: (files: readonly string[]) => Promise<Map<string, PeVersionInfo | null>>;
  limits?: { minBytes?: number; maxCandidates?: number; maxDepth?: number };
  /** 至少多像安装包才收进目录，默认 2。 */
  minScore?: number;
}): Promise<DiscoverReport> {
  const started = Date.now();
  const roots = deps.roots ?? defaultInstallerRoots();
  const candidates = await scanInstallers(roots, deps.fsProbe, deps.limits);
  const probe = deps.probeVersions ?? readPeVersions;
  const versions = await probe(candidates.map((c) => c.file));
  const scored = candidates.map((candidate) => toPackage(candidate, versions.get(candidate.file) ?? null, deps.installed));
  const minScore = deps.minScore ?? 2;
  const packages = scored.filter((pkg) => pkg.installerScore >= minScore);
  return {
    roots: roots.map((root) => ({ id: root.id, label: root.label, dir: root.dir, exists: candidates.some((c) => c.root === root.id) })),
    scanned: candidates.length,
    rejected: scored.length - packages.length,
    packages,
    durationMs: Date.now() - started,
  };
}
