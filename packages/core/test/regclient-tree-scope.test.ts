import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryRegClient, RUN_ROOTS, regKey } from "@appcenter/core";

const BS = String.fromCharCode(92);
const hkcuRun = RUN_ROOTS[0] ?? "";
const hkcuRunOnce = RUN_ROOTS[1] ?? "";

/**
 * `queryTree` 必须按**键边界**取子树：真机 `reg.exe query <root> /s` 只返回该键自己与它的子键，
 * 不会把同名的兄弟键（`...\Run` 与 `...\RunOnce` 就是一对前缀关系）一起带回来。
 * 桩实现用裸 `startsWith` 就会多返回兄弟键——测试里表现为「读到了根上并不存在的残留项」，
 * 足以把按根隔离、失败根不产项这类判据悄悄糊成假绿。
 */
test("queryTree 不得把名字互为前缀的兄弟键当成自己的子树", async () => {
  const reg = new InMemoryRegClient([
    regKey(hkcuRun + BS + "DemoApp", { DemoApp: "C:\\Program Files\\Demo\\demo.exe" }),
    regKey(hkcuRunOnce + BS + "OtherApp", { OtherApp: "C:\\Program Files\\Other\\other.exe" }),
  ]);

  const runKeys = await reg.queryTree(hkcuRun);
  const runOnceKeys = await reg.queryTree(hkcuRunOnce);

  assert.ok(runKeys.length >= 1, "根自身与它的子键要能读到");
  assert.ok(
    runKeys.every((k) => k.path === hkcuRun || k.path.toLowerCase().startsWith(hkcuRun.toLowerCase() + BS)),
    "查询 `...\\Run` 读到了兄弟键 `...\\RunOnce` 下的项：" + JSON.stringify(runKeys.map((k) => k.path)),
  );
  assert.ok(
    runOnceKeys.every((k) => k.path === hkcuRunOnce || k.path.toLowerCase().startsWith(hkcuRunOnce.toLowerCase() + BS)),
    "反向也不能串：" + JSON.stringify(runOnceKeys.map((k) => k.path)),
  );
});

test("queryTree 读根键自身时仍要带上它自己的键值", async () => {
  const reg = new InMemoryRegClient([regKey(hkcuRun, { Inline: "C:\\a.exe" })]);
  const keys = await reg.queryTree(hkcuRun);
  const self = keys.find((k) => k.path === hkcuRun);
  assert.ok(self, "根键自身必须在结果里（启动项就挂在根键的值上）");
  assert.equal(self?.values.find((v) => v.name === "Inline")?.data, "C:\\a.exe");
});
