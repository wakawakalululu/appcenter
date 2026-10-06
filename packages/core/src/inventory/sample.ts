import { UNINSTALL_ROOTS } from "./registry.ts";

const BS = String.fromCharCode(92);

/** reg.exe query /s 的真实输出形状，供测试与离线演示使用。 */
export const REG_KEY_SAMPLE: string = [
  UNINSTALL_ROOTS[0]?.path + BS + "SogouExplorer",
  "    DisplayIcon" + BS + "    REG_SZ    C:" + BS + "Program Files" + BS + "Sogou" + BS + "SogouExplorer" + BS + "app_sogou.ico",
  "    DisplayName    REG_SZ    搜狗高速浏览器",
  "    DisplayVersion    REG_SZ    13.9.6121.400",
  "    EstimatedSize    REG_DWORD    0x64000",
  "    InstallLocation    REG_SZ    C:" + BS + "Program Files" + BS + "Sogou" + BS + "SogouExplorer",
  "    Publisher    REG_SZ    北京搜狗科技发展有限公司",
  "    UninstallString    REG_SZ    C:" + BS + "Program Files" + BS + "Sogou" + BS + "SogouExplorer" + BS + "uninst.exe",
  "",
  UNINSTALL_ROOTS[0]?.path + BS + "WpsOffice",
  "    DisplayName    REG_SZ    WPS Office",
  "    DisplayVersion    REG_SZ    12.1.0",
  "    WindowsInstaller    REG_SZ    1",
  "    UninstallString    REG_SZ    MsiExec.exe /X" + "{1A2B3C4D-0000-0000-0000-000000000001}",
  "",
].join("\r\n");

export const UNINSTALL_ROOT_PATH = UNINSTALL_ROOTS[0]?.path ?? "";
