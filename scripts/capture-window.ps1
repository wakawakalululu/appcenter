param(
  [string]$TitleLike = "*appcenter*",
  [string]$OutFile = ".shots\desktop-window.png"
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Cap {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$targets = @()
$targets += Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like $TitleLike }
$targets += Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like $TitleLike }
$p = $targets | Select-Object -First 1
if (-not $p) { Write-Output "no window matching $TitleLike"; exit 2 }
$h = $p.MainWindowHandle
[Win32Cap]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 700
$r = New-Object Win32Cap+RECT
[Win32Cap]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[Win32Cap]::PrintWindow($h, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc)
$bmp.Save($OutFile)
$g.Dispose()
$bmp.Dispose()
Write-Output ("captured " + $w + "x" + $ht + " pid=" + $p.Id + " title=" + $p.MainWindowTitle + " -> " + $OutFile)
