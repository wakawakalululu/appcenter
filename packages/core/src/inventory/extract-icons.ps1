param(
  [Parameter(Mandatory = $true)][string]$ManifestFile,
  [Parameter(Mandatory = $true)][string]$ResultFile
)

# 从 exe/dll/ico 提取图标为 64x64 PNG。用清单文件传参，避免命令行超长（ENAMETOOLONG）。
Add-Type -AssemblyName System.Drawing

$jobs = Get-Content -LiteralPath $ManifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
$results = New-Object System.Collections.ArrayList

foreach ($job in $jobs) {
  $key = [string]$job.key
  $source = [string]$job.source
  $out = [string]$job.out
  try {
    if (-not (Test-Path -LiteralPath $source)) {
      [void]$results.Add(@{ key = $key; file = $null; ok = $false; message = "source missing" })
      continue
    }
    if ($source -match '\.ico$') {
      Copy-Item -LiteralPath $source -Destination $out -Force
      [void]$results.Add(@{ key = $key; file = $out; ok = $true; message = "copied" })
      continue
    }
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($source)
    if ($null -eq $icon) {
      [void]$results.Add(@{ key = $key; file = $null; ok = $false; message = "no associated icon" })
      continue
    }
    $bmp = New-Object System.Drawing.Bitmap 64, 64
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($icon.ToBitmap(), 0, 0, 64, 64)
    $g.Dispose()
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $icon.Dispose()
    [void]$results.Add(@{ key = $key; file = $out; ok = $true; message = "extracted" })
  } catch {
    [void]$results.Add(@{ key = $key; file = $null; ok = $false; message = $_.Exception.Message })
  }
}

ConvertTo-Json -InputObject $results -Depth 4 -Compress | Set-Content -LiteralPath $ResultFile -Encoding UTF8
