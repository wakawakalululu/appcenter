import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listenerOwnerPid, runDesktop, type DesktopSession } from "../src/desktop.ts";

/**
 * 桌面壳的准备/退出判据要落在「是我起的进程」上，不是「那个端口有人听」。
 * 这一族缺陷在本仓库已经修过三处（smoke、demo 截图、ui-shot 的 CDP 端口），这里补 desktop.ts 那条。
 */
async function isolatedEnv(): Promise<{ DB_FILE: string; PACKAGE_ROOT: string; TMP_BASE: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "desktop-id-"));
  return { DB_FILE: path.join(dir, "catalog.db"), PACKAGE_ROOT: path.join(dir, "pkgs"), TMP_BASE: dir };
}

const desktopOptions = (extras: { DB_FILE: string; PACKAGE_ROOT: string; TMP_BASE: string }) => ({
  uiPort: 0,
  shellPath: "",
  workarea: { x: 0, y: 0, width: 1280, height: 800 },
  envExtras: { DB_FILE: extras.DB_FILE, PACKAGE_ROOT: extras.PACKAGE_ROOT },
});

test("默认路径不复用任何 well-known 端口，起起来的是自己刚分配的临时号码", async () => {
  const extras = await isolatedEnv();
  const prior = process.env.CATALOG_PORT;
  delete process.env.CATALOG_PORT;
  let session: Awaited<ReturnType<typeof runDesktop>> | undefined;
  try {
    session = await runDesktop({ ...desktopOptions(extras) });
    // 旧实现这里得到 7991：一个所有本地实例都会去占的号码，占着它的不一定是这次起的服务。
    assert.notEqual(session.catalogPort, 7991, "默认不能再落到固定的 well-known 端口");
    assert.ok(session.catalogPort > 0, "必须有一个真正在用的端口号码");
    const res = await fetch("http://127.0.0.1:" + String(session.catalogPort) + "/api/apps");
    assert.equal(res.status, 200, "刚判定的就绪端口必须真的服务我们这份目录");
    const list = (await res.json()) as unknown[];
    assert.ok(Array.isArray(list) && list.length > 0, "阳性对照：拿到的必须是非空目录，而不是别的进程的空响应");
  } finally {
    if (session) await session.close();
    if (prior !== undefined) process.env.CATALOG_PORT = prior;
    await rm(path.dirname(extras.DB_FILE), { recursive: true, force: true });
  }
});

test("两个桌面壳并发跑：各自拿到不同端口，谁也不许顶掉谁", async () => {
  // 旧实现在这里必然是同一个 7991：第二个子进程 EADDRINUSE 退出，或者更糟——对上第一个的服务。
  const a = await isolatedEnv();
  const c = await isolatedEnv();
  delete process.env.CATALOG_PORT;
  let s1: Awaited<ReturnType<typeof runDesktop>> | undefined;
  let s2: Awaited<ReturnType<typeof runDesktop>> | undefined;
  try {
    [s1, s2] = await Promise.all([
      runDesktop(desktopOptions(a)),
      runDesktop(desktopOptions(c)),
    ]);
    assert.notEqual(s1.catalogPort, s2.catalogPort, "并发实例不许共用同一个端口号码");
    for (const s of [s1, s2]) {
      const res = await fetch("http://127.0.0.1:" + String(s.catalogPort) + "/api/apps");
      assert.equal(res.status, 200);
    }
  } finally {
    if (s1) await s1.close();
    if (s2) await s2.close();
    await rm(path.dirname(a.DB_FILE), { recursive: true, force: true });
    await rm(path.dirname(c.DB_FILE), { recursive: true, force: true });
  }
});

test("端口持有者查询本身可用（阳性对照），非 Windows 明确返回 null 而不是假通过", async () => {
  const holder = net.createServer();
  const port = await new Promise<number>((resolve) => holder.listen(0, "127.0.0.1", () => resolve((holder.address() as net.AddressInfo).port)));
  try {
    const accidental: Awaited<ReturnType<typeof runDesktop>>[] = [];

    const owner = await listenerOwnerPid(port);
    if (process.platform === "win32") {
      assert.equal(owner, process.pid, "查自己正在监听的端口必须得到本进程 PID；拿不到就说明这条判据是空的");
    } else {
      assert.equal(owner, null, "非 Windows 上必须是「明确不可用」，不能返回 0 或猜测值冒充核对通过");
    }
  } finally {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
});

test("显式请求的端口被别人占时：必须当场失败，绝不能把别人的服务当成就绪", async () => {
  // 这条正是缺陷的原形：端口能连上（这里连的是测试自己起的假监听），旧判据会点头说 ready。
  // 现在两种归宿都可接受——子进程绑不上而退出，或者身份核对发现持有者不是我们的子进程；
  // 不可接受的是「成功返回一个指向别人服务的会话」。
  const extras = await isolatedEnv();
  const taken = net.createServer();
  const port = await new Promise<number>((resolve) => taken.listen(0, "127.0.0.1", () => resolve((taken.address() as net.AddressInfo).port)));
  const accidental: DesktopSession[] = [];
  try {
    const err = await runDesktop({ ...desktopOptions(extras), catalogPort: port }).then(
      (s) => { accidental.push(s); return null },
      (e: unknown) => e as Error,
    );
    assert.ok(err !== null, "端口不是我们的，就必须失败而不是返回会话");
    assert.match(err.message, /持有，不是本次起的目录服务|exited early|did not listen|spawn failed/, err.message);
    if (/持有/.test(err.message)) {
      assert.ok(err.message.includes(String(port)), "身份失败要报出是哪个端口：" + err.message);
    }
  } finally {
    for (const s2 of accidental) await s2.close();
    await new Promise<void>((resolve) => taken.close(() => resolve()));
    await rm(path.dirname(extras.DB_FILE), { recursive: true, force: true });
  }
});
