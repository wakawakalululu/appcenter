import { after, test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runDesktop } from "../src/desktop.ts";

type Probe = (port: number, timeoutMs: number) => Promise<boolean>;

/**
 * waitForPort 是本次修复要新增的导出；按名 import 会在它存在之前把整个文件变成
 * 模块加载错假红，所以这里运行期取用，取不到就是本用例自己的行为红。
 */
async function probe(): Promise<Probe> {
  const mod = (await import("../src/desktop.ts")) as { waitForPort?: Probe };
  if (typeof mod.waitForPort !== "function") throw new Error("waitForPort 尚未导出：就绪判定还停留在日志字面匹配");
  return mod.waitForPort.bind(mod);
}

/**
 * 「端口已释放」不能拿 waitForPort 取反来断言：它是「一旦连得上就 true」，
 * 进程被 kill 与端口真正释放之间总有毫秒级间隙，取反会把正常的慢收敛误判成泄漏。
 * 这里反向轮询：持续探到连不上（连续两次）才算释放。
 */
async function waitUntilFree(port: number, timeoutMs = 4000): Promise<boolean> {
  const { waitForPort } = (await import("../src/desktop.ts")) as { waitForPort: Probe };
  const deadline = Date.now() + timeoutMs;
  let misses = 0;
  while (Date.now() < deadline) {
    // 每轮只给 200ms：连得上会立刻 true，连不上要等 connect 报错，足够区分。
    const up = await waitForPort(port, 200);
    if (up) misses = 0;
    else {
      misses += 1;
      if (misses >= 2) return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

/**
 * 假的「目录服务」：只监听端口，**一行日志都不打**——靠 stdout 字面匹配判就绪的
 * 实现会在这里超时；FAKE_EXIT_EARLY 则在监听之前就退出，用来验证失败回收。
 */
async function silentServerEntry(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "desktop-fake-"));
  fakeDirs.push(dir);
  const file = path.join(dir, "silent-server.mjs");
  await writeFile(
    file,
    "import net from 'node:net';\n" +
      "if (process.env.FAKE_EXIT_EARLY === '1') { console.error('boom'); process.exit(3); }\n" +
      "const port = Number(process.env.CATALOG_PORT ?? 0);\n" +
      "net.createServer().listen(port, '127.0.0.1', () => {});\n" +
      "setInterval(() => {}, 1000);\n",
    "utf8",
  );
  return file;
}

/**
 * 这个助手每次调用都在临时目录里写一个假服务脚本，此前**从不回收**：实测跑一次本文件
 * （4 条断言全绿）就多留 4 个 desktop-fake-*，本机已累积 404 个。
 * 「全绿」和「无界消耗资源」完全可以同时成立——这种目录只被子进程读一次，
 * 任何断言都不会因为它而变红，所以它是"成功路径沉默"那一族的又一副面孔。
 * 回收之后还要**逐个再查一次**：`rm` 在 Windows 上可能 EPERM/EBUSY，静默失败的话这个钩子
 * 就退化成一句"我们试过了"；查到的若不是 ENOENT 也当没回收，别把无关错误读成"已经没了"。
 */
const fakeDirs: string[] = [];

after(async () => {
  const created = fakeDirs.splice(0, fakeDirs.length);
  for (const dir of created) {
    await rm(dir, { recursive: true, force: true });
  }
  const survivors: string[] = [];
  for (const dir of created) {
    try {
      await access(dir);
      survivors.push(dir + "（仍然存在）");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") survivors.push(dir + "（查询失败：" + String(code) + "）");
    }
  }
  if (survivors.length > 0) throw new Error("假服务的临时目录没被回收：" + survivors.join("、"));
});

async function freePort(): Promise<number> {
  const srv = net.createServer();
  const port = await new Promise<number>((resolve) => srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port)));
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

async function occupiedPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const holder = net.createServer();
  const port = await new Promise<number>((resolve) => holder.listen(0, "127.0.0.1", () => resolve((holder.address() as net.AddressInfo).port)));
  return { port, release: () => new Promise<void>((resolve) => holder.close(() => resolve())) };
}

test("就绪判定走 TCP 探测而不是日志措辞，close() 之后端口必须释放", async () => {
  const waitForPort = await probe();
  const entry = await silentServerEntry();
  const catalogPort = await freePort();
  const session = await runDesktop({ serverEntry: entry, catalogPort, uiPort: 0, shellPath: "", workarea: { x: 0, y: 0, width: 1280, height: 800 } });
  try {
    assert.match(session.uiUrl, /^http:\/\/127\.0\.0\.1:\d+/, "桥应已就绪");
    assert.ok(await waitForPort(catalogPort, 1000), "假服务此时应在监听");
  } finally {
    await session.close();
  }
  assert.ok(await waitUntilFree(catalogPort), "close() 之后目录服务必须已退出");
});

test("目录服务起不来：runDesktop 拒绝，且宿主进程不被未处理异常打死", async () => {
  const entry = await silentServerEntry();
  const catalogPort = await freePort();
  await assert.rejects(
    () => runDesktop({ serverEntry: entry, catalogPort, uiPort: 0, shellPath: "", workarea: { x: 0, y: 0, width: 1280, height: 800 }, envExtras: { FAKE_EXIT_EARLY: "1" } }),
    /exit|did not listen|spawn failed/i,
  );
  assert.ok(!(await waitForPortReal(catalogPort, 300)), "服务没起来，端口不该可连");
});

async function waitForPortReal(port: number, timeoutMs: number): Promise<boolean> {
  const fn = await probe();
  return fn(port, timeoutMs);
}

test("开窗前任何一步失败（桥端口被占）都必须回收已起的目录服务", async () => {
  const entry = await silentServerEntry();
  const catalogPort = await freePort();
  const taken = await occupiedPort();
  try {
    await assert.rejects(() => runDesktop({ serverEntry: entry, catalogPort, uiPort: taken.port, shellPath: "", workarea: { x: 0, y: 0, width: 1280, height: 800 } }));
    assert.ok(await waitUntilFree(catalogPort), "startUi 抛错后目录服务必须被 kill，否则端口与进程双泄漏");
  } finally {
    await taken.release();
  }
});

test("浏览器 profile 目录在会话关闭后不得留在 %TEMP%", async () => {
  const entry = await silentServerEntry();
  const catalogPort = await freePort();
  const session = await runDesktop({ serverEntry: entry, catalogPort, uiPort: 0, shellPath: "", workarea: { x: 0, y: 0, width: 1280, height: 800 } });
  const profiles = session.profileDirs;
  assert.ok(Array.isArray(profiles) && profiles.length > 0, "runDesktop 应报告它建过哪些 profile 目录");
  for (const dir of profiles) assert.ok(dir.startsWith(path.join(tmpdir(), "appcenter-shell-")), "profile 必须落在约定的临时前缀下：" + dir);
  await session.close();
  const stillThere = await Promise.all(profiles.map((dir) => access(dir).then(() => true).catch(() => false)));
  assert.ok(!stillThere.some(Boolean), "close() 之后 profile 目录应被清掉：" + JSON.stringify(stillThere));
});
