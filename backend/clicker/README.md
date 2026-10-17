# backend/clicker —— 猜猜呗自动点击器

把出题器抽到的任意 Bangumi 角色，准确点进「猜猜呗」（anime-character-guessr）游戏：
房主出题（host）、后端常驻自动循环（auto）、只定位不点击（dry_run）。只做出题方。
**核心原则：按角色 id 定位和核验，不按名字猜。** 重名角色、重名作品、同一作品里的重名角色都靠 id 区分。

- 给前端的接口说明：[API.md](API.md)

## 怎么用

1. 起带调试端口的 Chrome 并打开房间：
   ```bat
   scripts\launch-guessr-chrome.bat https://anime-character-guessr.netlify.app/multiplayer/<房间号>
   ```
   端口默认 9223、用户目录 `%LOCALAPPDATA%\outsetter\chrome-debug-profile`（Chrome 136+ 不允许在默认用户目录开调试端口）。
   macOS / Linux 用 `bash scripts/launch-guessr-chrome.sh <房间URL>`，参数和用户目录的含义一样。
   端口上已有调试版 Chrome 时，脚本只会在里面新开一个标签页。
2. 在这个 Chrome 里手动进房（输名字 → 创建 / 加入）。
3. 起后端：Windows 用 `backend\venv\Scripts\python.exe -m uvicorn backend.app:app --port 8099`（`start-all.bat` 也行）；macOS / Linux 用 `backend/venv/bin/python -m uvicorn backend.app:app --port 8099`（`start-all.sh` 也行）。
4. 前端调 `POST /autoclick/once` / `/v2/autoclick/auto/start`，或者先 `POST /autoclick/dry_run` 验证。

## 文件

| 文件 | 干什么 |
|---|---|
| `service.py` | `ClickerService`：对外 API、状态机、日志（最近 200 条）、单次任务 / 自动模式调度、自带事件循环线程 |
| `flows.py` | 业务流程：host 开弹窗 → 定位 → 点 → 核验 → 确认；auto 循环 |
| `locate.py` | 定位核心：离线规划（选关键词 / 选路径）、响应监听、页面搜索框操作、「这一项是不是目标」的识别 |
| `browser.py` | 连 Chrome（CDP）、按页面状态给标签页打分选页、断线重连、卡死标签页体检、统一接住游戏 alert |
| `bgm.py` | Bangumi 公开 API 小客户端（标准库 http.client 长连接池 + 缓存 + 重试）、图片 URL 取 id 的正则 |
| `js.py` | 注入页面的只读脚本（读 DOM 和 React fiber，不改页面） |
| `models.py` | pydantic 模型：状态、日志、请求体、LocateResult |
| `selftest.py` | 离线自检：`backend\venv\Scripts\python.exe -m backend.clicker.selftest`（macOS / Linux：`backend/venv/bin/python -m backend.clicker.selftest`） |

## 定位是怎么做的（为什么鲁棒）

1. **离线规划**（`locate.Planner`）：先用和游戏**完全相同**的请求参数问 Bangumi：
   目标在「原名」「原名 中文名」「中文名」「别名」「本地库名字」这些关键词的搜索结果里各排第几？
   - 绝大多数角色原名就在前 10，只发 1 个请求就结束。
   - 常见短名（レイ / アリス / 田中，结果 1000 条封顶）会并发往深处翻，同时算「先搜作品」路径；
     挑「要点『更多』次数最少」的方案。例：169858 原名「アリス」在第 80 项，换成「爱丽丝」只在第 24 项。
   - 直接搜要点 3 次以上「更多」时，优先考虑「搜作品 → 按作品 id 点作品 → 在主角/配角列表里按角色 id 找」。
2. **页面里按 id 找**（`locate.PageSearch`），依据按可信度：
   `resp_id`（监听游戏自己的搜索响应，id 顺序 = 页面顺序）→ `react_key`（结果项的 React key 就是 id）
   → `img_id`（头像 URL 里的 id）→ `text`（只在页面上完全没有 id 线索时才按名字，重名则拒绝点）。
   游戏的 cached-axios 对**重复关键词不发请求**，这时 `resp_id` 拿不到，`react_key` 顶上。
3. **点之前再核验一次**：要点的那个元素的 key/图片还是不是目标（防止列表刚好刷新导致点错）。
4. **点之后核验**：看出题弹窗里选中的头像 id / 选中 state。

## 配置（`backend/config.json` 的 `autoclick`，全部可选）

| 键 | 默认 | 说明 |
|---|---|---|
| `cdp_port` | 9223 | Chrome 调试端口 |
| `cdp_host` | 127.0.0.1 | 故意不用 localhost（会先解析成 ::1，Chrome 只听 127.0.0.1） |
| `url_pattern` | — | 单个房间页规则（写法同 `url_patterns`），会排在默认规则前面 |
| `url_patterns` | 见下 | 房间页规则列表；默认已含 netlify 线上、localhost:5173、127.0.0.1:5173（本地运行上游项目时 vite 的默认端口）、ccb.baka.website、ccbeta.baka.website 的 `/multiplayer/`。每条写成 `主机[:端口][/路径前缀]`，前面可以加 `http://` 或 `https://`（不加 = 两种都行）。标签页的协议、主机、端口都要对上，路径以前缀开头，才算房间页；不是在整条地址里找子串，也必须写主机。没写端口 = 默认端口（80 / 443），本机开发地址要带上端口 |
| `max_more_clicks` | 40 | 「更多」最多点几次（40 次 = 第 210 条） |
| `prefer_subject_after` | 3 | 直接搜要点超过几次「更多」时，优先考虑作品路径 |
| `search_timeout_s` / `subject_timeout_s` / `confirm_timeout_s` | 12 / 25 / 25 | 各步等待上限 |
| `idle_disconnect_s` | 0 | 空闲多久断开 CDP；0 = 一直连着（推荐，原因见下） |
| `bring_to_front` | true | 操作前把标签页切到前台（后台标签页的定时器会被节流） |
| `cancel_grace_s` | 5 | 取消后等多久；还没停下就进入 `stuck` 并自动重置浏览器连接 |
| `bgm_api_base` | https://api.bgm.tv | 离线规划用的 API |

## 几个设计决定（及原因）

- **自己开事件循环线程**：Playwright 需要起子进程，Windows 上只有 Proactor 循环支持；uvicorn 开 `--reload` 时会换成 Selector 循环。
  所以点击器在 `clicker-loop` 线程里跑自己的 Proactor 循环，用的是 Playwright **async** API，FastAPI 侧只投递任务。
- **常驻连接 + 统一接住 alert**：连着 CDP 时，游戏房间页的 `alert()` 会被接住、写进日志、自动点确定；
  别的标签页（不符合房间页规则的）弹出的提示框不会被点，留在 Chrome 里由你自己处理，日志里只提示一句是哪个站点弹的。
  如果断开期间游戏弹了 alert（例如房间 5 分钟没开局被服务器关闭），那个标签页会卡死，下次连接直接超时。
  连接超时时会用标准库手写的最小 WebSocket 逐个标签页体检，把卡死的 URL 报给用户。
- **不信 fiber 指针本身**：DOM 上的 `__reactFiber$` 可能指向双缓冲的旧树，读到的 props 是旧的（例如：玩家已取消准备，读到的仍是已准备）。
  `js.py` 会先找到当前树；并且「出题模式开没开」「选中了谁」优先看 DOM（按钮 active 类、选中头像 URL）。
- **遮罩**：网络差时游戏会弹 z-index 9999 的「网络提示」，盖住「确认」。流程开始和点击被挡时会先关掉它（设置弹窗不动），并记 warn 日志。
- **取消要等真正停下**：对 `run_coroutine_threadsafe` 返回的 Future 调 `cancel()` 会让它立刻变成 done，
  但 clicker-loop 里的协程可能还卡在 Playwright 调用里。所以「任务结束」只看协程 finally 里 set 的事件（`service._TaskCtl.done`）；
  取消时 `busy` 保持 true、`state=cancelling`；5 秒没停下 → `stuck` + 自动重置浏览器连接（卡住的调用立刻失败）；上一个协程停下之前拒绝一切新任务。
- **断线判定不靠异常文字**：按 Playwright 异常类型（`TargetClosedError` / `TimeoutError`）+ `Browser.is_connected()`
  + Playwright 驱动进程是否还活着判断；读页面状态返回结构化结果（`browser.ProbeResult`：timeout / page_closed / disconnected / error）；
  所有断线统一走 `BrowserManager.reset()`（显式重连路径：丢掉旧 Browser 引用，驱动死了连驱动一起重启），下次操作自动重连。异常文字只做兜底。
- **关服顺序**：停自动模式 → 中止并等待单次任务（落到 `state=closed`）→ 断开 Chrome、停驱动 → 取消 loop 里剩下的 Task → 停 loop。
  不会关掉用户的 Chrome（CDP 连接的 close 只是断开）。

## 开发 / 测试

- 离线自检：`python -m backend.clicker.selftest`（不需要浏览器和网络；覆盖定位、关服、取消语义、断线判定等）。
- 要在真实页面上测试，可以在本地运行上游的猜猜呗项目（`server` 目录 `node server.js`，`client` 目录 `npx vite`），
  再用上面的脚本开带调试端口的 Chrome，并确认 `url_patterns` 里有对应的本机地址。

## 已知限制

- 依赖游戏的 DOM 类名（`.search-result-item` 等）和 React 内部结构（fiber key）。猜猜呗大改版时 `js.py` 需要跟着改；
  即使 fiber 读不到，仍有「响应 id」和「图片 id」两层兜底。
- 离线规划依赖本机能访问 `api.bgm.tv`；访问不了时退化为「页面里逐页按 id 翻找」（更慢，但仍按 id）。
- 「搜作品」结果只有 10 条且没有「更多」：作品名太常见、目标作品不在前 10 时，这条路径不可用（会换关键词或回到直接搜）。
- 游戏规定出题需要房间里至少 2 人且其他人都已准备；自动 host 会一直等，`auto.waiting_for` 会写明在等什么。
- 连着 CDP 时游戏自己的 alert 会被自动点掉（内容进日志）；想看原生弹窗，把 `idle_disconnect_s` 设成正数。
