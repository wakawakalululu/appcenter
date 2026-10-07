/**
 * 用本机自动发现的真实安装包，替换演示目录里的假程序，并把安装包镜像到本地仓库。
 *
 * 流程：认位置 → 扫包 → 读 PE 版本 → 联已安装清单 → 算 sha256
 *      → 确保分类存在 → 删掉演示假应用 → 发布真实应用 → 镜像到本地仓库 → 盘点校验。
 *
 * 安全边界：
 * - 只镜像本机已有的安装包文件（file://），绝不下载或执行任何东西。
 * - 不拷贝已安装应用目录里的二进制。
 * - 发布到服务端后，安装动作仍由 UI 走 simulateInstalls / silent 流程，这里不触发安装。
 */
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import {
  defaultInstallerRoots,
  discoverPackages,
  createLocalFileDownloader,
  packageToCatalogApp,
  scanInstalledApps,
  LocalRepo,
  RegExeClient,
  guessCategory,
  FALLBACK_CATEGORY,
  type Category,
  type DiscoverFs,
} from "@appcenter/core";

const SERVER_URL = process.env.CATALOG_URL ?? "http://127.0.0.1:7991";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const REPO_ROOT = process.env.LOCAL_REPO ?? path.join(process.cwd(), "local-repo");
/** 演示假应用：seedDemo 灌进去的那批，发布真实应用前整批清掉。 */
const DEMO_APP_IDS = [
  "music-player",
  "wps-office",
  "mobile-desktop",
  "video-player",
  "enterprise-im",
  "code-ide",
  "cloud-notes",
  "endpoint-guard",
  "screen-capture",
  "vpn-client",
  // 之前 seed-bundle-demo.mts 灌的占位应用。
  "kit-player",
  "kit-im",
];

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

function sha256File(file: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function api(method: string, route: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(SERVER_URL + route, {
    method,
    headers: { "content-type": "application/json", ...(ADMIN_TOKEN ? { authorization: "Bearer " + ADMIN_TOKEN } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, json: parsed };
}

async function main(): Promise<void> {
  console.log("== 自动发现本机安装包 ==");
  const roots = defaultInstallerRoots();
  console.log("识别到的来源根：");
  for (const root of roots) {
    const exists = await nodeFs.stat(root.dir);
    console.log(`  ${root.label.padEnd(18)} ${root.dir}  ${exists ? "存在" : "不存在"}`);
  }

  const installed = await scanInstalledApps(new RegExeClient());
  console.log(`本机已安装应用：${installed.length} 个`);

  const report = await discoverPackages({ fsProbe: nodeFs, installed, limits: { maxCandidates: 400 } });
  console.log(`候选安装包：${report.scanned} 个，拒绝 ${report.rejected} 个，收进目录 ${report.packages.length} 个，用时 ${report.durationMs}ms`);

  if (report.packages.length === 0) {
    console.log("没有发现可镜像的安装包，结束。");
    return;
  }

  console.log("\n== 为安装包计算 sha256（镜像时按它校验）==");
  const withHash = await Promise.all(
    report.packages.map(async (pkg) => ({ pkg, sha256: await sha256File(pkg.candidate.file) })),
  );

  console.log("\n== 确保分类存在 ==");
  const neededCategories = new Set<string>();
  for (const { pkg } of withHash) neededCategories.add(guessCategory(pkg));
  neededCategories.add(FALLBACK_CATEGORY.id);
  const existing = await api("GET", "/api/categories");
  const existingIds = new Set((existing.json as Category[] | null)?.map((c) => c.id) ?? []);
  const categoryNames: Record<string, string> = { dev: "开发工具", "office-doc": "文档", media: "影音娱乐", security: "安全", other: "其他" };
  for (const id of neededCategories) {
    if (existingIds.has(id)) {
      console.log(`  [已存在] ${id}`);
      continue;
    }
    const created = await api("POST", "/api/admin/categories", { category: { id, name: categoryNames[id] ?? id, parentId: null, sortOrder: 50 } });
    console.log(`  [新建] ${id} -> ${created.status}`);
  }

  console.log("\n== 删除演示假应用 ==");
  for (const id of DEMO_APP_IDS) {
    const removed = await api("DELETE", "/api/admin/apps/" + encodeURIComponent(id));
    if (removed.status === 200) console.log(`  [删除] ${id}`);
  }

  console.log("\n== 发布真实安装包到目录 ==");
  let published = 0;
  for (const { pkg, sha256 } of withHash) {
    const app = packageToCatalogApp(pkg, sha256);
    const res = await api("POST", "/api/admin/apps", { detail: app, versions: app.versions });
    if (res.status === 201) {
      published += 1;
      const rel = pkg.installed ? `本机已装 ${pkg.installed.displayName}` : "本机未装";
      console.log(`  [发布] ${app.name} ${app.latestVersion} (${Math.round(pkg.candidate.sizeBytes / 1048576)}MB) ${rel}`);
    } else {
      console.log(`  [失败] ${app.name} -> ${res.status} ${JSON.stringify(res.json)}`);
    }
  }
  console.log(`发布 ${published}/${withHash.length} 个`);

  console.log("\n== 镜像安装包到本地仓库 ==");
  const apps = await Promise.all(withHash.map(async ({ pkg, sha256 }) => packageToCatalogApp(pkg, sha256)));
  const categories = (await api("GET", "/api/categories").then((r) => r.json)) as Category[] | null;
  // 来源白名单就用发现阶段认下的那几个根：目录里的 file:// 只能指向它们之内，
  // 否则一条被污染的清单就能把本机任意文件拷进镜像再随 manifest.json 外泄。
  const repo = new LocalRepo({ downloader: createLocalFileDownloader(roots.map((root) => root.dir)), root: REPO_ROOT, verify: "size" });
  const syncReport = await repo.sync({ apps, categories: categories ?? [FALLBACK_CATEGORY], allVersions: false });
  console.log(`镜像：${syncReport.saved.length} 新存，${syncReport.cached.length} 已缓存，${syncReport.failed.length} 失败`);
  console.log(`本地仓库占用：${Math.round(syncReport.totalBytes / 1048576)}MB，用时 ${syncReport.durationMs}ms`);
  for (const f of syncReport.failed) console.log(`  [失败] ${f.appId}@${f.version}: ${f.error}`);

  console.log("\n== 盘点本地仓库 ==");
  const status = await repo.status();
  console.log(`saved=${status.saved} failed=${status.failed} pending=${status.pending} total=${Math.round(status.totalBytes / 1048576)}MB`);
  console.log(`清单文件：${path.join(REPO_ROOT, "manifest.json")}`);
  console.log("\n完成：演示目录已替换为真实发现的应用，安装包已保存到本地仓库。");
}

main().catch((err) => {
  console.error("build-real-catalog 失败：", err);
  process.exit(1);
});
