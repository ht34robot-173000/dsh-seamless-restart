/* ============================================================================
 * dsh-seamless-restart :: Client half
 * ----------------------------------------------------------------------------
 * 一个按钮：点一下，完全重启 DSH。
 * 重启期间窗口会被磨砂遮罩接管，所以这里不做任何遮罩/动画 —— 页面马上就要没了。
 * ========================================================================== */
(function () {
  'use strict'

  if (window.__DSH_RESTART_UI__) return
  window.__DSH_RESTART_UI__ = true

  var API = '/dsh-seamless-restart'
  var Z_BTN = 2147482000
  var Z_MODAL = 2147482200
  var ICON =
    '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">'
    + '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" '
    + 'd="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>'

  var CSS = [
    '#dsh-seamless-restart-btn{position:fixed;left:calc(var(--dsh-windows-sidebar-width, 280px) + 16px);bottom:14px;z-index:' + Z_BTN + ';',
    'display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 13px 0 11px;border:0;border-radius:8px;box-sizing:border-box;',
    'background:var(--dsw-alias-bg-layer-1,#f3f4f6);color:var(--dsw-alias-label-primary,#111827);cursor:pointer;',
    'font:600 12.5px/1 "Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif;',
    'box-shadow:0 2px 10px rgba(0,0,0,.14),0 0 0 1px var(--dsw-alias-border-l1,rgba(128,128,128,.28));',
    'user-select:none;-webkit-user-select:none;transition:filter .15s ease,transform .06s ease}',
    'html[data-windows-titlebar]:not([data-fullscreen]) #dsh-seamless-restart-btn{left:auto;right:196px;top:6px;bottom:auto;',
    'height:28px;padding:0 11px 0 9px;font-size:12px;-webkit-app-region:no-drag}',
    '#dsh-seamless-restart-btn:hover{filter:brightness(.97)}',
    '#dsh-seamless-restart-btn:active{transform:translateY(1px)}',
    '#dsh-seamless-restart-btn[data-state="busy"]{opacity:.6;cursor:progress}',
    '#dsh-seamless-restart-btn svg{flex:0 0 auto}',
    '#dsh-seamless-restart-btn[data-state="busy"] svg{animation:dsh-seamless-restart-spin .8s linear infinite}',
    '@keyframes dsh-seamless-restart-spin{to{transform:rotate(360deg)}}',
    '#dsh-seamless-restart-btn .dsh-seamless-restart-label{white-space:nowrap}',

    // 确认框：颜色全部走 DSH 的主题令牌（--dsw-alias-*），不写死颜色，
    // 这样浅色/深色主题都跟着变，和界面其余部分齐平。
    '.dsh-seamless-restart-mask{position:fixed;inset:0;z-index:' + Z_MODAL + ';display:flex;align-items:center;justify-content:center;',
    'background:rgba(15,17,22,.42);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);',
    'font:13px/1.55 "Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif}',
    '.dsh-seamless-restart-card{width:min(430px,92vw);padding:18px 18px 14px;border-radius:12px;box-sizing:border-box;',
    'background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111827);',
    'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));box-shadow:0 24px 60px rgba(0,0,0,.32)}',
    '.dsh-seamless-restart-title{margin:0 0 10px;font-size:14.5px;font-weight:600}',
    '.dsh-seamless-restart-body{font-size:12.5px;color:var(--dsw-alias-label-secondary,#4b5563)}',
    '.dsh-seamless-restart-line{margin:3px 0}',
    '.dsh-seamless-restart-pre{margin:0;white-space:pre-wrap;word-break:break-word;',
    'font:12px/1.55 ui-monospace,Consolas,monospace;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.1));',
    'padding:10px;border-radius:8px}',
    '.dsh-seamless-restart-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}',
    '.dsh-seamless-restart-act{font:inherit;padding:6px 15px;border-radius:7px;cursor:pointer;',
    'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:transparent;color:inherit}',
    '.dsh-seamless-restart-act:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12))}',
    // 主按钮不能拿 --dsw-alias-brand-primary 当底色。
    // 它在两套主题里是**反转的前景色**：浅色 #0f1115、深色 #f9fafb —— 深色主题下
    // 接近纯白，于是就出现"白底白字"的按钮（自己写、下载的插件都踩过这个坑）。
    // 用 --dsw-alias-button-info-fill：浅色 #4176e6、深色 #7aaaff，两套都是蓝色，
    // 配深色文字都读得清。这也是主题里"信息/主操作按钮"的本来用途。
    '.dsh-seamless-restart-act[data-primary="1"]{border-color:transparent;',
    'background:var(--dsw-alias-button-info-fill,#4176e6);color:#0f1115;font-weight:600}',
    '.dsh-seamless-restart-act[data-primary="1"]:hover{filter:brightness(1.06)}',
    '.dsh-seamless-restart-act:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#4176e6);outline-offset:2px}',
  ].join('')

  var dom = { btn: null, label: null }
  var busy = false

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = text
    return node
  }

  function setState(state, text) {
    if (!dom.btn) return
    dom.btn.dataset.state = state
    dom.label.textContent = text
  }

  function doRestart() {
    if (busy) return
    showConfirm()
  }

  // 自绘确认框，不是 window.confirm()。
  //
  // 两个原因，都是实测出来的：
  //   ① 原生 confirm() 在 Electron 里是同步模态调用，它阻塞渲染进程的消息循环。
  //      点"取消"之后焦点没能还给页面，输入框就收不到键盘 —— 必须切走再切回来。
  //   ② 它用的是系统对话框样式，跟 DSH 的深色主题完全不搭。
  // 自绘的用 DOM + 主题令牌画，焦点由我们自己还给原来的元素。
  function showConfirm() {
    if (document.getElementById('dsh-seamless-restart-confirm')) return

    // 记住打开前的焦点，关掉之后还回去。
    var previousFocus = document.activeElement

    var mask = el('div')
    mask.id = 'dsh-seamless-restart-confirm'
    mask.className = 'dsh-seamless-restart-mask'

    var card = el('div', 'dsh-seamless-restart-card')
    var title = el('div', 'dsh-seamless-restart-title', '完全重启 DSH？')
    card.appendChild(title)

    var list = el('div', 'dsh-seamless-restart-body')
    ;[
      '窗口会变成加载画面，约 5-15 秒后原地恢复',
      '正在运行的任务会中断（会话与文件已落盘）',
      '草稿与终端会丢失',
    ].forEach(function (text) {
      var row = el('div', 'dsh-seamless-restart-line', '· ' + text)
      list.appendChild(row)
    })
    card.appendChild(list)

    var actions = el('div', 'dsh-seamless-restart-actions')
    var cancel = el('button', 'dsh-seamless-restart-act', '取消')
    cancel.type = 'button'
    var confirm = el('button', 'dsh-seamless-restart-act', '确定重启')
    confirm.type = 'button'
    confirm.dataset.primary = '1'
    actions.appendChild(cancel)
    actions.appendChild(confirm)
    card.appendChild(actions)

    mask.appendChild(card)
    document.body.appendChild(mask)
    // 点击卡片内部的空白不该穿透到底下的输入框（那会把焦点丢到奇怪的位置）。
    card.addEventListener('mousedown', function (event) { event.stopPropagation() })

    function close(restoreFocus) {
      document.removeEventListener('keydown', onKey, true)
      if (mask.parentNode) mask.parentNode.removeChild(mask)
      if (!restoreFocus) return
      // 把焦点还给对话输入框。
      //
      // 为什么不是简单地 previousFocus.focus()：用户是点按钮打开这个框的，所以
      // previousFocus 就是那个按钮 —— 焦点回到按钮上，用户还得再点一下输入框才能打字。
      // 用户要的是"取消之后立刻能继续说话"，所以直接找页面的输入区。
      // 缺了这一整步时，表现就是"输入框点不了，必须切走再切回来"：原生 confirm()
      // 阻塞过渲染进程，焦点停在一个已经不可交互的位置。
      try {
        var editor = document.querySelector(
          '[contenteditable="true"], textarea, input[type="text"], input:not([type])'
        )
        if (editor && typeof editor.focus === 'function') {
          editor.focus()
          // 光标落到末尾，接着之前的话往下写。
          if (editor.setSelectionRange && typeof editor.value === 'string') {
            var end = editor.value.length
            editor.setSelectionRange(end, end)
          }
          return
        }
        if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus()
      } catch (e) { /* ignore */ }
    }

    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close(true)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        close(false)
        reallyRestart()
      }
    }

    cancel.addEventListener('click', function () { close(true) })
    confirm.addEventListener('click', function () { close(false); reallyRestart() })
    mask.addEventListener('mousedown', function (event) {
      if (event.target === mask) close(true)
    })
    document.addEventListener('keydown', onKey, true)

    // 打开后把焦点放到"取消"上：误按回车不会直接重启。
    try { cancel.focus() } catch (e) { /* ignore */ }
  }

  function reallyRestart() {
    if (busy) return
    busy = true
    setState('busy', '正在重启…')
    fetch(API + '/restart', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-dsh-seamless-restart': '1' },
      body: '{}',
    }).then(function (response) {
      return response.json().catch(function () { return {} }).then(function (payload) {
        if (!response.ok || payload.ok !== true) {
          var message = String((payload && (payload.error || payload.reason)) || ('HTTP ' + response.status))
          throw new Error(message)
        }
        // 进程马上就没了，页面不用再更新。
        setState('busy', '重启中…')
      })
    }).catch(function (error) {
      busy = false
      setState('idle', '重启 DSH')
      showError(String((error && error.message) || error))
    })
  }

  // 失败提示同样不用 window.alert()：它会打断焦点，而且样式不搭。
  function showError(message) {
    var mask = el('div')
    mask.className = 'dsh-seamless-restart-mask'
    var card = el('div', 'dsh-seamless-restart-card')
    card.appendChild(el('div', 'dsh-seamless-restart-title', '无法重启'))
    var body = el('div', 'dsh-seamless-restart-body')
    var pre = el('pre', 'dsh-seamless-restart-pre', message)
    body.appendChild(pre)
    card.appendChild(body)
    var actions = el('div', 'dsh-seamless-restart-actions')
    var ok = el('button', 'dsh-seamless-restart-act', '知道了')
    ok.type = 'button'
    ok.dataset.primary = '1'
    actions.appendChild(ok)
    card.appendChild(actions)
    mask.appendChild(card)
    document.body.appendChild(mask)
    function close() {
      if (mask.parentNode) mask.parentNode.removeChild(mask)
      try { if (dom.btn) dom.btn.focus() } catch (e) { /* ignore */ }
    }
    ok.addEventListener('click', close)
    mask.addEventListener('mousedown', function (event) { if (event.target === mask) close() })
    try { ok.focus() } catch (e) { /* ignore */ }
  }

  function buildButton() {
    var btn = el('button')
    btn.id = 'dsh-seamless-restart-btn'
    btn.type = 'button'
    btn.dataset.state = 'idle'
    btn.setAttribute('aria-label', '完全重启 DSH')
    btn.title = '完全重启 DSH：重启期间窗口由加载遮罩接管'
    btn.innerHTML = ICON
    var label = el('span', 'dsh-seamless-restart-label', '重启 DSH')
    btn.appendChild(label)
    btn.addEventListener('click', doRestart)
    document.body.appendChild(btn)
    dom.btn = btn
    dom.label = label
  }

  function boot() {
    try {
      if (!document.body) return
      var style = el('style')
      style.textContent = CSS
      ;(document.head || document.documentElement).appendChild(style)
      buildButton()
    } catch (error) {
      try { console.error('[dsh-seamless-restart] ui boot failed:', error) } catch (e) { /* ignore */ }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true })
  else boot()
})()
