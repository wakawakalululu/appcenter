import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// 这条门禁是 P8"定期自审依赖许可"的唯一落地物；判据必须由用例钉住，否则它会静默退化。
// 用临时 fixture 仓库跑，不碰真树的 node_modules。
const script = path.join(process.cwd(), "scripts", "check-licenses.mjs");

async function fixture(deps: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "lic-gate-"));
  // dependencies 必须是「名字 -> 版本范围」的映射；写成数组会让门禁把下标当包名，整条用例假红。
  const dependencies = Object.fromEntries(Object.keys(deps).map((n) => [n, "1.0.0"]));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", version: "0.0.0", dependencies }, null, 2) + "\n");
  await mkdir(path.join(dir, "node_modules"), { recursive: true });
  for (const [name, license] of Object.entries(deps)) {
    await mkdir(path.join(dir, "node_modules", name), { recursive: true });
    await writeFile(
      path.join(dir, "node_modules", name, "package.json"),
      JSON.stringify({ name, version: "1.0.0", ...(license === null ? {} : { license }) }, null, 2) + "\n",
    );
  }
  return dir;
}

function run(dir: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

test("宽松许可证 ⇒ 绿", async () => {
  const dir = await fixture({ alpha: "MIT", beta: "Apache-2.0", gamma: "BSD-3-Clause" });
  try {
    const r = run(dir);
    assert.equal(r.status, 0, r.out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("copyleft ⇒ 红并点名", async () => {
  const dir = await fixture({ alpha: "MIT", nasty: "GPL-3.0-or-later" });
  try {
    const r = run(dir);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /nasty/);
    assert.match(r.out, /GPL-3\.0-or-later/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("没有 license 字段 ⇒ 红（缺证即拒，不能默认放行）", async () => {
  const dir = await fixture({ mystery: null });
  try {
    const r = run(dir);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /mystery.*没有 license 字段/, r.out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("复合表达式里含未批准项 ⇒ 红（「(MIT OR GPL-2.0)」不能因为带 MIT 就放行）", async () => {
  const dir = await fixture({ combo: "(MIT OR GPL-2.0)" });
  try {
    const r = run(dir);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /combo/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("依赖没装 ⇒ 红，不能让空集合冒充通过", async () => {
  const dir = await fixture({});
  try {
    const r = run(dir);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /一个直接依赖都没解析到/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("真树自身的依赖许可 ⇒ 绿（否则这条门禁一提交就把 CI 弄红）", async () => {
  const r = run(process.cwd());
  assert.equal(r.status, 0, r.out);
});
