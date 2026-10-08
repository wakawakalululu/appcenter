import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { makeTrackedTmp, pendingTrackedDirs } from "./util/tmp-dirs.ts";

/**
 * 钉的是**回收机制会不会悄悄不工作**，不是某个测试有没有忘记清理目录。
 *
 * 判据本身在助手的 `process.on("exit")` 里：登记过却活到进程退出 ⇒ 打印点名并把退出码改成 1。
 * 之所以用退出钩子而不是"在本文件的 after() 里看助手清没清"：根级 after() 的执行先后
 * 不是我能依赖的语义，而"赌钩子顺序"正是这个仓库刚栽过的坑（extras-hardening 那条收尾也是因此写成显式顺序）。
 *
 * 为什么这条值得钉：把 `after()` 改成"第一次建目录时才注册"是**静默失效**的——
 * 实测那种写法下目录一个都没回收、断言却全绿、退出码仍是 0。没有这条判据，仓库里不会有任何东西变红。
 */
const seen: string[] = [];

test("建两个受跟踪目录，并证明跑的过程中它们确实存在、确实登记着", async () => {
  const a = await makeTrackedTmp("tracked-live-");
  const b = await makeTrackedTmp("tracked-live-");
  seen.push(a, b);
  assert.ok(existsSync(a) && existsSync(b), "用例进行到一半目录就该在，否则后面的判据没有对象");
  const pending = pendingTrackedDirs();
  assert.ok(
    pending.filter((d) => d === a || d === b).length === 2,
    "两个新目录没有都出现在登记表里 ⇒ 助手根本没在记账：" + pending.join("、"),
  );
});

test("同一文件里的后续用例也照样登记（钩子只在模块加载时注册一次，够用）", async () => {
  const c = await makeTrackedTmp("tracked-live-");
  seen.push(c);
  assert.ok(existsSync(c));
});

test("阳性对照：样本建够了 3 个，否则退出判据是空转", async () => {
  assert.equal(seen.length, 3, "上面两条没建出目录，进程退出时那道判据就没有任何东西可查");
  // 这里**故意不**断言"已经被回收"——回收发生在所有用例之后，此刻必然还在。
  // 真正的红/绿由退出钩子决定：跑完还留着就是 exit 1。
  assert.equal(pendingTrackedDirs().length, 3, "此刻还没轮到 drain，登记数应当是 3");
});
