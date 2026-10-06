import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  UNINSTALL_ROOTS,
  regKey,
  toInstalledApp,
  scanResidue,
  decodeTextWithBom,
  type InstalledApp,
} from "@appcenter/core";

const BS = String.fromCharCode(92);

function utf16leWithBom(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

test("decodeTextWithBom 识别 UTF-16LE/BE 与 UTF-8 BOM，无 BOM 仍按 UTF-8", () => {
  assert.equal(decodeTextWithBom(Buffer.from("plain <Task/>", "utf8")), "plain <Task/>");
  assert.equal(decodeTextWithBom(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<Task/>", "utf8")])), "<Task/>");
  const u16 = utf16leWithBom('<?xml version="1.0"?><Task><Command>C:\\x.exe</Command></Task>');
  const decoded = decodeTextWithBom(u16);
  assert.ok(decoded.includes("<Task"), "UTF-16LE+BOM 应能识别出 <Task");
  assert.ok(decoded.includes("C:\\x.exe"));
  // UTF-16BE（FE FF）也要正确解码
  const le = Buffer.from("<Task>ok</Task>", "utf16le");
  const be = Buffer.from(le);
  for (let i = 0; i + 1 < be.length; i += 2) {
    const a = be[i] as number;
    be[i] = be[i + 1] as number;
    be[i + 1] = a;
  }
  assert.equal(decodeTextWithBom(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), "<Task>ok</Task>");
});

test("残留扫描能发现以 UTF-16LE 存储的计划任务残留（真机取证：旧实现命中 0）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "task-u16-"));
  try {
    const installDir = ["C:", "Program Files", "DemoShell"].join(BS);
    const tasksRoot = path.join(dir, "System32", "Tasks");
    await fs.mkdir(tasksRoot, { recursive: true });
    // 任务文件指向已卸载程序的 exe——正是应被抓到的高风险持久化残留
    const xml = '<?xml version="1.0" encoding="UTF-16"?>\r\n<Task version="1.2"><Executies><Exec><Command>' + installDir + BS + "runner.exe</Command></Exec></Executies></Task>";
    await fs.writeFile(path.join(tasksRoot, "DemoShellTask"), utf16leWithBom(xml));

    const probe = {
      exists: async (p: string) => {
        try { await fs.stat(p); return true; } catch { return false; }
      },
      readDir: async (p: string) => {
        try { const e = await fs.readdir(p, { withFileTypes: true }); return e.map((d) => path.join(p, d.name)); } catch { return []; }
      },
      // 与生产 nodeProbe 一致：按 BOM 解码
      readText: async (p: string) => {
        try { return decodeTextWithBom(await fs.readFile(p)); } catch { return null; }
      },
    };

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

    const report = await scanResidue(app, {
      reg: { queryTree: async () => [], queryChildren: async () => [], readKey: async () => null },
      fs: probe,
      env: { programData: dir, appData: dir, commonStartMenu: dir, userStartMenu: dir, temp: dir, systemRoot: dir },
    });

    assert.ok(report.counts.task >= 1, "UTF-16LE 计划任务残留应被发现（旧 utf8 读法此处为 0）");
    const task = report.items.find((i) => i.kind === "task");
    assert.ok(task, "应产出一条 task 残留");
    assert.equal(task?.risk, "high");
    assert.ok(task?.detail.includes("runner.exe"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
