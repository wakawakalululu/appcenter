import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppCenterFacade, UNINSTALL_ROOTS, regKey } from "@appcenter/core";

const NAME = "Universal CRT Redistributable";
const A = "{0460C87B-7F4C-3170-FAC9-B7A6AE5CE4E9}";
const B = "{368E4D03-5983-1C2C-B42E-1C0C51A935A5}";
const UNIQUE = "只有一个实例的应用";

const root64 = UNINSTALL_ROOTS[0]!.path;

/**
 * 真机实测的同名不同实例形态（本机 141 项里就有这一组）：两条不同的 GUID 卸载项、
 * 两个不同版本，在清单里是两行。残留报告必须按行取，因为它直接喂破坏性清理。
 */
const keys = () => [
  regKey(root64 + "\\" + A, { DisplayName: NAME, DisplayVersion: "10.0.26624", Publisher: "Microsoft" }),
  regKey(root64 + "\\" + B, { DisplayName: NAME, DisplayVersion: "10.1.26100.7705", Publisher: "Microsoft" }),
  regKey(root64 + "\\SoloApp", { DisplayName: UNIQUE, DisplayVersion: "1.0.0", Publisher: "本机" }),
];

async function facade(): Promise<{ facade: AppCenterFacade; dataDir: string }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "residue-sel-"));
  const instance = new AppCenterFacade(
    { serverUrl: "http://127.0.0.1:1", userId: "me", dataDir, appVersion: "1.0.0", registryKeys: keys() },
    // facade 的第二个参数是宿主接口；这里只需要窗口/托盘之外的只读扫描路径。
    { } as never,
  );
  return { facade: instance, dataDir };
}

test("对照：残留扫描这条路径本身跑得通（别让基础设施错冒充结论）", async () => {
  const { facade: app, dataDir } = await facade();
  try {
    const installed = await app.installed();
    assert.equal(installed.length, 3, "桩清单应是 3 行，实际 " + String(installed.length));
    const report = await app.residueReport(UNIQUE);
    assert.equal(report.regDir, "SoloApp", "唯一名字的实例按名字就该拿到它自己的报告");
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("残留报告必须按行取：同名不同实例要点哪行扫哪行", async () => {
  const { facade: app, dataDir } = await facade();
  try {
    const report = await app.residueReport(NAME, B);
    assert.equal(
      report.regDir,
      B,
      "扫的是 " + report.regDir + " 那条实例，而用户点的是 " + B + "——报告里的每一项都归属错实例，清理就会去删另一个组件的键与目录",
    );
    assert.equal(report.app, NAME);
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("只给名字且有歧义时必须显式拒绝，而不是默默扫第一条", async () => {
  const { facade: app, dataDir } = await facade();
  try {
    await assert.rejects(
      () => app.residueReport(NAME),
      /ambiguous/i,
      "「扫到哪条」不能由清单排序决定",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("按 regDir 直接扫仍要成立（大小写不敏感，与卸载侧一致）", async () => {
  const { facade: app, dataDir } = await facade();
  try {
    const report = await app.residueReport(B.toLowerCase());
    assert.equal(
      report.regDir.toLowerCase(),
      B.toLowerCase(),
      "只给 regDir 也要精确命中那条（小写传入也要认，实际 " + report.regDir + "）",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
