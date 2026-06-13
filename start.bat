@echo off
chcp 65001 >nul
echo ============================================
echo   ModelProxy - AI 模型 API 代理
echo ============================================
echo.

:: 检查 Node.js
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 未找到 Node.js，请先安装 Node.js 18+
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

:: 检查 node_modules
if not exist "%~dp0node_modules" (
    echo [信息] 正在安装依赖...
    cd /d "%~dp0"
    call npm install
)

:: 启动代理
echo [信息] 正在启动 ModelProxy...
cd /d "%~dp0"
node src/index.js
pause
