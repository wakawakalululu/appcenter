/**
 * 真机 UI 取证：用无头 Chrome 的 CDP 接口打开界面、切到指定视图并截图。
 * 不引入依赖，Node 自带 WebSocket；浏览器不可用时直接以非零码退出。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// 浏览器位置从环境变量推（写死 C: 在换系统盘的机器上会「找不到浏览器」，与 desktop.ts 同一条理由）。
const chromeCandidates = [
  process.env.CHROME_PATH,
  (process.env.ProgramFiles ?? "C:\\Program Files") + "\\Google\\Chrome\\Application\\chrome.exe",
  (process.env.LOCALAPPDATA ?? "") ? (process.env.LOCALAPPDATA as string) + "\\Google\\Chrome\\Application\\chrome.exe" : undefined,
  (process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)") + "\\Microsoft\\Edge\\Application\\msedge.exe",
  (process.env.ProgramFiles ?? "C:\\Program Files") + "\\Microsoft\\Edge\\Application\\msedge.exe",
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

// URL 与输出目录都必须显式给。以前的缺省是 "http://127.0.0.1:8080/" + ".shots"，
// 而 8080 往往是别人常驻的、扫真机的那台实例——按构造就能把真机已装清单截进公开配图（#89 那次泄露就是这么来的）。
// 所以这里不留"帮你猜一个"的默认：参数不全就在起浏览器之前退出。
const uiUrl = process.argv[2];
const outDir = process.argv[3];
if (uiUrl === undefined || outDir === undefined) {
  console.error("用法：node scripts/ui-shot.mts <ui 地址（公开配图请带 ?mask=1）> <输出目录> [视图列表] [宽x高]");
  console.error("拒绝默认值：写死的 8080 很可能指向别人常驻的实例，截出来的图会把本机内容带进公开面。");
  process.exit(1);
}
const views = (process.argv[4] ?? "home,categories,installed,settings").split(",");
// 第二道护栏只针对"直接落进公开面"这一种用法：未脱敏的截图写进 docs/assets/screenshots 就是 #89 那次泄露的形状
// （状态栏与已装列表会把对照对象厂商名、本机用户名一起烤进图）。
// 本地目视仍然放行——那是拿它验收的唯一手段；只有"不脱敏 + 公开目录"这个组合被拒。
{
  const absOut = path.resolve(outDir);
  const publicDir = path.resolve(import.meta.dirname, "..", "docs", "assets", "screenshots");
  if (!/mask=1/.test(uiUrl) && (absOut === publicDir || absOut.startsWith(publicDir + path.sep))) {
    console.error("拒绝：输出目录是公开配图目录，但 URL 没有 ?mask=1。");
    console.error("公开面里的截图只能来自「虚构已装清单 + 路径脱敏显示」；要目视未脱敏视图请写到仓库外的临时目录。");
    process.exit(1);
  }
}
// CDP 端口交给我们自己起的 Chrome 挑（0 = 临时端口），再从它的 stderr 里读回实际端口。
// 旧写法写死 9337 并轮询「这个端口通不通」：两个 ui-shot 并行时，后起的那个连上的是**前一个的浏览器**，
// 于是 A 截图截到 B 正在看的视图（view-search / view-settings）却以 exit 0 收工，B 则挂在没了浏览器的
// 那条 CDP 调用上永不返回 —— 就绪判据不含身份信息，就会「绿得毫无意义」。
let port = 0;

const exe = await firstExisting(chromeCandidates);
// profile 也要每次唯一：同一秒内起两次会撞同一个 user-data-dir，Chrome 会把第二个实例并进第一个。
const profile = path.join(tmpdir(), "ac-cdp-profile-" + String(process.pid) + "-" + randomBytes(4).toString("hex"));
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
let chromeLog = "";
chrome.stderr.on("data", (chunk: Buffer) => {
  chromeLog += chunk.toString("utf8");
});
// 没有 'error' 监听时，spawn 失败（比如 CHROME_PATH 指向不存在的文件）会把这个进程直接带走，
// 现场只留一个裸退出码，看不出是谁起的浏览器没起来。
chrome.on("error", (err) => {
  console.error("chrome spawn failed: " + err.message);
  process.exit(1);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 只认自己那个 Chrome 打印的 DevTools 行；它没 announce 或者半路退出，就带着 stderr 立刻失败。 */
async function announcedCdpPort(timeoutMs = 20000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(chromeLog);
    if (hit) return Number(hit[1]);
    if (chrome.exitCode !== null) {
      throw new Error("chrome 提前退出（code " + String(chrome.exitCode) + "）；stderr 尾部：" + chromeLog.slice(-300));
    }
    await sleep(150);
  }
  throw new Error("chrome 没在 " + String(timeoutMs) + "ms 内 announce CDP 端口；stderr 尾部：" + chromeLog.slice(-300));
}

port = await announcedCdpPort();
console.log("own chrome announced CDP port " + String(port));

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
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
let socket: WebSocket;

/**
 * 每条 CDP 调用都必须有归宿：旧写法只在收到同 id 的回应时才 resolve，
 * 浏览器被别的进程关掉（并行跑时前一个 ui-shot 收尾会 kill 掉共用的 Chrome）就永远挂着，
 * 整个脚本不退出、也不报错。超时/断链一律当场失败。
 */
function send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("cdp 超时（" + String(timeoutMs) + "ms）未收到 " + method + " 的回应"));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

function abandonPending(reason: string): void {
  for (const [, waiter] of pending) waiter.reject(new Error(reason));
  pending.clear();
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
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter.resolve(message.result);
    }
  }
});
socket.addEventListener("close", () => abandonPending("cdp 连接已关闭"));
socket.addEventListener("error", () => abandonPending("cdp 连接出错"));

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
// 截图脚本自己也要有判据：页面根本没加载时（服务挂了、URL 写错）它照样能截出一张错误页并以 0 退出，
// 于是 CI 的「UI 截图产物」会是一批空白图 + 绿勾。这里把「视图真的渲染了吗」钉成硬失败。
const problems: string[] = [];
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
    // 「点到了」和「点了有反应」是两件事：旧版只把 missing/disabled 打印出来就继续落盘并 exit 0。
    const signature =
      "JSON.stringify({view:(document.querySelector('.view.active')||{id:null}).id,dom:document.getElementsByTagName('*').length,toast:(document.getElementById('toast')||{textContent:''}).textContent,detail:(document.getElementById('detail')||{classList:{contains:()=>false}}).classList.contains('open'),name:(document.getElementById('detail-name')||{textContent:''}).textContent})";
    const before = (await send("Runtime.evaluate", { expression: signature, returnByValue: true })) as { result?: { value?: string } };
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
    const after = (await send("Runtime.evaluate", { expression: signature, returnByValue: true })) as { result?: { value?: string } };
    const verdict = String(hit.result?.value);
    if (verdict !== "clicked") {
      problems.push("click " + selector + " 没点到可交互元素（返回 " + verdict + "）——图照样落盘、脚本照样 exit 0");
    } else if (String(before.result?.value) === String(after.result?.value)) {
      problems.push("click " + selector + " 点到了，但 DOM 前后签名完全一致（" + String(after.result?.value) + "）——这一步没有任何可见效果");
    }
    console.log("click " + selector + " -> " + verdict + " | sig " + String(before.result?.value) + " => " + String(after.result?.value) + " | " + String(meta.result?.value) + " | " + file);
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
  const dim = await send("Runtime.evaluate", {
    expression: "(function(){var v=document.querySelector('.view.active');var root=v||document;return JSON.stringify({view:v?v.id:null,banners:root.querySelectorAll('.banner').length,items:root.querySelectorAll('[data-card],.app-main,.cat-card,.row').length,height:document.body.scrollHeight,errors:window.__acErrors})})()",
    returnByValue: true,
  }) as { result?: { value?: string } };
  errors.push(view + " [" + String((clicked as { result?: { value?: string } })?.result?.value) + "] " + (dim.result?.value ?? "{}"));
  const problemsBefore = problems.length;
  let state: { view?: string | null; errors?: unknown } = {};
  try {
    state = JSON.parse(dim.result?.value ?? "{}") as typeof state;
  } catch {
    problems.push(view + " 的页面状态读不出来（JSON 解析失败）：" + String(dim.result?.value).slice(0, 120));
  }
  if (!state.view) problems.push(view + " 视图没渲染（.view.active 为空）——页面很可能压根没加载");
  if (Array.isArray(state.errors) && state.errors.length > 0) problems.push(view + " 页面报错：" + state.errors.map(String).join("; "));
  // 先跑判据，再决定这张图算什么。以前是"先落盘再判红"，失败时留下的错误页和成功截图长得一模一样，
  // 于是"文件存在"被当成"这次截成功过"——做阳性对照时它真把上一轮的有效图覆盖掉了。
  const failed = problems.length > problemsBefore;
  const shot = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
  const file = path.join(path.resolve(outDir), (failed ? ".FAILED-" : "") + view + ".png");
  await writeFile(file, Buffer.from(shot.data, "base64"));
  console.log((failed ? "判据未通过，图只作现场（前缀 .FAILED-）：" : "saved ") + file);
}

console.log("\n" + errors.join("\n"));
socket.close();
chrome.kill();
await rm(profile, { recursive: true, force: true }).catch(() => undefined);
if (problems.length > 0) {
  console.error("UI 取证失败（不是「截图成功」）：\n  - " + problems.join("\n  - "));
  process.exit(1);
}
