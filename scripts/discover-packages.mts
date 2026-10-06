/** 真机跑一次自动发现：认出来源根、扫包、读 PE 版本、联已安装清单。 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { scanInstalledApps } from "@appcenter/core";
import { RegExeClient } from "@appcenter/core";
import { defaultInstallerRoots, discoverPackages, type DiscoverFs } from "@appcenter/core";

const nodeFs: DiscoverFs = {
  async stat(file) {
    try {
      const s = await fs.stat(file);
      return { sizeBytes: s.size, modifiedAt: s.mtime.toISOString(), isFile: s.isFile() };
    } catch {
      return null;
    }
  },
  async readDir(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch {
      return [];
    }
  },
};

const roots = defaultInstallerRoots();
console.log("自动识别到的来源根：");
for (const root of roots) {
  const exists = await nodeFs.stat(root.dir);
  console.log(`  ${root.label.padEnd(18)} ${root.dir}  ${exists ? "存在" : "不存在"}`);
}

const started = Date.now();
const installed = await scanInstalledApps(new RegExeClient());
console.log(`\n本机已安装应用：${installed.length} 个（${Date.now() - started}ms）`);

const report = await discoverPackages({ fsProbe: nodeFs, installed, limits: { maxCandidates: 120 } });
const named = report.packages.filter((p) => p.naming === "pe-version");
const matched = report.packages.filter((p) => p.installed);
console.log(`\n发现候选安装包：${report.scanned} 个，用时 ${report.durationMs}ms`);
console.log(`  PE 资源认出名字：${named.length} 个`);
console.log(`  与已安装清单对上：${matched.length} 个`);
console.log("\n样例（前 12 个，按大小）：");
for (const pkg of [...report.packages].sort((a, b) => b.candidate.sizeBytes - a.candidate.sizeBytes).slice(0, 12)) {
  const rel = pkg.installed ? `已装 ${pkg.installed.displayName}${pkg.installed.sameVersion ? "（同版本）" : " v" + pkg.installed.displayVersion}` : "本机未装";
  console.log(
    `  [${pkg.naming.padEnd(10)}] ${(pkg.name + " " + pkg.appVersion).padEnd(38)} ${(Math.round(pkg.candidate.sizeBytes / 1048576) + "MB").padStart(6)}  ${rel}`,
  );
  console.log(`      ${path.relative(process.cwd(), pkg.candidate.file) || pkg.candidate.file}`);
}

await fs.writeFile(path.join("local-repo", "discover-report.json").replace(/^local-repo/, "."), JSON.stringify(report, null, 2), "utf8").catch(async () => {
  await fs.mkdir("local-repo", { recursive: true });
  await fs.writeFile(path.join("local-repo", "discover-report.json"), JSON.stringify(report, null, 2), "utf8");
});
console.log("\n完整结果写入 local-repo/discover-report.json");
