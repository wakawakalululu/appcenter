import { createRequire } from "node:module";
import { RegExeClient, scanInstalledApps, type InstalledApp } from "../packages/core/src/index.ts";

const require = createRequire(import.meta.url);
const manifest = require("../local-repo/manifest.json") as {
  catalog: { apps: { id: string; name: string; publisher: string; searchKeys: string[]; latestVersion: string }[] };
  items: { appId: string; tags: string[] }[];
};

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

const installed = await scanInstalledApps(new RegExeClient());
const byExact = new Map<string, InstalledApp[]>();
const byNorm = new Map<string, InstalledApp[]>();
for (const app of installed) {
  (byExact.get(app.displayName) ?? byExact.set(app.displayName, []).get(app.displayName)!).push(app);
  const n = norm(app.displayName);
  (byNorm.get(n) ?? byNorm.set(n, []).get(n)!).push(app);
}

let exactHit = 0;
let normOnlyRecovery = 0;
let ambiguous = 0;
let noMatch = 0;
const recoveredSamples: string[] = [];
const ambiguousSamples: string[] = [];

const differs = new Set(manifest.items.filter((it) => it.tags.includes("original-name-differs")).map((it) => it.appId));

for (const entry of manifest.catalog.apps) {
  const exact = byExact.get(entry.name)?.length ?? 0;
  const normCount = byNorm.get(norm(entry.name))?.length ?? 0;
  if (normCount > 1) {
    ambiguous++;
    if (ambiguousSamples.length < 6) ambiguousSamples.push(`${entry.name} -> ${String(normCount)} 个已装项`);
    continue;
  }
  if (exact >= 1) exactHit++;
  else if (normCount === 1) {
    normOnlyRecovery++;
    if (recoveredSamples.length < 8) recoveredSamples.push(`「${entry.name}」↔「${byNorm.get(norm(entry.name))?.[0]?.displayName}」${differs.has(entry.id) ? " [标记 name-differs]" : ""}`);
  } else noMatch++;
}

const line = (s: string): void => { process.stdout.write(s + "\n"); };
line(`真机已装清单 ${installed.length} 项；目录 apps ${manifest.catalog.apps.length} 项（只读测量，不执行任何安装）\n`);
line(`当前「displayName 全等」回读命中 : ${exactHit}`);
line(`归一化(大小写/空白)后额外安全命中 : ${normOnlyRecovery}   ← 保守匹配可挽回`);
line(`存在歧义(一名对多项，须拒绝猜测) : ${ambiguous}`);
line(`无匹配(多为未安装/名字差异过大) : ${noMatch}`);
if (recoveredSamples.length) line(`\n归一化挽回样本:\n  ${recoveredSamples.join("\n  ")}`);
if (ambiguousSamples.length) line(`\n歧义样本(一名对多已装项，旧 .find 会取到不确定版本):\n  ${ambiguousSamples.join("\n  ")}`);

// 逐个歧义名打印：各已装项版本 + 目录 latestVersion + 「按请求版本消歧」能否唯一定位。
for (const entry of manifest.catalog.apps) {
  const n = norm(entry.name);
  const cands = byNorm.get(n) ?? [];
  if (cands.length < 2) continue;
  const versions = cands.map((c) => c.displayVersion);
  const wanted = entry.latestVersion;
  const resolved = versions.filter((v) => v === wanted).length;
  line(
    `\n歧义「${entry.name}」: 已装版本 [${versions.join(", ")}] | 目录请求 ${String(wanted)} | ` +
      `按请求版本可唯一定位=${resolved === 1 ? "是" : "否(仍不唯一)"} → 保守策略应只在唯一确定时回读，否则判为未命中而非取首个`,
  );
}
