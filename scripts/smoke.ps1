# 本地冒烟测试：备份用户配置 -> 用 mock 服务跑一次 Electron --smoke -> 恢复配置
# 用法: powershell -File scripts/smoke.ps1 [-Balance 5.00] [-Collapsed] [-Real] [-Port 8899]
param(
  [string]$Balance = '88.50',
  [switch]$Collapsed,
  [switch]$Real,
  [int]$Port = 8899
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$cfgDir = Join-Path $env:APPDATA 'deepseek-balance-card'
$cfg = Join-Path $cfgDir 'config.json'
$backup = Join-Path $cfgDir 'config.backup.json'

if (Test-Path -LiteralPath $cfg) {
  Copy-Item -LiteralPath $cfg -Destination $backup -Force
}

# 结束旧的 mock 监听
$old = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty OwningProcess
if ($old) { Stop-Process -Id $old -Force; Start-Sleep -Milliseconds 500 }

if (-not $Real) {
  Start-Process -FilePath 'F:\nodejs\node.exe' -ArgumentList @(
    (Join-Path $root 'scripts\mock-server.js'), "$Port", $Balance
  ) -WorkingDirectory $root -WindowStyle Hidden
  Start-Sleep -Seconds 2
  $env:DS_BALANCE_API = "http://127.0.0.1:$Port/user/balance"
} else {
  Remove-Item Env:\DS_BALANCE_API -ErrorAction SilentlyContinue
}

# 写入测试配置
$cfgDir = Join-Path $env:APPDATA 'deepseek-balance-card'
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$testCfg = @{
  apiKey = if ($Real) { 'sk-invalid-test-key' } else { 'sk-test' }
  refreshInterval = 300000
  lowBalanceThreshold = 10
  theme = 'dark'
  alwaysOnTop = $true
  autoLaunch = $false
  collapsed = [bool]$Collapsed
  pos = $null
} | ConvertTo-Json -Compress
Set-Content -LiteralPath $cfg -Value $testCfg -Encoding ascii -NoNewline

try {
  & $electron $root --smoke 2>&1 | Out-String
} finally {
  # 恢复用户真实配置（electron 可能仍在收尾，稍等后校验）
  Start-Sleep -Milliseconds 800
  if (Test-Path -LiteralPath $backup) {
    Copy-Item -LiteralPath $backup -Destination $cfg -Force
    $restored = Get-Content -LiteralPath $cfg -Raw
    $backed = Get-Content -LiteralPath $backup -Raw
    if ($restored -ne $backed) {
      Start-Sleep -Milliseconds 800
      Copy-Item -LiteralPath $backup -Destination $cfg -Force
      $restored = Get-Content -LiteralPath $cfg -Raw
    }
    if ($restored -ne $backed) {
      Write-Output '[smoke] ERROR: config restore mismatch!'
    } else {
      Write-Output '[smoke] user config restored and verified'
    }
  }
}
