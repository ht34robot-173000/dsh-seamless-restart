# ============================================================================
# dsh-seamless-restart :: stand-in window (frosted cover during a restart)
# ----------------------------------------------------------------------------
# During a FULL RESTART the Electron shell is killed, so its window goes away and the
# desktop is briefly empty. This script covers that gap: it draws a borderless window
# at the exact rectangle of the old one and fills it with a frosted copy of that
# window's screenshot plus a centred loading ring.
#
# ----------------------------------------------------------------------------
# HARD SAFETY RULES (a previous implementation broke the user's machine by ignoring
# every one of these; do not relax them for convenience):
#
#   1. NEVER topmost. No HWND_TOPMOST, no Form.TopMost. The cover must never sit above
#      other applications. It does not need to: the old window is destroyed just after
#      we are shown, so whatever was covering us disappears and we are revealed anyway.
#   2. ALWAYS closable. No FormClosing cancel, no WM_CLOSE swallowing. If the user
#      clicks the X, the process exits. A stuck cover is far worse than a visible gap.
#   3. HARD TIMEOUT. Twenty seconds, then exit no matter what.
#   4. NEVER blocks the restart. The caller waits for us for at most ~2s and then
#      proceeds regardless of whether we made it.
#   5. NOTHING is written outside the log. No flags to clean up, no other processes
#      to kill.
#
# It closes itself the moment it sees a *different* DSH process with a real window,
# i.e. the new instance has painted. Matching on "any DSH window" would match the old
# one that is still on screen, so the old pid is passed in and compared.
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.
# ============================================================================
param(
  [int]$RectX = -1,
  [int]$RectY = -1,
  [int]$RectW = 1280,
  [int]$RectH = 820,
  [int]$ShellPid = 0,
  [string]$ProcessName = 'DeepSeek Harness',
  [string]$Shot = '',
  [string]$LogPath = '',
  [int]$TimeoutSec = 20,
  # Preferred entry point: a JSON file with every option. The launcher uses this because
  # the command line has to survive explorer -> wscript -> powershell, and one missed
  # quote there makes wscript fail with 800A0409 and no window ever appears.
  [string]$Job = ''
)

$ErrorActionPreference = 'Continue'

if ($Job -ne '' -and (Test-Path -LiteralPath $Job)) {
  try {
    $cfg = Get-Content -LiteralPath $Job -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -ne $cfg) {
      if ($null -ne $cfg.x) { $RectX = [int]$cfg.x }
      if ($null -ne $cfg.y) { $RectY = [int]$cfg.y }
      if ($null -ne $cfg.width) { $RectW = [int]$cfg.width }
      if ($null -ne $cfg.height) { $RectH = [int]$cfg.height }
      if ($null -ne $cfg.shellPid) { $ShellPid = [int]$cfg.shellPid }
      if ($null -ne $cfg.shot) { $Shot = [string]$cfg.shot }
      if ($null -ne $cfg.logPath) { $LogPath = [string]$cfg.logPath }
      if ($null -ne $cfg.timeoutSec) { $TimeoutSec = [int]$cfg.timeoutSec }
    }
  } catch { }
}

function Write-Log([string]$Message) {
  if ($LogPath -eq '') { return }
  try {
    Add-Content -LiteralPath $LogPath -Value ("{0} [cover] {1}" -f (Get-Date).ToString("o"), $Message) -Encoding UTF8
  } catch { }
}

Write-Log ("start {0},{1} {2}x{3} oldPid={4} timeout={5}s" -f $RectX, $RectY, $RectW, $RectH, $ShellPid, $TimeoutSec)

# ---- DPI awareness BEFORE WinForms ------------------------------------------
# WinForms caches the process DPI context when its assembly loads, so awareness set
# afterwards is silently ignored and every coordinate gets virtualised by the display
# scale (measured: a 1619x1029 window came out 1295x823 at 125%, and earlier 823px of
# height rendered as ~1070px at 130%). This must be the first thing that happens.
try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class DshWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);

  private static int _oldPid;

  /// Collect pids of processes that show a real, titled Electron main window.
  ///
  /// The previous version accepted "any titled window not belonging to the old pid",
  /// which matched a leftover window the instant the old shell died - measured 72 ms
  /// after "old shell is gone" and, crucially, BEFORE the relaunch script had even
  /// started the new process. The cover then closed onto an empty desktop, which is
  /// exactly the "it closes too early" symptom.
  ///
  /// The caller additionally requires the pid to be fresh and to have started after
  /// the cover appeared, so nothing that predates the cover can trigger a hand-over.
  public static List<int> FreshWindowPids(int oldPid) {
    _oldPid = oldPid;
    List<int> pids = new List<int>();
    EnumWindows(new EnumProc(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if ((int)pid == _oldPid) return true;
      StringBuilder cls = new StringBuilder(256);
      GetClassNameW(h, cls, 256);
      if (!cls.ToString().StartsWith("Chrome_WidgetWin_1")) return true;
      StringBuilder title = new StringBuilder(256);
      GetWindowTextW(h, title, 256);
      string t = title.ToString();
      // The shell shows a placeholder until the page has painted; ignore it so the
      // cover is not removed onto a blank window.
      if (t.Length == 0) return true;
      if (t == "DeepSeek Harness") return true;
      if (t.Length < 3) return true;
      pids.Add((int)pid);
      return true;
    }), IntPtr.Zero);
    return pids;
  }

}
'@ -ErrorAction Stop
  # -4 = PER_MONITOR_AWARE_V2
  $ok = [DshWin]::SetProcessDpiAwarenessContext([IntPtr](-4))
  if (-not $ok) { [void][DshWin]::SetProcessDpiAwareness(2) }
  Write-Log ("dpi awareness: {0}" -f $ok)
} catch {
  Write-Log ("native helpers unavailable: {0}" -f $_.Exception.Message)
}

try { Add-Type -AssemblyName System.Windows.Forms } catch {
  Write-Log ("no WinForms: {0}" -f $_.Exception.Message)
  exit 2
}
try { Add-Type -AssemblyName System.Drawing } catch { }

# ---- frosted backdrop -------------------------------------------------------
# Downscale-then-upscale is a cheap, dependency-free blur: drawing into a 1/9 thumbnail
# and blowing it back up removes high-frequency detail, which is the ground-glass look.
# /9 keeps the conversation layout visible through it; /14 turned it into grey mush.
$script:blur = $null
if ($Shot -ne '' -and (Test-Path -LiteralPath $Shot)) {
  try {
    $bytes = [System.IO.File]::ReadAllBytes($Shot)
    $stream = New-Object System.IO.MemoryStream(,$bytes)
    $img = [System.Drawing.Image]::FromStream($stream)
    $bw = [Math]::Max(1, [int]($img.Width / 9))
    $bh = [Math]::Max(1, [int]($img.Height / 9))
    $small = New-Object System.Drawing.Bitmap($bw, $bh)
    $sg = [System.Drawing.Graphics]::FromImage($small)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
    $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $sg.DrawImage($img, 0, 0, $bw, $bh)
    $sg.Dispose()
    $img.Dispose()
    $script:blur = $small
    Write-Log ("backdrop ok, {0}x{1}" -f $bw, $bh)
  } catch {
    $script:blur = $null
    Write-Log ("backdrop failed: {0}" -f $_.Exception.Message)
  }
}

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.ShowInTaskbar = $false
# RULE 1: no topmost, ever.
$form.TopMost = $false
$form.Text = 'DSH'
$form.BackColor = [System.Drawing.Color]::FromArgb(20, 24, 31)
# WinForms scales .Bounds by the DPI factor; turning its own scaling off keeps the raw
# pixel numbers, and SetWindowPos below pins the final rectangle anyway.
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$form.AutoScaleDimensions = New-Object System.Drawing.SizeF(0, 0)
try {
  $flags = [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic
  $prop = [System.Windows.Forms.Form].GetProperty('DoubleBuffered', $flags)
  # Set through reflection: the plain assignment throws on Form and that exception used
  # to abort the whole script before the window even existed.
  if ($null -ne $prop) { $prop.SetValue($form, $true) }
} catch { }

# Clamp the rectangle to the virtual desktop.
#
# A maximised / full-screen window measures 8px OUTSIDE the screen on each side
# (measured: -9,-9 1938x1038 on a 1920x1080 display) because Windows hides the resize
# border past the screen edges. That is normal, and it must be REPRODUCED EXACTLY:
# clipping the cover to the screen would make it 18px narrower than the window it is
# standing in for, which is the sliver of desktop the user sees at the edges.
#
# The earlier version treated the negative origin as "rect off-screen" and centred the
# cover - that is why full-screen restarts showed a wrong-sized cover in the wrong
# place. Now the handed-over rect is used as-is, and only a genuinely unusable one
# (no overlap with any screen, or absurd size) falls back to centring.
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$overlapW = [Math]::Min($RectX + $RectW, $vs.Right) - [Math]::Max($RectX, $vs.X)
$overlapH = [Math]::Min($RectY + $RectH, $vs.Bottom) - [Math]::Max($RectY, $vs.Y)
$usable = ($overlapW -ge 200) -and ($overlapH -ge 150) -and
          ($RectW -le ($vs.Width + 40)) -and ($RectH -le ($vs.Height + 40))

if (-not $usable) {
  Write-Log ("rect unusable ({0},{1} {2}x{3}); centring" -f $RectX, $RectY, $RectW, $RectH)
  if ($RectW -lt 320 -or $RectW -gt ($vs.Width + 40)) { $RectW = [Math]::Min(1280, [int]($vs.Width * 0.7)) }
  if ($RectH -lt 240 -or $RectH -gt ($vs.Height + 40)) { $RectH = [Math]::Min(820, [int]($vs.Height * 0.7)) }
  $RectX = $vs.X + [int](($vs.Width - $RectW) / 2)
  $RectY = $vs.Y + [int](($vs.Height - $RectH) / 2)
} elseif ($RectX -lt $vs.X -or $RectY -lt $vs.Y -or
          ($RectX + $RectW) -gt $vs.Right -or ($RectY + $RectH) -gt $vs.Bottom) {
  # Expected for maximised/full-screen windows; keeping the exact numbers is the point.
  Write-Log ("rect extends past the screen edge ({0},{1} {2}x{3}); keeping it as-is" -f $RectX, $RectY, $RectW, $RectH)
}
$form.Bounds = New-Object System.Drawing.Rectangle($RectX, $RectY, $RectW, $RectH)

$script:startedAt = Get-Date
$script:phase = 0.0
$script:progress = 0.05
$script:closing = $false
# Hand-over is decided in two steps, because "is there a DSH window" alone is ambiguous:
# while the old shell still lives its window matches, and while none lives the answer is
# empty. So: wait until no window of the OLD pid is left (i.e. it really is gone), then
# wait for a window of some OTHER pid carrying a real title (the new instance painted).
$script:sawOldGone = $false

function Test-OldGone() {
  if ($ShellPid -le 0) { return $true }
  try {
    return $null -eq (Get-Process -Id $ShellPid -ErrorAction SilentlyContinue)
  } catch { return $true }
}

# A candidate pid is only accepted if it belongs to a DSH process that STARTED AFTER
# this cover appeared. That single condition is what the first version was missing:
# right after the old shell died, a leftover window (or a helper process that had been
# alive all along) satisfied "some other titled window exists", the cover closed 72 ms
# later, and the restart had not even launched the new executable yet. Requiring a
# fresh start time makes it impossible to hand over to anything that predates the cover.
function Test-FreshReady() {
  try {
    $pids = @([DshWin]::FreshWindowPids($ShellPid))
    if ($pids.Count -eq 0) { return $false }
    foreach ($candidate in $pids) {
      try {
        $proc = Get-Process -Id $candidate -ErrorAction Stop
        # Started after we appeared (1s slack for clock/rounding).
        if ($proc.StartTime -ge $script:startedAt.AddSeconds(-1)) {
          Write-Log ("new window from pid={0} started {1}" -f $candidate, $proc.StartTime.ToString('HH:mm:ss.fff'))
          return $true
        }
      } catch { /* process may be gone already */ }
    }
    return $false
  } catch {
    return $false
  }
}

function Finish([string]$why) {
  if ($script:closing) { return }
  $script:closing = $true
  Write-Log ("closing: {0}" -f $why)
  try { $script:timer.Stop() } catch { }
  try { $form.Close() } catch { }
}

$form.Add_Paint({
  param($sender, $e)
  $g = $e.Graphics
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $w = $sender.ClientSize.Width
  $h = $sender.ClientSize.Height

  if ($null -ne $script:blur) {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($script:blur, (New-Object System.Drawing.Rectangle(0, 0, $w, $h)))
    # Light veil only: enough to lift the ring off a busy wallpaper, not enough to wash
    # the user's own screen away. 62/255 keeps the layout readable through the glass.
    $veil = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(62, 14, 17, 24))
    $g.FillRectangle($veil, 0, 0, $w, $h)
    $veil.Dispose()
  } else {
    $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(20, 24, 31))
    $g.FillRectangle($bg, 0, 0, $w, $h)
    $bg.Dispose()
  }

  # centred ring
  $cx = $w / 2
  $cy = $h / 2
  $pulse = (([Math]::Sin($script:phase)) + 1) / 2
  $haloR = [int](44 + 6 * $pulse)
  $halo = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb([int](22 + 22 * $pulse), 91, 130, 255))
  $g.FillEllipse($halo, $cx - $haloR, $cy - $haloR, $haloR * 2, $haloR * 2)
  $halo.Dispose()

  $ringR = 21
  $track = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(54, 255, 255, 255), 3.0)
  $g.DrawEllipse($track, $cx - $ringR, $cy - $ringR, $ringR * 2, $ringR * 2)
  $track.Dispose()

  $arc = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 122, 155, 255), 3.0)
  $arc.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $arc.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawArc($arc, $cx - $ringR, $cy - $ringR, $ringR * 2, $ringR * 2, [int](($script:phase * 90) % 360), 96)
  $arc.Dispose()

  # caption
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $font = New-Object System.Drawing.Font("Segoe UI", 11.0, [System.Drawing.FontStyle]::Regular)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(234, 238, 246))
  $g.DrawString("Restarting DSH", $font, $brush, (New-Object System.Drawing.PointF($cx, ($cy + 44))), $fmt)
  $brush.Dispose()
  $font.Dispose()
  $fmt.Dispose()

  # progress bar, inset so the rounded corners do not clip it
  $barH = 3
  $inset = 14
  $barW = [Math]::Max(40, $w - $inset * 2)
  $barY = $h - $inset - $barH
  $trackB = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(56, 255, 255, 255))
  $g.FillRectangle($trackB, $inset, $barY, $barW, $barH)
  $trackB.Dispose()
  $fillW = [int]($barW * [Math]::Min(0.98, $script:progress))
  if ($fillW -gt 0) {
    $fill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 91, 130, 255))
    $g.FillRectangle($fill, $inset, $barY, $fillW, $barH)
    $fill.Dispose()
  }
})

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 50
$script:timer.Add_Tick({
  $script:phase += 0.07
  if ($script:progress -lt 0.92) {
    $script:progress += (0.92 - $script:progress) * 0.03
  }

  # RULE 3: hard timeout.
  if (((Get-Date) - $script:startedAt).TotalSeconds -gt $TimeoutSec) {
    Finish 'timeout'
    return
  }

  # Hand-over, in the only order that cannot misfire:
  #   1) wait until the old shell process is really gone;
  #   2) only then accept "some other process shows a titled main window" as the new one.
  # Doing (2) first would match the old window itself while it is still up, and the cover
  # would vanish the instant it appeared - which is exactly what a first cut did.
  if (-not $script:sawOldGone) {
    if (Test-OldGone) {
      $script:sawOldGone = $true
      Write-Log 'old shell is gone; waiting for the new window'
    }
  } elseif (Test-FreshReady) {
    $script:progress = 1.0
    try { $form.Invalidate(); $form.Update() } catch { }
    Finish 'new window is up'
    return
  }

  try { $form.Invalidate() } catch { }
})

$form.Add_Shown({
  # Pin the true physical rectangle after WinForms has finished its own layout pass;
  # running inline lets the show sequence overwrite it.
  $form.BeginInvoke([Action]{
    try {
      for ($i = 1; $i -le 3; $i++) {
        # SWP_NOZORDER | SWP_NOACTIVATE - deliberately NOT topmost (RULE 1).
        [void][DshWin]::SetWindowPos($form.Handle, [IntPtr]::Zero, $RectX, $RectY, $RectW, $RectH, (0x0004 -bor 0x0010))
        Start-Sleep -Milliseconds 50
        $r = New-Object DshWin+RECT
        if ([DshWin]::GetWindowRect($form.Handle, [ref]$r)) {
          $gw = $r.Right - $r.Left
          $gh = $r.Bottom - $r.Top
          if ([Math]::Abs($gw - $RectW) -le 2 -and [Math]::Abs($gh - $RectH) -le 2) {
            Write-Log ("rect pinned: {0},{1} {2}x{3}" -f $r.Left, $r.Top, $gw, $gh)
            break
          }
        }
      }
    } catch { }
    try {
      $pref = 2
      [void][DshWin]::DwmSetWindowAttribute($form.Handle, 33, [ref]$pref, 4)
    } catch { }
  }) | Out-Null
  $script:timer.Start()
  Write-Log 'shown'
})

# RULE 2: no FormClosing handler at all - the user may close this window at any time
# and nothing will intercept it.

[void]$form.ShowDialog()
Write-Log 'exited'
exit 0
