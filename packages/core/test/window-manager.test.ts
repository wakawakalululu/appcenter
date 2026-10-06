import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowManager, isSystemComponent, type WindowDescriptor, type WindowHost } from "@appcenter/core";

function fakeHost(): WindowHost & { calls: { create: number; show: string[]; focus: string[]; close: string[] } } {
  let seq = 0;
  const calls = { create: 0, show: [] as string[], focus: [] as string[], close: [] as string[] };
  return {
    calls,
    async create() {
      calls.create += 1;
      return "win-" + String(seq++);
    },
    async show(id) { calls.show.push(id); },
    async hide() { /* no-op */ },
    async focus(id) { calls.focus.push(id); },
    async close(id) { calls.close.push(id); },
  };
}

test("同一 role 的不同 key 是两个独立窗口，不再互相顶掉", async () => {
  const host = fakeHost();
  const wm = new WindowManager(host);
  const a = await wm.open("bulk-install", { key: "batchA" });
  const b = await wm.open("bulk-install", { key: "batchB" });
  assert.notEqual(a.id, b.id, "旧实现把算出来的 key 直接 `void key` 丢掉，只按 role 复用，两个批次会共用一个窗口");
  assert.equal(host.calls.create, 2);

  const again = await wm.open("bulk-install", { key: "batchA" });
  assert.equal(again.id, a.id, "同 key 仍应复用");
  assert.equal(host.calls.create, 2);
});

test("allowMultiple 的复用只能在同 role 内，且命中后要真的显示并聚焦", async () => {
  const host = fakeHost();
  const wm = new WindowManager(host);
  const settings = await wm.open("settings", { route: "/dup" });
  const detail = await wm.open("detail", { allowMultiple: true, route: "/dup" });
  assert.notEqual(detail.id, settings.id, "旧实现跨 role 按 route 命中，会返回另一个角色的窗口");
  assert.equal(host.calls.create, 2);

  const reopened = await wm.open("detail", { allowMultiple: true, route: "/dup" });
  assert.equal(reopened.id, detail.id);
  assert.deepEqual(host.calls.show, [detail.id], "复用隐藏窗口时必须 show");
  assert.deepEqual(host.calls.focus, [detail.id], "复用隐藏窗口时必须 focus");
});

test("remove() 抹掉 OS 侧已关闭的窗口，避免复用到死 id", async () => {
  const host = fakeHost();
  const wm = new WindowManager(host);
  const main = await wm.open("main");
  assert.equal((await wm.open("main")).id, main.id);
  wm.remove(main.id); // 用户在 OS 标题条上直接关了窗口
  assert.equal(wm.list().length, 0);
  const fresh = await wm.open("main");
  assert.notEqual(fresh.id, main.id, "旧实现没有 remove()，死 id 会一直被复用：show(死 id) 不开窗也不报错");
  assert.equal(host.calls.create, 2);
});

test("requestClose 之后同样不再残留描述符", async () => {
  const host = fakeHost();
  const wm = new WindowManager(host);
  const detail = await wm.open("detail", { allowMultiple: true, route: "/app/x" });
  const closed = await wm.requestClose(detail.id);
  assert.equal(closed.minimizedToTray, false);
  assert.equal(wm.list().length, 0);
  assert.equal((await wm.open("detail", { allowMultiple: true, route: "/app/x" })).id !== detail.id, true);
});

test("主窗口关闭进托盘不算销毁，仍可被 focusOrOpen 唤回", async () => {
  const host = fakeHost();
  const wm = new WindowManager(host);
  const main = await wm.open("main");
  assert.equal((await wm.requestClose(main.id)).minimizedToTray, true);
  assert.equal(wm.list().length, 1);
  assert.equal((await wm.focusOrOpen("main")).id, main.id);
  assert.equal(host.calls.create, 1);
});

test("系统组件识别：SQL Server 不再被当成 Windows 更新件，补丁号仍算", () => {
  assert.equal(isSystemComponent("Microsoft SQL Server 2019 Setup"), false, "裸子串 MICROSOFT SQL 会把这个用户主动安装的产品整条藏掉");
  assert.equal(isSystemComponent("Microsoft Visual C++ 2015-2022 Redistributable"), false);
  assert.equal(isSystemComponent("Security Update for Windows (KB5034441)"), true);
  assert.equal(isSystemComponent("Update for Windows 11 (KB5028185)"), true);
  assert.equal(isSystemComponent("Windows 10 版本升级助手"), false);
  assert.equal(isSystemComponent("Microsoft Mouse and Keyboard Center"), false);
  assert.equal(isSystemComponent("某键盘驱动 KB 版"), false, "没有补丁号的裸 KB 不该命中");
});
