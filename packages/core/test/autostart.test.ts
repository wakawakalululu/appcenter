import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AUTO_START_ENTRY_NAME,
  AppCenterFacade,
  AutoStartController,
  MemoryAutoStartBackend,
  RegAutoStartBackend,
  sanitize,
  type AutoStartBackend,
  type RuntimeConfig,
  type WindowHost,
} from "@appcenter/core";

const CMD = '"C:\\Program Files\\AppCenter\\AppCenter.exe" --silent';

class NullHost implements WindowHost {
  async create(): Promise<string> {
    return "win-1";
  }
  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async close(): Promise<void> {}
  async focus(): Promise<void> {}
}

type Call = { op: "write" | "delete" | "read"; name: string; command?: string };

/** 记录每一次调用，用来证明「没有多余动作」以及「没有触达真实注册表」。 */
class SpyAutoStartBackend implements AutoStartBackend {
  readonly calls: Call[] = [];
  private readonly entries = new Map<string, string>();
  async writeRunEntry(name: string, command: string): Promise<void> {
    this.calls.push({ op: "write", name, command });
    this.entries.set(name, command);
  }
  async deleteRunEntry(name: string): Promise<void> {
    this.calls.push({ op: "delete", name });
    this.entries.delete(name);
  }
  async readRunEntry(name: string): Promise<string | null> {
    this.calls.push({ op: "read", name });
    return this.entries.get(name) ?? null;
  }
}

async function facadeWith(backend: AutoStartBackend, init?: Partial<RuntimeConfig>) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "autostart-"));
  if (init) await writeFile(path.join(dataDir, "runtime-config.json"), JSON.stringify(init), "utf8");
  const facade = new AppCenterFacade(
    {
      serverUrl: "http://127.0.0.1:1",
      userId: "me",
      dataDir,
      appVersion: "1.0.0",
      registryKeys: [],
      autoStartBackend: backend,
      autoStartCommand: CMD,
    },
    new NullHost(),
  );
  return { facade, dataDir };
}

async function withFacade<T>(backend: AutoStartBackend, init: Partial<RuntimeConfig> | undefined, fn: (facade: AppCenterFacade) => Promise<T>): Promise<T> {
  const { facade, dataDir } = await facadeWith(backend, init);
  try {
    return await fn(facade);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("默认开机自启条目名是 AppCenter", () => {
  assert.equal(AUTO_START_ENTRY_NAME, "AppCenter");
});

test("开启自启写入 Run 项，关闭则删除", async () => {
  const backend = new MemoryAutoStartBackend();
  const controller = new AutoStartController(backend);
  assert.equal(await controller.isEnabled(), false);

  await controller.apply(true, CMD);
  assert.equal(await backend.readRunEntry("AppCenter"), CMD);
  assert.equal(await controller.isEnabled(), true);

  await controller.apply(false, CMD);
  assert.equal(await backend.readRunEntry("AppCenter"), null);
  assert.equal(await controller.isEnabled(), false);
});

test("关闭时删除不存在的条目不抛错", async () => {
  const backend = new MemoryAutoStartBackend();
  const controller = new AutoStartController(backend);
  await controller.apply(false, CMD);
  assert.equal(await controller.isEnabled(), false);
});

test("自定义条目名生效且互不干扰", async () => {
  const backend = new MemoryAutoStartBackend();
  const controller = new AutoStartController(backend, "Other");
  await controller.apply(true, CMD);
  assert.equal(await backend.readRunEntry("Other"), CMD);
  assert.equal(await backend.readRunEntry("AppCenter"), null);
  assert.equal(await controller.isEnabled(), true);
});

test("updateRuntimeConfig 开启自启会写到注入的后端", async () => {
  const backend = new MemoryAutoStartBackend();
  await withFacade(backend, undefined, async (facade) => {
    const result = await facade.updateRuntimeConfig({ autoStart: true });
    assert.equal(result.config.autoStart, true);
    assert.deepEqual(result.issues, []);
    assert.equal(typeof result.scheduler.running, "boolean");
    assert.equal(await backend.readRunEntry("AppCenter"), CMD, "命令来自 autoStartCommand");
  });
});

test("patch 不含 autoStart 时完全不碰后端", async () => {
  const spy = new SpyAutoStartBackend();
  await withFacade(spy, undefined, async (facade) => {
    const result = await facade.updateRuntimeConfig({ concurrency: 3 });
    assert.equal(result.config.concurrency, 3);
    assert.equal(spy.calls.length, 0, "不应触达自启后端");
  });
});

test("applyAutoStart 按配置幂等同步，开启时写入", async () => {
  const backend = new MemoryAutoStartBackend();
  await withFacade(backend, { autoStart: true }, async (facade) => {
    await facade.applyAutoStart();
    await facade.applyAutoStart();
    assert.equal(await backend.readRunEntry("AppCenter"), CMD);
  });
});

test("applyAutoStart 关闭时会清掉手工残留的 Run 项", async () => {
  const backend = new MemoryAutoStartBackend();
  await withFacade(backend, { autoStart: false }, async (facade) => {
    await backend.writeRunEntry("AppCenter", "stale-entry");
    await facade.applyAutoStart();
    assert.equal(await backend.readRunEntry("AppCenter"), null, "以配置为准");
  });
});

test("自启配置落盘后，新实例按同一 dataDir 读回", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "autostart-shared-"));
  try {
    const first = new AppCenterFacade(
      { serverUrl: "http://127.0.0.1:1", userId: "me", dataDir, appVersion: "1.0.0", registryKeys: [], autoStartBackend: new MemoryAutoStartBackend(), autoStartCommand: CMD },
      new NullHost(),
    );
    await first.updateRuntimeConfig({ autoStart: true });

    const secondBackend = new MemoryAutoStartBackend();
    const second = new AppCenterFacade(
      { serverUrl: "http://127.0.0.1:1", userId: "me", dataDir, appVersion: "1.0.0", registryKeys: [], autoStartBackend: secondBackend, autoStartCommand: CMD },
      new NullHost(),
    );
    assert.equal((await second.runtimeConfig()).config.autoStart, true, "配置已落盘");
    await second.applyAutoStart();
    assert.equal(await secondBackend.readRunEntry("AppCenter"), CMD, "新实例读回并同步");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("非法 autoStart 回落为 false 且不被计为 issue", async () => {
  const sanitized = sanitize({ autoStart: "yes" as never });
  assert.equal(sanitized.config.autoStart, false);
  assert.ok(!sanitized.issues.some((i) => i.field === "autoStart"), "非法 autoStart 静默回落，不产生 issue");

  const spy = new SpyAutoStartBackend();
  await withFacade(spy, undefined, async (facade) => {
    const result = await facade.updateRuntimeConfig({ autoStart: "yes" as never });
    assert.equal(result.config.autoStart, false);
    assert.ok(!spy.calls.some((c) => c.op === "write"), "回落为 false 时不应写入 Run 项");
  });
});

test("未注入后端时 facade 连的是真实 RegAutoStartBackend（故自启测试必须注入）", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "autostart-real-"));
  try {
    const facade = new AppCenterFacade(
      { serverUrl: "http://127.0.0.1:1", userId: "me", dataDir, appVersion: "1.0.0", registryKeys: [] },
      new NullHost(),
    );
    const controller = (facade as unknown as { autoStart: unknown }).autoStart;
    const backend = (controller as unknown as { backend: unknown }).backend;
    assert.ok(backend instanceof RegAutoStartBackend, "默认后端会写真实注册表");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
