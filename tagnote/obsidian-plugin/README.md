# TagNote 标签笔记 · Obsidian 插件

打开 frontmatter 里有 `tagnote: 1` 的笔记时，直接显示六种可切换的图（分支画布、标签谱、卡诺图、增减阶梯、领地图、谱系）。
笔记由 `backend/v2/tagnote_note.py` 生成。

## 安装

1. 在本目录执行 `npm i`，再执行 `npm run build`，生成 `main.js`。
2. 把 `main.js`、`manifest.json`、`styles.css` 复制到 `<库>/.obsidian/plugins/tagnote/`。
3. 在 Obsidian 的「设置 → 第三方插件」里启用「TagNote 标签笔记」。
   也可以用命令行：`Obsidian.com vault=<库名> plugin:enable id=tagnote filter=community`。
   如果 Obsidian 开着时才放进插件文件夹，命令行会报「not found」，要先让 Obsidian 重新扫描插件：
   `Obsidian.com vault=<库名> eval code="app.plugins.loadManifests().then(()=>null); 1"`。

## 开发

- `npm run dev`：监听改动，自动重新生成 `main.js`（不压缩，带 source map）。
- `npm run build`：先做 TypeScript 类型检查（`tsc -noEmit`），再生成压缩版 `main.js`。
- `npm run typecheck`：只做类型检查。
- 引擎在 `vendor/tagnote.esm.js`，由 `../build.py` 生成并复制过来。**不要手改 vendor/**；引擎要改就改 `../src/`，再跑 `python ../build.py`。
- 代码只有 `main.ts`（插件）和 `styles.css`（把 Obsidian 主题变量映射成引擎的 `--tn-*` 变量）。

## 用法

- 打开标签笔记：直接显示六种视图，不会先闪一下 Markdown。
- 看原文：标题栏右上角「以 Markdown 查看」，或命令「在标签笔记视图和 Markdown 之间切换」。
  在 Markdown 视图里，标题栏有「以六种视图查看」按钮可以切回。
  在某个面板里选了 Markdown 后，这个面板再打开同一篇仍是 Markdown；面板换过别的笔记、或在别的面板打开时，照常显示六种视图。
- 设置里的「自动打开六视图」关掉后，标签笔记按 Markdown 打开，用上面的按钮或命令切换。
- 双击作品名（或 Ctrl/⌘ + 单击）：库里有这部作品的笔记 → 在新标签页打开；没有笔记但有 Bangumi 编号 → 打开 bgm.tv 条目页；两样都没有 → 提示「这部作品没有链接」。不会新建笔记。
- 普通笔记里的 ```` ```tagnote ```` 代码块显示成一张卡片：「标签笔记 · 标题 · N 部作品」和「打开六种视图」按钮。
- 插件只读：不会改写笔记。封面、配色、侧栏是所有笔记共用的设置；每篇笔记记住上次看的视图（存在插件的 data.json 里，改名、删除会跟着更新）。

## 调试

建议用一个单独的测试库，不要在日常使用的库里试。测试库里放几篇示例笔记、坏数据笔记，和带 ```` ```tagnote ```` 代码块的普通笔记。

- 改完代码：`npm run build`（或开着 `npm run dev`），把 `main.js`、`manifest.json`、`styles.css` 复制到测试库的 `.obsidian/plugins/tagnote/`。
- 重新加载：在「设置 → 第三方插件」里把插件关掉再打开，Obsidian 会重新读取 `main.js`。
- 看报错：Obsidian 的开发者工具控制台（Windows / Linux 按 Ctrl+Shift+I，macOS 按 Cmd+Option+I）。
- 需要自动化调试时，可以用 `--remote-debugging-port=<端口>` 启动 Obsidian，再通过 Chrome DevTools 协议连接。

## 已知限制

- 手机端没有在真机上测过。只在桌面版 Obsidian 的手机模拟（`app.emulateMobile(true)`，390×844）里测过：能打开，六种视图都有内容，画板能横向滚动，页面能竖向滚动。代码里没有用只在桌面端才有的接口（`isDesktopOnly: false`）。
- 引擎的 Esc（取消固定高亮、退出全屏）监听在 document 上：按 Esc 时，所有开着的标签笔记面板都会取消各自的固定高亮；有一个面板在全屏时，这次 Esc 只作用于它（先取消固定，再按一次退出全屏）。
- 在 Markdown 视图里看过的笔记，如果原文是 CRLF 换行，切走时 Obsidian 自己会把它存成 LF（内容不变）。这是 Obsidian 的行为，与插件无关。
