# Agent 操作手册：`restart_dsh`

给 agent 用的接口文档。人类用户请读 [README.md](./README.md)。

---

## 一句话

插件注册了一个工具 `restart_dsh`，让 agent 能判断并执行「彻底重启 DSH 桌面版」。
重启期间窗口被磨砂遮罩接管，看起来像没离开过。

---

## 工具签名

```
restart_dsh(action, reason?)
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | `'status' \| 'dryRun' \| 'restart'` | ✅ | 要做什么 |
| `reason` | string | — | 为什么要重启。写进插件日志，方便以后排查（截断到 300 字符） |

三个动作**权限递增**，按需选择：

| action | 副作用 | 什么时候用 |
|---|---|---|
| `status` | 无 | 先看看能不能重启、上次什么时候重启过 |
| `dryRun` | 无 | 不确定时先跑这个，它会告诉你"会发生什么" |
| `restart` | **中断任务、丢草稿** | 确认要重启时 |

---

## 什么时候该调用

**合适**：

- 刚装/改了插件，需要完整重启才生效（新增 bundle 不会热激活）
- 界面卡住、状态不一致，重启是最快的恢复手段
- 用户明确要求"重启 DSH"／"重启一下"

**不合适**：

- ❌ 单个工具调用失败了 —— 那是那个工具的问题，重启不会修好它
- ❌ 想"清空上下文" —— 重启不会清会话，它保留全部历史
- ❌ 刚重启过又觉得"还不对" —— 先看 `status` 里 `lastRestart.agoMs`，
  短时间内重复重启通常解决不了问题
- ❌ 重启失败后立刻重试 —— 失败原因（比如 `parent-unrecognized`）不会因为重试而改变

---

## 三种典型用法

### 1. 先确认能不能重启

```
restart_dsh(action: "status")
```

返回：

```json
{
  "ok": true,
  "action": "status",
  "platform": "win32",
  "canRestart": true,
  "reason": "desktop-shell",
  "shellPid": 33164,
  "shellExe": "<DSH 安装目录>\\DeepSeek Harness.exe",
  "hostPid": 33844,
  "hostUptimeMs": 331266,
  "lastRestart": {
    "at": 1794742245606,
    "agoMs": 1488844,
    "shellPid": 40320,
    "cover": "frosted"
  }
}
```

`canRestart: false` 时看 `reason`：

| reason | 含义 | 怎么办 |
|---|---|---|
| `desktop-shell` | ✅ 可以重启 | 继续 |
| `parent-unrecognized` | 父进程不像 DSH 应用 | 当前不是桌面版（可能是 `dsh web`），无法重启 |
| `parent-is-child-process` | 父进程是 Electron 的子进程 | 同上 |
| `shell-exe-missing` | 外壳 exe 找不到 | 安装可能损坏 |
| `unsupported-platform` | 非 Windows | 无法重启 |
| `parent-unknown` | 查不到父进程 | 权限或 WMI 问题 |

### 2. 不确定就先干跑

```
restart_dsh(action: "dryRun", reason: "user asked to apply the plugin update")
```

返回会列出**每一步**和**每个副作用**，但不执行任何操作：

```json
{
  "ok": true,
  "action": "dryRun",
  "wouldRestart": true,
  "steps": [
    "抓取当前窗口矩形与截图（PrintWindow）",
    "在旧矩形上显示磨砂遮罩（截图 + 加载圈 + 进度条，硬超时 20 秒）",
    "经 explorer.exe 派发 relaunch.ps1（脱离 Job Object）",
    "请求外壳关闭 → 等 3 秒 → 强制结束 → 等端口释放",
    "拉起新实例（复用原命令行）",
    "遮罩看到新窗口出现后自行退场"
  ],
  "sideEffects": [
    "正在进行中的任务会中断",
    "未发送的草稿与打开中的终端会丢失",
    "会话记录与项目文件已经落盘，重启后可继续"
  ],
  "target": { "shellPid": 33164, "exe": "<DSH 安装目录>\\DeepSeek Harness.exe" }
}
```

### 3. 真正重启

```
restart_dsh(action: "restart", reason: "installed dsh-rewind-plugin v0.4.0")
```

返回：

```json
{
  "ok": true,
  "action": "restart",
  "canRestart": true,
  "started": true,
  "acceptedAt": 1794743000000,
  "cover": "frosted",
  "shellPid": 33164,
  "note": "重启已派发。本进程即将退出，本工具调用的返回值是最后一次通信。"
}
```

---

## ⚠️ 重启之后你会消失

这是最重要的一条。

`restart` 会终结当前的 Host 进程——**也就是你自己**。所以：

1. **不要**在 `restart` 之后写任何"重启完成了"之类的话，你不会看到结果；
2. 返回值是**最后一次通信**，可能来不及送达页面；
3. 重启完成后是**同一个会话、新的进程**，用户会看到原来的对话。
   如果需要"继续做某事"，得靠用户再发消息，或者你在重启前把
   "下一步该做什么"写进某个持久位置（文件、goal、todo）。

**换句话说**：`restart` 是你主动执行的最后一步。别指望它返回后还能继续。

如果你需要"重启后自动继续"，那不是这个工具的能力——用
[`dsh-ctl-desktop`](https://github.com/ht34robot-173000/dsh-ctl-desktop) 的
`/dshctl` 系列或外部脚本编排。

---

## 常见错误

| 错误信息 | 原因 | 处理 |
|---|---|---|
| `当前 DSH 不是由桌面壳托管（xxx），无法重启` | 非桌面版形态 | 告诉用户无法重启，别重试 |
| `未知 action「xxx」；可用：status \| dryRun \| restart` | action 拼错 | 只能是那三个值 |
| `ok: false` 但没有 error | 罕见；看插件日志 | `$DSH_HOME\seamless-restart\reload.log` |

---

## 排查：重启真的发生了吗

工具返回 `started: true` 只代表**已派发**，不代表成功。事后确认看这两个文件：

```
$DSH_HOME\seamless-restart\reload.log     ← 派发记录
$DSH_HOME\seamless-restart\restart.log    ← 每一步的执行日志
```

`restart.log` 里一次成功的重启长这样：

```
[cover]    start 150,0 1619x1029 oldPid=33164 timeout=20s
[cover]    dpi awareness: True
[cover]    backdrop ok, 180x114
[cover]    shown
[cover]    rect pinned: 150,0 1619x1029
[relaunch] requesting graceful close
[relaunch] shell gone after graceful request: False
[relaunch] forcing shell termination
[relaunch] shell gone after force: True
[relaunch] port free: True
[relaunch] launching: <DSH 安装目录>\DeepSeek Harness.exe
[relaunch] new instance up: True
[cover]    old shell is gone; waiting for the new window
[cover]    new window from pid=40320 started 18:19:41
[cover]    closing: new window is up
```

关键判断点：

- **有 `new instance up: True`** → 新进程起来了
- **遮罩的 `closing:` 是 `new window is up`** → 正常交接
- 如果是 `closing: timeout` → 遮罩自己超时退场，说明新窗口没被识别到（但重启可能仍成功）

---

## 与 HTTP 接口的关系

同一套逻辑还有 HTTP 入口，agent 一般用不到，但可以记着：

| 方法 | 路径 | 等价 action |
|---|---|---|
| GET | `/dsh-seamless-restart/status.json` | `status` |
| POST | `/dsh-seamless-restart/restart` | `restart` |

区别：HTTP 路由需要 `x-dsh-restart: 1` 头做 CSRF 防护，工具调用不需要（进程内调用，没有跨站问题）。

---

## 实现备注（给维护者）

- 工具在 `apply()` 里通过 `root.inject(['tools'], ...)` 注册，
  **拿不到 `tools` 服务时静默跳过**，不影响按钮和 HTTP 路由
- `execute(args)` 的 `args` 已经过 schema 校验，不用重复校验类型
- `output.render(_args, value)` 返回 `[{ type: 'text', text }]`
- 三个 action 共用 `detectShell()`，所以 `status` 和 `dryRun` 的判断与
  真实重启**完全一致**——不会出现"干跑说可以、真跑说不行"
