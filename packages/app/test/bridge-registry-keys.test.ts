import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startUi } from "../src/bridge.ts";

const ROOT = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const key = (name: string, display: string, version: string) => ({
  path: ROOT + "\\" + name,
  values: [
    { name: "DisplayName", type: "REG_SZ", data: display },
    { name: "DisplayVersion", type: "REG_SZ", data: version },
    { name: "Publisher", type: "REG_SZ", data: "示例厂商" },
    { name: "InstallLocation", type: "REG_SZ", data: "C:\\Example\\" + name },
  ],
});

/**
 * 这条测的是「缝有没有真的接上」：startUi 若把 registryKeys 丢掉，facade 就退回 RegExeClient，
 * installed() 会去扫**这台机器真实的注册表**（本机 141 条），断言立刻不成立。
 * 演示入口的截图能脱敏（#91），全靠这一条转发在。
 */
test("startUi 转发 registryKeys：清单来自注入的假注册表，而不是真机", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bridge-reg-"));
  const started = await startUi({
    serverUrl: "http://127.0.0.1:1",
    userId: "demo",
    dataDir,
    appVersion: "1.0.0",
    port: 0,
    simulateInstalls: true,
    registryKeys: [key("DemoEditor", "示例编辑器", "2.4.0"), key("DemoPlayer", "示例播放器", "1.0.3")] as never,
  });
  try {
    const apps = await started.facade.installed();
    assert.deepEqual(
      apps.map((a) => a.displayName).sort(),
      ["示例播放器", "示例编辑器"],
      "只该看到注入的两条；多出来就说明它在扫真机注册表",
    );
    assert.ok(started.url.includes(":"), "端口 0 要回实际绑定值：" + started.url);
  } finally {
    await new Promise<void>((resolve, reject) => started.server.close((err) => (err ? reject(err) : resolve())));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("不注入时仍走真机路径（默认行为没被改动）", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bridge-reg-"));
  const started = await startUi({
    serverUrl: "http://127.0.0.1:1",
    userId: "demo",
    dataDir,
    port: 0,
    simulateInstalls: true,
  });
  try {
    const apps = await started.facade.installed();
    assert.ok(
      apps.every((a) => a.displayName !== "示例编辑器"),
      "没注入假清单时不该出现示例条目（说明默认路径被悄悄换掉了）",
    );
  } finally {
    await new Promise<void>((resolve, reject) => started.server.close((err) => (err ? reject(err) : resolve())));
    await rm(dataDir, { recursive: true, force: true });
  }
});
