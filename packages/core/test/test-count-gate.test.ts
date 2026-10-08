import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// 这条门禁防的是最贵的一种假绿：`node --test "<glob>"` 在 glob 一个文件都没匹配上时退出码仍是 0、
// 汇总打 `tests 0`，整作业十几秒就"绿"完（#83 本机实测）。
// 它自己如果没有用例钉着，就等于把整个 CI 的可信度押在一个从没被反例验证过的脚本上。
const script = path.join(process.cwd(), "scripts", "check-test-count.mjs");

async function gate(args: string[]): Promise<{ status: number | null; out: string }> {
  const run = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { status: run.status, out: (run.stdout ?? "") + (run.stderr ?? "") };
}

async function logWith(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "count-gate-"));
  const file = path.join(dir, "npm-test.log");
  await writeFile(file, body, "utf8");
  return file;
}

// 汇总行的形状才是被测对象；前面那行"用例输出"用普通文本，别放 U+2714（它落在 emoji 基线的禁列 \u2600-\u27BF，
// 会让 check:emoji 在真实 CI 上把整个作业判红——本仓库的图标一律内联 SVG，源码里也不留字符图形）。
const summary = (tests: number, pass: number, fail: number, extra = "") =>
  "ok 1 - 某条用例 (1ms)\nℹ tests " + String(tests) + "\nℹ pass " + String(pass) + "\nℹ fail " + String(fail) + "\n" + extra;

async function withLog<T>(body: string, fn: (file: string) => Promise<T>): Promise<T> {
  const file = await logWith(body);
  try {
    return await fn(file);
  } finally {
    await rm(path.dirname(file), { recursive: true, force: true });
  }
}

test("正常汇总 ⇒ 绿（否则下面的红都说明脚本根本没跑起来）", async () => {
  await withLog(summary(120, 120, 0), async (file) => {
    const r = await gate(["100", file]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /用例数门禁通过/);
  });
});

test("glob 退化成零用例 ⇒ 必须红（这正是这条门禁存在的理由）", async () => {
  await withLog(summary(0, 0, 0), async (file) => {
    const r = await gate(["100", file]);
    assert.equal(r.status, 1, "零用例被判绿了，门禁失效：" + r.out);
    assert.match(r.out, /低于下限/);
  });
});

test("有失败用例 ⇒ 红", async () => {
  await withLog(summary(120, 118, 2), async (file) => {
    assert.equal((await gate(["100", file])).status, 1);
  });
});

test("汇总行缺失（npm test 提前崩掉）⇒ 红，不能当成没发生", async () => {
  await withLog("node:internal/modules/run_main:12\nError: something died\n", async (file) => {
    const r = await gate(["100", file]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /没解析到测试汇总/);
  });
});

test("账不平 ⇒ 红：pass 少于 tests 又没有 cancelled/skipped/todo 解释", async () => {
  await withLog(summary(10, 8, 0), async (file) => {
    const r = await gate(["5", file]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /不等于/);
  });
});

test("合法跳过不能误伤：tests=pass+skipped ⇒ 绿（平台相关的 skip 是常态）", async () => {
  await withLog(summary(10, 8, 0, "ℹ skipped 2\n"), async (file) => {
    assert.equal((await gate(["5", file])).status, 0, "把合法跳过判成红了：" + (await gate(["5", file])).out);
  });
});

test("tap 形态的 `# tests` 汇总也要认（报告器换了不能变成静默放行）", async () => {
  await withLog("# tests 130\n# pass 130\n# fail 0\n", async (file) => {
    assert.equal((await gate(["100", file])).status, 0);
  });
});

test("参数缺失 ⇒ 用法错误（exit 2），与「测试没跑」区分开", async () => {
  const r = await gate([]);
  assert.equal(r.status, 2, r.out);
});
