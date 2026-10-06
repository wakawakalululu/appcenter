export type WindowRole = "main" | "detail" | "settings" | "bulk-install" | "approvals" | "update";

export interface WindowDescriptor {
  id: string;
  role: WindowRole;
  route: string;
  width: number;
  height: number;
  visible: boolean;
  focused: boolean;
  closeToTray: boolean;
}

export interface WindowHost {
  create(spec: Omit<WindowDescriptor, "id" | "visible" | "focused">): Promise<string>;
  show(id: string): Promise<void>;
  hide(id: string): Promise<void>;
  close(id: string): Promise<void>;
  focus(id: string): Promise<void>;
}

export interface OpenOptions {
  route?: string;
  width?: number;
  height?: number;
  /** detail 允许同时存在多个，其余角色单例复用。 */
  allowMultiple?: boolean;
  key?: string;
}

const DEFAULT_SIZE: Record<WindowRole, [number, number]> = {
  main: [1200, 800],
  detail: [880, 640],
  settings: [720, 560],
  "bulk-install": [640, 420],
  approvals: [760, 600],
  update: [520, 360],
};

export class WindowManager {
  private readonly windows = new Map<string, WindowDescriptor>();

  constructor(private readonly host: WindowHost) {}

  list(): WindowDescriptor[] {
    return [...this.windows.values()];
  }

  get(id: string): WindowDescriptor | undefined {
    return this.windows.get(id);
  }

  async open(role: WindowRole, options: OpenOptions = {}): Promise<WindowDescriptor> {
    const key = role + (options.key ? ":" + options.key : "");
    if (!options.allowMultiple) {
      const existing = [...this.windows.values()].find((w) => w.role === role);
      if (existing) {
        await this.host.show(existing.id);
        await this.host.focus(existing.id);
        existing.visible = true;
        existing.focused = true;
        if (options.route) existing.route = options.route;
        return existing;
      }
    } else {
      const existing = [...this.windows.values()].find((w) => w.route === (options.route ?? ""));
      if (existing) return existing;
    }
    const [width, height] = DEFAULT_SIZE[role];
    const created = await this.host.create({
      role,
      route: options.route ?? "/" + role,
      width: options.width ?? width,
      height: options.height ?? height,
      closeToTray: role === "main",
    });
    const descriptor: WindowDescriptor = {
      id: created,
      role,
      route: options.route ?? "/" + role,
      width: options.width ?? width,
      height: options.height ?? height,
      visible: true,
      focused: true,
      closeToTray: role === "main",
    };
    this.windows.set(descriptor.id, descriptor);
    void key;
    return descriptor;
  }

  async hide(id: string): Promise<void> {
    const win = this.windows.get(id);
    if (!win) return;
    await this.host.hide(id);
    win.visible = false;
  }

  /** 主窗口关闭动作转托盘，其余角色真正销毁。 */
  async requestClose(id: string): Promise<{ minimizedToTray: boolean }> {
    const win = this.windows.get(id);
    if (!win) return { minimizedToTray: false };
    if (win.closeToTray) {
      await this.host.hide(id);
      win.visible = false;
      return { minimizedToTray: true };
    }
    await this.host.close(id);
    this.windows.delete(id);
    return { minimizedToTray: false };
  }

  /** 收到唤起请求时优先聚焦已有主窗，而不是再开一个。 */
  async focusOrOpen(role: WindowRole = "main"): Promise<WindowDescriptor> {
    const existing = [...this.windows.values()].find((w) => w.role === role);
    if (existing) {
      await this.host.show(existing.id);
      await this.host.focus(existing.id);
      existing.visible = true;
      existing.focused = true;
      return existing;
    }
    return this.open(role);
  }
}

export interface LockResult {
  acquired: boolean;
  holderPid: number | null;
}

/** 单实例锁：以带 pid 的锁文件实现，锁主进程已退出时视为陈旧锁并回收。 */
export class SingleInstanceLock {
  constructor(
    private readonly file: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async acquire(): Promise<LockResult> {
    const { readFile, writeFile, rm } = await import("node:fs/promises");
    try {
      const raw = await readFile(this.file, "utf8");
      const holder = Number(JSON.parse(raw).pid);
      if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) {
        return { acquired: false, holderPid: holder };
      }
      await rm(this.file, { force: true });
    } catch {
      // 没有锁文件或内容不可解析，继续抢占
    }
    await writeFile(this.file, JSON.stringify({ pid: process.pid, at: this.now() }), "utf8");
    return { acquired: true, holderPid: process.pid };
  }

  async release(): Promise<void> {
    const { rm } = await import("node:fs/promises");
    await rm(this.file, { force: true }).catch(() => undefined);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
