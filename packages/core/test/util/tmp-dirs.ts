import { after } from "node:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 测试用临时目录的**唯一**建法：建了就登记，本文件跑完时回收。
 *
 * 为什么要有这个文件：实测约 25 个测试文件各自 `mkdtemp(path.join(tmpdir(), "x-"))` 却从不回收，
 * 本机系统临时目录因此堆到 8571 条，而 `npm run ci` 全绿——泄漏不会让任何断言变红，
 * 所以它是"成功路径沉默"的标准形状（隔离跑一次 engine.test.ts 就绿着留下 23 个目录）。
 *
 * 回收之后还要逐个复查：`rm` 在 Windows 上可能 EPERM/EBUSY，静默失败的话这个钩子就退化成
 * 一句"我们试过了"；查到的若不是 ENOENT 也当没回收，别把无关错误读成"已经没了"。
 */
const created: string[] = [];

// 钩子必须在**模块加载时**注册，不能等第一次建目录时再注册：
// 实测在测试执行中途调 after() 是"注册了但不触发"——新建的目录跑完仍在原地，而退出码还是 0，
// 于是这个共享回收器看起来在工作，实际什么都没回收（比不修更糟，因为它让"已修"变成一句谎）。
after(async () => {
  await drain();
});

export async function makeTrackedTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * 登记一个**不是本助手创建**的目录，让同一个 after() 一起回收。
 *
 * 需要它是因为一类真实存在的旁路：`recycle-retention.test.ts` 会故意在受跟踪目录的**兄弟位置**
 * 造一个 `escapee-*`（用来证明回收器不会把 root 之外的东西带走）。那条用例测的是回收的**边界**，
 * 所以正确的修法是把那个旁路目录显式登记进来，而**不是**让回收器去猜"邻近目录"——
 * 后者恰好会破坏它想证明的性质，也会把别人的东西纳入删除范围。
 *
 * 不做存在性校验也不报错：登记时目录可能还没被建出来（测试随后才 mkdir），
 * 真正的判据在回收之后（drain 会逐个复查到 ENOENT）。
 */
export function trackExisting(dir: string): string {
  created.push(dir);
  return dir;
}

/**
 * 给判据用的只读视图：还没被回收的登记项。
 * 存在的意义是让"回收到底有没有发生"能被**当场证伪**——`tmp-dirs-tracked.test.ts` 的 after()
 * 读它，一旦有人把钩子改回延迟注册（那种写法是静默失效：目录留着、退出码仍是 0），这里就会看见非空。
 */
export function pendingTrackedDirs(): string[] {
  return [...created];
}

/**
 * 进程退出时的最后一道判据：登记过却还活着的东西 ⇒ 说明 drain 根本没跑，直接让这次跑红。
 *
 * 为什么不用"在本文件的 after() 里检查助手有没有清空"：那要赌 after() 钩子的注册先后
 * （node:test 里根钩子的执行次序不是我能依赖的语义），而"赌顺序"正是这个仓库刚栽过的坑。
 * `process.on("exit")` 与钩子顺序无关，且在所有钩子之后必然执行。
 * 这里只能同步做事——只断言"列表为空"，不尝试补删（补删会把"回收失败"重新变成静默）。
 * 触发场景很具体：有人把上面那个 `after()` 改回"第一次建目录时才注册"，
 * 那种写法是**静默失效**的（目录留着、退出码仍是 0、断言全绿）。
 *
 * 已实测它在 CI 的真实调用方式下也有效：`npm test` 带 `--test-force-exit`（它会走 process.exit 路径，
 * 我一度怀疑那样就把我在退出处理器里设的 exitCode 冲掉了），孪生的"延迟注册"变异体在**加与不加**
 * 该参数两种跑法下都是退出码 1 且点名消息照打 ⇒ 这个判据不是只在隔离环境才咬得住。
 */
process.on("exit", () => {
  if (created.length > 0) {
    process.stderr.write("临时目录没被回收（after() 大概被改成延迟注册了）：" + created.join("、") + "\n");
    process.exitCode = 1;
  }
});

async function drain(): Promise<void> {
  const pending = created.splice(0, created.length);
  for (const dir of pending) {
    await rm(dir, { recursive: true, force: true });
  }
  const survivors: string[] = [];
  for (const dir of pending) {
    try {
      await access(dir);
      survivors.push(dir + "（仍然存在）");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") survivors.push(dir + "（查询失败：" + String(code) + "）");
    }
  }
  if (survivors.length > 0) throw new Error("测试临时目录没被回收：" + survivors.join("、"));
}
