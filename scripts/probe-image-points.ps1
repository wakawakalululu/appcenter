param([string]$Path)
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile($Path)
function Hex($c) { return "#{0:X2}{1:X2}{2:X2}" -f $c.R, $c.G, $c.B }
$points = @(
  @{ n = "nav-top"; x = 100; y = 200 },
  @{ n = "nav-mid"; x = 100; y = 450 },
  @{ n = "nav-bottom"; x = 100; y = 660 },
  @{ n = "nav-right-edge"; x = 210; y = 450 },
  @{ n = "page-bg"; x = 700; y = 470 },
  @{ n = "card-bg"; x = 600; y = 400 },
  @{ n = "active-pill"; x = 130; y = 180 },
  @{ n = "nav-label"; x = 108; y = 181 },
  @{ n = "nav-label-inactive"; x = 130; y = 248 },
  @{ n = "banner-a-bg"; x = 320; y = 200 },
  @{ n = "banner-a-title"; x = 300; y = 178 },
  @{ n = "essential-title"; x = 300; y = 373 },
  @{ n = "btn-green-solid"; x = 1143; y = 517 },
  @{ n = "btn-green-outline"; x = 638; y = 517 },
  @{ n = "btn-one-click-install"; x = 1117; y = 390 },
  @{ n = "section-aside"; x = 310; y = 570 },
  @{ n = "app-name"; x = 480; y = 503 },
  @{ n = "app-desc"; x = 480; y = 533 },
  @{ n = "search-box"; x = 400; y = 40 },
  @{ n = "topbar-bg"; x = 700; y = 20 }
)
foreach ($p in $points) {
  if ($p.x -lt $bmp.Width -and $p.y -lt $bmp.Height) {
    $c = $bmp.GetPixel($p.x, $p.y)
    Write-Output ($p.n + " (" + $p.x + "," + $p.y + ") = " + (Hex $c))
  }
}
# 找导航栏右边界：在 y=450 上从左往右扫描到颜色突变
$row = 450
$left = $bmp.GetPixel(0, $row)
for ($x = 1; $x -lt [Math]::Min($bmp.Width, 400); $x++) {
  $c = $bmp.GetPixel($x, $row)
  $d = [Math]::Abs($c.R - $left.R) + [Math]::Abs($c.G - $left.G) + [Math]::Abs($c.B - $left.B)
  if ($d -gt 120) { Write-Output ("nav content starts at x=" + $x + " color=" + (Hex $c)); break }
}
for ($x = 150; $x -lt [Math]::Min($bmp.Width, 500); $x++) {
  $c = $bmp.GetPixel($x, $row)
  if ($c.R -gt 245 -and $c.G -gt 245 -and $c.B -gt 245) { Write-Output ("page bg begins at x=" + $x); break }
}
$bmp.Dispose()
