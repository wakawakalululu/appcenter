import { RegExeClient, scanInstalledApps, type InstalledApp } from "../packages/core/src/index.ts";

const line = (s: string): void => { process.stdout.write(s + "\n"); };

/** 现状 parseUninstallCommand 的取 program 方式：去所有引号后按空白切，取第一段。 */
function currentProgram(raw: string): string {
  const stripped = raw.replace(/"/g, "").trim();
  return (stripped.split(/\s+/).filter(Boolean)[0] ?? "");
}

/** 尊重引号的 Windows 风格首段：带引号则内部空格属于 program，否则到第一个空格为止。 */
function trueProgram(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"')) {
    const end = t.indexOf('"', 1);
    return end > 0 ? t.slice(1, end) : t.slice(1);
  }
  return t.split(/\s+/)[0] ?? "";
}

const installed: InstalledApp[] = await scanInstalledApps(new RegExeClient());

let withUninstall = 0;
let msi = 0;
let nonMsi = 0;
let brokenNonMsi = 0;
const samples: string[] = [];

for (const app of installed) {
  const raw = (app.quietUninstallString ?? app.uninstallString ?? "").trim();
  if (!raw) continue;
  withUninstall++;
  if (/msiexec/i.test(raw)) { msi++; continue; }
  nonMsi++;
  const tp = trueProgram(raw);
  const cp = currentProgram(raw);
  const isBroken = cp.toLowerCase() !== tp.toLowerCase();
  if (isBroken) {
    brokenNonMsi++;
    if (samples.length < 6) samples.push(`程序名应=「${tp}」\n      现解析取到=「${cp}」   ← 串: ${raw.slice(0, 90)}`);
  }
}

line(`真机已装 ${installed.length} 个；有卸载串 ${withUninstall}；MSI ${msi}；非-MSI ${nonMsi}（只读，不执行任何卸载）`);
line(`其中被「去引号+按空白切分」切错 program 的非-MSI 卸载串: ${brokenNonMsi} / ${nonMsi}`);
if (samples.length) line(`\n样本:\n  ${samples.join("\n  ")}`);
