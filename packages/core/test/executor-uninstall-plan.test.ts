import { test } from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { elevateViaPowerShell, parseUninstallCommand, tokenizeCommandLine } from "@appcenter/core";
import { makeTrackedTmp } from "./util/tmp-dirs.ts";

const GUID = "{1A2B3C4D-5E6F-7A8B-9C0D-1E2F3A4B5C6D}";

test("msiexec 卸载串里的产品码要取 /x 后面那段，不是最后一段", () => {
  // 真机常见形态：开关在后面，产品码在中间。旧实现取 segments[last] ⇒ 把 /qn 当产品码。
  for (const raw of [
    "msiexec.exe /x " + GUID + " /qn",
    "msiexec.exe /X" + GUID + " /quiet /norestart",
    "MsiExec.exe -X " + GUID + " /N",
    "C:\\Windows\\System32\\msiexec.exe /x " + GUID,
  ]) {
    const plan = parseUninstallCommand(raw, false);
    assert.equal(plan.program, "msiexec.exe");
    assert.equal(plan.args[0], "/x", raw);
    assert.equal(plan.args[1], GUID, "产品码取错了：" + raw + " → " + JSON.stringify(plan.args));
    assert.equal(plan.args.includes("/qn"), true, raw);
  }
});

test("产品码之外的开关不能被丢掉", () => {
  const plan = parseUninstallCommand("msiexec.exe /x " + GUID + " REMOVE=PREVIOUSVERSIONS", false);
  assert.equal(plan.args[1], GUID);
  assert.ok(plan.args.some((a) => a.startsWith("REMOVE=")), "自定义属性要留在参数里：" + JSON.stringify(plan.args));
});

test("提权执行必须把含空格的参数当成一个整体传过去", async (t) => {
  if (process.platform !== "win32") { t.skip("依赖 PowerShell"); return; }
  const dir = await makeTrackedTmp("elev-args-");
  const script = path.join(dir, "print-args.ps1");
  const outFile = path.join(dir, "out.txt");
  // 脚本把收到的参数条数与第一条原样写文件，直接检验进程真正收到了什么。
  await writeFile(script, "$args.Count | Set-Content -Encoding utf8 " + "'" + outFile.replace(/'/g, "''") + "'\n", "utf8");

  const result = await elevateViaPowerShell({
    program: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-File", script, "one argument with spaces", "second"],
    requiresAdmin: true,
    timeoutMs: 60000,
  });
  const received = (await readFile(outFile, "utf8")).trim();
  assert.equal(received, "2", "PowerShell 实际收到 " + received + " 个参数，期望 2 个（含空格的参数被拆开了）；stdout=" + result.stdout.slice(0, 200));
});

test("tokenizeCommandLine 对既有形态保持不动（回归护栏）", () => {
  assert.deepEqual(tokenizeCommandLine('"C:\\Program Files\\App\\unins000.exe" /SILENT'), ["C:\\Program Files\\App\\unins000.exe", "/SILENT"]);
  assert.deepEqual(tokenizeCommandLine("C:\\Program Files\\App\\unins000.exe /SILENT"), ["C:\\Program Files\\App\\unins000.exe", "/SILENT"]);
});
