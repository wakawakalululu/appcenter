import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DownloadError, Downloader } from "@appcenter/core";
import { makeTrackedTmp } from "./util/tmp-dirs.ts";

const body = (text: string) => new TextEncoder().encode(text);

function fakeResponse(chunk: Uint8Array, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers ?? {});
  if (!headers.has("content-length")) headers.set("content-length", String(chunk.length));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    body: {
      getReader() {
        let sent = false;
        return {
          read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: chunk })),
        };
      },
    },
  } as unknown as Response;
}

/** 记录每次请求的头与次序，便于断言「重试了几次」「有没有带 Range」。 */
function scriptedFetch(responses: Array<{ chunk?: Uint8Array; status?: number; headers?: Record<string, string> }>, spy: { urls: string[]; headers: Record<string, string>[] } = { urls: [], headers: [] }) {
  let i = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    spy.urls.push(String(url));
    spy.headers.push({ ...((init?.headers ?? {}) as Record<string, string>) });
    const spec = responses[Math.min(i, responses.length - 1)] ?? { chunk: new Uint8Array(0) };
    i += 1;
    if (spec.status && spec.status >= 400) return fakeResponse(new Uint8Array(0), { status: spec.status });
    return fakeResponse(spec.chunk ?? new Uint8Array(0), { status: spec.status, headers: spec.headers });
  }) as unknown as typeof fetch;
  return { impl, spy, calls: () => i };
}

async function tmpTarget(name: string): Promise<string> {
  const dir = await makeTrackedTmp("dl-" + name + "-");
  return path.join(dir, "pkg.bin");
}

test("瞬时 HTTP 故障（503/429/408）要重试，404/403 不重试", async () => {
  const target = await tmpTarget("retry");
  const payload = body("RETRY-PAYLOAD");
  const sha = createHash("sha256").update(payload).digest("hex");

  const failing = scriptedFetch([{ status: 503 }, { chunk: payload }]);
  const result = await new Downloader({ fetchImpl: failing.impl, attempts: 3, baseDelayMs: 1 }).download({ id: "a", url: "http://x/a.bin", target, expectedSha256: sha, expectedSize: payload.length });
  assert.equal(failing.calls(), 2, "503 之后应当重试一次并成功");
  assert.equal(result.sha256, sha);

  for (const status of [429, 408]) {
    const t = await tmpTarget("retry" + String(status));
    const s = scriptedFetch([{ status }, { chunk: payload }]);
    await new Downloader({ fetchImpl: s.impl, attempts: 3, baseDelayMs: 1 }).download({ id: "b", url: "http://x/b.bin", target: t, expectedSha256: sha, expectedSize: payload.length });
    assert.equal(s.calls(), 2, status + " 也该重试");
  }

  for (const status of [404, 403]) {
    const t = await tmpTarget("fatal" + String(status));
    const s = scriptedFetch([{ status }, { chunk: payload }]);
    await assert.rejects(
      () => new Downloader({ fetchImpl: s.impl, attempts: 3, baseDelayMs: 1 }).download({ id: "c", url: "http://x/c.bin", target: t }),
      (err: unknown) => err instanceof DownloadError && err.kind === "http-status",
      status + " 不该被重试",
    );
    assert.equal(s.calls(), 1, status + " 必须一次就放弃");
  }
});

test("同一 id 但目标/URL 不同，不得复用别人的下载", async () => {
  const dir = await makeTrackedTmp("dl-key-");
  const t1 = path.join(dir, "one.bin");
  const t2 = path.join(dir, "two.bin");
  const p1 = body("FIRST");
  const p2 = body("SECOND");
  let calls = 0;
  const impl = (async (url: string) => {
    calls += 1;
    return fakeResponse(url.endsWith("one.bin") ? p1 : p2);
  }) as unknown as typeof fetch;
  const dl = new Downloader({ fetchImpl: impl });
  const [r1, r2] = await Promise.all([
    dl.download({ id: "same", url: "http://x/one.bin", target: t1, expectedSize: p1.length }),
    dl.download({ id: "same", url: "http://x/two.bin", target: t2, expectedSize: p2.length }),
  ]);
  assert.equal(calls, 2, "两个不同目标必须各下一次，而不是第二个复用第一个");
  assert.equal(await readFile(t2, "utf8"), "SECOND");
  assert.equal(r1.target, t1);
  assert.equal(r2.target, t2);
});

test("排队途中被取消：请求要立刻以 cancelled 落败，不能永挂也不吃掉并发名额", async () => {
  const dir = await makeTrackedTmp("dl-abort-");
  const controller = new AbortController();
  let releaseFirst: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const impl = (async (url: string) => {
    if (url.endsWith("slow.bin")) {
      await gate;
      return fakeResponse(body("SLOW"));
    }
    return fakeResponse(body("QUICK"));
  }) as unknown as typeof fetch;
  const dl = new Downloader({ fetchImpl: impl, concurrency: 1, signal: controller.signal });
  const slow = dl.download({ id: "s", url: "http://x/slow.bin", target: path.join(dir, "slow.bin") });
  const queued = dl.download({ id: "q", url: "http://x/quick.bin", target: path.join(dir, "quick.bin") });

  // 让 queued 确实进入排队，然后取消。
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  controller.abort();
  const outcome = await Promise.race([
    queued.then(() => "resolved").catch((err: unknown) => (err instanceof DownloadError && err.kind === "cancelled" ? "cancelled" : "failed")),
    new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 500)),
  ]);
  assert.equal(outcome, "cancelled", "取消后排队中的请求必须落败（旧实现要等前一个下载结束才轮到它失败）");
  releaseFirst();
  // 第一个请求是在流中被取消的，它自己会以 cancelled 落败——这里只关心它别再把别人拖住。
  await slow.catch(() => undefined);
  // 说明：signal 是 Downloader 级共享的，abort 之后任何新请求都会立刻落败，
  // 所以「名额有没有被幽灵等待者吃掉」在这条用例里观察不到，不在这里假装已证。
});

test("续传要带 If-Range；远端换文件时不能拼出新旧混合体", async () => {
  const dir = await makeTrackedTmp("dl-ifrange-");
  const target = path.join(dir, "pkg.bin");
  const oldHead = body("AAAA");
  const newFull = body("XY-Z");
  // 造一个上次中断在 4 字节的现场（.part + sidecar，etag 是旧文件的 v1）。
  await writeFile(target + ".part", oldHead);
  await writeFile(target + ".part.json", JSON.stringify({ url: "http://x/pkg.bin", size: 8, etag: '"v1"', received: 4 }), "utf8");

  let first = true;
  const seen: Record<string, string>[] = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    seen.push(headers);
    if (first) {
      first = false;
      // 服务端换了文件（etag v2），但没理会 If-Range，仍按新内容回 206。
      return fakeResponse(body("ZZ"), { status: 206, headers: { etag: '"v2"', "content-range": "bytes 4-7/8" } });
    }
    return fakeResponse(newFull, { headers: { etag: '"v2"' } });
  }) as unknown as typeof fetch;

  // 不给 expectedSha256：这正是静默混合最危险的场景。
  const result = await new Downloader({ fetchImpl: impl, attempts: 3, baseDelayMs: 1 }).download({ id: "r", url: "http://x/pkg.bin", target, expectedSize: 4 });
  assert.equal(seen[0]?.["If-Range"], '"v1"', "续传必须带 If-Range");
  assert.equal(await readFile(target, "utf8"), "XY-Z", "绝不能把旧 .part 与新内容拼在一起");
  assert.equal(result.bytes, 4);
});
