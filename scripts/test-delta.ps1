# 动效测试：备份用户配置 -> 用测试配置 + mock 跑 smoke -> 恢复配置
param(
  [string]$Balances = '5.00,4.00',
  [int]$Port = 8899
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$cfg = Join-Path $env:APPDATA 'deepseek-balance-card\config.json'
$backup = Join-Path $env:APPDATA 'deepseek-balance-card\config.backup.json'

$old = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty OwningProcess
if ($old) { Stop-Process -Id $old -Force; Start-Sleep -Milliseconds 500 }

Copy-Item -LiteralPath $cfg -Destination $backup -Force
$test = '{"apiKey":"sk-test","refreshInterval":30000,"lowBalanceThreshold":1,"theme":"dark","alwaysOnTop":true,"autoLaunch":false,"mode":"card","pos":null}'
Set-Content -LiteralPath $cfg -Value $test -Encoding ascii -NoNewline

Start-Process -FilePath 'F:\nodejs\node.exe' -ArgumentList @(
  (Join-Path $root 'scripts\mock-server.js'), "$Port", $Balances
) -WorkingDirectory $root -WindowStyle Hidden
Start-Sleep -Seconds 2

$env:DS_BALANCE_API = "http://127.0.0.1:$Port/user/balance"
try {
  & $electron $root --smoke 2>&1 | Out-String
} finally {
  # 确保恢复用户配置（electron 可能仍在收尾，稍等后校验）
  Start-Sleep -Milliseconds 800
  Copy-Item -LiteralPath $backup -Destination $cfg -Force
  $restored = Get-Content -LiteralPath $cfg -Raw
  $backed = Get-Content -LiteralPath $backup -Raw
  if ($restored -ne $backed) {
    Start-Sleep -Milliseconds 800
    Copy-Item -LiteralPath $backup -Destination $cfg -Force
    $restored = Get-Content -LiteralPath $cfg -Raw
  }
  if ($restored -ne $backed) {
    Write-Output '[test-delta] ERROR: config restore mismatch!'
  } else {
    Write-Output '[test-delta] user config restored and verified'
  }
  $mock = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty OwningProcess
  if ($mock) { Stop-Process -Id $mock -Force }
}
