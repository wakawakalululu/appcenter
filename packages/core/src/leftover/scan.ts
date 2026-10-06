import type { InstalledApp } from "../inventory/inventory.ts";
import { RUN_ROOTS, SERVICES_ROOT, UNINSTALL_ROOTS, type RegClient, type RegistryKey } from "../inventory/registry.ts";
import { readShellLink, taskExecutables } from "./lnk.ts";
import { scanContextMenu } from "./contextmenu.ts";

/**
 * 残留类别按可扫描来源划分：
 * 注册表 / 服务 / 启动项 / 任务 / 菜单项 / 快捷方式 / 安装残留，外加用户数据与配置。
 */
export type ResidueKind =
  | "registry"
  | "service"
  | "startup"
  | "task"
  | "menu"
  | "shortcut"
  | "directory"
  | "userdata"
  | "contextmenu";

export type ResidueRisk = "low" | "medium" | "high";

export interface ResidueItem {
  kind: ResidueKind;
  risk: ResidueRisk;
  path: string;
  detail: string;
  reason: string;
  /** 值级残留（如启动项）：删除要分别给出键路径与值名，整键导出备份也要用键路径。 */
  keyPath?: string;
  valueName?: string;
}

export interface ResidueReport {
  app: string;
  regDir: string;
  scannedAt: string;
  durationMs: Record<ResidueKind, number>;
  items: ResidueItem[];
  /** 按类别计数，与界面上的「残留项统计: 注册表=n, 服务=n ...」行对齐。 */
  counts: Record<ResidueKind, number>;
}

export interface FileSystemProbe {
  exists(path: string): Promise<boolean>;
  /** 目录列举；无权限或不存在时返回空数组。 */
  readDir(path: string): Promise<string[]>;
  /** 文本读取（计划任务 XML 等）；失败返回 null。 */
  readText(path: string): Promise<string | null>;
}

export interface ScanEnv {
  programData: string;
  appData: string;
  commonStartMenu: string;
  userStartMenu: string;
  temp: string;
  systemRoot: string;
}

const RISK: Record<ResidueKind, ResidueRisk> = {
  service: "high",
  startup: "high",
  task: "high",
  userdata: "high",
  registry: "medium",
  directory: "low",
  menu: "low",
  shortcut: "low",
  contextmenu: "medium",
};

const SEP = "\\";

const KINDS: ResidueKind[] = ["registry", "service", "startup", "task", "menu", "shortcut", "directory", "userdata", "contextmenu"];

export function normPath(value: string): string {
  return value
    .replace(/[\\/]+/g, SEP)
    .replace(/\\+$/, "")
    .toLowerCase();
}

function basename(value: string): string {
  const clean = value.replace(/"/g, "").trim();
  const segments = clean.split(/[\\/]/);
  return (segments[segments.length - 1] ?? "").toLowerCase();
}

/** 卸载串与图标里指向的真实可执行文件，用于把残留归属收敛到该应用。 */
export function executableOf(app: InstalledApp): string | null {
  const raw = app.displayIcon ?? app.uninstallString ?? null;
  if (!raw) return null;
  const stripped = raw.replace(/"/g, "").trim();
  const head = stripped.split(/\s+(?=[/-])/)[0] ?? stripped;
  return /\.(exe|msi)$/i.test(head) ? head : null;
}

function references(anchors: string[], candidate: string): boolean {
  const needle = normPath(candidate);
  if (!needle) return false;
  return anchors.some((anchor) => {
    const a = normPath(anchor);
    return Boolean(a) && (needle === a || needle.includes(a) || a.includes(needle));
  });
}

function subKeyTail(path: string): string {
  const segments = path.split(SEP).filter(Boolean);
  return (segments[segments.length - 1] ?? "").toLowerCase();
}

function isUninstallPath(path: string): boolean {
  return UNINSTALL_ROOTS.some((root) => normPath(path).startsWith(normPath(root.path)));
}

export interface ScanDeps {
  reg: RegClient;
  fs: FileSystemProbe;
  env: ScanEnv;
  now?: () => Date;
}

async function walkFiles(fs: FileSystemProbe, dir: string, extension: string, limit = 1500): Promise<string[]> {
  const found: string[] = [];
  const stack: string[] = [dir];
  let visited = 0;
  while (stack.length && found.length < limit && visited < 8000) {
    const current = stack.pop();
    if (!current) continue;
    visited += 1;
    for (const entry of await fs.readDir(current)) {
      // 大小写不敏感比较：此前用大写条目名去 endsWith 小写扩展名，永远匹配不上，
      // 导致 menu/shortcut 残留从未被检出。
      if (entry.toLowerCase().endsWith(extension.toLowerCase())) found.push(entry);
      else stack.push(entry);
    }
  }
  return found;
}

async function collectTaskDefinitions(fs: FileSystemProbe, root: string, limit = 400): Promise<{ file: string; xml: string }[]> {
  const out: { file: string; xml: string }[] = [];
  const stack: string[] = [root];
  let probed = 0;
  while (stack.length && out.length < limit && probed < 5000) {
    const dir = stack.pop();
    if (!dir) continue;
    const entries = await fs.readDir(dir);
    // 同一目录内的读取先全部发起再按原顺序消费：并行拿回结果，同时保持
    // DFS 顺序、probed 计数时机与 limit/probed 的截断点逐字节一致。
    const pending = entries.map((entry) => fs.readText(entry));
    for (let index = 0; index < entries.length; index++) {
      probed += 1;
      const xml = await pending[index];
      const entry = entries[index];
      if (!entry) continue;
      if (xml && xml.includes("<Task")) {
        out.push({ file: entry, xml });
        continue;
      }
      stack.push(entry);
    }
  }
  return out;
}

/**
 * 卸载后的残留检测，八段独立计时。只读，不删除任何东西。
 * 卸载项检查按 regDir 直接点查，不递归整棵 Uninstall 树——这样单步只需数毫秒，
 * 全量递归在真机上要两秒。
 */
export async function scanResidue(app: InstalledApp, deps: ScanDeps): Promise<ResidueReport> {
  const items: ResidueItem[] = [];
  const durationMs = Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<ResidueKind, number>;
  const exe = executableOf(app);
  const anchors = [app.registryPath, app.installLocation ?? "", exe ?? ""].filter(Boolean);
  const exeName = app.installLocation ? "" : basename(exe ?? "");

  const timed = async (kind: ResidueKind, work: () => Promise<void>): Promise<void> => {
    const started = Date.now();
    await work();
    durationMs[kind] = Date.now() - started;
  };

  await timed("registry", async () => {
    for (const root of UNINSTALL_ROOTS) {
      // 只查这一条卸载项本身，不再递归整棵子树（卸载项下无子键）。
      const direct = await deps.reg.readKey(root.path + SEP + app.regDir);
      const stillThere = direct && normPath(direct.path) === normPath(app.registryPath) ? direct : undefined;
      if (stillThere) {
        items.push({
          kind: "registry",
          risk: RISK.registry,
          path: stillThere.path,
          detail: "卸载注册表项在卸载后仍存在",
          reason: "uninstall-entry-left-behind",
        });
      }
    }
    if (app.regDir && !app.regDir.startsWith("{")) {
      const vendorRoots = vendorConfigRoots(app.regDir);
      // 三个厂商配置根并行查询，省掉两次串行的进程启动往返。
      const dumps = await Promise.all(vendorRoots.map((root) => deps.reg.queryTree(root)));
      const candidates: RegistryKey[] = [];
      for (const dump of dumps) candidates.push(...dump);
      for (const key of candidates) {
        if (isUninstallPath(key.path) || normPath(key.path) === normPath(app.registryPath)) continue;
        if (!ownsTree(key, app.regDir)) continue;
        if (key.values.some((v) => references(anchors, v.data))) {
          items.push({
            kind: "registry",
            risk: RISK.registry,
            path: key.path,
            detail: "厂商配置键仍指向该应用路径",
            reason: "vendor-config-orphan",
          });
        }
      }
    }
  });

  await timed("service", async () => {
    const names = await deps.reg.queryChildren(SERVICES_ROOT);
    const installBase = app.installLocation ? basename(app.installLocation) : "";
    const hints = [
      ...tokensOf(app.regDir),
      ...tokensOf(basename(exe ?? "")),
      ...tokensOf(installBase),
      ...tokensOf(app.displayName),
    ].filter((hint) => hint.length > 3);
    const suspects = names.filter((p) => hints.some((hint) => p.toLowerCase().includes(hint))).slice(0, 40);
    for (const keyPath of suspects) {
      // 服务键下发常有 Parameters / Security 子键，只读键自身即可，避免递归白扫。
      const key = await deps.reg.readKey(keyPath);
      if (!key || normPath(key.path) !== normPath(keyPath)) continue;
      const imagePath = valueOf(key, "ImagePath");
      if (imagePath && references(anchors, imagePath)) {
        items.push({
          kind: "service",
          risk: RISK.service,
          path: key.path,
          detail: "后台服务仍指向已卸载程序 " + imagePath,
          reason: "orphan-service",
        });
      }
    }
  });

  await timed("startup", async () => {
    // 四个启动项根并行取数，再按原顺序处理，保证结果顺序不变。
    const dumps = await Promise.all(RUN_ROOTS.map((root) => deps.reg.queryTree(root)));
    for (let index = 0; index < RUN_ROOTS.length; index++) {
      for (const key of dumps[index] ?? []) {
        for (const value of key.values) {
          const hit = references(anchors, value.data) || (exeName !== "" && basename(value.data) === exeName);
          if (hit) {
            items.push({
              kind: "startup",
              risk: RISK.startup,
              path: key.path + SEP + value.name,
              keyPath: key.path,
              valueName: value.name,
              detail: "启动项仍指向已卸载程序 " + value.data,
              reason: "orphan-startup-entry",
            });
          }
        }
      }
    }
  });

  await timed("task", async () => {
    const tasksRoot = [deps.env.systemRoot, "System32", "Tasks"].join(SEP);
    for (const { file, xml } of await collectTaskDefinitions(deps.fs, tasksRoot, 300)) {
      const commands = taskExecutables(xml);
      const hit = commands.find((command) => references(anchors, command) || (exeName !== "" && basename(command) === exeName));
      if (!hit) continue;
      items.push({
        kind: "task",
        risk: RISK.task,
        path: file,
        detail: "计划任务仍会启动已卸载程序 " + hit,
        reason: "orphan-scheduled-task",
      });
    }
  });

  // menu 与 shortcut 两段逻辑相同，只差 kind：共享同一棵开始菜单树的
  // 遍历与 .lnk 解析结果，避免同一目录被走两遍；items 顺序与原先逐段重走完全一致。
  const scannedLinks: { file: string; link: Awaited<ReturnType<typeof readShellLink>> }[] = [];
  for (const root of [deps.env.commonStartMenu, deps.env.userStartMenu]) {
    for (const file of await walkFiles(deps.fs, root, ".lnk", 1500)) {
      scannedLinks.push({ file, link: await readShellLink(file) });
    }
  }

  const menuAndShortcuts = (kind: ResidueKind): void => {
    for (const { file, link } of scannedLinks) {
      const target = link?.target ?? "";
      const icon = link?.icon ?? "";
      const hit =
        (target && (references(anchors, target) || (exeName !== "" && basename(target) === exeName))) ||
        (icon && references(anchors, icon));
      if (!hit) continue;
      items.push({
        kind,
        risk: RISK[kind],
        path: file,
        detail: (kind === "menu" ? "开始菜单项" : "快捷方式") + "指向已卸载程序 " + (target || icon),
        reason: kind === "menu" ? "orphan-start-menu-entry" : "leftover-shortcut",
      });
    }
  };

  await timed("menu", async () => menuAndShortcuts("menu"));
  await timed("shortcut", async () => menuAndShortcuts("shortcut"));

  await timed("directory", async () => {
    const dirs = [app.installLocation, deps.env.programData + SEP + app.regDir, deps.env.temp + SEP + app.regDir].filter(
      (d): d is string => Boolean(d),
    );
    const seenDirs = new Set<string>();
    for (const dir of dirs) {
      const key = normPath(dir);
      if (!key || seenDirs.has(key)) continue;
      seenDirs.add(key);
      if (await deps.fs.exists(dir)) {
        items.push({ kind: "directory", risk: RISK.directory, path: dir, detail: "安装目录在卸载后仍存在", reason: "leftover-directory" });
      }
    }
  });

  await timed("userdata", async () => {
    const owners = [...new Set([app.regDir, app.displayName, ...tokensOf(app.publisher)].filter((v) => v && v.length > 2))];
    const roots = [deps.env.appData, deps.env.programData];
    for (const root of roots) {
      for (const entry of await deps.fs.readDir(root)) {
        const name = normPath(entry).split(SEP).pop() ?? "";
        if (!owners.some((owner) => name === owner.toLowerCase())) continue;
        if (normPath(entry).startsWith(normPath(app.installLocation ?? "\u0000"))) continue;
        items.push({
          kind: "userdata",
          risk: RISK.userdata,
          path: entry,
          detail: "用户数据或配置目录仍存在",
          reason: "orphan-user-data",
        });
      }
    }
  });

  await timed("contextmenu", async () => {
    const found = await scanContextMenu(app, deps.reg, (candidate) => references(anchors, candidate) || (exeName !== "" && basename(candidate) === exeName));
    items.push(...found);
  });

  const seen = new Set<string>();
  const unique = items.filter((item) => {
    const key = item.path + "|" + item.kind;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const counts = Object.fromEntries(KINDS.map((kind) => [kind, unique.filter((item) => item.kind === kind).length])) as Record<
    ResidueKind,
    number
  >;
  return {
    app: app.displayName,
    regDir: app.regDir,
    scannedAt: (deps.now?.() ?? new Date()).toISOString(),
    durationMs,
    items: unique,
    counts,
  };
}

function valueOf(key: RegistryKey, name: string): string | null {
  const lowered = name.toLowerCase();
  return key.values.find((v) => v.name.toLowerCase() === lowered)?.data ?? null;
}

/** 该键是否属于 regDir 这棵厂商配置子树（自身或其父链命中）。 */
function ownsTree(key: RegistryKey, regDir: string): boolean {
  const segments = key.path.split(SEP).filter(Boolean).map((s) => s.toLowerCase());
  const target = regDir.toLowerCase();
  if (subKeyTail(key.path) === target) return true;
  return segments.includes(target);
}

/**
 * 厂商配置根。只探测这三处，不递归整棵 HKLM\SOFTWARE：
 * 真机上整棵子树有数十万键，一次扫描会让清理界面卡住十几秒。
 */
export function vendorConfigRoots(regDir: string): string[] {
  const bases = [["HKLM", "SOFTWARE"], ["HKLM", "SOFTWARE", "WOW6432Node"], ["HKCU", "SOFTWARE"]];
  return bases.map((base) => [...base, regDir].join(SEP));
}

/** 拆出可用于匹配服务名的候选词：分隔符与驼峰边界都算。 */
export function tokensOf(value: string): string[] {
  if (!value) return [];
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced
    .split(/[^0-9A-Za-z一-龥]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
}
