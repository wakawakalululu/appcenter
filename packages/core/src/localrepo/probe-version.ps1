param(
  [string]$ManifestFile = "",
  [string]$ResultFile = ""
)

# 批量读取 PE 的版本资源（ProductName/CompanyName/ProductVersion...）。
# 用清单文件传参，避免命令行超长；输出 UTF-8 JSON，调用方要容错 BOM。
Add-Type -AssemblyName System.Windows.Forms

$rows = Get-Content -LiteralPath $ManifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
$results = New-Object System.Collections.ArrayList

foreach ($row in $rows) {
  $key = [string]$row.key
  $file = [string]$row.file
  try {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
      [void]$results.Add(@{ key = $key; ok = $false; message = "file missing" })
      continue
    }
    $item = Get-Item -LiteralPath $file
    $info = $item.VersionInfo
    [void]$results.Add(@{
        key = $key
        ok = $true
        sizeBytes = $item.Length
        modifiedAt = $item.LastWriteTime.ToString("yyyy-MM-ddTHH:mm:ss")
        productName = [string]$info.ProductName
        productVersion = [string]$info.ProductVersion
        fileVersion = [string]$info.FileVersion
        companyName = [string]$info.CompanyName
        fileDescription = [string]$info.FileDescription
        originalFilename = [string]$info.OriginalFilename
        language = [string]$info.Language
    })
  } catch {
    [void]$results.Add(@{ key = $key; ok = $false; message = $_.Exception.Message })
  }
}

$json = $results | ConvertTo-Json -Depth 4 -Compress
if ($null -eq $json) { $json = "[]" }
[System.IO.File]::WriteAllText($ResultFile, $json, (New-Object System.Text.UTF8Encoding($false)))
