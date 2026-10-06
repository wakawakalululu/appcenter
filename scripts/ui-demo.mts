import os from "node:os";
import path from "node:path";
import { CatalogDb, createApi, seedDemo } from "../packages/server/src/server.ts";
import { startUi } from "../packages/app/src/bridge.ts";

const db = CatalogDb.open(process.env.DB_FILE ?? path.join(process.cwd(), "smoke-catalog.db"));
seedDemo(db);
// 演示运营位：目录数据归 seedDemo，banner 属于演示配置，单独灌在这里。
db.upsertBanner({ id: "banner-office", title: "一键装机 常用软件极速到位", subtitle: "精选办公套件，一次配置全端就绪", link: "app:wps-office", sortOrder: 1 });
db.upsertBanner({ id: "banner-mobile", title: "移动云桌面", subtitle: "手机应用到大屏，继续用更顺手", link: "app:mobile-desktop", sortOrder: 2 });
const catalogApi = createApi({ db, packageRoot: "smoke-packages", adminToken: "admin" });
await new Promise<void>((resolve) => catalogApi.listen(Number(process.env.CATALOG_PORT ?? 7991), "127.0.0.1", resolve));
console.log("catalog api on http://127.0.0.1:7991");

const ui = await startUi({
  serverUrl: "http://127.0.0.1:" + String(Number(process.env.CATALOG_PORT ?? 7991)),
  userId: os.userInfo().username,
  dataDir: path.join(os.tmpdir(), "appcenter-ui-demo"),
  appVersion: "1.0.0",
  port: Number(process.env.UI_PORT ?? 8080),
  // 演示目录里的安装包是占位文件，绝不能在真机上执行。
  simulateInstalls: true,
});
console.log("ui on " + ui.url);
