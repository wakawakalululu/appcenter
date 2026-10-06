import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UNINSTALL_ROOTS,
  regKey,
  toInstalledApp,
  scanResidue,
  decodeTextWithBom,
  type FileSystemProbe,
  type InstalledApp,
  type RegistryKey,
} from "@appcenter/core";

const BS = String.fromCharCode(92);

function utf16leWithBom(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

test("decodeTextWithBom 识别 UTF-16LE/BE 与 UTF-8 BOM，无 BOM 仍按 UTF-8", () => {
  assert.equal(decodeTextWithBom(Buffer.from("plain <Task/>", "utf8")), "plain <Task/>");
  assert.equal(decodeTextWithBom(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<Task/>", "utf8")])), "<Task/>");
  const decoded = decodeTextWithBom(utf16leWithBom('<Task><Command>C:\\x.exe</Command></Task>'));
  assert.ok(decoded.includes("<Task") && decoded.includes("C:\\x.exe"));
  const le = Buffer.from("<Task>ok</Task>", "utf16le");
  const be = Buffer.from(le);
  for (let i = 0; i + 1 < be.length; i += 2) {
    const a = be[i] as number;
    be[i] = be[i + 1] as number;
    be[i + 1] = a;
  }
  assert.equal(decodeTextWithBom(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), "<Task>ok</Task>");
});

test("残留扫描能发现以 UTF-16LE 存储的计划任务残留（真机取证：旧 utf8 读法命中 0）", async () => {
  const installDir = ["C:", "Program Files", "DemoShell"].join(BS);
  const app: InstalledApp = (() => {
    const built = toInstalledApp(
      regKey((UNINSTALL_ROOTS[0]?.path ?? "") + BS + "DemoShell", {
        DisplayName: "Demo Shell",
        DisplayVersion: "1.0.0",
        InstallLocation: installDir,
        UninstallString: installDir + BS + "unins000.exe",
      }),
      "machine-64",
      "HKLM",
      false,
    );
    if (!built) throw new Error("fixture build failed");
    return built;
  })();

  // scanResidue 用固定 "\" 拼出 tasksRoot，这里用内存探针按同一路径喂 UTF-16 字节，跨平台一致。
  const tasksRoot = ["TASKROOT", "System32", "Tasks"].join(BS);
  const taskFile = tasksRoot + BS + "DemoShellTask";
  const taskBytes = utf16leWithBom(
    '<?xml version="1.0" encoding="UTF-16"?><Task version="1.2"><Actions><Exec><Command>' + installDir + BS + "runner.exe</Command></Exec></Actions></Task>",
  );
  const probe: FileSystemProbe = {
    exists: async () => false,
    readDir: async (p: string) => (p === tasksRoot ? [taskFile] : []),
    // 与生产 nodeProbe.readText 完全一致：读字节后按 BOM 解码
    readText: async (p: string) => (p === taskFile ? decodeTextWithBom(taskBytes) : null),
  };
  const emptyReg = { queryTree: async (): Promise<RegistryKey[]> => [], queryChildren: async () => [], readKey: async () => null };

  const report = await scanResidue(app, {
    reg: emptyReg,
    fs: probe,
    env: { programData: "P", appData: "A", commonStartMenu: "CS", userStartMenu: "US", temp: "T", systemRoot: "TASKROOT" },
  });

  assert.ok(report.counts.task >= 1, "UTF-16LE 计划任务残留应被发现（旧 utf8 读法此处为 0）");
  const task = report.items.find((i) => i.kind === "task");
  assert.ok(task, "应产出一条 task 残留");
  assert.equal(task?.risk, "high");
  assert.ok(task?.detail.includes("runner.exe"));
});
