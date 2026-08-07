# 截取屏幕并采样卡片窗口区域，验证渲染是否正常
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Rect {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

# 若卡片窗口未运行，则先启动（需 mock 服务监听 8899）
$proc = Get-Process electron -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -like 'DeepSeek*' } |
  Select-Object -First 1
if (-not $proc) {
  $root = Split-Path -Parent $PSScriptRoot
  $env:DS_BALANCE_API = 'http://127.0.0.1:8899/user/balance'
  Start-Process -FilePath (Join-Path $root 'node_modules\electron\dist\electron.exe') `
    -ArgumentList '.' -WorkingDirectory $root -WindowStyle Hidden
  for ($i = 0; $i -lt 30 -and -not $proc; $i++) {
    Start-Sleep -Milliseconds 500
    $proc = Get-Process electron -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowTitle -like 'DeepSeek*' } |
      Select-Object -First 1
  }
}
if (-not $proc) { Write-Error 'card window not found'; exit 1 }

$rect = New-Object Win32Rect+RECT
[Win32Rect]::GetWindowRect($proc.MainWindowHandle, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
Write-Output "window rect: x=$($rect.Left) y=$($rect.Top) ${w}x${h}"

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)

$out = Join-Path (Split-Path -Parent $PSScriptRoot) 'screenshot-card.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "screenshot: $out"

$dark = 0; $light = 0; $total = 0
for ($y = $rect.Top + 8; $y -lt $rect.Bottom - 8; $y += 3) {
  for ($x = $rect.Left + 8; $x -lt $rect.Right - 8; $x += 3) {
    $p = $bmp.GetPixel($x, $y)
    $total++
    $lum = 0.30 * $p.R + 0.59 * $p.G + 0.11 * $p.B
    if ($lum -lt 60) { $dark++ }
    elseif ($lum -gt 170) { $light++ }
  }
}
Write-Output "card sample: total=$total dark_bg=$dark light_text=$light"

# 采样余额数字区域的颜色：绿=正常、琥珀=偏低、红=低余额/错误
$green = 0; $amber = 0; $red = 0
for ($y = $rect.Top + 40; $y -lt $rect.Bottom - 40; $y += 2) {
  for ($x = $rect.Left + 40; $x -lt $rect.Right - 40; $x += 2) {
    $p = $bmp.GetPixel($x, $y)
    $pr = [int]$p.R; $pg = [int]$p.G; $pb = [int]$p.B
    if ($pg -gt 120 -and $pg -gt $pr * 1.3 -and $pg -gt $pb * 1.3) { $green++ }
    elseif ($pr -gt 150 -and $pr -gt $pg * 1.3 -and $pr -gt $pb * 1.3) { $red++ }
    elseif ($pr -gt 150 -and $pg -gt 100 -and $pr -gt $pb * 1.5) { $amber++ }
  }
}
Write-Output "color sample: green=$green amber=$amber red=$red"

# 裁剪卡片区域为独立图片，便于预览/README 使用
$cropW = $rect.Right - $rect.Left
$cropH = $rect.Bottom - $rect.Top
$crop = New-Object System.Drawing.Bitmap($cropW, $cropH)
$cg = [System.Drawing.Graphics]::FromImage($crop)
$srcRect = New-Object System.Drawing.Rectangle($rect.Left, $rect.Top, $cropW, $cropH)
$dstRect = New-Object System.Drawing.Rectangle(0, 0, $cropW, $cropH)
$cg.DrawImage($bmp, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$cropOut = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\screenshot-card.png'
$crop.Save($cropOut, [System.Drawing.Imaging.ImageFormat]::Png)
$cg.Dispose()
$crop.Dispose()
Write-Output "card crop: $cropOut"

$g.Dispose()
$bmp.Dispose()
