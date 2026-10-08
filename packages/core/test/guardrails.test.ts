import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installProcessGuardrails } from "@appcenter/core";
import { makeTrackedTmp } from "./util/tmp-dirs.ts";

const coreIndex = pathToFileURL(path.resolve(process.cwd(), "packages/core/src/index.ts")).href;

/**
 * 子进程必须跑「真·未处理拒绝」，所以要独立进程：`node -e` 在 Node 24 走 CJS 解析，
 * 带 import 会直接 SyntaxError，因此一律写成临时 .mts 再跑。
 */
async function runChild(body: string, label = "case"): Promise<{ code: number; out: string }> {
  const dir = await makeTrackedTmp("guard-child-");
  const file = path.join(dir, label + ".mts");
  await writeFile(file, body, "utf8");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-transform-types", file], { stdio: ["ignore", "pipe", "pipe"], cwd: dir });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", (err) => resolve({ code: -1, out: out + "spawn failed: " + err.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

test("护栏在位时：旁路任务的未处理拒绝不再带走宿主进程", async () => {
  const result = await runChild(
    "import { installProcessGuardrails } from " + JSON.stringify(coreIndex) + ";\n" +
      "installProcessGuardrails({ log: (_l, m) => console.log('SINK ' + m.split('\\n')[0]) });\n" +
      "Promise.reject(new Error('side task blew up'));\n" +
      "setTimeout(() => console.log('ALIVE'), 120);\n",
  );
  assert.match(result.out, /SINK unhandledRejection #1: Error: side task blew up/, "死因要落到 sink：" + result.out.slice(0, 200));
  assert.match(result.out, /ALIVE/, "旁路拒绝不该把宿主打死（未修时这里 exit 1 且无 ALIVE）");
  assert.equal(result.code, 0, "退出码应为 0，实际 " + String(result.code) + " / " + result.out.slice(0, 200));
});

test("没有护栏时：同一个未处理拒绝确实会终止进程（对照组）", async () => {
  const result = await runChild("Promise.reject(new Error('side task blew up'));\nsetTimeout(() => console.log('ALIVE'), 120);\n");
  assert.doesNotMatch(result.out, /ALIVE/, "对照组必须证明这是真风险，不是我在修一个不存在的问题");
  assert.notEqual(result.code, 0, "未修时退出码应非 0");
});

test("未捕获异常：记录死因后仍按原样退出，不假装恢复", async () => {
  const result = await runChild(
    "import { installProcessGuardrails } from " + JSON.stringify(coreIndex) + ";\n" +
      "installProcessGuardrails({ log: (_l, m) => console.log('SINK ' + m.split('\\n')[0]) });\n" +
      "setTimeout(() => { throw new Error('unreachable state'); }, 10);\n",
  );
  assert.match(result.out, /SINK uncaughtException #1: Error: unreachable state/);
  assert.equal(result.code, 1, "uncaughtException 之后必须退，实际退出码 " + String(result.code));
});

test("卸载护栏之后，同样的未处理拒绝重新会杀死进程（证明监听器真的被摘掉）", async () => {
  const result = await runChild(
    "import { installProcessGuardrails } from " + JSON.stringify(coreIndex) + ";\n" +
      "const uninstall = installProcessGuardrails({ log: () => console.log('SINK') });\n" +
      "uninstall();\n" +
      "Promise.reject(new Error('after uninstall'));\n" +
      "setTimeout(() => console.log('ALIVE'), 120);\n",
    "uninstall",
  );
  assert.doesNotMatch(result.out, /ALIVE/, "卸载后不该再有兜底：" + result.out.slice(0, 200));
  assert.notEqual(result.code, 0, "卸载后未处理拒绝应终止进程，实际退出码 " + String(result.code));
});

test("重复安装只保留一份监听器（宿主热重启不叠加日志）", async () => {
  const dir = await makeTrackedTmp("guard-dup-");
  const file = path.join(dir, "dup.mts");
  await writeFile(
    file,
    "import { installProcessGuardrails } from " + JSON.stringify(coreIndex) + ";\n" +
      "let n = 0;\n" +
      "installProcessGuardrails({ log: () => { n += 1; } });\n" +
      "installProcessGuardrails({ log: () => { n += 1; } });\n" +
      "process.emit('unhandledRejection', new Error('once'));\n" +
      "console.log('COUNT ' + String(n));\n",
    "utf8",
  );
  const result = await runChild("import " + JSON.stringify(pathToFileURL(file).href));
  assert.match(result.out, /COUNT 1/, "两次安装应只有一个在记：" + result.out.slice(0, 200));
});
