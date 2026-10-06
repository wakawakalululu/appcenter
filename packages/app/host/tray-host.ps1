param(
  [string]$RpcUrl = "http://127.0.0.1:8090/rpc",
  [string]$UiUrl = "http://127.0.0.1:8090/",
  [string]$LogFile = "tray-host.log",
  [int]$Seconds = 6,
  [string]$StatusColor = "#2F6BFF"
)

# 真实 Windows 托盘与窗口宿主：只用系统自带的 WinForms / GDI+，不引入 Electron 或 Tauri。
# 菜单与状态来自引擎的 ui.tray，菜单动作通过 ui.trayAction 回传，宿主本身不含业务判断。

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$lines = New-Object System.Collections.ArrayList

function Invoke-Rpc([string]$method, [hashtable]$params) {
  $body = @{ method = $method; params = $params } | ConvertTo-Json -Depth 6 -Compress
  try {
    return Invoke-RestMethod -Method Post -Uri $RpcUrl -ContentType "application/json; charset=utf-8" -Body $body
  } catch {
    [void]$lines.Add("rpc-error " + $method + " " + $_.Exception.Message)
    return $null
  }
}

function New-TrayIcon([string]$hex) {
  $clean = $hex.TrimStart("#")
  $r = [Convert]::ToInt32($clean.Substring(0, 2), 16)
  $g = [Convert]::ToInt32($clean.Substring(2, 2), 16)
  $b = [Convert]::ToInt32($clean.Substring(4, 2), 16)
  $bmp = New-Object System.Drawing.Bitmap(16, 16)
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $gfx.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, $r, $g, $b))
  $gfx.FillEllipse($brush, 1, 1, 13, 13)
  $gfx.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$tray = Invoke-Rpc "ui.tray" @{}
if (-not $tray -or -not $tray.ok) {
  [void]$lines.Add("abort tray view unavailable")
  $lines | Out-File -FilePath $LogFile -Encoding UTF8
  exit 1
}

$status = $tray.result.status
$tooltip = $tray.result.icon.tooltip
$icon = New-TrayIcon $StatusColor
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $icon
$notify.Visible = $true
$notify.Text = $tooltip

$form = New-Object System.Windows.Forms.Form
$form.Text = "应用中心 - " + $tooltip
# 窗口取屏幕的一部分（如 2048x1152 屏上约 1237x762，约 60% x 66%），而不是最大化窗口。
# 未声明 DPI 感知的进程拿到的是虚拟化后的工作区，所以下限也要按工作区缩放，否则永远命中下限。
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$floorW = [Math]::Min(960, [int]($wa.Width * 0.5))
$floorH = [Math]::Min(640, [int]($wa.Height * 0.5))
$winW = [int][Math]::Max($floorW, [Math]::Min([int]($wa.Width * 0.604), [int]($wa.Width * 0.86)))
$winH = [int][Math]::Max($floorH, [Math]::Min([int]($wa.Height * 0.661), [int]($wa.Height * 0.9)))
$minW = [int][Math]::Min(900, [int]($wa.Width * 0.45))
$minH = [int][Math]::Min(600, [int]($wa.Height * 0.45))
$form.Size = New-Object System.Drawing.Size($winW, $winH)
$form.MinimumSize = New-Object System.Drawing.Size($minW, $minH)
$form.StartPosition = "Manual"
# 先停在屏幕外，等宿主调用 show 时再挪回居中位置。
$form.Location = New-Object System.Drawing.Point(-16000, -16000)
$form.Add_Shown({
  # 先算好整数坐标再构造 Point：把表达式内联进 New-Object 参数会被 PowerShell 解析成多余实参。
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $x = [int]($area.Left + ($area.Width - $this.Width) / 2)
  $y = [int]($area.Top + ($area.Height - $this.Height) / 2)
  $this.Location = New-Object System.Drawing.Point($x, $y)
})
$form.ShowInTaskbar = $false
$browser = New-Object System.Windows.Forms.WebBrowser
$browser.Dock = "Fill"
$browser.ScriptErrorsSuppressed = $true
$form.Controls.Add($browser)

$menu = New-Object System.Windows.Forms.ContextMenu
foreach ($item in $tray.result.menu) {
  if ($item.kind -eq "separator") {
    [void]$menu.MenuItems.Add((New-Object System.Windows.Forms.MenuItem("-")))
    continue
  }
  $caption = $item.label
  if ($item.badge) { $caption = $caption + " (" + $item.badge + ")" }
  $action = $item.action
  $handler = {
    param($sender, $eventArgs)
    $target = $action
    if ($target -like "app.quit*") {
      [void]$lines.Add("menu app.quit")
      $form.Close()
      return
    }
    $reply = Invoke-Rpc "ui.trayAction" @{ action = $target }
    [void]$lines.Add("menu " + $target + " handled=" + $reply.result.handled)
    if ($target -like "window.open*" -and $form.Visible -eq $false) {
      $browser.Navigate($UiUrl)
      $form.Location = New-Object System.Drawing.Point(80, 60)
      $form.ShowInTaskbar = $true
      $form.Show() | Out-Null
      [void]$lines.Add("window-hwnd " + $form.Handle.ToInt64())
[void]$lines.Add("window-size " + $form.Size.Width + "x" + $form.Size.Height)
$_wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
[void]$lines.Add("workarea " + $_wa.Width + "x" + $_wa.Height + " ratio " + [Math]::Round(100 * $form.Size.Width / $_wa.Width, 1) + "%x" + [Math]::Round(100 * $form.Size.Height / $_wa.Height, 1) + "%")
    }
  }
  [void]$menu.MenuItems.Add((New-Object System.Windows.Forms.MenuItem($caption, $handler)))
}
$notify.ContextMenu = $menu

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({
  $refresh = Invoke-Rpc "ui.tray" @{}
  if ($refresh -and $refresh.ok) {
    $script:status = $refresh.result.status
    $notify.Text = $refresh.result.icon.tooltip
    [void]$lines.Add("poll " + $refresh.result.status)
  }
})
$timer.Start()

# 无交互自检：走引擎的 trayAction 打开主窗口（这样窗口状态由 WindowManager 统一记录），
# 记录真实 HWND 与托盘图标句柄，然后按 Seconds 退出。
$opened = Invoke-Rpc "ui.trayAction" @{ action = "window.open:main" }
[void]$lines.Add("tray-action ok=" + $opened.ok)
$browser.Navigate($UiUrl)
$form.Location = New-Object System.Drawing.Point(60, 60)
$form.ShowInTaskbar = $true
$form.Show() | Out-Null
[void]$lines.Add("tray-visible " + $notify.Visible)
[void]$lines.Add("tray-icon-handle " + $icon.Handle.ToInt64())
[void]$lines.Add("window-hwnd " + $form.Handle.ToInt64())
[void]$lines.Add("window-size " + $form.Size.Width + "x" + $form.Size.Height)
$_wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
[void]$lines.Add("workarea " + $_wa.Width + "x" + $_wa.Height + " ratio " + [Math]::Round(100 * $form.Size.Width / $_wa.Width, 1) + "%x" + [Math]::Round(100 * $form.Size.Height / $_wa.Height, 1) + "%")
[void]$lines.Add("windows-after " + ((Invoke-Rpc "ui.windows" @{}) | ConvertTo-Json -Compress -Depth 6))

$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 80
}

$timer.Stop()
$notify.Visible = $false
$notify.Dispose()
$form.Close()
$form.Dispose()
$icon.Dispose()
[void]$lines.Add("exited ok")
$lines | Out-File -FilePath $LogFile -Encoding UTF8
