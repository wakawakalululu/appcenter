import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { RegExeClient, scanInstalledApps, defaultScanEnv, trayStatusFor, buildTrayMenu } from "../packages/core/src/index.ts";

const label = (tag) => (chunk) => process.stdout.write("[" + tag + "] " + chunk);

const server = spawn(process.execPath, ["--experimental-transform-types", "packages/server/src/main.ts", "--seed"], {
  env: { ...process.env, PORT: "7991", DB_FILE: "smoke-catalog.db", PACKAGE_ROOT: "smoke-packages" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", label("server"));
server.stderr.on("data", label("server!"));
await wait(1500);

const demo = spawn(process.execPath, ["--experimental-transform-types", "packages/cli/src/main.ts", "demo"], {
  env: { ...process.env, APPCENTER_API: "http://127.0.0.1:7991" },
});
demo.stdout.pipe(process.stdout);
demo.stderr.on("data", label("demo!"));
await new Promise((resolve) => demo.on("exit", resolve));

const shell = spawn(process.execPath, ["--experimental-transform-types", "packages/cli/src/main.ts", "shell"], {
  env: { ...process.env, APPCENTER_API: "http://127.0.0.1:7991" },
});
shell.stdout.on("data", label("shell"));
shell.stderr.on("data", label("shell!"));
shell.stdin.write(JSON.stringify({ id: 1, method: "catalog.search", params: { text: "wps" } }) + "\n");
await wait(500);
shell.stdin.write(JSON.stringify({ id: 2, method: "ui.skin", params: { id: "cny" } }) + "\n");
shell.stdin.write(JSON.stringify({ id: 3, method: "ui.window", params: { role: "settings" } }) + "\n");
shell.stdin.write(JSON.stringify({ id: 4, method: "ui.tray" }) + "\n");
await wait(500);
shell.stdin.end();
await new Promise((resolve) => shell.on("exit", resolve));

const started = Date.now();
const apps = await scanInstalledApps(new RegExeClient());
console.log("[real-registry] " + String(apps.length) + " installed apps listed in " + String(Date.now() - started) + "ms");
for (const app of apps.slice(0, 8)) {
  console.log("[real-registry]  - " + app.displayName + " | " + app.displayVersion + " | " + (app.installLocation ?? app.regDir));
}
console.log("[real-registry] scan roots: " + JSON.stringify(defaultScanEnv()));
console.log("[real-registry] tray: " + JSON.stringify(buildTrayMenu({ jobs: [], upgradeCount: 2, pendingApprovals: 0 }).map((m) => m.label).filter(Boolean)));
console.log("[real-registry] status: " + trayStatusFor({ jobs: [], upgradeCount: 2, pendingApprovals: 0 }));

server.kill();
console.log("smoke done");
