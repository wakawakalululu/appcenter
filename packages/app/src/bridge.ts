import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppCenterFacade, type ExecutionRequest, type ExecutionResult, type InstallJob, type ProcessRunner, type WindowHost } from "@appcenter/core";
import { contentType, dispatch, readStatic } from "./dispatch.ts";

/** 桌面宿主未接入时，窗口由这里记录状态，UI 上的窗口面板与托盘面板据此渲染。 */
class RecordingWindowHost implements WindowHost {
  private seq = 0;

  async create(): Promise<string> {
    this.seq += 1;
    return "win-" + String(this.seq);
  }

  async show(): Promise<void> {}

  async hide(): Promise<void> {}

  async close(): Promise<void> {}

  async focus(): Promise<void> {}
}

export interface BridgeOptions {
  facade: AppCenterFacade;
  webRoot: string;
  /** 本地只监听回环，UI 不做远程暴露。 */
  host?: string;
}

interface RpcCall {
  method: string;
  params?: Record<string, unknown>;
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8"): void {
  const payload = Buffer.isBuffer(body) ? body : typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "content-length": String(Buffer.byteLength(payload)) });
  res.end(payload);
}

/** 由 seed 稳定生成一块 64×64 圆角渐变 SVG：色相取自哈希，中间是首字母。 */
function generatedIcon(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.codePointAt(0)!) % 360;
  const from = hash;
  const to = (hash + 48) % 360;
  const letter = (seed.replace(/[^\p{L}\p{N}]/gu, "")[0] ?? seed[0] ?? "?").toUpperCase();
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    "<defs><linearGradient id=\"g\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\">" +
    '<stop offset="0" stop-color="hsl(' + String(from) + ' 72% 58%)"/>' +
    '<stop offset="1" stop-color="hsl(' + String(to) + ' 68% 46%)"/>' +
    "</linearGradient></defs>" +
    '<rect width="64" height="64" rx="14" fill="url(#g)"/>' +
    '<circle cx="48" cy="16" r="10" fill="hsl(' + String((to + 180) % 360) + ' 80% 72%)" opacity="0.55"/>' +
    '<text x="32" y="43" text-anchor="middle" font-family="\'Segoe UI\',\'Microsoft YaHei\',sans-serif" font-size="28" font-weight="700" fill="#ffffff">' +
    escapeXml(letter) +
    "</text></svg>";
  return svg;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

/** 应用中心的品牌图标：云 + 购物袋，自绘原创，跟随皮肤主色交给 CSS 不适合 SVG，这里用品牌绿。 */
function faviconSvg(): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<rect width="64" height="64" rx="14" fill="#27A46A"/>' +
    '<path d="M17 30a9 9 0 0 1 1.6-5.1A11.5 11.5 0 0 1 40.5 22 8.3 8.3 0 0 1 44.5 30H17Z" fill="#ffffff" opacity="0.92"/>' +
    '<path d="M19 34h26l-2.1 10.6a3.2 3.2 0 0 1-3.2 2.6H24.3a3.2 3.2 0 0 1-3.2-2.6L19 34Z" fill="#ffffff"/>' +
    '<path d="M25.6 34v-2.3a4.4 4.4 0 0 1 8.8 0V34" stroke="#27A46A" stroke-width="2.4" stroke-linecap="round" fill="none"/>' +
    "</svg>"
  );
}

/**
 * 浏览器来源闸门。桥只绑回环，但「只绑回环」挡不住 CSRF：网页发 `POST` + `text/plain`
 * 属于 CORS 简单请求，不触发预检就能直达 dispatch（实测可跨源把皮肤切掉）。
 * 规则：带 Origin / Sec-Fetch-Site 的按浏览器请求处理，必须同源；两者都不带的视为本机原生
 * 客户端（CLI 与托盘宿主用 application/json 且不发 Origin），保持放行。
 */
export function browserRequestBlocked(req: IncomingMessage): string | null {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return "sec-fetch-site=" + site;
  const origin = req.headers.origin;
  if (origin === undefined || origin === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return "origin-unparseable";
  }
  if (parsed.host !== (req.headers.host ?? "")) return "cross-origin:" + origin;
  return null;
}

/** 只接受 JSON 请求体：把「简单请求」这条路单独堵死，与来源检查互为冗余。 */
function isJsonRequest(req: IncomingMessage): boolean {
  const type = String(req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || type.endsWith("+json");
}

export function createBridge(options: BridgeOptions): Server {
  const { facade, webRoot } = options;
  const clients = new Set<ServerResponse>();

  const broadcast = (event: string, data: unknown): void => {
    const payload = "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
    for (const client of clients) client.write(payload);
  };

  facade.onJob((job: InstallJob) => {
    broadcast("job", { id: job.id, appId: job.appId, name: job.appName, state: job.state, error: job.error ?? null, progress: job.progress ?? null });
    broadcast("tray", facade.trayView());
  });

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // /rpc 改状态、/events 泄本地状态，两者都要过来源闸门；静态资源不设闸。
      if (url.pathname === "/rpc" || url.pathname === "/events") {
        const blocked = browserRequestBlocked(req);
        if (blocked) return send(res, 403, { ok: false, error: "blocked-by-origin-policy: " + blocked });
      }
      if (url.pathname === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write("event: hello\ndata: " + JSON.stringify({ tray: facade.trayView(), skins: facade.skins.list(), windows: facade.windowList() }) + "\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (url.pathname === "/rpc") {
        // 不回任何 CORS 头，预检在浏览器侧必然失败；这里显式拒绝，避免落到静态资源分支变成 404。
        if (req.method === "OPTIONS") return send(res, 405, { ok: false, error: "preflight-unsupported" });
        if (req.method !== "POST") return send(res, 405, { ok: false, error: "method-not-allowed" });
        if (!isJsonRequest(req)) return send(res, 415, { ok: false, error: "content-type-must-be-application-json" });
        const call = await readJson<RpcCall>(req);
        const result = await dispatch(facade, call.method, call.params ?? {});
        return send(res, result.ok ? 200 : 400, result);
      }
      if (url.pathname === "/favicon.svg") {
        // 独立应用窗口（--app 模式）拿站点图标当窗口/任务栏图标。
        return send(res, 200, faviconSvg(), "image/svg+xml; charset=utf-8");
      }
      if (url.pathname.startsWith("/icons/gen/")) {
        // 生成式演示图标：真机装上之前，用 seed 决定的色相画一块首字母圆角渐变。
        const seed = decodeURIComponent(url.pathname.slice("/icons/gen/".length)).replace(/\.svg$/, "");
        if (!seed || /[^\w.-]/.test(seed)) return send(res, 404, "not found", "text/plain; charset=utf-8");
        return send(res, 200, generatedIcon(seed), "image/svg+xml; charset=utf-8");
      }
      if (url.pathname.startsWith("/icons/")) {
        const name = path.basename(decodeURIComponent(url.pathname.slice("/icons/".length)));
        if (!name.endsWith(".png")) return send(res, 404, "not found", "text/plain; charset=utf-8");
        const servedIcon = await readStatic(facade.iconsDir(), "/" + name);
        if (!servedIcon) return send(res, 404, "not found", "text/plain; charset=utf-8");
        return send(res, 200, servedIcon.body, "image/png");
      }
      const served = await readStatic(webRoot, url.pathname);
      if (served) return send(res, 200, served.body, contentType(served.file));
      return send(res, 404, "not found", "text/plain; charset=utf-8");
    })().catch((err: unknown) => send(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) }));
  });
  return server;
}

export interface StartOptions {
  serverUrl: string;
  dataDir: string;
  userId: string;
  appVersion?: string;
  port?: number;
  token?: string;
  /**
   * 演示目录里的安装包是占位文件，宿主只记录调用而不真的执行；
   * 真实部署不要开这个开关。
   */
  simulateInstalls?: boolean;
}

/** 只记录、不执行的进程端口，给演示宿主用。 */
class SimulatedRunner implements ProcessRunner {
  readonly calls: ExecutionRequest[] = [];
  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    this.calls.push(request);
    console.log("[demo] 模拟安装 " + request.program + " " + request.args.join(" "));
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 5, requiresReboot: false };
  }
}

export async function startUi(options: StartOptions): Promise<{ server: Server; url: string; facade: AppCenterFacade }> {
  const runner = options.simulateInstalls ? new SimulatedRunner() : undefined;
  const facade = new AppCenterFacade(
    {
      serverUrl: options.serverUrl,
      userId: options.userId,
      dataDir: options.dataDir,
      appVersion: options.appVersion ?? "1.0.0",
      token: options.token ?? "",
      runner,
    },
    new RecordingWindowHost(),
  );
  const server = createBridge({ facade, webRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web") });
  // 端口被占时 listen 只发 'error' 事件；不挂监听就是未处理异常直接打死宿主进程。
  // 桌面壳与演示入口要的是「起不来就抛错」，由调用方决定怎么退。
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err) => reject(err));
    server.listen(options.port ?? 8080, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return { server, url: "http://127.0.0.1:" + String(port), facade };
}
export { dispatch, readStatic, resolveStatic, contentType } from "./dispatch.ts";
