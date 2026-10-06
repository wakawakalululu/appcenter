import { spawn } from "node:child_process";

export const AUTO_START_ENTRY_NAME = "AppCenter";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/**
 * 开机自启后端：真实环境写 HKCU\...\Run；测试/离线注入内存实现。
 * 与 RegClient（只读）分开，因为自启需要写入。
 */
export interface AutoStartBackend {
  writeRunEntry(name: string, command: string): Promise<void>;
  deleteRunEntry(name: string): Promise<void>;
  readRunEntry(name: string): Promise<string | null>;
}

/**
 * 真实 Windows 后端：通过 reg.exe 写入/删除/读取 Run 项。
 * program 可注入（缺省 reg.exe），既便于测试 spawn 失败路径，也便于将来换成绝对路径。
 */
export class RegAutoStartBackend implements AutoStartBackend {
  constructor(private readonly program: string = "reg.exe") {}

  private regExit(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.program, args, { windowsHide: true });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += String(d)));
      child.stderr.on("data", (d) => (err += String(d)));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err || "reg exit " + String(code)))));
    });
  }

  async writeRunEntry(name: string, command: string): Promise<void> {
    await this.regExit(["add", RUN_KEY, "/v", name, "/t", "REG_SZ", "/d", command, "/f"]);
  }
  async deleteRunEntry(name: string): Promise<void> {
    await this.regExit(["delete", RUN_KEY, "/v", name, "/f"]).catch(() => undefined);
  }
  async readRunEntry(name: string): Promise<string | null> {
    try {
      const out = await this.regExit(["query", RUN_KEY, "/v", name]);
      const match = /REG_SZ\s+(.*)$/m.exec(out);
      return match ? (match[1] ?? "").trim().replace(/^"|"$/g, "") : null;
    } catch {
      return null;
    }
  }
}

/** 内存后端：测试与无注册表环境用，直接断言读写不触达系统。 */
export class MemoryAutoStartBackend implements AutoStartBackend {
  private readonly entries = new Map<string, string>();
  async writeRunEntry(name: string, command: string): Promise<void> {
    this.entries.set(name, command);
  }
  async deleteRunEntry(name: string): Promise<void> {
    this.entries.delete(name);
  }
  async readRunEntry(name: string): Promise<string | null> {
    return this.entries.get(name) ?? null;
  }
}

export class AutoStartController {
  constructor(
    private readonly backend: AutoStartBackend,
    private readonly entryName: string = AUTO_START_ENTRY_NAME,
  ) {}

  /** 开/关：开启则写入 Run 项，关闭则删除。命令是启动本客户端的命令行。 */
  async apply(enabled: boolean, command: string): Promise<void> {
    if (enabled) await this.backend.writeRunEntry(this.entryName, command);
    else await this.backend.deleteRunEntry(this.entryName);
  }

  async isEnabled(): Promise<boolean> {
    return (await this.backend.readRunEntry(this.entryName)) !== null;
  }
}
