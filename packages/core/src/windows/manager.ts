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
  /** `role[:key]` → 窗口 id。过去 key 只算出来就被 `void key` 丢掉，同 role 多实例根本分不开。 */
  private readonly byKey = new Map<string, string>();

  constructor(private readonly host: WindowHost) {}

  list(): WindowDescriptor[] {
    return [...this.windows.values()];
  }

  get(id: string): WindowDescriptor | undefined {
    return this.windows.get(id);
  }

  /**
   * 宿主（OS）侧真正关闭窗口时调用，抹掉管理器里的描述符。
   * 不抹掉的话，下一次 open()/focusOrOpen() 会复用一个已经不存在的窗口 id：
   * `host.show(死 id)` 既不报错也不开窗，界面上看就是「点任务栏没反应」。
   */
  remove(id: string): void {
    const win = this.windows.get(id);
    if (!win) return;
    this.windows.delete(id);
    for (const [key, mapped] of this.byKey) if (mapped === id) this.byKey.delete(key);
  }

  async open(role: WindowRole, options: OpenOptions = {}): Promise<WindowDescriptor> {
    const key = role + (options.key ? ":" + options.key : "");
    if (!options.allowMultiple) {
      // 带 key 的角色按 key 复用（同 role 可以有多个实例）；不带 key 的保持原「每角色单例」行为。
      const keyed = this.windows.get(this.byKey.get(key) ?? "");
      const existing = keyed ?? (options.key ? undefined : [...this.windows.values()].find((w) => w.role === role));
      if (existing) {
        await this.host.show(existing.id);
        await this.host.focus(existing.id);
        existing.visible = true;
        existing.focused = true;
        if (options.route) existing.route = options.route;
        return existing;
      }
    } else {
      // 只在同 role 内按 route 复用：跨 role 命中会返回另一个角色的窗口，而且既不 show 也不 focus。
      const existing = [...this.windows.values()].find((w) => w.role === role && w.route === (options.route ?? ""));
      if (existing) {
        await this.host.show(existing.id);
        await this.host.focus(existing.id);
        existing.visible = true;
        existing.focused = true;
        return existing;
      }
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
    this.byKey.set(key, descriptor.id);
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
    this.remove(id);
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
