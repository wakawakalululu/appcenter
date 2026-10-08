import { test } from "node:test";
import assert from "node:assert/strict";

import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryRegClient, UNINSTALL_ROOTS, regKey, scanInstalledApps, scanResidue, type FileSystemProbe } from "@appcenter/core";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { makeTrackedTmp } from "./util/tmp-dirs.ts";

const BS = String.fromCharCode(92);

function buildLink(options: { target: string; icon?: string }): Buffer {
  const header = Buffer.alloc(76);
  header.writeUInt32LE(76, 0);
  Buffer.from("0114020000000000c000000000000046", "hex").copy(header, 4);
  header.writeUInt32LE(0x00000002 | 0x00000040 | 0x00008000, 20);

  const localPath = Buffer.from(options.target, "latin1");
  const linkInfoSize = 0x14 + localPath.length + 1;
  const linkInfo = Buffer.alloc(0x14);
  linkInfo.writeUInt32LE(linkInfoSize, 0);
  linkInfo.writeUInt32LE(0x14, 4);
  linkInfo.writeUInt16LE(0x14, 0x10);

  const iconChars = options.icon ?? "";
  const iconBuf = Buffer.from(iconChars, "utf16le");
  const iconLen = Buffer.alloc(2);
  iconLen.writeUInt16LE(iconChars.length, 0);

  return Buffer.concat([header, linkInfo, localPath, Buffer.alloc(1), iconLen, iconBuf]);
}

/** 包一层计数，验证「每个开始菜单根只被遍历一次」。 */
class CountingProbe implements FileSystemProbe {
  readonly readDirCalls: string[] = [];
  readonly readTextCalls: string[] = [];
  constructor(private readonly inner: FileSystemProbe) {}
  async exists(p: string): Promise<boolean> {
    return this.inner.exists(p);
  }
  async readDir(p: string): Promise<string[]> {
    this.readDirCalls.push(p);
    return this.inner.readDir(p);
  }
  async readText(p: string): Promise<string | null> {
    this.readTextCalls.push(p);
    return this.inner.readText(p);
  }
}

test("menu and shortcut segments share one start-menu walk and keep the item order", async () => {
  const dir = await makeTrackedTmp("menu-walk-");
  const common = path.join(dir, "common");
  const sub = path.join(common, "Sub");
  const user = path.join(dir, "user");
  await mkdir(sub, { recursive: true });
  await mkdir(user, { recursive: true });

  const installDir = ["C:", "Program Files", "Demo App"].join(BS);
  const lnkCommon = path.join(common, "App.lnk");
  const lnkSub = path.join(sub, "App2.lnk");
  const lnkUser = path.join(user, "Other.lnk"); // 不命中，验证过滤仍在生效
  await writeFile(lnkCommon, buildLink({ target: installDir + BS + "app.exe" }));
  await writeFile(lnkSub, buildLink({ target: installDir + BS + "app2.exe" }));
  await writeFile(lnkUser, buildLink({ target: ["C:", "elsewhere", "x.exe"].join(BS) }));
  // 占位：确保真实文件可读（readShellLink 走 node fs 而非 probe）
  await readFile(lnkCommon);

  const tree = new Map<string, string[]>([
    [common, [lnkCommon, sub]],
    [sub, [lnkSub]],
    [user, [lnkUser]],
  ]);
  const counting = new CountingProbe({
    exists: async () => false,
    readDir: async (p) => tree.get(p) ?? [],
    readText: async () => null,
  });

  const reg = new InMemoryRegClient([
    regKey((UNINSTALL_ROOTS[0]?.path ?? "") + BS + "DemoApp", {
      DisplayName: "Demo App",
      DisplayVersion: "1.0.0",
      InstallLocation: installDir,
      UninstallString: installDir + BS + "unins000.exe",
    }),
  ]);
  const app = (await scanInstalledApps(reg))[0];
  assert.ok(app, "fixture app");
  if (!app) return;

  const report = await scanResidue(app, {
    reg,
    fs: counting,
    env: { programData: path.join(dir, "pd"), appData: path.join(dir, "ad"), commonStartMenu: common, userStartMenu: user, temp: dir, systemRoot: dir },
  });

  // 收益：每个开始菜单根只被 walk 一次（改前 menu 与 shortcut 各走一遍 = 每根 2 次）。
  assert.equal(counting.readDirCalls.filter((p) => p === common).length, 1, "commonStartMenu 只应遍历一次");
  assert.equal(counting.readDirCalls.filter((p) => p === user).length, 1, "userStartMenu 只应遍历一次");

  // 结果集不变：命中的 .lnk 各产出一条 menu 与一条 shortcut（两段 kind 不同，不去重）。
  assert.equal(report.counts.menu, 2);
  assert.equal(report.counts.shortcut, 2);
  assert.deepEqual(report.items.filter((i) => i.kind === "menu").map((i) => i.path), [lnkCommon, lnkSub]);
  assert.deepEqual(report.items.filter((i) => i.kind === "shortcut").map((i) => i.path), [lnkCommon, lnkSub]);
  // 顺序：全部 menu 先于全部 shortcut，段内保持 common→user、父目录→子目录的遍历序。
  assert.deepEqual(
    report.items.filter((i) => i.kind === "menu" || i.kind === "shortcut").map((i) => i.kind),
    ["menu", "menu", "shortcut", "shortcut"],
  );
});
