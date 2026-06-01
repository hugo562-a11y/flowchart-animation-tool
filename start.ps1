$ErrorActionPreference = "Stop"
$url = "http://127.0.0.1:8765/index.html"
$server = Join-Path $PSScriptRoot "resolve_export_server.py"
$fontScript = Join-Path $PSScriptRoot "installed-fonts.js"
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
$json = $fonts | ConvertTo-Json -Compress
Set-Content -LiteralPath $fontScript -Value "globalThis.INSTALLED_FONTS = $json;" -Encoding UTF8
$edgeCandidates = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$edge = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$health = $false
try {
    $health = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8765/api/health" -TimeoutSec 1).StatusCode -eq 200
} catch {}
if (-not $health) {
    $python = (Get-Command python -ErrorAction Stop).Source
    Start-Process -FilePath $python -ArgumentList "`"$server`"" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 150
        try {
            if ((Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8765/api/health" -TimeoutSec 1).StatusCode -eq 200) { break }
        } catch {}
    }
}
if ($edge) {
    Start-Process -FilePath $edge -ArgumentList "--app=$url"
} else {
    Start-Process $url
}
