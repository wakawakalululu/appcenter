import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RegExeClient,
  readShellLink,
  scanInstalledApps,
  scanResidue,
  taskExecutables,
  type FileSystemProbe,
  type ScanEnv,
} from "../packages/core/src/index.ts";

const probe: FileSystemProbe = {
  async exists(target: string): Promise<boolean> {
    try {
      await stat(target);
      return true;
    } catch {
      return false;
    }
  },
  async readDir(target: string): Promise<string[]> {
    try {
      const entries = await readdir(target, { withFileTypes: true });
      return entries.map((entry) => path.join(target, entry.name));
    } catch {
      return [];
    }
  },
  async readText(target: string): Promise<string | null> {
    try {
      return await readFile(target, "utf8");
    } catch {
      return null;
    }
  },
};

const home = os.homedir();
const env: ScanEnv = {
  programData: process.env.ProgramData ?? path.join("C:", "ProgramData"),
  appData: process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
  commonStartMenu: path.join(process.env.ProgramData ?? path.join("C:", "ProgramData"), "Microsoft", "Windows", "Start Menu", "Programs"),
  userStartMenu: path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs"),
  temp: os.tmpdir(),
  systemRoot: process.env.SystemRoot ?? ["C:", "Windows"].join(path.sep),
};

const reg = new RegExeClient();
const started = Date.now();
const installed = await scanInstalledApps(reg);
console.log("installed listing: " + String(installed.length) + " apps in " + String(Date.now() - started) + "ms");

const targets = ["微信", "企业微信", "夸克", "WPS Office", "Snipaste"]
  .map((name) => installed.find((app) => app.displayName === name))
  .filter((app): app is NonNullable<typeof app> => Boolean(app));

for (const app of targets.slice(0, 4)) {
  const t0 = Date.now();
  const report = await scanResidue(app, { reg, fs: probe, env });
  console.log(
    app.displayName +
      " | total " + String(Date.now() - t0) + "ms | items " + String(report.items.length) +
      " | " + JSON.stringify(report.counts) +
      " | ms " + JSON.stringify(report.durationMs),
  );
  for (const item of report.items.slice(0, 4)) console.log("   - [" + item.risk + "] " + item.kind + " " + item.path);
}

const menuRoot = env.userStartMenu;
const links: string[] = [];
async function collect(dir: string, depth: number): Promise<void> {
  if (depth > 3 || links.length >= 12) return;
  for (const entry of await probe.readDir(dir)) {
    if (entry.toUpperCase().endsWith(".LNK") && links.length < 12) links.push(entry);
    else if (!(entry.toUpperCase().endsWith(".LNK") || entry.toUpperCase().endsWith(".URL"))) await collect(entry, depth + 1);
  }
}
await collect(menuRoot, 0);
await collect(env.commonStartMenu, 0);
console.log("parsed " + String(links.length) + " shell links:");
for (const file of links.slice(0, 8)) {
  const link = await readShellLink(file);
  console.log("   " + path.basename(file) + " -> " + (link?.target ?? "(no target)") + (link?.icon ? " | icon " + link.icon : ""));
}

const tasksRoot = path.join(env.systemRoot, "System32", "Tasks");
async function collectTasks(dir: string, out: string[], depth: number): Promise<void> {
  if (depth > 4 || out.length >= 500) return;
  for (const entry of await probe.readDir(dir)) {
    if (entry.toUpperCase().endsWith(".XML")) out.push(entry);
    else await collectTasks(entry, out, depth + 1);
  }
}
const taskFiles: string[] = [];
await collectTasks(tasksRoot, taskFiles, 0);
let withCommands = 0;
for (const file of taskFiles.slice(0, 40)) {
  const xml = await probe.readText(file);
  if (xml && taskExecutables(xml).length > 0) withCommands += 1;
}
console.log("scheduled task xml files found: " + String(taskFiles.length) + "，前 40 个里能解析出可执行文件的: " + String(withCommands));
console.log("compare scan done");
