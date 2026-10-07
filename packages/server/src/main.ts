import path from "node:path";
import { CatalogDb, createApi, seedDemo } from "./server.ts";

const port = Number(process.env.CATALOG_PORT ?? 7991);
const file = process.env.DB_FILE ?? path.join(process.cwd(), "catalog.db");
const packageRoot = process.env.PACKAGE_ROOT ?? path.join(process.cwd(), "packages-store");
const adminToken = process.env.ADMIN_TOKEN ?? "";

const db = CatalogDb.open(file);
if (process.argv.includes("--seed")) seedDemo(db);

const server = createApi({ db, packageRoot, adminToken: adminToken || undefined });
// listen(port) 不带 host 会绑 0.0.0.0，而旧代码把日志写死成 127.0.0.1 —— 运维据此以为服务只在回环上。
// 默认只绑回环；确实要对外暴露，显式给 HOST。
const host = process.env.HOST ?? "127.0.0.1";
server.listen(port, host, () => {
  const actual = server.address();
  const shown = typeof actual === "object" && actual ? actual.address + ":" + String(actual.port) : host + ":" + String(port);
  console.log("appcenter catalog api listening on http://" + shown);
  console.log("package root: " + packageRoot);
  if (!adminToken) console.log("警告：ADMIN_TOKEN 未设置，/api/admin/* 一律 403（fail-closed）。需要无鉴权演示请显式传 allowUnauthenticatedAdmin。");
});
