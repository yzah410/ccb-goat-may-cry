# 自动点击器 HTTP 接口

> 后端默认 `http://127.0.0.1:8099`。
> `logs` 是 `{ts, level, msg}` 对象数组；另有 `log_lines`（已格式化好的日志文字），方便直接显示。
> 字段的唯一真相来源是 `backend/clicker/models.py`。
>
> **写请求（POST / PUT / PATCH / DELETE）必须带请求头 `X-Outsetter: 1`**，并且不能带外部网页的 `Origin`，否则返回 403
> （挡外部网页借浏览器向本机后端发请求）。出题器前端已自动带上；自己写脚本或 curl 调用时要手动加，例如
> `curl -X POST -H "X-Outsetter: 1" http://127.0.0.1:8099/autoclick/cancel`。GET 不受影响。规则见 `backend/writeguard.py`。
>
> 只支持房主出题（host）。工作台的自动模式用 `POST /v2/autoclick/auto/start` 启动，经典工作台的用 `POST /autoclick/auto/start` 启动（需要经典工作台数据，没有时返回 503）；每轮按方案抽一题。

## 一句话理解

- **host（出题）**：在「自己是房主」的房间页里，自动点「有人想出题？」→ 点自己那行的「选择」→ 在出题弹窗里搜目标 → 按角色 id 核验选中的就是它 → 点「确认」。
- **auto**：后端常驻循环。每局出一题，出完等本局结束立刻出下一题。
- **dry_run（验证）**：只定位不点击，告诉你「会点第几项、依据是什么」。

## 端点一览

| 方法 | 路径 | 用途 | 立即返回？ |
|---|---|---|---|
| POST | `/autoclick/once` | 单次出题（也可 `dry_run:true`） | 是，返回 task_id；进度看 status |
| POST | `/autoclick/dry_run` | 「验证」按钮：同步返回定位结果 | 否，约 1–5 秒 |
| GET | `/autoclick/status` | 全部状态（轮询用） | 是 |
| GET | `/autoclick/probe` | 只查 Chrome 调试端口和猜猜呗标签页（不接管浏览器） | 是 |
| POST | `/autoclick/cancel` | 取消正在跑的单次任务或验证 | 最多等 2 秒（等任务真正停下），见下 |
| POST | `/v2/autoclick/auto/start` | 启动自动模式（每轮按工作台的方案抽题） | 是 |
| POST | `/autoclick/auto/start` | 启动自动模式（每轮按经典工作台的方案抽题，需要经典工作台数据） | 是 |
| POST | `/autoclick/auto/stop` | 停止自动模式（最多等 8 秒让当前一轮收尾） | 基本是 |

## POST /autoclick/once

请求体（只有 `mode` 必填；`{mode, char_id, char_name}` 就够用）：

```json
{
  "mode": "host",              // "host"（房主出题）
  "char_id": 37064,            // 强烈建议传。只传 char_name 时后端会按角色库里的名字反查（重名时选热度最高的并记 warn）
  "char_name": "雷伊",          // 可选
  "work_name_hint": null,      // 可选：作品名提示，走「先搜作品」路径时优先用它
  "dry_run": false,            // 可选：true = 只定位不点击
  "confirm": true,             // 可选（host）：false = 只选中不点「确认」，留给人点
  "open_popup": true           // 可选（host）：false = 弹窗没开就报错，不自动「有人想出题？」
}
```

响应：

```json
{ "task_id": "task-1700000000000", "accepted": true, "message": null, "state": "locating" }
```

`accepted:false` 的情况（`message` 可直接展示）：
- 上一个任务还没结束：`"上一个任务还没结束"`
- 上一个任务正在取消（`state=cancelling`）：`"上一个任务正在取消，等它真正停下再发（通常不到 1 秒）"`
- 上一个任务取消后卡住（`state=stuck`）：`"上一个任务取消后卡住了：后端已自动重置浏览器连接，等它停下再发（可以再调一次取消，会再重置一次；还不行就重启后端）"`
- 自动模式正在运行：`"自动模式正在运行，先停止自动模式再单次发送"`
- 后端正在退出（`state=closed`）：`"点击器已关闭（后端正在退出）"`

`POST /autoclick/dry_run` 被拒时返回 `ok:false`：上一个任务还没结束 / 正在取消 / 取消后卡住 → `error` 是上面对应的文字再加「，稍后再验证」；后端正在退出 → `error:"点击器已关闭（后端正在退出）"`。
**自动模式运行时 dry_run 不会被拒**：它会排队等自动模式当前这一轮做完，再在页面里输入、定位、清空搜索框。

## POST /autoclick/dry_run

请求体：`{ "mode": "host", "char_id": 173121, "char_name"?, "work_name_hint"?, "in_page": true }`

- `in_page:true`（默认）：页面上有能用的搜索框时（出题弹窗已开），**真的输入关键词、翻页找到目标，但不点**，最后清空输入框。
- 没有能用的搜索框、或 `in_page:false`：只做离线预测（用 Bangumi API 按和游戏相同的参数算），`source:"api"`、`evidence:"planned"`，`warnings` 里写明原因。
- 返回一个 **LocateResult**（见下）。

## GET /autoclick/status（轮询）

建议轮询间隔：`busy` 或 `auto.running` 为 true 时 500–1000ms；空闲时 3–5 秒。

```json
{
  "connected": true,           // Playwright 当前是否接着 Chrome（默认一直接着，见 README「几个设计决定（及原因）」里的「常驻连接」）
  "browser_ok": true,          // Chrome 调试端口能不能访问（纯 HTTP 检查）
  "cdp_port": 9223,
  "page_url": "https://anime-character-guessr.netlify.app/multiplayer/428c…",   // 当前/最近操作的标签页
  "page_role": "host_lobby",   // 见下「page_role」
  "state": "done",             // 见下「state 状态机」（含 cancelling / stuck / closed）
  "busy": false,               // 单次任务 / 验证 是否在跑；取消中（cancelling / stuck）仍是 true，任务真正停下才变 false
  "task_id": "task-…",
  "target": { "char_id": 124313, "name": "六道桃助", "name_cn": "六道桃助", "work_hint": null },
  "strategy_used": "char_search/resp_id",   // 「路径/依据」，见下
  "attempts": 1,               // 本次任务尝试过几条路径（含重试）
  "last_error": null,          // 最近一次失败的中文原因（可直接展示）
  "last_result": { …LocateResult… },
  "logs": [ { "ts": 1700000060.0, "level": "info", "msg": "自动模式已停止" } ],   // 最近 200 条
  "auto": {
    "running": false, "mode": "host", "round": 2, "failed": 0,
    "started_at": 1700000000.0, "last_round_at": 1700000030.0,
    "last_char_id": 124313, "last_char_name": "六道桃助",
    "waiting_for": null,       // 自动模式正在等什么（中文，可直接展示），例：「本局进行中，等结束后出下一题」
    "provider": "spec",        // spec = 按工作台的方案抽题；classic = 按经典工作台的方案抽题；default = 没给方案（不出题）
    "stop_reason": "手动停止"
  },
  "updated_at": 1700000060.0,
  // —— 冗余字段：格式化好的日志文字和三个布尔值 ——
  "running": false, "manual_running": false, "auto_running": false,
  "log_lines": ["08:45:19 [info] 自动模式已停止"]
}
```

### state 状态机

```
idle ──once/dry_run──▶ locating ──▶ typing ──▶ selecting ──▶ confirming ──▶ done
                         │  找页面、开弹窗、  │  输入关键词、   │  点结果、     │  host：点「确认」
                         │  离线规划          │  点「更多」、    │  按 id 核验   │
                         │                    │  搜作品          │               │
                         └──────────任何一步失败──────────────────────────────▶ error（看 last_error）
```

- dry_run 成功停在 `done`（`last_result.dry_run=true`、`clicked=false`）。
- 自动模式下每一轮都会走一遍这个状态机；轮与轮之间 `state` 停在上一轮的 `done`/`error`，看 `auto.waiting_for` 知道在等什么。

**取消 / 关服相关的 3 个取值**

```
locating / typing / selecting / confirming ──POST /autoclick/cancel──▶ cancelling ──任务真正停下（通常几十毫秒）──▶ error（last_error="已取消"）
                                                                         │
                                                                         └─5 秒还没停下──▶ stuck ──后端自动重置浏览器连接，任务停下──▶ error（last_error="已取消（取消后卡住了一段时间，已重置浏览器连接）"）
任何状态 ──后端退出（uvicorn 关闭）──▶ closed（被中止的任务 last_error / last_result.error = "服务关闭，任务被中止"）
```

| state | 含义 | busy | 能不能发新任务 | 建议显示 |
|---|---|---|---|---|
| `cancelling` | 已经发出取消，正在等任务真正停下 | true | 不能（`accepted:false`，见上） | 「正在取消…」 |
| `stuck` | 取消后 5 秒（配置 `cancel_grace_s`）还没停下，多半卡在没响应的页面上；后端已自动重置浏览器连接（断开 CDP、重启 Playwright 驱动），一般随即停下变成 `error` | true | 不能；可以再调一次 cancel（会再重置一次连接），还不行就重启后端 | 「取消卡住了，正在重置浏览器连接」（红色） |
| `closed` | 后端正在退出 / 已退出，点击器不再接任务 | false | 不能 | 「后端已关闭」 |

为什么要有 `cancelling`：取消时如果立刻把 `busy` 改成 false，页面里的操作可能还没停，下一个任务会和它交叉。所以 `busy` 一直是 true，直到任务真正停下。

### page_role（当前标签页的身份）

| 值 | 含义 |
|---|---|
| `host_lobby` | 房主，本局没开始（可以出题） |
| `setter` | 出题弹窗开着（我是出题人） |
| `setter_ingame` | 本局是我出的题，正在看别人猜 |
| `guesser` | 局内、有猜测搜索框 |
| `guest_lobby` | 非房主，本局没开始 |
| `observer` | 局内但没有搜索框（旁观） |
| `single` | 单人模式页 |
| `not_joined` | 还在「创建/加入房间」界面 |
| `unknown` | 读不出来 |

### strategy_used = 「路径/依据」

- 路径：`char_search`（直接搜角色，必要时点「更多」）| `subject`（先「搜作品」再在作品的主角/配角列表里找）
- 依据（凭什么认定这一项就是目标，可信度从高到低）：
  - `resp_id`：游戏自己的搜索请求响应里的 id，按顺序对上第 N 项
  - `react_key`：结果项的 React key（= 角色 id）。游戏对**重复关键词走本地缓存、不发请求**，这时就靠它
  - `img_id`：头像图片地址里带的 id
  - `text`：只按名字文字（没有任何 id 线索时才用，会有 warning；同名多个时拒绝点）
  - `planned`：只做了离线预测，没在页面里验证（仅 dry_run 可能出现）

## LocateResult（`last_result` / dry_run 的返回）

| 字段 | 说明 |
|---|---|
| `ok` | 成功与否 |
| `dry_run` | 是否只验证 |
| `mode` / `char_id` | 模式 / 目标 id |
| `path` / `keyword` / `keyword_label` | 用的路径、输入框里打的字、关键词来源（name 原名 / name+cn / cn / alias / ds_name / ds_name_jp / subject_cn / subject_name / work_hint） |
| `index` / `nth` | 目标在结果里的位置：0 基 / 1 基（「第 N 项」） |
| `more_clicks` | 点了几次「更多」 |
| `subject_id` / `subject_name` | 走作品路径时的作品 |
| `evidence` / `evidence_detail` | 依据（见上）/ 细节文字，例：「搜索响应第 3 项 id=37064（React key 一致）」 |
| `source` | `page` 在真实页面里找到 / `api` 只离线预测 / `none` 失败 |
| `clicked` / `verified` / `confirmed` | 点了没 / 点后按 id 核验通过没 / host 点了「确认」且弹窗关闭没 |
| `summary` | 给人看的一句话，例：「搜角色「爱丽丝」→ 第 24 项（点了 3 次「更多」）；依据：游戏搜索响应里的 id」 |
| `warnings` | 需要人注意但没失败的事 |
| `error` | 失败原因（中文，可直接展示） |
| `plan` | 离线规划出的候选路径（数组，按优先级排序），每项 `{path, keyword, keyword_label, index, more_clicks, subject_id, subject_name, subject_index, cost, note}` |
| `elapsed_ms` | 耗时 |

## POST /v2/autoclick/auto/start

```json
{ "mode": "host", "spec": { …方案… } }
```

- 每轮用方案抽一题；方案有没生效的部分、或者题库是空的，就不启动（`ok:false`）。
- 抽不出题时 `auto.waiting_for` =「抽题失败（方案为空？）」，每 3 秒再试。
- 响应：`{ "ok": true, "result": "auto_started" | "auto_already_running", "status": {…同 status…} }`；出错 `{ "ok": false, "error": "…" }`（HTTP 200）。
- 单次任务正在跑时启动会失败（`ok:false`）。

## POST /autoclick/auto/start

```json
{ "mode": "host", "config": { "mode": "char-weight", "seed": null, "blocks": [ … ], "include_extra_work_tags": false } }
```

- `config` 是经典工作台的方案（字段同 `POST /candidates` 里的 `config`）；每轮按它抽一题，种子逐轮加 1。不传 `config` 就没有方案可抽，自动模式照常启动但每轮抽题失败。
- 没有经典工作台数据时返回 HTTP 503（`GET /classic/status` 里有原因）。
- 响应和出错格式同 `POST /v2/autoclick/auto/start`。

## POST /autoclick/cancel

取消正在跑的单次任务或验证（不影响自动模式，自动模式用 `/autoclick/auto/stop`）。接口会**最多等 2 秒**看任务是不是真的停下了：

```json
{ "ok": true, "result": "cancelled" }
```

| result | 含义 | 之后的 status |
|---|---|---|
| `cancelled` | 任务已经按取消停下（绝大多数情况，几十毫秒） | `busy:false`、`state:"error"`、`last_error:"已取消"` |
| `cancelling` | 已发出取消，2 秒内还没停下 | `busy:true`、`state:"cancelling"`；继续轮询，5 秒后没停会变成 `stuck` |
| `stuck` | 取消后超过 5 秒还没停下，后端已自动重置浏览器连接（这次调用会再重置一次） | `busy:true`、`state:"stuck"`，停下后变 `error` |
| `no_task` | 没有在跑的任务（或者取消到达前任务刚好自己跑完了） | 不变 |

前端提示建议：`cancelled` →「已取消」；`cancelling` / `stuck` →「正在取消…」并继续轮询 status；`no_task` →「没有正在跑的任务」。
被取消的 `dry_run` 请求本身返回 HTTP 200 + `{ok:false, error:"已取消"}`（卡住过时 error 会说明）。

## POST /autoclick/auto/stop

响应：`{ "ok": true, "result": "auto_stopped" | "auto_not_running" }`

## GET /autoclick/probe

```json
{ "ok": true, "browser": "Chrome/153.0.…", "cdp": "127.0.0.1:9223", "connected": true,
  "pages": [{"url": "…", "title": "…"}], "matched_pages": [{"url": "…/multiplayer/…", "title": "…"}], "error": null }
```

`ok:false` 时 `error` 是连接错误原文；前端可提示「先运行 `scripts\launch-guessr-chrome.bat <房间URL>`」（macOS / Linux：`scripts/launch-guessr-chrome.sh <房间URL>`）。

`error_code`（`ok:true` 时为 null）：`refused` = 端口没人听（Chrome 没用调试端口启动）；`timeout` = 端口在但不回（Chrome 卡住）；`error` = 其他（例如端口上不是 Chrome）。

## 常见失败（`last_error` 原文，前端可直接展示）

| 情况 | 文案（节选） |
|---|---|
| Chrome 没用调试端口启动 | 连不上 Chrome 调试端口 127.0.0.1:9223。请先启动带调试端口的 Chrome（Windows：scripts\launch-guessr-chrome.bat；macOS / Linux：scripts/launch-guessr-chrome.sh）… |
| 标签页被 alert 卡死 | Chrome 里有标签页没有响应（多半弹着提示框没点掉）…请切到这些标签页点掉：<URL> |
| 没打开房间页 | Chrome 里没找到猜猜呗房间页（匹配规则：…）。当前打开的是：… |
| 还没进房 | 这个标签页还在「创建/加入房间」界面，先手动进房间 |
| 本局进行中想出题 | 本局还在进行中，等这一局结束后才能出题 |
| 不是房主 | 这个标签页不是房主，没法指定出题人… |
| 有人没准备 | 「有人想出题？」现在不可点：还有人没准备：<玩家名> |
| 网络慢 / 被墙 | 搜索请求 12 秒还没返回（网络慢，或 Bangumi 接口被墙…） |
| 真找不到 | 所有路径都没找到目标：<每条路径的原因> |
| 操作中 Chrome 被关掉 / 崩溃 / 调试连接断了 | 和 Chrome 的连接断了（浏览器被关掉 / 崩溃，或调试连接中断），已重置连接，下次操作会自动重连（会自动重试 1 次；Chrome 真没了时最后显示「连不上 Chrome 调试端口…」） |
| 操作中标签页被关掉 | 正在操作的标签页被关掉了（会自动重试 1 次，换一个标签页） |
| 被取消 | 已取消（取消后卡住过时：已取消（取消后卡住了一段时间，已重置浏览器连接）） |
| 后端退出时任务被中止 | 服务关闭，任务被中止（`state:"closed"`） |

## 前端怎么展示（参考 web/src/features/clicker）

- 顶部一条状态：`browser_ok`（Chrome 在不在）→ `page_role`（在哪个页面、什么身份）→ `state`（步骤条）。
- 当前目标卡片：`target.name_cn`（大）+ `target.name`（小）+ `char_id`。
- 结果：`last_result.summary` 一句话；`evidence` 用小徽章（resp_id / react_key 绿色，img_id 黄色，text / planned 灰色）；`warnings` 黄条；`error` 红条。
- 「验证」按钮 → `POST /autoclick/dry_run`，把 `summary` 和 `plan[0]` 展示出来。
- 日志：`logs` 按 level 着色，默认隐藏 `debug`。
- 「取消当前任务」按钮：`busy` 为 true 时显示；`state` 是 `cancelling` / `stuck` 时按钮显示「正在取消…」（仍可再点，`stuck` 时再点会再重置一次浏览器连接）。
  `state` 还有 `cancelling`（正在取消）、`stuck`（取消卡住了）、`closed`（后端已关闭）这 3 个取值。它们不在步骤条的 STEPS 里，前端用 `STATE_LABEL` 给它们单独的文案。
- 自动模式面板：`auto.round` / `auto.failed` / `auto.waiting_for` / `auto.last_char_name`。
