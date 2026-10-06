param([string]$Path)
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile($Path)
Write-Output ("IMAGE " + $Path + " " + $bmp.Width + "x" + $bmp.Height)
$step = [Math]::Max(1, [int]($bmp.Width / 40))
function Hex($c) { return "#{0:X2}{1:X2}{2:X2}" -f $c.R, $c.G, $c.B }
# 沿水平中线与几条垂直线取样，找出侧栏右边界、内容区起点与主色
$yMid = [int]($bmp.Height * 0.45)
$prev = $null
for ($x = 0; $x -lt $bmp.Width; $x += $step) {
  $c = $bmp.GetPixel($x, $yMid)
  $h = Hex $c
  if ($h -ne $prev) { Write-Output ("y=" + $yMid + " x=" + $x + " " + $h); $prev = $h }
}
Write-Output "--- vertical scan at x=12% ---"
$xv = [int]($bmp.Width * 0.12)
$prev = $null
for ($y = 0; $y -lt $bmp.Height; $y += [Math]::Max(1, [int]($bmp.Height/40))) {
  $c = $bmp.GetPixel($xv, $y)
  $h = Hex $c
  if ($h -ne $prev) { Write-Output ("x=" + $xv + " y=" + $y + " " + $h); $prev = $h }
}
Write-Output "--- content column scan at x=45% ---"
$xv2 = [int]($bmp.Width * 0.45)
$prev = $null
for ($y = 0; $y -lt $bmp.Height; $y += [Math]::Max(1, [int]($bmp.Height/40))) {
  $c = $bmp.GetPixel($xv2, $y)
  $h = Hex $c
  if ($h -ne $prev) { Write-Output ("x=" + $xv2 + " y=" + $y + " " + $h); $prev = $h }
}
$bmp.Dispose()
