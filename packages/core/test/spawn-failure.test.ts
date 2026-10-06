import { test } from "node:test";
import assert from "node:assert/strict";
import { AutoStartController, RegAutoStartBackend } from "@appcenter/core";

const uncaught: unknown[] = [];
process.on("uncaughtException", (err) => uncaught.push(err));

const MISSING = "definitely-not-a-real-program-appcenter-test.exe";

async function outcome(p: Promise<unknown>, ms = 2000): Promise<"resolved" | "rejected" | "hung"> {
  const timer = new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms));
  return Promise.race([p.then(() => "resolved" as const, () => "rejected" as const), timer]);
}

test("spawn 失败必须以 rejection 交回调用方，而不是让 promise 永挂 + 打死宿主进程", async () => {
  const backend = new RegAutoStartBackend(MISSING);
  assert.equal(await outcome(backend.writeRunEntry("AppCenter", "node app.js")), "rejected", "旧写法没有 child.on('error')，promise 永不 settle");
  assert.deepEqual(uncaught, [], "不应出现未处理的 'error' 事件——本机 Node 24 下它等于进程 exit 1");
});

test("读取失败降级为 null；控制器开启时如实抛错，关闭时吞掉", async () => {
  const controller = new AutoStartController(new RegAutoStartBackend(MISSING));
  assert.equal(await controller.isEnabled(), false);
  await assert.rejects(() => controller.apply(true, "node app.js"));
  await controller.apply(false, "node app.js");
  assert.equal(uncaught.length, 0);
});
