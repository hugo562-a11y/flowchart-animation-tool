$ErrorActionPreference = "Stop"
$url        = "http://127.0.0.1:8765/index.html"
$server     = Join-Path $PSScriptRoot "resolve_export_server.py"
$fontScript = Join-Path $PSScriptRoot "installed-fonts.js"
$reqFile    = Join-Path $PSScriptRoot "requirements.txt"

# ── 字型掃描 ──────────────────────────────────────────────────────
$fontKeys = @(
    "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
    "HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"
)
$fonts = foreach ($key in $fontKeys) {
    if (Test-Path -LiteralPath $key) {
        (Get-ItemProperty -LiteralPath $key).PSObject.Properties |
            Where-Object { $_.Name -notlike "PS*" } |
            ForEach-Object { ($_.Name -replace "\s+\((TrueType|OpenType|All res)\)$", "").Trim() }
    }
}
$fonts = $fonts | Where-Object { $_ } | Sort-Object -Unique
$json  = $fonts | ConvertTo-Json -Compress
Set-Content -LiteralPath $fontScript -Value "globalThis.INSTALLED_FONTS = $json;" -Encoding UTF8

# ── Python 版本確認 ───────────────────────────────────────────────
try {
    $python = (Get-Command python -ErrorAction Stop).Source
} catch {
    Write-Host ""
    Write-Host "  找不到 Python，請至 https://python.org 安裝後再試。" -ForegroundColor Red
    Write-Host ""
    Read-Host "按 Enter 關閉"
    exit 1
}

# ── Python 套件自動安裝 ───────────────────────────────────────────
if (Test-Path $reqFile) {
    try {
        # --dry-run 只模擬，不真正安裝；若有輸出「Would install」表示缺套件
        $dryOut = & python -m pip install -r $reqFile --dry-run -q 2>&1
        $needInstall = ($dryOut | Where-Object { $_ -match "Would install" }).Count -gt 0
    } catch {
        $needInstall = $false
    }

    if ($needInstall) {
        Write-Host ""
        Write-Host "  首次安裝 Python 套件（語音辨識），約需 1-3 分鐘..." -ForegroundColor Cyan
        & python -m pip install -r $reqFile
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  套件安裝完成。" -ForegroundColor Green
        } else {
            Write-Host "  部分套件安裝失敗，語音辨識功能將無法使用。" -ForegroundColor Yellow
        }
        Write-Host ""
    }
}

# ── FFmpeg 檢查 ───────────────────────────────────────────────────
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
    Write-Host ""
    Write-Host "  注意：找不到 FFmpeg。" -ForegroundColor Yellow
    Write-Host "        影片輸出（MOV/MP4）和 MP3 下載功能將無法使用。" -ForegroundColor Yellow
    Write-Host "        下載：https://ffmpeg.org/download.html" -ForegroundColor Yellow
    Write-Host "        安裝後請將 bin 目錄加入系統 PATH。" -ForegroundColor Yellow
    Write-Host ""
}

# ── 啟動 Python 伺服器 ────────────────────────────────────────────
$health = $false
try {
    $health = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8765/api/health" -TimeoutSec 1).StatusCode -eq 200
} catch {}

if (-not $health) {
    Start-Process -FilePath $python -ArgumentList "`"$server`"" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 150
        try {
            if ((Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8765/api/health" -TimeoutSec 1).StatusCode -eq 200) { break }
        } catch {}
    }
}

# ── 開啟瀏覽器 ───────────────────────────────────────────────────
$browserCandidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$browser = $browserCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if ($browser) {
    Start-Process -FilePath $browser -ArgumentList "--app=$url"
} else {
    Start-Process $url
}
