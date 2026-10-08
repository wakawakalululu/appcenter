import { RegExeClient, CONTEXTMENU_ROOTS, scanInstalledApps, scanResidue, defaultScanEnv, type InstalledApp, type RegistryKey, type RegClient } from "../packages/core/src/index.ts";
import fs from "node:fs/promises";
import path from "node:path";

const line = (s: string): void => { process.stdout.write(s + "\n"); };
const norm = (p: string): string => p.toLowerCase().replace(/\\+$/, "");

/** 真实注册表只读探针：按调用类别累计次数与耗时，定位 contextmenu 段的开销来源。 */
class TimedClient implements RegClient {
  private readonly inner = new RegExeClient();
  counts = { roots: 0, clsid: 0, other: 0 };
  ms = { roots: 0, clsid: 0, other: 0 };

  private classify(p: string): "roots" | "clsid" | "other" {
    const n = norm(p);
    if (CONTEXTMENU_ROOTS.some((r) => n === norm(r) || n.startsWith(norm(r) + "\\"))) return "roots";
    if (n === "hkcr\\clsid" || n.startsWith("hkcr\\clsid\\")) return "clsid";
    return "other";
  }

  private async time<T>(p: string, fn: () => Promise<T>): Promise<T> {
    const cat = this.classify(p);
    const t0 = performance.now();
    const out = await fn();
    const dt = performance.now() - t0;
    this.counts[cat]++;
    this.ms[cat] += dt;
    return out;
  }

  queryTree(p: string): Promise<RegistryKey[]> {
    return this.time(p, () => this.inner.queryTree(p));
  }
  queryChildren(p: string): Promise<string[]> {
    return this.time(p, () => this.inner.queryChildren(p));
  }
  readKey(p: string): Promise<RegistryKey | null> {
    return this.time(p, () => this.inner.readKey(p));
  }
}

const nodeProbe = {
  async exists(target: string): Promise<boolean> {
    try { await fs.stat(target); return true; } catch { return false; }
  },
  async readDir(target: string): Promise<string[]> {
    try { const e = await fs.readdir(target, { withFileTypes: true }); return e.map((d) => path.join(target, d.name)); } catch { return []; }
  },
  async readText(target: string): Promise<string | null> {
    try { return await fs.readFile(target, "utf8"); } catch { return null; }
  },
};

const all = await scanInstalledApps(new RegExeClient());
const candidates = all.filter((a: InstalledApp) => a.regDir && !a.regDir.startsWith("{")).slice(0, 3);
line(`本机已装应用 ${all.length}，取 ${candidates.length} 个非 GUID 项做 contextmenu 段归因（只读，不删除）\n`);

let grand = { roots: 0, clsid: 0, other: 0 };
let grandMs = { roots: 0, clsid: 0, other: 0 };
for (const app of candidates) {
  const client = new TimedClient();
  const started = performance.now();
  const report = await scanResidue(app, { reg: client, fs: nodeProbe, env: defaultScanEnv() });
  const total = Math.round(performance.now() - started);
  grand = { roots: grand.roots + client.counts.roots, clsid: grand.clsid + client.counts.clsid, other: grand.other + client.counts.other };
  grandMs = { roots: grandMs.roots + client.ms.roots, clsid: grandMs.clsid + client.ms.clsid, other: grandMs.other + client.ms.other };
  line(`[app ${app.displayName}] 全程=${total}ms  contextmenu段=${report.durationMs.contextmenu}ms  ` +
    `queryTree根=${client.counts.roots}(${Math.round(client.ms.roots)}ms)  CLSID=${client.counts.clsid}(${Math.round(client.ms.clsid)}ms)  其它=${client.counts.other}(${Math.round(client.ms.other)}ms)`);
}
line(`\n合计: 卸载根递归 ${grand.roots} 次 / ${Math.round(grandMs.roots)}ms ; ` +
  `CLSID 递归 ${grand.clsid} 次 / ${Math.round(grandMs.clsid)}ms ; 其它 ${grand.other} 次 / ${Math.round(grandMs.other)}ms`);
const clsidShare = grandMs.clsid / Math.max(1, grandMs.roots + grandMs.clsid);
line(`判定: contextmenu 段主要开销 = ${clsidShare > 0.6 ? "CLSID 逐个递归 queryTree fan-out" : "五个挂载根递归 queryTree"}（CLSID 占比 ${(clsidShare * 100).toFixed(0)}%）`);
