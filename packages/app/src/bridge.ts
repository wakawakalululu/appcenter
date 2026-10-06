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
      if (url.pathname === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write("event: hello\ndata: " + JSON.stringify({ tray: facade.trayView(), skins: facade.skins.list(), windows: facade.windowList() }) + "\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (url.pathname === "/rpc" && req.method === "POST") {
        const call = await readJson<RpcCall>(req);
        const result = await dispatch(facade, call.method, call.params ?? {});
        return send(res, result.ok ? 200 : 400, result);
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
  await new Promise<void>((resolve) => server.listen(options.port ?? 8080, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, url: "http://127.0.0.1:" + String(port), facade };
}
export { dispatch, readStatic, resolveStatic, contentType } from "./dispatch.ts";
