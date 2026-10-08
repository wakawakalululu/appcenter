import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShellArgs, findShellExecutable, geometryFor, shellCandidates } from "../src/desktop.ts";

test("window geometry follows the 60.4% x 66.1% workarea ratio with a floor", () => {
  // 实测基准：2048x1112 工作区 → 1237x735，居中。
  const geometry = geometryFor({ x: 0, y: 0, width: 2048, height: 1112 });
  assert.deepEqual(geometry, { x: 406, y: 189, width: 1237, height: 735 });

  // 小工作区触底下限，且不出工作区。
  const tiny = geometryFor({ x: 10, y: 20, width: 1000, height: 700 });
  assert.equal(tiny.width, 900);
  assert.equal(tiny.height, 600);
  assert.equal(tiny.x, 10 + Math.round((1000 - 900) / 2));
  assert.equal(tiny.y, 20 + Math.round((700 - 600) / 2));
});

test("shell discovery picks the first existing candidate and tolerates holes", async () => {
  const seen: string[] = [];
  const exists = async (file: string): Promise<boolean> => {
    seen.push(file);
    return file.endsWith("chrome-a.exe");
  };
  const picked = await findShellExecutable([undefined, "C:\\a\\chrome-a.exe", "C:\\b\\msedge.exe"], exists);
  assert.equal(picked, "C:\\a\\chrome-a.exe");
  assert.deepEqual(seen, ["C:\\a\\chrome-a.exe"], "命中即停，不探测后面的候选");

  assert.equal(await findShellExecutable([undefined, "C:\\missing\\edge.exe"], async () => false), null);
});

test("shell args launch an app window with geometry and an isolated profile", () => {
  const args = buildShellArgs("http://127.0.0.1:8080/?shell=app#/home", { x: 405, y: 188, width: 1237, height: 735 }, "C:\\tmp\\profile");
  assert.equal(args[0], "--app=http://127.0.0.1:8080/?shell=app#/home");
  assert.equal(args[1], "--window-size=1237,735");
  assert.equal(args[2], "--window-position=405,188");
  assert.match(args[3]!, /^--user-data-dir=C:\\tmp\\profile$/);
  assert.ok(args.includes("--no-first-run"));
});

test("浏览器位置随环境变量走：系统盘不是 C: 也找得到", () => {
  const list = shellCandidates({
    ProgramFiles: "D:\\Program Files",
    "ProgramFiles(x86)": "D:\\Program Files (x86)",
    LOCALAPPDATA: "D:\\Users\\mock\\AppData\\Local",
  });
  assert.ok(list.includes("D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"));
  assert.ok(list.includes("D:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"));
  assert.ok(list.includes("D:\\Users\\mock\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"), "用户级安装的 Chrome 也要在列");
  assert.ok(!list.some((c) => String(c).startsWith("C:\\")), "环境变量给全时不该再冒出写死 C: 的候选");
  // 反过来：没有那些变量时要退回 C: 兜底，候选不能变空（CI 与纯净环境靠它）。
  const fallback = shellCandidates({});
  assert.ok(String(fallback[1]).startsWith("C:\\"));
  assert.ok(fallback.some((c) => String(c).includes("msedge.exe")));
});

test("default candidates prefer chrome then edge, env override first", () => {
  const original = process.env.SHELL_PATH;
  try {
    delete process.env.SHELL_PATH;
    const list = shellCandidates();
    assert.equal(list[0], undefined);
    assert.ok(String(list[1]).includes("chrome.exe"));
    assert.ok(list.some((c) => String(c).includes("msedge.exe")));
    process.env.SHELL_PATH = "C:\\custom\\browser.exe";
    assert.equal(shellCandidates()[0], "C:\\custom\\browser.exe");
  } finally {
    if (original === undefined) delete process.env.SHELL_PATH;
    else process.env.SHELL_PATH = original;
  }
});
