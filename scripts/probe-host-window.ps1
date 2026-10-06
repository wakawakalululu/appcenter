Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win4 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetDpiForWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$lines = New-Object System.Collections.ArrayList
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
[void]$lines.Add("WORKAREA " + $wa.Width + "x" + $wa.Height)
# 直接按进程找主窗口，避开 EnumWindows 回调在原生线程里拿不到脚本作用域的问题。
$hosts = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like "*tray-host.ps1*" }
if (-not $hosts) { [void]$lines.Add("no tray-host process") }
foreach ($h in $hosts) {
  $proc = Get-Process -Id $h.ProcessId -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  $hwnd = $proc.MainWindowHandle
  if ($hwnd -eq [IntPtr]::Zero) {
    [void]$lines.Add("pid=" + $h.ProcessId + " MainWindowHandle=0 (窗口未创建)")
    continue
  }
  $r = New-Object Win4+RECT
  [void][Win4]::GetWindowRect($hwnd, [ref]$r)
  [void]$lines.Add("pid=" + $h.ProcessId + " title=" + $proc.MainWindowTitle + " size=" + ($r.Right-$r.Left) + "x" + ($r.Bottom-$r.Top) + " pos=" + $r.Left + "," + $r.Top + " visible=" + [Win4]::IsWindowVisible($hwnd) + " dpi=" + [Win4]::GetDpiForWindow($hwnd))
}
[System.IO.File]::WriteAllLines($args[0], $lines, (New-Object System.Text.UTF8Encoding($false)))
