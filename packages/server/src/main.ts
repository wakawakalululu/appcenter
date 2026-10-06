import path from "node:path";
import { CatalogDb, createApi, seedDemo } from "./server.ts";

const port = Number(process.env.CATALOG_PORT ?? 7991);
const file = process.env.DB_FILE ?? path.join(process.cwd(), "catalog.db");
const packageRoot = process.env.PACKAGE_ROOT ?? path.join(process.cwd(), "packages-store");
const adminToken = process.env.ADMIN_TOKEN ?? "";

const db = CatalogDb.open(file);
if (process.argv.includes("--seed")) seedDemo(db);

const server = createApi({ db, packageRoot, adminToken: adminToken || undefined });
server.listen(port, () => {
  console.log("appcenter catalog api listening on http://127.0.0.1:" + String(port));
  console.log("package root: " + packageRoot);
});
