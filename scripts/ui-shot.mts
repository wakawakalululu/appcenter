/**
 * 真机 UI 取证：用无头 Chrome 的 CDP 接口打开界面、切到指定视图并截图。
 * 不引入依赖，Node 自带 WebSocket；浏览器不可用时直接以非零码退出。
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const chromeCandidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter((c): c is string => Boolean(c));

async function firstExisting(candidates: string[]): Promise<string> {
  const { access } = await import("node:fs/promises");
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // 继续找下一个
    }
  }
  throw new Error("no chrome/edge found");
}

const uiUrl = process.argv[2] ?? "http://127.0.0.1:8080/";
const outDir = process.argv[3] ?? ".shots";
const views = (process.argv[4] ?? "home,categories,installed,settings").split(",");
const port = 9337;

const exe = await firstExisting(chromeCandidates);
const profile = path.join(tmpdir(), "ac-cdp-profile-" + Date.now().toString(36));
const chrome = spawn(exe, [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--no-first-run",
  "--window-size=1440,1000",
  "--remote-debugging-port=" + String(port),
  "--user-data-dir=" + profile,
  "about:blank",
]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDebugger(): Promise<Response> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const list = await fetch("http://127.0.0.1:" + String(port) + "/json/list");
      if (list.ok) return list;
    } catch {
      // 还没起来
    }
    await sleep(250);
  }
  throw new Error("cdp endpoint never came up");
}

let nextId = 1;
const pending = new Map<number, (value: unknown) => void>();
let socket: WebSocket;

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await waitForDebugger();
await fetch("http://127.0.0.1:" + String(port) + "/json/new?url=about:blank", { method: "PUT" });
const targets = await (await fetch("http://127.0.0.1:" + String(port) + "/json/list")).json();
const page = (targets as { type: string; webSocketDebuggerUrl?: string }[]).find((t) => t.type === "page");
if (!page?.webSocketDebuggerUrl) throw new Error("no page target");

socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("cdp socket failed")), { once: true });
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
  if (message.id !== undefined) {
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message.result);
    }
  }
});

await send("Page.enable");
await send("Runtime.enable");
// 第 5 个参数给视口尺寸，方便按目标窗口大小截图对比。
const viewport = (process.argv[5] ?? "").match(/^(\d+)x(\d+)$/);
if (viewport) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: Number(viewport[1]),
    height: Number(viewport[2]),
    deviceScaleFactor: 1,
    mobile: false,
  });
}
await mkdir(path.resolve(outDir), { recursive: true });

await send("Page.navigate", { url: uiUrl });
await sleep(3500);

const errors: string[] = [];
socket.addEventListener("event", () => {});
const consoleHook = await send("Runtime.evaluate", {
  expression: "window.__acErrors = []; window.addEventListener('error', (e) => window.__acErrors.push(String(e.message))); 'ok'",
  returnByValue: true,
});
void consoleHook;

for (const view of views) {
  if (view.startsWith("shot:")) {
    const shot = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
    const file = path.join(path.resolve(outDir), view.slice(5) + ".png");
    await writeFile(file, Buffer.from(shot.data, "base64"));
    console.log("saved " + file);
    continue;
  }
  if (view.startsWith("wait:")) {
    // 视图参数是按逗号切的，所以表达式里带逗号的等待只能做成独立步骤。
    await sleep(Number(view.slice(5)) || 2000);
    continue;
  }
  if (view.startsWith("js:")) {
    // 直接在页面里跑一段表达式，用来取真实错误而不是靠猜。
    const evaluated = (await send("Runtime.evaluate", {
      expression: "(async () => { try { return 'OK ' + JSON.stringify(await (" + view.slice(3) + ")); } catch (err) { return 'ERR ' + (err && err.message ? err.message : String(err)); } })()",
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: string } };
    console.log("js -> " + String(evaluated.result?.value));
    continue;
  }
  if (view.startsWith("click:")) {
    // 点真实按钮，验证 UI 到引擎的整条链路，而不只是渲染。
    const selector = view.slice(6);
    const hit = await send("Runtime.evaluate", {
      expression: "(function(){const n=document.querySelector('" + selector + "');if(!n)return 'missing';if(n.disabled)return 'disabled';n.click();return 'clicked';})()",
      returnByValue: true,
    }) as { result?: { value?: string } };
    await sleep(2500);
    const shot = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
    const name = selector.replace(/[^a-z0-9]/gi, "-");
    const file = path.join(path.resolve(outDir), "click" + name + ".png");
    await writeFile(file, Buffer.from(shot.data, "base64"));
    const meta = await send("Runtime.evaluate", {
      expression:
        "(document.getElementById('selfupdate-meta')||{}).textContent + ' || toast: ' + (document.getElementById('toast')||{}).textContent +" +
        "' || bundle: ' + (document.getElementById('bundle-meta')||{}).textContent + ' | ' + (document.getElementById('bundle-list')||{}).innerText + ' || state: ' + (typeof state === 'undefined' ? 'n/a' : JSON.stringify({hasManifest: !!state.selfUpdate, hasStaged: !!state.staged, hasBundleRun: !!state.bundleRun})) + ' || errors: ' + JSON.stringify(window.__acErrors)",
      returnByValue: true,
    }) as { result?: { value?: string } };
    console.log("click " + selector + " -> " + String(hit.result?.value) + " | " + String(meta.result?.value) + " | " + file);
    continue;
  }
  if (view.startsWith("skin:")) {
    // 换肤要先让设置视图把皮肤下拉填上：走真实的 ≡ 菜单 → 设置，顺带验证菜单可用。
    await send("Runtime.evaluate", { expression: "document.getElementById('btn-menu').click(); 'ok'", returnByValue: true });
    await sleep(400);
    await send("Runtime.evaluate", {
      expression: "(function(){const b=document.querySelector('#main-menu [data-view=\"settings\"]'); if(b) b.click(); return b?'opened':'missing';})()",
      returnByValue: true,
    });
    await sleep(1800);
    await send("Runtime.evaluate", {
      expression:
        "(function(){const id='" + view.slice(5) + "';const select=document.getElementById('skin');if(!select)return 'no-select';" +
        "select.value=id;select.dispatchEvent(new Event('change'));return select.value;})()",
      returnByValue: true,
    });
    await sleep(1200);
    const shot = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
    const file = path.join(path.resolve(outDir), view.replace(":", "-") + ".png");
    await writeFile(file, Buffer.from(shot.data, "base64"));
    console.log("saved " + file);
    continue;
  }
  const clicked = await send("Runtime.evaluate", {
    expression:
      "(function(){const nav=document.querySelector('[data-view=\"" + view + "\"]'); if(nav){nav.click(); return 'nav';}" +
      "location.hash='#/" + view + "'; return 'hash';})()",
    returnByValue: true,
  });
  // 卸载页/升级页要扫真机注册表（140 个应用约 2-3 秒），等待时间给足。
  await sleep(view === "settings" || view === "installed" || view === "upgrade" ? 3800 : 1400);
  const shot = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
  const file = path.join(path.resolve(outDir), view + ".png");
  await writeFile(file, Buffer.from(shot.data, "base64"));
  const dim = await send("Runtime.evaluate", {
    expression: "JSON.stringify({view: document.querySelector('.view.active') ? document.querySelector('.view.active').id : null, banners: document.querySelectorAll('.banner').length, cards: document.querySelectorAll('.app-card').length, height: document.body.scrollHeight, errors: window.__acErrors})",
    returnByValue: true,
  }) as { result?: { value?: string } };
  errors.push(view + " [" + String((clicked as { result?: { value?: string } })?.result?.value) + "] " + (dim.result?.value ?? "{}"));
  console.log("saved " + file);
}

console.log("\n" + errors.join("\n"));
socket.close();
chrome.kill();
await rm(profile, { recursive: true, force: true }).catch(() => undefined);
