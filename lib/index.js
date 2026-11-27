// ============================================================================
// dsh-seamless-restart —— Host half
// ============================================================================
// 只做一件事：**把 DSH 完全重启一遍**，并在那段空档里用磨砂遮罩盖住，让窗口看着
// 没离开过。没有插件热重载、没有局部刷新 —— 就是一个彻底的退出再启动。
//
// 重启链路（每一步都有实测依据）：
//   ① 抓旧窗口的矩形 + 截图（PrintWindow，被遮挡也拿得到）
//   ② 在旧矩形上起遮罩（磨砂底图 + 居中加载圈 + 底部进度条）
//   ③ 经 explorer.exe 派发 relaunch.ps1（宿主自己 spawn 的进程会被 job object 收走）
//   ④ 它主动请求外壳关闭 → 短等 → 强制结束 → 等端口释放 → 拉起新实例
//   ⑤ 遮罩看到"旧进程没了 + 新窗口出现"后自己退场
//
// 遮罩的三条铁律（上一版忽略它们直接搞坏了机器，任何改动都不许碰）：
//   1. 永不置顶      2. 随时可关      3. 硬超时 20 秒
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASE = '/dsh-seamless-restart'
const VERSION = '2.1.1'

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

const POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
)

const PS_UTF8_PREFIX = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;'

// —— 小工具 ---------------------------------------------------------------------
function installedVersion() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
    if (parsed && typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
  } catch { /* 落到常量 */ }
  return VERSION
}

function dshHome() {
  return process.env.DSH_HOME
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.dsh') : path.join(process.env.HOME || '.', '.dsh'))
}

let stateDirCache = null
function stateDir() {
  if (stateDirCache !== null) return stateDirCache
  const override = process.env.DSH_SEAMLESS_RESTART_HOME
  const dir = override ? path.resolve(override) : path.join(dshHome(), 'seamless-restart')
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 只读也不致命 */ }
  stateDirCache = dir
  return dir
}

function log(line) {
  try {
    const file = path.join(stateDir(), 'reload.log')
    try {
      if (fs.statSync(file).size > 256 * 1024) fs.writeFileSync(file, '')
    } catch { /* 不存在就新建 */ }
    fs.appendFileSync(file, `${new Date().toISOString()} [dsh-seamless-restart] ${line}\n`)
  } catch { /* 日志失败绝不影响主流程 */ }
}

function runPowerShell(script, timeoutMs = 20000) {
  return execFileSync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_UTF8_PREFIX + script],
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
  )
}

function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

// —— 识别外壳 -------------------------------------------------------------------
function queryProcess(pid) {
  const script = '$p = Get-CimInstance Win32_Process -Filter "ProcessId=' + String(Number(pid))
    + '" -ErrorAction SilentlyContinue; if ($p) {'
    + ' $j = $p | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress;'
    + ' [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j)) }'
  try {
    const raw = String(runPowerShell(script, 15000)).trim()
    if (raw === '') return null
    const decoded = Buffer.from(raw, 'base64').toString('utf8').trim()
    if (decoded.startsWith('{')) return JSON.parse(decoded)
    return JSON.parse(raw)
  } catch { return null }
}

// 宿主是外壳 fork 出来的子进程，process.ppid 就是主进程。只在它确实像 DSH 时才认，
// 绝不去杀一个碰巧是父进程的别的程序。
function detectShell() {
  const detail = {
    platform: process.platform,
    hostPid: process.pid,
    hostPpid: Number(process.ppid) || null,
    hostExe: process.execPath,
  }
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported-platform', ...detail }

  const parentPid = Number(process.ppid)
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1) {
    return { ok: false, reason: 'parent-unknown', ...detail }
  }
  const info = queryProcess(parentPid)
  if (info === null) return { ok: false, reason: 'parent-unknown', ...detail }

  const name = path.basename(String(info.Name || ''))
  const exe = String(info.ExecutablePath || '')
  const cmd = String(info.CommandLine || '')
  detail.parentName = name
  detail.parentExe = exe

  // Electron 的 --type= 子进程（渲染/GPU/工具）不是外壳。
  if (/--type=/i.test(cmd)) return { ok: false, reason: 'parent-is-child-process', ...detail }
  if (!/deepseek|harness|dsh/i.test(name)) return { ok: false, reason: 'parent-unrecognized', ...detail }
  if (exe === '' || !fs.existsSync(exe)) return { ok: false, reason: 'shell-exe-missing', ...detail }
  return { ok: true, reason: 'desktop-shell', ...detail, shellPid: parentPid, exePath: exe, commandLine: cmd }
}

// —— 抓矩形 + 截图 ---------------------------------------------------------------
// PrintWindow 而不是屏幕抓取：屏幕抓取拿的是"那个矩形最上层的东西"，DSH 不在前台时
// 会抓到压在它上面的别的窗口；PrintWindow 让窗口自己把内容画进 DC，被遮挡也拿得到。
//
// ⚠️ 不用 Process.MainWindowHandle：用户把窗口缩小之后，它可能返回某个小面板
// （实测量到 327x32），于是遮罩要么被尺寸门槛挡掉、要么退化到旧缓存、尺寸完全不对。
// 我们改用 EnumWindows 枚举该进程的所有顶层窗口，取面积最大且可见的那一个 ——
// 那才是用户眼里的"DSH 窗口"，与它当前是大是小无关。
const CAPTURE_SCRIPT = [
  'Add-Type -AssemblyName System.Drawing',
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Collections.Generic;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class DshShot {',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);',
  '  public delegate bool EnumProc(IntPtr h, IntPtr p);',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);',
  '  private static int _target;',
  '  private static long _bestArea;',
  '  private static IntPtr _best;',
  '  private static RECT _bestRect;',
  '  /// Largest visible top-level window owned by the pid. This is what the user sees,',
  '  /// and unlike MainWindowHandle it does not collapse to a tiny panel when resized.',
  '  public static IntPtr LargestWindow(int pid, out int x, out int y, out int w, out int h) {',
  '    _target = pid; _bestArea = 0; _best = IntPtr.Zero;',
  '    _bestRect = new RECT();',
  '    EnumWindows(new EnumProc(Scan), IntPtr.Zero);',
  '    x = _bestRect.Left; y = _bestRect.Top;',
  '    w = _bestRect.Right - _bestRect.Left; h = _bestRect.Bottom - _bestRect.Top;',
  '    return _best;',
  '  }',
  '  private static bool Scan(IntPtr h, IntPtr p) {',
  '    uint pid;',
  '    GetWindowThreadProcessId(h, out pid);',
  '    if ((int)pid != _target) return true;',
  '    if (!IsWindowVisible(h)) return true;',
  '    StringBuilder cls = new StringBuilder(256);',
  '    GetClassNameW(h, cls, 256);',
  '    // Only Chromium/Electron top-level frames; skip tray hosts, tooltips, IME.',
  '    if (!cls.ToString().StartsWith("Chrome_WidgetWin_1")) return true;',
  '    RECT r;',
  '    if (!GetWindowRect(h, out r)) return true;',
  '    long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);',
  '    if (area > _bestArea) { _bestArea = area; _best = h; _bestRect = r; }',
  '    return true;',
  '  }',
  '  public static bool IsMinimized(IntPtr h) { return IsIconic(h); }',
  '}',
  '"@',
  '# DPI awareness BEFORE measuring: an unaware process gets virtualised coordinates',
  '# (measured: same window read as 1295x823 unaware vs 1619x1029 aware at 125%).',
  'try { [void][DshShot]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }',
].join('\n')

// 拼出量矩形/抓图的脚本。measureOnly=true 时不做 PrintWindow（纯色底遮罩用）。
function buildRectScript(pid, target, measureOnly) {
  const head = CAPTURE_SCRIPT + '\n'
    + '$ErrorActionPreference = "Continue"\n'
    + '$p = Get-Process -Id ' + String(Number(pid)) + ' -ErrorAction SilentlyContinue\n'
    + 'if (-not $p) { Write-Output "WHY=no-process"; exit 0 }\n'
    + '$x = 0; $y = 0; $w = 0; $h = 0\n'
    + '$hwnd = [DshShot]::LargestWindow(' + String(Number(pid)) + ', [ref]$x, [ref]$y, [ref]$w, [ref]$h)\n'
    + 'if ($hwnd -eq [IntPtr]::Zero) { Write-Output "WHY=no-window"; exit 0 }\n'
    + 'if ($w -le -30000 -or $y -le -30000) { Write-Output "WHY=sentinel"; exit 0 }\n'
    + 'if ($w -lt 120 -or $h -lt 80) { Write-Output ("WHY=too-small {0}x{1}" -f $w, $h); exit 0 }\n'
  if (measureOnly) {
    return head
      + 'Write-Output ("RECT={0},{1},{2},{3}" -f $x, $y, $w, $h)\n'
  }
  return head
    + 'try {\n'
    + '  $bmp = New-Object System.Drawing.Bitmap($w, $h)\n'
    + '  $g = [System.Drawing.Graphics]::FromImage($bmp)\n'
    + '  $dc = $g.GetHdc()\n'
    + '  $ok = $false\n'
    + '  try { $ok = [DshShot]::PrintWindow($hwnd, $dc, 2) } finally { $g.ReleaseHdc($dc) }\n'
    + '  $g.Dispose()\n'
    + '  if ($ok) { $bmp.Save(' + psLiteral(target) + ', [System.Drawing.Imaging.ImageFormat]::Png) }\n'
    + '  $bmp.Dispose()\n'
    + '  Write-Output ("WHY=ok printwindow=" + $ok)\n'
    + '} catch { Write-Output ("WHY=draw-ex " + $_.Exception.Message) }\n'
    + 'Write-Output ("RECT={0},{1},{2},{3}" -f $x, $y, $w, $h)\n'
}

function parseRectOutput(out) {
  const why = /WHY=([^\r\n]*)/.exec(out)
  const line = /RECT=(-?\d+),(-?\d+),(\d+),(\d+)/.exec(out)
  if (line === null) {
    return { rect: null, why: why === null ? 'no-rect-line' : why[1].trim() }
  }
  const nums = [line[1], line[2], line[3], line[4]].map(Number)
  if (!nums.every(Number.isFinite) || nums[2] < 120 || nums[3] < 80) {
    return { rect: null, why: why === null ? 'bad-numbers' : why[1].trim() }
  }
  return {
    rect: { x: nums[0], y: nums[1], width: nums[2], height: nums[3] },
    why: why === null ? 'ok' : why[1].trim(),
  }
}

function captureWindow(pid, target) {
  try {
    const out = String(runPowerShell(buildRectScript(pid, target, false), 25000)).trim()
    const parsed = parseRectOutput(out)
    log(`capture: ${parsed.why}${parsed.rect === null ? '' : ` ${parsed.rect.width}x${parsed.rect.height}`}`)
    if (parsed.rect === null) return null
    const shot = fs.existsSync(target) && fs.statSync(target).size > 4096 ? target : ''
    return { ...parsed.rect, shot }
  } catch (error) {
    log(`capture threw: ${String((error && error.message) || error)}`)
    return null
  }
}

// 只要矩形，不抓图。抓图失败时的退路：遮罩用纯色底，仍然把空档盖住。
// 这条路径比完整抓图快得多（不用建 Bitmap、不用 PrintWindow），失败率也低。
// 只要矩形，不抓图。抓图失败时的退路：遮罩用纯色底，仍然把空档盖住。
function windowRectOnly(pid) {
  try {
    const out = String(runPowerShell(buildRectScript(pid, '', true), 12000)).trim()
    const parsed = parseRectOutput(out)
    log(`rect-only: ${parsed.why}${parsed.rect === null ? '' : ` ${parsed.rect.width}x${parsed.rect.height}`}`)
    if (parsed.rect === null) return null
    return { ...parsed.rect, shot: '' }
  } catch (error) {
    log(`rect-only threw: ${String((error && error.message) || error)}`)
    return null
  }
}

// —— VBS wrapper -----------------------------------------------------------------
// 生成一个 VBS wrapper：用给定命令行启动进程，不显示窗口。
//
// 为什么不用 `Run """..."""`：命令行的引号要穿过 explorer → wscript 两层，而 VBS
// 字符串里只有"每个 " 换成 "" "一条转义规则 —— 看起来简单，实测极易漏；漏掉一处，
// wscript 就以 800A0401/800A0409（语句未结束）直接失败，窗口不出现、日志也空白。
// 这就是遮罩一开始根本不出现的真正原因。
//
// 这里把所有引号都用 Chr(34) 拼出来：wrapper 结构固定，不含任何需要转义的双引号。
// 带空格的参数自动加引号（由 Chr(34) 提供），调用方传原始值即可。
function writeWrapper(target, exe, args) {
  const parts = args.map((value) => {
    const text = String(value).replace(/"/g, '')
    if (text !== '' && !/\s/.test(text)) return ` & " ${text}"`
    return ` & " " & Chr(34) & "${text}" & Chr(34)`
  }).join('')
  const lines = [
    "' generated by dsh-seamless-restart :: launcher",
    "' quotes are built with Chr(34); nothing here needs escaping",
    'Set sh = CreateObject("WScript.Shell")',
    `cmd = Chr(34) & "${String(exe).replace(/"/g, '')}" & Chr(34)${parts}`,
    'sh.Run cmd, 0, False',
    '',
  ]
  fs.writeFileSync(target, '\uFEFF' + lines.join('\r\n'), 'utf16le')
}

// —— 上次成功量到的矩形 ---------------------------------------------------------
// 抓图和取矩形两条 PowerShell 路径都失败时，用它兜底。存在的理由很具体：
// 用户报告过"这次又完全没有遮罩"，日志里是 capture 与 rect 双双失败 —— 而遮罩
// 位置略有偏差，也远好过整块消失。窗口位置在两次重启之间几乎不会变，所以这个
// 缓存值的命中率很高。
function rectCacheFile() {
  return path.join(stateDir(), 'last-rect.json')
}

function rememberRect(rect) {
  try {
    fs.writeFileSync(rectCacheFile(), JSON.stringify({
      x: rect.x, y: rect.y, width: rect.width, height: rect.height, at: Date.now(),
    }), 'utf8')
  } catch { /* 缓存失败无所谓 */ }
}

function lastKnownRect() {
  try {
    const parsed = JSON.parse(fs.readFileSync(rectCacheFile(), 'utf8'))
    const nums = [parsed.x, parsed.y, parsed.width, parsed.height].map(Number)
    if (!nums.every(Number.isFinite)) return null
    if (nums[2] < 200 || nums[3] < 150) return null
    // 超过 7 天就别信了：用户可能换了显示器或改了缩放。
    if (Date.now() - Number(parsed.at || 0) > 7 * 24 * 3600 * 1000) return null
    return { x: nums[0], y: nums[1], width: nums[2], height: nums[3], shot: '' }
  } catch {
    return null
  }
}

// —— 起遮罩 ---------------------------------------------------------------------
// 参数写进 JSON 文件让脚本自己读：命令行只需传一个路径，转义面最小。
// 派发后立刻返回，绝不等待、绝不阻塞重启 —— 没有遮罩只是多几秒空档，比卡住强。
function startCover(rect, shot, shellPid) {
  const script = path.join(HERE, 'stand-in.ps1')
  if (!fs.existsSync(script)) {
    log('cover skipped: stand-in.ps1 missing')
    return false
  }
  const jobFile = path.join(stateDir(), 'cover-job.json')
  try {
    fs.writeFileSync(jobFile, JSON.stringify({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      shellPid,
      shot,
      logPath: path.join(stateDir(), 'restart.log'),
      timeoutSec: 20,
    }), 'utf8')
  } catch (error) {
    log(`cover job write failed: ${String((error && error.message) || error)}`)
    return false
  }

  const wrapper = path.join(stateDir(), 'cover-wrapper.vbs')
  try {
    writeWrapper(wrapper, POWERSHELL, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', script,
      '-Job', jobFile,
    ])
    const child = spawn('explorer.exe', [wrapper], { detached: true, stdio: 'ignore', windowsHide: true })
    if (typeof child.unref === 'function') child.unref()
    log(`cover dispatched ${rect.width}x${rect.height}${shot === '' ? ' (solid)' : ' (frosted)'}`)
    return true
  } catch (error) {
    log(`cover dispatch failed: ${String((error && error.message) || error)}`)
    return false
  }
}

// —— 完全重启 -------------------------------------------------------------------
async function beginRestart(shell) {
  const logFile = path.join(stateDir(), 'restart.log')
  const shotFile = path.join(stateDir(), 'cover-shot.png')

  // ① Capture FIRST, cover second. The other order photographs the cover itself.
  //
  //    Capture is allowed to fail without giving up the cover: the cover's job is to
  //    hide the gap, and a solid-colour cover hides it just as well as a frosted one.
  //    Bailing out on a failed capture is what produced "no cover at all" on a restart
  //    that happened right after another one (the window handle was not ready yet).
  let shot = ''
  let rect = captureWindow(shell.shellPid, shotFile)
  if (rect === null) {
    // 抓图失败的退路：只要矩形，纯色底遮罩。两次调用独立，一次失败不影响另一次。
    rect = windowRectOnly(shell.shellPid)
    log(rect === null
      ? 'capture and rect both failed; trying the last known rect'
      : 'capture failed; using a solid cover at the measured rect')
  } else {
    shot = rect.shot
  }
  // 最后一道保险：两条 PowerShell 路径都失败时，用上一次成功量到的矩形。
  // 遮罩宁可位置略有偏差，也不要整块消失 —— 用户抱怨的正是"完全没有遮罩"。
  // 只有在从没成功量到过矩形时才真的放弃。
  if (rect === null) {
    rect = lastKnownRect()
    if (rect !== null) log('using the last known rect for a solid cover')
  }
  if (rect !== null) rememberRect(rect)

  let cover = 'skipped'
  if (rect !== null) {
    // ② Cover. It never blocks: a restart without one is still a correct restart.
    if (startCover(rect, shot, shell.shellPid)) cover = shot === '' ? 'solid' : 'frosted'
  }

  // ③ Dispatch the relauncher through Explorer. Chromium's main process carries a
  //    job object with KILL_ON_JOB_CLOSE, so anything the Host spawns directly dies
  //    together with the shell; Explorer is an outside process that already runs.
  const ps = path.join(HERE, 'relaunch.ps1')
  const wrapper = path.join(stateDir(), 'relaunch-wrapper.vbs')
  writeWrapper(wrapper, POWERSHELL, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', ps,
    '-ShellPid', String(shell.shellPid),
    '-ExePath', shell.exePath,
    '-LogPath', logFile,
  ])
  const child = spawn('explorer.exe', [wrapper], { detached: true, stdio: 'ignore', windowsHide: true })
  if (typeof child.unref === 'function') child.unref()

  const record = { at: Date.now(), shellPid: shell.shellPid, exePath: shell.exePath, cover }
  try {
    fs.writeFileSync(path.join(stateDir(), 'last-restart.json'), JSON.stringify(record, null, 2))
  } catch { /* ignore */ }
  log(`restart dispatched: pid=${shell.shellPid} cover=${cover}`)
  return record
}

// —— 路由护栏 -------------------------------------------------------------------
function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (h === '') return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  return Number(m[1]) === 127 && [m[2], m[3], m[4]].every((part) => Number(part) <= 255)
}

function deny(res, code, message) {
  try {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(message || '')
  } catch { /* ignore */ }
  return true
}

function rejected(ctx, req, res) {
  try {
    const headers = (req && req.headers) || {}
    let hostUrl = null
    try { hostUrl = new URL(`http://${String(headers.host || '')}`) } catch { return deny(res, 400, 'bad host') }
    if (!isLoopbackHostname(hostUrl.hostname)) return deny(res, 403, 'loopback only')
    if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return deny(res, 403, 'cross-site rejected')
    const origin = headers.origin
    if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
      let originUrl = null
      try { originUrl = new URL(origin) } catch { return deny(res, 403, 'bad origin') }
      if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return deny(res, 403, 'cross-origin rejected')
    }
    let connection = null
    try { connection = ctx.get('connection') } catch { connection = null }
    if (connection && typeof connection.requestRejection === 'function') {
      let code
      try { code = connection.requestRejection(req) } catch { return deny(res, 403, 'fence failed') }
      if (code !== undefined && code !== null && code !== false) {
        return deny(res, typeof code === 'number' ? code : 403, 'unauthorized')
      }
    }
    return false
  } catch {
    return deny(res, 403, 'rejected')
  }
}

async function readBody(req, limit = 8192) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function loadUiScript() {
  for (const candidate of [path.join(HERE, 'ui.js'), path.join(HERE, '..', 'lib', 'ui.js')]) {
    try { return fs.readFileSync(candidate, 'utf8') } catch { /* next */ }
  }
  return ''
}

const INLINE_BOOT_ROW =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;'
  + 'var s=document.createElement("script");s.src="' + BASE + '/ui.js";s.async=true;'
  + 's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

// —— Agent 工具 ------------------------------------------------------------------
// 让 agent 自己判断"该重启了"并执行，而不是等用户点按钮。
//
// 三个动作刻意分层，权限递增：
//   status   只读，随时可调
//   restart  有副作用（中断任务、丢草稿），但可恢复——会话与文件都已落盘
//   dryRun   只报告"会发生什么"，不动任何进程
//
// 为什么不做一个 boolean 参数：让模型显式选动作，比让它填 `force: true` 更难误用。
// 参数名用 `action` 而不是 `restart: true`，是因为前者在 schema 里能列 enum，
// 模型看得到全部选项，也就更难"猜"出一个不存在的用法。
const TOOL_NAME = 'restart_dsh'

function toolStatus() {
  const shell = detectShell()
  const last = readLastRestart()
  return {
    ok: true,
    platform: process.platform,
    canRestart: shell.ok === true,
    reason: shell.reason,
    shellPid: shell.ok ? shell.shellPid : null,
    shellExe: shell.ok ? shell.shellExe : null,
    hostPid: process.pid,
    hostUptimeMs: Math.round(process.uptime() * 1000),
    lastRestart: last,
  }
}

function readLastRestart() {
  try {
    const raw = fs.readFileSync(path.join(stateDir(), 'last-restart.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const at = Number(parsed.at)
    return {
      at: Number.isFinite(at) ? at : null,
      agoMs: Number.isFinite(at) ? Date.now() - at : null,
      shellPid: parsed.shellPid ?? null,
      cover: parsed.cover ?? null,
    }
  } catch {
    return null
  }
}

// 干跑：把要做的每一步都算出来，但不执行。agent 可以先调它确认判断正确。
function toolDryRun(shell) {
  if (!shell.ok) {
    return {
      wouldRestart: false,
      blockedBy: shell.reason,
      hint: '只在桌面版（Electron 外壳）下能重启；当前 DSH 不是由外壳托管的。',
    }
  }
  return {
    wouldRestart: true,
    steps: [
      '抓取当前窗口矩形与截图（PrintWindow）',
      '在旧矩形上显示磨砂遮罩（截图 + 加载圈 + 进度条，硬超时 20 秒）',
      '经 explorer.exe 派发 relaunch.ps1（脱离 Job Object）',
      '请求外壳关闭 → 等 3 秒 → 强制结束 → 等端口释放',
      '拉起新实例（复用原命令行）',
      '遮罩看到新窗口出现后自行退场',
    ],
    sideEffects: [
      '正在进行中的任务会中断',
      '未发送的草稿与打开中的终端会丢失',
      '会话记录与项目文件已经落盘，重启后可继续',
    ],
    target: { shellPid: shell.shellPid, exe: shell.shellExe },
  }
}

function toolRestart(shell) {
  return beginRestart(shell).then((record) => ({
    started: true,
    acceptedAt: record.at,
    cover: record.cover,
    shellPid: record.shellPid,
    note: '重启已派发。本进程即将退出，本工具调用的返回值是最后一次通信。',
  }))
}

export function registerAgentTool(ctx) {
  if (typeof ctx.tools?.register !== 'function') return () => {}

  const definition = {
    name: TOOL_NAME,
    description: [
      'Restart the DSH desktop application (Electron shell + Host). The window is covered by',
      'a frosted loading overlay during the 5-15s gap, so it looks like it never left.',
      '',
      'Use it when: a plugin was just installed or changed and needs a full restart to take',
      'effect; the UI is stuck; the user explicitly asks to restart DSH.',
      '',
      'Do NOT use it to "fix" a single failed tool call, and do not retry it after a restart',
      '(the session continues in a new process). Prefer action=dryRun first when unsure:',
      'it reports what would happen without touching any process.',
      '',
      'Warning: this interrupts in-flight tasks and loses unsent drafts.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'dryRun', 'restart'],
        description: 'status: read-only report. dryRun: what a restart would do, executes nothing. restart: actually restart.',
      },
      reason: {
        type: 'string',
        description: 'Why the restart is needed. Recorded in the plugin log; helps later debugging.',
      },
    },
    output: {
      // ⚠️ output.schema 是标准 JSON Schema：`required` 必须是数组挂在父对象上，
      // 不能写在属性内部（那样会报 unsupported JSON schema 并让整个工具注册失败）。
      // parameters 那套"属性内 required: true"是工具参数专用的形态，两者不同。
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['ok', 'action'],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          canRestart: { type: 'boolean' },
          started: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
      render(_args, value) {
        const parts = []
        if (value.action === 'status') {
          parts.push(value.canRestart
            ? `可重启 · 外壳 pid ${value.shellPid}`
            : `不可重启（${value.reason}）`)
          if (value.lastRestart?.agoMs != null) {
            parts.push(`上次重启 ${Math.round(value.lastRestart.agoMs / 1000)} 秒前 · 遮罩 ${value.lastRestart.cover ?? '?'}`)
          }
        } else if (value.action === 'dryRun') {
          if (value.wouldRestart) {
            parts.push('干跑：会执行以下步骤，未做任何改动')
            for (const step of value.steps ?? []) parts.push(`· ${step}`)
            parts.push('副作用：')
            for (const effect of value.sideEffects ?? []) parts.push(`· ${effect}`)
          } else {
            parts.push(`干跑：不会重启（${value.blockedBy}）`)
            if (value.hint) parts.push(value.hint)
          }
        } else if (value.action === 'restart') {
          parts.push(`重启已派发 · 遮罩 ${value.cover} · 外壳 pid ${value.shellPid}`)
          if (value.note) parts.push(value.note)
        }
        if (value.ok === false && value.error) parts.push(`错误：${value.error}`)
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    async execute(args) {
      const action = String(args?.action ?? '')
      const reason = typeof args?.reason === 'string' ? args.reason.slice(0, 300) : ''
      const shell = detectShell()

      if (action === 'status') {
        const { ok: _ignored, ...rest } = toolStatus()
        return { ok: true, action, ...rest }
      }

      if (action === 'dryRun') {
        const plan = toolDryRun(shell)
        return { ok: true, action, ...plan }
      }

      if (action === 'restart') {
        if (!shell.ok) {
          return {
            ok: false,
            action,
            started: false,
            canRestart: false,
            error: `当前 DSH 不是由桌面壳托管（${shell.reason}），无法重启`,
          }
        }
        log(`agent requested restart${reason === '' ? '' : `: ${reason}`}`)
        const result = await toolRestart(shell)
        return { ok: true, action, canRestart: true, ...result }
      }

      return {
        ok: false,
        action,
        error: `未知 action「${action}」；可用：status | dryRun | restart`,
      }
    },
  }

  try {
    const dispose = ctx.tools.register(definition)
    log(`agent tool registered: ${TOOL_NAME}`)
    return typeof dispose === 'function' ? dispose : () => {}
  } catch (error) {
    log(`agent tool registration failed: ${String((error && error.message) || error)}`)
    return () => {}
  }
}

export default {
  name: 'dsh-seamless-restart',
  apply(root) {
    // ① 注入行必须第一时间进表：桌面壳的注入表是启动时一次性收集的。
    root.effect(() => {
      const off = root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(`${BASE}/ui.js`) >= 0) return
          }
          table.push({ kind: 'script', placement: 'body', text: INLINE_BOOT_ROW })
        } catch { /* ignore */ }
      })
      return () => { try { off() } catch { /* ignore */ } }
    })

    // ② Agent 工具：独立注入，拿不到 tools 服务时静默跳过，不影响按钮与路由。
    root.inject(['tools'], (toolCtx) => {
      const dispose = registerAgentTool(toolCtx)
      toolCtx.effect(() => () => { try { dispose() } catch { /* ignore */ } })
    })

    root.inject(['webServer'], (ctx) => {
      const disposers = []
      const register = (routePath, handler) => {
        disposers.push(ctx.webServer.register({
          kind: 'exact',
          path: routePath,
          handler: async (req, res) => {
            if (rejected(ctx, req, res)) return undefined
            try {
              return await handler(req, res)
            } catch (error) {
              log(`route ${routePath} failed: ${String((error && error.message) || error)}`)
              try {
                res.writeHead(500, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }))
              } catch { /* ignore */ }
              return undefined
            }
          },
        }))
      }

      const send = (res, code, payload) => {
        res.writeHead(code, JSON_HEADERS)
        res.end(JSON.stringify(payload))
      }

      register(`${BASE}/status.json`, (req, res) => {
        const shell = detectShell()
        send(res, 200, {
          ok: true,
          version: installedVersion(),
          runningVersion: VERSION,
          platform: process.platform,
          hostPid: process.pid,
          canRestart: shell.ok === true,
          restartReason: shell.reason,
          shellPid: shell.ok ? shell.shellPid : null,
          shellExe: shell.ok ? shell.exePath : null,
        })
      })

      register(`${BASE}/ui.js`, (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(loadUiScript())
      })

      register(`${BASE}/restart`, async (req, res) => {
        if (String(req.method || 'GET').toUpperCase() !== 'POST') return deny(res, 405, 'POST only')
        if (String((req.headers || {})['x-dsh-seamless-restart'] || '') !== '1') return deny(res, 403, 'missing x-dsh-seamless-restart header')
        try { await readBody(req) } catch { /* body may be empty */ }

        const shell = detectShell()
        if (!shell.ok) {
          return send(res, 409, {
            ok: false,
            reason: shell.reason,
            error: `当前 DSH 不是由桌面壳托管（${shell.reason}），无法重启`,
          })
        }
        const record = await beginRestart(shell)
        send(res, 200, { ok: true, acceptedAt: record.at, cover: record.cover })
        return undefined
      })

      // 浏览器形态的注入通道。
      disposers.push(ctx.webServer.tapIndex((html) => {
        if (typeof html !== 'string') return html
        if (html.indexOf(`${BASE}/ui.js`) !== -1) return html
        const tag = `<script defer src="${BASE}/ui.js"></script>`
        return html.indexOf('</body>') !== -1 ? html.replace('</body>', `${tag}</body>`) : html + tag
      }))

      const timer = setTimeout(() => {
        const shell = detectShell()
        log(`mounted v${installedVersion()}: hostPid=${process.pid} shell=${shell.ok ? shell.shellPid : 'n/a(' + shell.reason + ')'}`)
      }, 1200)
      if (typeof timer.unref === 'function') timer.unref()

      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* ignore */ }
        }
      })
    })
  },
}
