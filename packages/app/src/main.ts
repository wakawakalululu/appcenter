import os from "node:os";
import path from "node:path";
import { startUi } from "./bridge.ts";

const serverUrl = process.env.APPCENTER_API ?? "http://127.0.0.1:7991";
const started = await startUi({
  serverUrl,
  userId: process.env.APPCENTER_USER ?? os.userInfo().username,
  dataDir: process.env.APPCENTER_DATA ?? path.join(os.homedir(), ".appcenter"),
  appVersion: "1.0.0",
  port: Number(process.env.UI_PORT ?? 8080),
  token: process.env.APPCENTER_TOKEN ?? "",
});
console.log("appcenter ui: " + started.url);
console.log("catalog api:  " + serverUrl);
