import { test } from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { CatalogDb, createApi, seedDemo } from "@appcenter/server";
import { makeTrackedTmp } from "./util/tmp-dirs.ts";
import {
  AppCenterFacade,
  CONFIRM_TOKEN,
  UNINSTALL_ROOTS,
  regKey,
  type CleanupPolicy,
  type ResidueItem,
  type ResidueReport,
  type WindowHost,
} from "@appcenter/core";

class NullHost implements WindowHost {
  async create(): Promise<string> { return "win-1"; }
  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async close(): Promise<void> {}
  async focus(): Promise<void> {}
}

async function wiredFacade(): Promise<{ facade: AppCenterFacade; dataDir: string; api: ReturnType<typeof createApi> }> {
  const db = CatalogDb.memory("host-secret");
  seedDemo(db);
  const api = createApi({ db, packageRoot: await makeTrackedTmp("host-pkgs-"), adminToken: "admin" });
  const port = await new Promise<number>((resolve) => api.listen(0, "127.0.0.1", () => resolve((api.address() as AddressInfo).port)));
  const dataDir = await makeTrackedTmp("host-data-");
  const facade = new AppCenterFacade(
    {
      serverUrl: "http://127.0.0.1:" + String(port),
      userId: "me",
      dataDir,
      appVersion: "1.0.0",
      registryKeys: [
        regKey((UNINSTALL_ROOTS[0]?.path ?? "") + "\\Wps", {
          DisplayName: "WPS Office",
          DisplayVersion: "12.0.0",
          Publisher: "金山办公",
          // 指向一个必定不存在的 exe：注册表里的 DisplayIcon 陈旧是常态。
          DisplayIcon: path.join(dataDir, "definitely-missing-app.exe"),
        }),
      ],
    },
    new NullHost(),
  );
  await facade.refreshCatalog();
  return { facade, dataDir, api };
}

test("打开失效路径的应用：返回失败而不是打死宿主进程", async () => {
  const { facade, api } = await wiredFacade();
  try {
    const result = await facade.openInstalled("wps-office");
    assert.equal(result.launched, false, "路径不存在时不得谎报已启动");
    // 未修时这里根本跑不到：spawn 的 ENOENT 是异步 'error' 事件，无监听即 Unhandled 'error' → 进程 exit 1。
    assert.doesNotMatch(result.message, /已启动/);
  } finally {
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});

function reportOf(items: ResidueItem[]): ResidueReport {
  return {
    app: "WPS Office",
    regDir: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Wps",
    scannedAt: new Date().toISOString(),
    durationMs: {} as ResidueReport["durationMs"],
    items,
    counts: {} as ResidueReport["counts"],
  };
}

test("文件类残留默认走「移动到回收目录」，不再不可逆删除", async () => {
  const { facade, dataDir, api } = await wiredFacade();
  try {
    const sandbox = await makeTrackedTmp("host-recycle-");
    const residueDir = path.join(sandbox, " leftovers ");
    await mkdir(residueDir, { recursive: true });
    await writeFile(path.join(residueDir, "note.txt"), "还要得回来", "utf8");

    const policy: CleanupPolicy = {
      includeRisks: ["low"],
      allowWriteRoots: [sandbox],
      confirmToken: CONFIRM_TOKEN,
      backupDir: path.join(sandbox, "backups"),
    };
    const outcome = await facade.applyCleanup(reportOf([{ kind: "directory", risk: "low", path: residueDir, detail: "安装目录残留", reason: "leftover-directory" }]), policy, false);

    assert.equal(outcome.failed.length, 0, "不该有失败项：" + JSON.stringify(outcome.failed));
    const gone = await access(residueDir).then(() => false).catch(() => true);
    assert.ok(gone, "原位置应已移走");

    const recycleRoot = path.join(dataDir, "cleanup-recycle");
    const days = await readdir(recycleRoot).catch(() => [] as string[]);
    assert.ok(days.length > 0, "facade 必须把 recycleDir 接到执行器上（缺 movePath 接线时这里就是空的）");
    const moved = await readdir(path.join(recycleRoot, days[0] ?? ""), { recursive: true }).catch(() => [] as unknown[]);
    assert.ok(moved.length > 0, "回收目录里要能看到被移走的残留：" + JSON.stringify(moved));
  } finally {
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});

test("显式传 recycleDir:\"\" 时退回不可逆删除（保留显式opt-out）", async () => {
  const { facade, api } = await wiredFacade();
  try {
    const sandbox = await makeTrackedTmp("host-delete-");
    const residueDir = path.join(sandbox, "gone");
    await mkdir(residueDir, { recursive: true });
    await writeFile(path.join(residueDir, "x.txt"), "bye", "utf8");
    const outcome = await facade.applyCleanup(
      reportOf([{ kind: "directory", risk: "low", path: residueDir, detail: "安装目录残留", reason: "leftover-directory" }]),
      { includeRisks: ["low"], allowWriteRoots: [sandbox], confirmToken: CONFIRM_TOKEN, backupDir: path.join(sandbox, "backups"), recycleDir: "" },
      false,
    );
    assert.equal(outcome.failed.length, 0);
    assert.ok(await access(residueDir).then(() => false).catch(() => true), "opt-out 之后应真的删掉");
  } finally {
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});
