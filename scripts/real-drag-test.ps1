# 真实鼠标拖拽测试：用 OS 级鼠标事件拖动卡片，验证 movementX 路径
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseTest2 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

[MouseTest2]::SetProcessDPIAware() | Out-Null

$proc = Get-Process electron -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -like 'DeepSeek*' } |
  Select-Object -First 1
if (-not $proc) { Write-Error 'card window not found'; exit 1 }

$r = New-Object MouseTest2+RECT
[MouseTest2]::GetWindowRect($proc.MainWindowHandle, [ref]$r) | Out-Null
$cx = [int](($r.Left + $r.Right) / 2)
$cy = [int](($r.Top + $r.Bottom) / 2)
$start = "x=$($r.Left) y=$($r.Top) size=$($r.Right - $r.Left)x$($r.Bottom - $r.Top)"

# 按下
[MouseTest2]::SetCursorPos($cx, $cy)
Start-Sleep -Milliseconds 200
[MouseTest2]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 150
# 移动 5 步，每步 +12,+7
for ($i = 1; $i -le 5; $i++) {
  [MouseTest2]::SetCursorPos($cx + $i * 12, $cy + $i * 7)
  Start-Sleep -Milliseconds 80
}
Start-Sleep -Milliseconds 150
# 松开
[MouseTest2]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 600

$r2 = New-Object MouseTest2+RECT
[MouseTest2]::GetWindowRect($proc.MainWindowHandle, [ref]$r2) | Out-Null
$end = "x=$($r2.Left) y=$($r2.Top) size=$($r2.Right - $r2.Left)x$($r2.Bottom - $r2.Top)"
$moved = "delta x=$($r2.Left - $r.Left) y=$($r2.Top - $r.Top)"
Write-Output "[real-drag] start: $start"
Write-Output "[real-drag] end:   $end"
Write-Output "[real-drag] $moved"
