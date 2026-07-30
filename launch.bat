@echo off
chcp 65001 >nul

where python >nul 2>&1
if errorlevel 1 (
    echo.
    echo  找不到 Python，請至 https://python.org 安裝後再試。
    echo.
    pause
    exit /b 1
)

python "%~dp0launch.py"
if errorlevel 1 (
    echo.
    echo  啟動時發生錯誤，請檢查上方訊息。
    echo.
    pause
)