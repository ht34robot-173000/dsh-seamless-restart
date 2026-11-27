# ============================================================================
# dsh-seamless-restart :: relaunch helper
# ----------------------------------------------------------------------------
# The ONLY job of this script: wait for the Electron shell to exit, then start it
# again. It never touches windows, never sets topmost, never asks for confirmation.
#
# Why it is started through explorer.exe (see lib/index.js): DSH's processes live in
# a Windows Job Object with KILL_ON_JOB_CLOSE, so anything the Host spawns directly is
# killed the moment the shell dies. explorer.exe is an already-running process outside
# that job, so a child it starts survives long enough to do the relaunch.
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.
# ============================================================================
param(
  [Parameter(Mandatory = $true)][int]$ShellPid,
  [Parameter(Mandatory = $true)][string]$ExePath,
  [string]$LogPath = "",
  [int]$Port = 19387
)

$ErrorActionPreference = 'Continue'

function Write-Log([string]$Message) {
  if ($LogPath -eq '') { return }
  try {
    Add-Content -LiteralPath $LogPath -Value ("{0} [relaunch] {1}" -f (Get-Date).ToString("o"), $Message) -Encoding UTF8
  } catch { }
}

function Test-Alive([int]$ProcessId) {
  try { return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) } catch { return $false }
}

Write-Log ("helper started: shellPid={0} exe={1}" -f $ShellPid, $ExePath)

if (-not (Test-Path -LiteralPath $ExePath)) {
  Write-Log ("ABORT: executable not found: {0}" -f $ExePath)
  exit 2
}

# 1) Ask the shell to close, then wait for it.
#
#    Waiting alone is not enough: DSH treats a close as "minimise to tray", so the
#    process stays alive forever and this script used to sit here for the full 25s
#    timeout before force-killing anything. That wait was the whole "restart takes
#    ages" complaint. So: request the close ourselves, give it a short grace period,
#    then force it.
$proc = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $ShellPid) -ErrorAction SilentlyContinue
$sameExe = $proc -and $proc.ExecutablePath -and ($proc.ExecutablePath.ToLower() -eq $ExePath.ToLower())
if (-not $sameExe) {
  Write-Log "ABORT: pid does not belong to the shell we were asked to restart"
  exit 3
}

# WM_CLOSE first (taskkill without /F). Cheap, and lets the app save state if it wants.
Write-Log "requesting graceful close"
try {
  $null = & taskkill.exe /PID $ShellPid 2>&1
} catch {
  Write-Log ("graceful close request failed: {0}" -f $_.Exception.Message)
}

# Short grace period only - this app hides to the tray instead of exiting, so a long
# wait buys nothing and is felt by the user.
$deadline = (Get-Date).AddSeconds(3)
while ((Get-Date) -lt $deadline -and (Test-Alive $ShellPid)) {
  Start-Sleep -Milliseconds 150
}
$gone = -not (Test-Alive $ShellPid)
Write-Log ("shell gone after graceful request: {0}" -f $gone)

if (-not $gone) {
  Write-Log "forcing shell termination"
  try {
    # /T is deliberately NOT used: it would take down the whole tree, including
    # processes that are still flushing state to disk.
    $null = & taskkill.exe /F /PID $ShellPid 2>&1
  } catch {
    Write-Log ("taskkill failed: {0}" -f $_.Exception.Message)
  }
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline -and (Test-Alive $ShellPid)) { Start-Sleep -Milliseconds 150 }
  $gone = -not (Test-Alive $ShellPid)
  Write-Log ("shell gone after force: {0}" -f $gone)
}

if (-not $gone) {
  Write-Log "ABORT: shell did not exit; not starting a second instance"
  exit 4
}

# 2) Let the listening socket go, otherwise the new instance exits with EADDRINUSE.
#    Asking to bind the port ourselves is the cheapest and least ambiguous test: it
#    answers "could the new instance listen right now?". Get-NetTCPConnection was the
#    obvious alternative but it is a CIM query costing hundreds of ms per poll.
function Test-PortFree([int]$PortNumber) {
  $listener = $null
  try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $PortNumber)
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($null -ne $listener) { try { $listener.Stop() } catch { } }
  }
}

$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline -and -not (Test-PortFree $Port)) {
  Start-Sleep -Milliseconds 100
}
Write-Log ("port free: {0}" -f (Test-PortFree $Port))

# 3) Start it again. Reuse the exact arguments the shell was launched with - the Host
#    passes them through the recorded command line, so flags such as --user-data-dir
#    survive the restart.
$workDir = [System.IO.Path]::GetDirectoryName($ExePath)
Write-Log ("launching: {0} (cwd {1})" -f $ExePath, $workDir)
$launched = $false
for ($attempt = 1; $attempt -le 3 -and -not $launched; $attempt++) {
  try {
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine = ('"{0}"' -f $ExePath)
      CurrentDirectory = $workDir
    }
    Write-Log ("create attempt {0} rv={1} pid={2}" -f $attempt, $result.ReturnValue, $result.ProcessId)
    if ($result.ReturnValue -eq 0) { $launched = $true }
  } catch {
    Write-Log ("create attempt {0} failed: {1}" -f $attempt, $_.Exception.Message)
  }
  if (-not $launched) { Start-Sleep -Milliseconds 700 }
}

if (-not $launched) {
  Write-Log "WMI create failed; falling back to Start-Process"
  try {
    Start-Process -FilePath $ExePath -WorkingDirectory $workDir -ErrorAction Stop
    $launched = $true
  } catch {
    Write-Log ("fallback launch failed: {0}" -f $_.Exception.Message)
  }
}

# 4) Confirm it is actually up. Nothing else happens here: the shell shows its own
#    window, and dsh-seamless-restart's page gets told by the Host once it is ready.
$deadline = (Get-Date).AddSeconds(25)
$up = $false
while ((Get-Date) -lt $deadline) {
  $running = Get-CimInstance Win32_Process -Filter ("Name='{0}'" -f [System.IO.Path]::GetFileName($ExePath)) -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and ($_.ExecutablePath.ToLower() -eq $ExePath.ToLower()) -and ($_.CommandLine -notmatch '--type=') }
  if ($running) { $up = $true; break }
  Start-Sleep -Milliseconds 250
}

Write-Log ("new instance up: {0}" -f $up)
if ($up) { exit 0 }
Write-Log "FAILED: could not start DSH automatically"
exit 5
