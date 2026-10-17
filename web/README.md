# 出题器前端（web/）

React 19 + Vite 6 + TypeScript + Tailwind 4，状态用 zustand，请求用 react-query。
后端是仓库根目录的 `backend/`（FastAPI），前端调它的 `/v2/*` 和 `/autoclick/*` 接口；经典工作台另外用 `/preview`、`/draw`、`/plans` 等接口，只在装了经典工作台数据时可用。
安装和日常使用见[根目录的 README](../README.md)，这里只写开发相关的内容。

## 开发时启动

```bash
# 仓库根目录：后端 8099
backend/venv/Scripts/python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8099   # Windows（setup-deps.bat 建的虚拟环境）
backend/venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8099           # macOS / Linux（setup-deps.sh 建的虚拟环境）

# web/：前端 5175
npm run dev          # http://127.0.0.1:5175
```

- **端口**：前端默认 5175（`vite.config.ts`），后端地址默认 `http://127.0.0.1:8099`（`src/lib/apiClient.ts`）。
  想换：在 `web/.env.development.local` 写 `WEB_PORT=xxxx` 和 `VITE_API_BASE=http://127.0.0.1:xxxx`（`*.local` 文件不进 git）。根目录的 `start-all.bat` / `start-all.sh` 也读这两项来决定后端端口和要打开的页面。
  也可以在「设置 → 后端地址」临时切换。
- **URL 参数**：`?theme=<主题id>&mode=light|dark&shell=sidebar|topbar|dock|split&density=compact|comfortable|spacious`（会记住；在界面上再切换就清掉）。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器（5175） |
| `npm run build` | 类型检查 + 生产构建到 `dist/`（有壁纸时会复制进 `dist/wallpapers/`，见 `../assets/wallpapers/README.md`） |
| `npm run preview` | 预览构建结果 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint（含 React 编译器规则） |
| `npm test` | Vitest |
| `node scripts/gen-base-tokens.mjs` | 改了 `src/styles/tokens.base.css` 后，重新生成 base 主题模板 |
| `node scripts/gen-token-table.mjs` | 生成主题 token 表 |

后端测试在仓库根目录跑，用上面那个虚拟环境里的 python。第一次要先装测试依赖（比运行时多一个 httpx）：

```bash
python -m pip install -r backend/requirements-dev.txt
python -m unittest discover -s backend/v2/tests -t .
```

## 页面

| 路由 | 页面 |
|---|---|
| `/` | **工作台**：一句话让 AI 填 → 对局设置（模式、作品标签数）→ 纳入范围（从哪来 / 取角色 / 再筛，范围之间是「或」）→ 排除（永远最后生效）→ 题库人数 + 抽一题（机会均等 / 先抽作品 / 按范围占比、种子）→ 抽到的人 + 设为当前；撤销 / 重做；保存 / 另存为 / 打开 / 新建 |
| `/pool` | **候选池**：工作台当前方案圈到的全部角色；卡片 / 列表 / 统计三种看法；作品标签按模式分栏（规则在 `src/lib/tagRules.json`，动画模式按标签分档）；挑一个设为当前题目 |
| `/ask` | **问数据**：一句话问 → AI 写 SQL，在只读库上跑；解释、统计范围、SQL 原文（可改了重跑）、结果表；存为清单 / 存为条件；表结构参考 |
| `/lists` | **清单**：角色 / 作品 / 标签清单增删改；一个一个加（自动补全）或粘贴一批（名字或 id，对不上的列出来）；被哪些方案用到 |
| `/classic` | **经典工作台**：按顺序组块（从上到下依次纳入 / 排除）圈题库；方案存在 `data/plans/`，和工作台的方案分开。需要经典工作台数据，没有时入口隐藏 |
| `/candidates` | **经典候选池**：经典工作台方案的全部候选、统计、设为当前题目（同样需要经典工作台数据） |
| `/plans` | **方案库**：工作台的方案（存在 `data/plans_v2/`）；有经典工作台数据时多一个「经典方案」标签页（`data/plans/`），可以载入样例方案 |
| `/canvas` | **导图导出**：把工作台当前圈到的角色导出成 Obsidian `.canvas`；有经典工作台数据时也可以导出经典工作台的筛选结果 |
| `/solo` | **单人猜猜呗**：用工作台或已保存的方案出题，在本地直接猜 |
| `/clicker` | **自动点击**：当前题目 + 发到猜猜呗 / 只定位不点击、连接状态、自动模式（房主出题，按工作台的方案抽题；有经典工作台数据时也可以按经典工作台的方案抽题）、日志 |
| `/data` | **数据**：数据库版本、构建时间、各表数据量；经典工作台数据是否已装 |
| `/settings` | **设置**：后端地址、主题 / 明暗 / 布局 / 密度 / 动效、头像、标签分档、自动预览人数、缓存与重置 |
| `/themes` | **主题**：主题画廊 + `/themes/compare?a=&b=&page=` 分屏对比 |
| 全局 | Ctrl/⌘+K 命令面板；页面一角始终显示「当前题目」 |

## 代码结构

| 路径 | 内容 |
|---|---|
| `src/app/` | 路由、外壳布局（侧栏 / 顶栏 / 停靠 / 分栏）、命令面板 |
| `src/pages/` | 每个页面一个目录 |
| `src/features/` | 按业务分的模块：接口、状态、组件（`workbench2`、`v2`、`tiers`、`tagnote`、`clicker`、`solo` …）。`v2/` 是后端 `/v2/*` 接口的前端封装 |
| `src/lib/` | 通用工具：请求、标签规则、壁纸清单、图标 |
| `src/themes/` | 主题：`base`「基础」（也是写新主题的模板）、`moonlit`「月夜·萤火」、`preview`「预览」 |
| `src/vendor/tagnote/` | 导图引擎的副本，由 `../tagnote/build.py` 生成，不要手改 |
