# Start-ModelProxy.ps1
# ModelProxy 启动脚本

param(
    [switch]$InstallCert,
    [switch]$GenCert
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 检查 Node.js
$nodeVersion = node --version 2>$null
if (-not $nodeVersion) {
    Write-Host "[错误] 未找到 Node.js，请先安装 Node.js 18+" -ForegroundColor Red
    Write-Host "下载地址: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

Write-Host "Node.js 版本: $nodeVersion" -ForegroundColor Green

# 检查依赖
if (-not (Test-Path "$ScriptDir\node_modules")) {
    Write-Host "[信息] 正在安装依赖..." -ForegroundColor Yellow
    Push-Location $ScriptDir
    npm install
    Pop-Location
}

Push-Location $ScriptDir

if ($InstallCert) {
    node src/index.js --install-cert
} elseif ($GenCert) {
    node src/index.js --gen-cert
} else {
    node src/index.js
}

Pop-Location
