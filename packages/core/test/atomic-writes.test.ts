import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RuntimeConfigStore, trayStatusFor, type InstallJob, type JobState } from "@appcenter/core";
import { makeTrackedTmp } from "./util/tmp-dirs.ts";

function job(state: JobState, at: string, tail: JobState[] = []): InstallJob {
  const states = [state, ...tail];
  return {
    id: "job-" + at,
    appId: "demo",
    appName: "演示应用",
    version: "2.0.0",
    state,
    phase: "install",
    history: states.map((s, i) => ({ state: s, at: new Date(Date.parse(at) + i * 1000).toISOString() })),
  };
}

test("并发保存运行配置不会互相踩临时文件，也不留脏 .tmp", async () => {
  const dir = await makeTrackedTmp("atomic-");
  const file = path.join(dir, "runtime.json");
  const store = new RuntimeConfigStore(file);
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => store.save({ downloadDir: path.join(dir, "dl" + String(i)) }).then(() => "ok", (err: unknown) => String(err))),
  );
  const failures = results.filter((r) => r !== "ok");
  assert.deepEqual(failures, [], "固定 `<file>.tmp` 时并发 rename 会互相把临时文件抢走：" + JSON.stringify(failures.slice(0, 2)));

  const persisted = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  assert.equal(typeof persisted.downloadDir, "string", "正式文件必须是完整可解析的 JSON");
  const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "不得留下 .tmp 残file");
});

test("保存失败时不留 .tmp 残渣", async () => {
  const dir = await makeTrackedTmp("atomic-fail-");
  const store = new RuntimeConfigStore(path.join(dir, "nested", "deep", "runtime.json"));
  // 把目标目录做成一个文件，mkdir 会失败：写临时文件那一步之前就应当抛出。
  const { writeFile: wf } = await import("node:fs/promises");
  await wf(path.join(dir, "nested"), "not a directory", "utf8");
  await assert.rejects(() => store.save({ concurrency: 2 }));
  const leftovers = (await readdir(dir)).filter((name) => name.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("托盘状态：历史失败不得永久钉住 error，也不得盖住可用更新", () => {
  const stale = job("failed", "2026-01-01T00:00:00.000Z", ["queued", "downloading", "failed"]);
  const fresh = job("succeeded", "2026-02-01T00:00:00.000Z", ["queued", "succeeded"]);
  assert.equal(trayStatusFor({ jobs: [stale, fresh], upgradeCount: 3, pendingApprovals: 0 }), "update-available", "最近一次迁移是成功，就不该继续显示 error");

  const onlyFailure = job("failed", "2026-03-01T00:00:00.000Z", ["queued", "failed"]);
  assert.equal(trayStatusFor({ jobs: [onlyFailure], upgradeCount: 2, pendingApprovals: 0 }), "error", "最近一次确实是失败时仍要报 error");

  assert.equal(trayStatusFor({ jobs: [], upgradeCount: 2, pendingApprovals: 0 }), "update-available");
  assert.equal(trayStatusFor({ jobs: [job("installing", "2026-04-01T00:00:00.000Z")], upgradeCount: 0, pendingApprovals: 0 }), "downloading");
  assert.equal(trayStatusFor({ jobs: [], upgradeCount: 0, pendingApprovals: 0 }), "idle");
});
