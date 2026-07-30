param(
  [Parameter(Position = 0)]
  [string]$InputFile,

  [ValidateRange(1, 60)]
  [int]$Fps = 30,

  [ValidateSet("ProRes", "H264")]
  [string]$Format = "ProRes"
)

$ErrorActionPreference = "Stop"
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
  throw "找不到 ffmpeg。請先安裝 FFmpeg，並確認 ffmpeg 已加入 PATH。"
}

if (-not $InputFile) {
  $folders = @((Join-Path $env:USERPROFILE "Downloads"), $PSScriptRoot)
  $latest = $folders |
    Where-Object { Test-Path -LiteralPath $_ } |
    ForEach-Object { Get-ChildItem -LiteralPath $_ -File } |
    Where-Object { $_.BaseName -like "流程圖動畫*" -and $_.BaseName -notlike "*Resolve相容*" -and $_.Extension -in ".mp4", ".webm", ".mov" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $latest) {
    throw "找不到流程圖動畫影片。請指定輸入影片路徑。"
  }
  $InputFile = $latest.FullName
}

$source = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InputFile)
if (-not (Test-Path -LiteralPath $source)) {
  throw "找不到輸入影片：$InputFile"
}
$directory = Split-Path -Parent $source
$name = [System.IO.Path]::GetFileNameWithoutExtension($source)
if ($Format -eq "ProRes") {
  $output = Join-Path $directory "$name-Resolve相容.mov"
  & $ffmpeg.Source `
    -y `
    -i $source `
    -an `
    -vf "fps=$Fps,format=yuv422p10le" `
    -c:v prores_ks `
    -profile:v 3 `
    -vendor apl0 `
    $output
}
else {
  $output = Join-Path $directory "$name-Resolve相容.mp4"
  & $ffmpeg.Source `
    -y `
    -i $source `
    -an `
    -vf "fps=$Fps,format=yuv420p" `
    -c:v libx264 `
    -preset medium `
    -crf 18 `
    -profile:v high `
    -level 4.1 `
    -movflags +faststart `
    $output
}

if ($LASTEXITCODE -ne 0) {
  throw "FFmpeg 轉換失敗，結束代碼：$LASTEXITCODE"
}

Write-Host ""
Write-Host "已建立 DaVinci Resolve 相容影片："
Write-Host $output
