import os from "node:os";
import path from "node:path";
import { CatalogDb, createApi, materializeDemoPackages, seedDemo } from "../packages/server/src/server.ts";
import { startUi } from "../packages/app/src/bridge.ts";

// 演示入口**不接**外部 DB_FILE：`npm run demo` 是个无心的动作，而真目录工作流里
// DB_FILE 指的就是那份真库——实测一次 demo 会往里灌 21 个演示应用并覆写 size/sha256。
// 确实要换演示库，用 UI_DEMO_DB_FILE。
if (process.env.DB_FILE) console.log("提示：已忽略 DB_FILE=" + process.env.DB_FILE + "；演示库请用 UI_DEMO_DB_FILE");
const db = CatalogDb.open(process.env.UI_DEMO_DB_FILE ?? path.join(process.cwd(), "smoke-catalog.db"));
seedDemo(db);
// 演示运营位：目录数据归 seedDemo，banner 属于演示配置，单独灌在这里。
db.upsertBanner({ id: "banner-office", title: "一键装机 常用软件极速到位", subtitle: "精选办公套件，一次配置全端就绪", link: "app:wps-office", sortOrder: 1 });
db.upsertBanner({ id: "banner-dev", title: "开发者专区", subtitle: "常用开发工具一次装齐", link: "app:code-ide", sortOrder: 2 });
// 把每个版本物化成真实文件并回写真 sha256：本地仓库同步、断点续传与校验链路都能真跑。
const materialized = materializeDemoPackages(db, "smoke-packages");
console.log("demo packages materialized: " + String(materialized.files) + " files, " + String(Math.round(materialized.bytes / 1024)) + " KB");
const catalogApi = createApi({ db, packageRoot: "smoke-packages", adminToken: "admin" });
await new Promise<void>((resolve) => catalogApi.listen(Number(process.env.CATALOG_PORT ?? 7991), "127.0.0.1", resolve));
// 端口取实际绑定值：旧日志把 7991 写死，CATALOG_PORT 换了它照样印 7991（#51 同族教训）。
const boundCatalogPort = (catalogApi.address() as { port: number }).port;
console.log("catalog api on http://127.0.0.1:" + String(boundCatalogPort));

// UI_DEMO_FAKE_INVENTORY=1：用一份虚构的已装清单替代真机注册表扫描，并改用中性 userId。
// 目的是让"演示截图"这条路不再必然泄露开发者机器 —— 已装视图原先直接扫真机，
// 于是公开在 README/Pages 的那张图里出现了对照对象的厂商名与安装目录。
const fakeInventory = process.env.UI_DEMO_FAKE_INVENTORY === "1";
const UNINSTALL_ROOT = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
type FakeEntry = { name: string; display: string; version: string; loc: string };
const defaultFakeEntries: FakeEntry[] = [
  { name: "DemoEditor", display: "示例编辑器", version: "2.4.0", loc: "C:\\Example\\DemoEditor" },
  { name: "DemoPlayer", display: "示例播放器", version: "1.0.3", loc: "C:\\Example\\DemoPlayer" },
  { name: "DemoOffice", display: "示例办公套件", version: "3.1.2", loc: "C:\\Example\\DemoOffice" },
];
// UI_DEMO_FAKE_INVENTORY_JSON 让验证脚本注入"故意刁钻"的清单（例如同名多实例），默认那三条是给公开配图用的。
// 两条路都只走注入的虚构键，永远不碰真机注册表。
const fakeEntries: FakeEntry[] = process.env.UI_DEMO_FAKE_INVENTORY_JSON
  ? (JSON.parse(process.env.UI_DEMO_FAKE_INVENTORY_JSON) as FakeEntry[])
  : defaultFakeEntries;
const demoRegistryKeys = fakeEntries.map((e) => ({
  path: UNINSTALL_ROOT + "\\" + e.name,
  values: [
    { name: "DisplayName", type: "REG_SZ", data: e.display },
    { name: "DisplayVersion", type: "REG_SZ", data: e.version },
    { name: "Publisher", type: "REG_SZ", data: "示例厂商" },
    { name: "InstallLocation", type: "REG_SZ", data: e.loc },
    { name: "UninstallString", type: "REG_SZ", data: e.loc + "\\unins000.exe /SILENT" },
  ],
}));

const ui = await startUi({
  serverUrl: "http://127.0.0.1:" + String(boundCatalogPort),
  userId: fakeInventory ? "demo" : os.userInfo().username,
  dataDir: process.env.UI_DEMO_DATA_DIR ?? path.join(os.tmpdir(), "appcenter-ui-demo"),
  appVersion: "1.0.0",
  port: Number(process.env.UI_PORT ?? 8080),
  // 演示目录里的安装包是占位文件，绝不能在真机上执行。
  simulateInstalls: true,
  registryKeys: fakeInventory ? demoRegistryKeys : undefined,
});
console.log("ui on " + ui.url);
