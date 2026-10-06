import * as readline from "node:readline";
import os from "node:os";
import path from "node:path";
import { AppCenterFacade, type RegistryKey, type WindowDescriptor, type WindowHost } from "@appcenter/core";
import { dispatch } from "@appcenter/app";

/** 无宿主窗口实现：只记录状态，便于 CLI、自动化与端到端演示驱动整个 facade。 */
class HeadlessWindowHost implements WindowHost {
  private seq = 0;
  readonly created: WindowDescriptor[] = [];

  async create(spec: Omit<WindowDescriptor, "id" | "visible" | "focused">): Promise<string> {
    this.seq += 1;
    const id = "win-" + String(this.seq);
    this.created.push({ id, visible: true, focused: true, ...spec });
    return id;
  }

  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async close(): Promise<void> {}
  async focus(): Promise<void> {}
}

interface Command {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

function buildFacade(serverUrl: string, userId: string, registry?: readonly RegistryKey[]): AppCenterFacade {
  return new AppCenterFacade(
    {
      serverUrl,
      userId,
      dataDir: path.join(os.tmpdir(), "appcenter-data"),
      appVersion: "1.0.0",
      ...(registry ? { registryKeys: registry } : {}),
    },
    new HeadlessWindowHost(),
  );
}

/**
 * JSON Lines 协议壳：每一行一个请求，返回一行响应。
 * 方法与 UI 完全同源（共用 @appcenter/app 的 dispatch 表），不会出现两套分发逻辑漂移。
 */
async function runShell(serverUrl: string, userId: string): Promise<void> {
  const facade = buildFacade(serverUrl, userId);
  facade.onJob((job) => {
    process.stdout.write(
      JSON.stringify({ method: "event", params: { type: "job", job: { id: job.id, state: job.state, error: job.error ?? null } } }) + "\n",
    );
  });
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let command: Command;
    try {
      command = JSON.parse(trimmed) as Command;
    } catch {
      process.stdout.write(JSON.stringify({ id: null, ok: false, error: "invalid json" }) + "\n");
      continue;
    }
    const response = await dispatch(facade, command.method, command.params ?? {});
    process.stdout.write(JSON.stringify({ id: command.id ?? null, ...response }) + "\n");
  }
  rl.close();
}

async function runDemo(serverUrl: string, userId: string): Promise<void> {
  const facade = buildFacade(serverUrl, userId);
  console.log("catalog loaded: " + String(await facade.refreshCatalog()) + " apps");
  for (const hit of await facade.search({ text: "wps", limit: 3 })) {
    console.log("search hit: " + hit.app.name + " " + hit.app.latestVersion + " via " + hit.matchedOn);
  }
  const tree = await facade.categories();
  console.log("root categories: " + tree.map((node) => node.name + "(" + String(node.appCount) + ")").join(", "));
  console.log("installed on this machine: " + String((await facade.installed()).length));
  const upgrades = await facade.upgrades();
  console.log("upgrade candidates: " + String(upgrades.summary.total) + " bytes=" + String(upgrades.summary.bytes));
  console.log("tray: " + JSON.stringify(facade.trayView().icon) + " menu=" + String(facade.trayView().menu.length));
  console.log("skin dark primary: " + facade.skin("dark").tokens.color.primary);
  const job = await facade.install("vpn-client");
  console.log("approval-gated install state: " + job.state + " " + (job.error ?? ""));
}

async function runRepoSync(serverUrl: string, userId: string, allVersions: boolean, dir?: string): Promise<void> {
  const facade = buildFacade(serverUrl, userId);
  console.log("catalog loaded: " + String(await facade.refreshCatalog()) + " apps");
  const report = await facade.syncLocalRepo({ allVersions, dir });
  console.log("repo root: " + report.root);
  console.log(
    "synced: " + String(report.saved.length) + " saved, " + String(report.cached.length) + " cached, " + String(report.failed.length) + " failed, " +
      String(Math.round(report.totalBytes / 1024)) + " KB in " + String(report.durationMs) + "ms",
  );
  for (const failure of report.failed) console.log("  failed: " + failure.appId + "@" + failure.version + " " + failure.error);
  console.log("manifest: " + report.manifestFile);
}

async function runRepoStatus(dir?: string): Promise<void> {
  const facade = buildFacade(serverUrl, userId);
  const status = await facade.localRepoStatus(dir);
  if (!status.manifestExists) {
    console.log("no manifest at " + status.manifestFile + " — run repo-sync first");
    return;
  }
  console.log("repo root: " + status.root);
  console.log("items: " + String(status.items.length) + " (" + String(status.saved) + " saved, " + String(status.failed) + " failed, " + String(status.pending) + " pending), " + String(Math.round(status.totalBytes / 1024)) + " KB");
  for (const item of status.items) {
    console.log("  [" + item.status + "] " + item.name + " " + item.version + " " + String(Math.round(item.sizeBytes / 1024)) + " KB → " + item.relativePath);
  }
}

const serverUrl = process.env.APPCENTER_API ?? "http://127.0.0.1:7991";
const userId = process.env.APPCENTER_USER ?? os.userInfo().username;
const mode = process.argv[2] ?? "shell";
const repoDir = process.argv.find((arg) => arg.startsWith("--dir="))?.slice(6);
const allVersions = process.argv.includes("--all-versions");

if (mode === "search") {
  const facade = buildFacade(serverUrl, userId);
  for (const hit of await facade.search({ text: process.argv[3] ?? "", limit: 10 })) {
    console.log(hit.app.name + "  " + hit.app.latestVersion + "  score=" + String(Math.round(hit.score)) + "  via=" + hit.matchedOn);
  }
} else if (mode === "demo") {
  await runDemo(serverUrl, userId);
} else if (mode === "repo-sync") {
  await runRepoSync(serverUrl, userId, allVersions, repoDir);
} else if (mode === "repo-status") {
  await runRepoStatus(repoDir);
} else if (mode === "shell") {
  await runShell(serverUrl, userId);
} else {
  console.log("usage: appcenter <search KEYWORD> | demo | repo-sync [--all-versions] [--dir=PATH] | repo-status [--dir=PATH] | shell");
}
