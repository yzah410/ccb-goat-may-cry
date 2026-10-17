/*! TagNote —— 作品标签笔记图引擎（六种视图 + 悬停交互）
 *  用法：TagNote.mount(元素, 作品集JSON, 选项) → 实例
 *  无依赖；渲染在 Shadow DOM 里；需要浏览器环境（布局靠测量真实字宽）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TagNote = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';
const VERSION = '1.1.0';
const CSS_TEXT = "/* TagNote 引擎样式 —— 运行在 Shadow DOM 里，与宿主页面（出题器 / Obsidian）互不干扰。\n   宿主可在挂载元素上覆盖下列 --tn-* 变量来适配自己的风格（外部样式优先于 :host）。 */\n:host{\n  --tn-paper:   oklch(0.972 0.006 240);   /* 画板外的底色 */\n  --tn-paper-2: oklch(0.955 0.009 240);   /* 画板底色 */\n  --tn-dot:     oklch(0.86 0.014 245);    /* 画板点阵 */\n  --tn-card:    oklch(0.995 0.003 240);   /* 卡片 */\n  --tn-ink:     oklch(0.26 0.035 262);    /* 主文字 */\n  --tn-ink-2:   oklch(0.46 0.03 258);     /* 次文字 */\n  --tn-ink-3:   oklch(0.6 0.022 255);     /* 弱文字 */\n  --tn-line:    oklch(0.885 0.014 245);\n  --tn-line-2:  oklch(0.77 0.02 250);\n  --tn-accent:  oklch(0.5 0.17 264);      /* 钢笔蓝：焦点、悬停 */\n  --tn-accent-2:oklch(0.93 0.04 264);\n  --tn-edge:    oklch(0.68 0.035 255);    /* 连线 */\n  --tn-hlL: 0.885; --tn-hlC: 0.1;         /* 荧光笔底色：亮度 / 彩度（色相来自每个标签的 --h） */\n  --tn-tgL: 0.33;  --tn-tgC: 0.11;        /* 荧光笔上的字色 */\n  --tn-lnL: 0.6;   --tn-lnC: 0.14;        /* 领地线、反向标签描边 */\n  --tn-shadow: 0 1px 0 oklch(0.86 0.016 250), 0 6px 14px -10px oklch(0.35 0.06 262 / .35);\n  --tn-f-display: \"Noto Serif SC\", \"Noto Serif CJK SC\", \"Source Han Serif SC\", \"Songti SC\", \"STSong\", \"SimSun\", serif;\n  --tn-f-body: \"Noto Sans SC\", \"Noto Sans CJK SC\", \"Source Han Sans SC\", \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", system-ui, sans-serif;\n  --tn-f-mono: \"IBM Plex Mono\", ui-monospace, \"SFMono-Regular\", Menlo, Consolas, monospace;\n  --tn-sticky-top: 0px;                   /* 侧栏吸顶时距滚动区域顶部的距离（宿主自己有吸顶栏时设成它的高度） */\n  --tn-z: 1;                              /* 字号倍率（由引擎设置） */\n  display: block; position: relative;\n  color: var(--tn-ink); font-family: var(--tn-f-body); font-size: 15px; line-height: 1.6;\n}\n@media (prefers-color-scheme: dark){ :host(:not([data-theme=\"light\"])){\n  --tn-paper: oklch(0.205 0.014 258); --tn-paper-2: oklch(0.185 0.013 258); --tn-dot: oklch(0.33 0.018 258);\n  --tn-card: oklch(0.25 0.017 258); --tn-ink: oklch(0.94 0.01 250); --tn-ink-2: oklch(0.78 0.018 252); --tn-ink-3: oklch(0.64 0.02 252);\n  --tn-line: oklch(0.33 0.018 258); --tn-line-2: oklch(0.45 0.022 256); --tn-accent: oklch(0.8 0.12 256); --tn-accent-2: oklch(0.33 0.07 262);\n  --tn-edge: oklch(0.52 0.03 255); --tn-hlL: 0.43; --tn-hlC: 0.095; --tn-tgL: 0.95; --tn-tgC: 0.04; --tn-lnL: 0.74; --tn-lnC: 0.13;\n  --tn-shadow: 0 1px 0 oklch(0.3 0.02 258), 0 8px 18px -10px oklch(0 0 0 / .7);\n  color-scheme: dark; } }\n:host([data-theme=\"dark\"]){\n  --tn-paper: oklch(0.205 0.014 258); --tn-paper-2: oklch(0.185 0.013 258); --tn-dot: oklch(0.33 0.018 258);\n  --tn-card: oklch(0.25 0.017 258); --tn-ink: oklch(0.94 0.01 250); --tn-ink-2: oklch(0.78 0.018 252); --tn-ink-3: oklch(0.64 0.02 252);\n  --tn-line: oklch(0.33 0.018 258); --tn-line-2: oklch(0.45 0.022 256); --tn-accent: oklch(0.8 0.12 256); --tn-accent-2: oklch(0.33 0.07 262);\n  --tn-edge: oklch(0.52 0.03 255); --tn-hlL: 0.43; --tn-hlC: 0.095; --tn-tgL: 0.95; --tn-tgC: 0.04; --tn-lnL: 0.74; --tn-lnC: 0.13;\n  --tn-shadow: 0 1px 0 oklch(0.3 0.02 258), 0 8px 18px -10px oklch(0 0 0 / .7);\n  color-scheme: dark; }\n:host(.tn-mono){ --tn-hlC: 0; --tn-tgC: 0; --tn-lnC: 0; }\n\n*{ box-sizing: border-box }\n[hidden]{ display: none !important }\nbutton{ font: inherit; color: inherit; appearance: none; -webkit-appearance: none; background: none; border: 0; box-shadow: none; margin: 0; height: auto; min-height: 0; cursor: pointer; }\n:focus-visible{ outline: 2px solid var(--tn-accent); outline-offset: 2px; border-radius: 4px }\nimg{ max-width: 100% }\n\n/* ---------- 顶栏：视图切换 + 显示设置 ---------- */\n/* 顶栏不吸顶：看图时它不该压在图上；想切视图就滑回顶部 */\n.bar{ position: relative; z-index: 30; display:flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 6px 16px; border-bottom: 1px solid var(--tn-line); }\n.tabs{ display:flex; gap: 2px; overflow-x: auto; scrollbar-width: thin; min-width: 0; padding-top: 6px }\n.tab{ padding: 7px 14px 9px; white-space: nowrap; color: var(--tn-ink-2); font-size: 15.5px; font-weight: 500; border-bottom: 2.5px solid transparent; border-radius: 0; }\n.tab .no{ font-family: var(--tn-f-mono); font-size: 12px; color: var(--tn-ink-3); margin-right: 6px }\n.tab:hover{ color: var(--tn-ink) }\n.tab[aria-selected=\"true\"]{ color: var(--tn-ink); border-bottom-color: var(--tn-accent) }\n.tab[aria-selected=\"true\"] .no{ color: var(--tn-accent) }\n.tools{ display:flex; flex-wrap: wrap; gap: 6px; align-items: center; padding-block: 6px }\n.ctl{ display:inline-flex; align-items:center; gap: 2px; border: 1px solid var(--tn-line); background: var(--tn-card); border-radius: 999px; padding: 2px; }\n.ctl > span{ font-size: 12.5px; color: var(--tn-ink-3); padding: 0 5px 0 9px }\n.ctl button{ border-radius: 999px; padding: 2px 10px; font-size: 13.5px; color: var(--tn-ink-2) }\n.ctl button[aria-pressed=\"true\"]{ background: var(--tn-ink); color: var(--tn-paper) }\n.ctl button:hover{ color: var(--tn-ink) }\n.ctl button[aria-pressed=\"true\"]:hover{ color: var(--tn-paper) }\n.drawer-btn{ display:inline-flex; align-items:center; gap: 6px; border: 1px solid var(--tn-line-2); background: var(--tn-card); border-radius: 999px; padding: 3px 12px 3px 10px; font-size: 13.5px; color: var(--tn-ink-2) }\n.drawer-btn:hover{ color: var(--tn-ink); border-color: var(--tn-ink-3) }\n.drawer-btn[aria-expanded=\"true\"]{ background: var(--tn-ink); color: var(--tn-paper); border-color: var(--tn-ink) }\n.drawer-btn .ar{ font-family: var(--tn-f-mono); font-size: 12px }\n.full-btn{ display:inline-flex; align-items:center; gap: 6px; border: 1px solid var(--tn-line-2); background: var(--tn-card); border-radius: 999px; padding: 3px 12px 3px 10px; font-size: 13.5px; color: var(--tn-ink-2) }\n.full-btn:hover{ color: var(--tn-ink); border-color: var(--tn-ink-3) }\n.full-btn svg{ width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round }\n\n.root{ container: tn / inline-size }\n/* 全屏：浏览器全屏（:fullscreen）或宿主不让全屏时铺满窗口（.overlay）。.root 自己滚动，侧栏贴着它的顶 */\n.root.full{ background: var(--tn-paper); overflow: auto; overscroll-behavior: contain; padding: 0 24px 24px; }\n.root.full.overlay{ position: fixed; inset: 0; z-index: 2147483000; }\n.root.full .drawer{ top: 12px; max-height: calc(100vh - 24px); margin-bottom: -64px; }\n\n/* ---------- 主体：视图 + 可收起的侧栏 ---------- */\n.frame{ display:grid; grid-template-columns: minmax(0,1fr) auto; gap: 0 18px; align-items: start; padding-block: 16px 40px }\n.main{ min-width: 0 }\n.vhead{ display:flex; flex-wrap: wrap; align-items: baseline; gap: 4px 18px; margin-bottom: 12px }\n.vhead h2{ font-family: var(--tn-f-display); font-weight: 900; font-size: 26px; margin: 0; letter-spacing: .03em }\n.vhead h2 .no{ font-family: var(--tn-f-mono); font-weight: 500; font-size: 15px; color: var(--tn-accent); margin-right: 10px; vertical-align: 3px }\n.vhead .howto{ color: var(--tn-ink-2); margin: 0; max-width: 78ch; font-size: 15px }\n.board-wrap{ overflow: auto; border: 1px solid var(--tn-line); border-radius: 14px; background-color: var(--tn-paper-2);\n  background-image: radial-gradient(circle, var(--tn-dot) 1.1px, transparent 1.4px); background-size: 22px 22px; padding: 30px 22px 34px; position: relative; }\n.board{ position: relative; margin: 0 auto; }\n.board > svg.edges{ position:absolute; left:0; top:0; overflow: visible; pointer-events: none }\n.board > .layer{ position:absolute; left:0; top:0; width: 100%; height: 100% }\n.board.flow > .layer{ position: static }\n.wait{ padding: 24px; color: var(--tn-ink-3) }\n\n/* 侧栏：标签索引 + 当前悬停的读数 */\n.drawer{ position: sticky; top: calc(var(--tn-sticky-top) + 12px); width: var(--tn-drawer-w, 248px);\n  max-height: var(--tn-drawer-max, calc(100vh - var(--tn-sticky-top) - 24px));\n  display:flex; flex-direction: column; overflow: hidden;\n  background: var(--tn-card); border: 1px solid var(--tn-line); border-radius: 14px; padding: 12px 12px 6px; box-shadow: var(--tn-shadow);\n  /* 吸顶元素不能越过所在格子的下沿：滚到底时，侧栏会被往上推、钻到顶栏下面。\n     负的下外边距让它可以伸进下面的空白：本框架的下内边距 40px，加上宿主声明的、引擎下方的空白 --tn-space-below。 */\n  margin-bottom: calc(-40px - var(--tn-space-below, 0px)); }\n/* 读数区高度由引擎按“最高的那条读数”固定下来；标签列表单独滚动。悬停时列表不会移动。 */\n.dr-list{ flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-gutter: stable; margin-right: -6px; padding: 0 6px 8px 0 }\n.dr-h{ flex: none; display:flex; align-items:center; justify-content: space-between; margin-bottom: 8px }\n.dr-h b{ font-family: var(--tn-f-display); font-weight: 900; font-size: 16px; letter-spacing: .04em }\n.dr-x{ font-size: 12.5px; color: var(--tn-ink-3); padding: 2px 6px; border-radius: 6px }\n.dr-x:hover{ color: var(--tn-ink); background: var(--tn-paper-2) }\n.now{ flex: none; border-radius: 10px; background: var(--tn-paper-2); padding: 9px 10px 10px; margin-bottom: 4px; min-height: 64px; font-size: 13.5px; color: var(--tn-ink-2);\n  overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-gutter: stable; }\n.now .hint{ color: var(--tn-ink-3); font-size: 13px; line-height: 1.55 }\n.now .k{ display:flex; align-items:center; gap: 6px; flex-wrap: wrap; font-size: 15px; color: var(--tn-ink); font-weight: 700; margin-bottom: 6px }\n.now .k .n{ font-family: var(--tn-f-mono); font-weight: 500; font-size: 12.5px; color: var(--tn-ink-3) }\n.now .pin{ font-size: 11.5px; font-weight: 500; color: var(--tn-accent); border: 1px solid currentColor; border-radius: 999px; padding: 0 6px }\n.now h5{ margin: 8px 0 3px; font-size: 11.5px; letter-spacing: .12em; color: var(--tn-ink-3); font-weight: 500 }\n.now ul{ list-style: none; margin: 0; padding: 0; display:flex; flex-direction: column; gap: 5px }\n.now li{ display:flex; flex-direction: column; gap: 2px; line-height: 1.35 }\n.now li .t{ color: var(--tn-ink); font-weight: 500; font-size: 13.5px }\n.now li .d{ display:flex; flex-wrap: wrap; gap: 3px }\n.now li .d .tg{ font-size: 12.5px }\n.now .names{ display:flex; flex-wrap: wrap; gap: 3px 10px; font-size: 13px; color: var(--tn-ink-2) }\n.dr-grp{ margin-top: 10px }\n.dr-grp:first-child{ margin-top: 8px }\n.dr-grp h4{ margin: 0 0 4px; font-size: 11.5px; letter-spacing: .14em; color: var(--tn-ink-3); font-weight: 500 }\n.dr-row{ display:flex; align-items:center; gap: 6px; padding: 2px 0 }\n.dr-row .tg{ font-size: 14px }\n.dr-row .n{ font-family: var(--tn-f-mono); font-size: 12px; color: var(--tn-ink-3); min-width: 1.6em }\n.dr-row .nx{ margin-left: auto; font-size: 12.5px; color: var(--tn-ink-3); border: 1px solid var(--tn-line); border-radius: 6px; padding: 0 7px; cursor: default; white-space: nowrap }\n.dr-row .nx:hover, .dr-row .nx.on{ color: var(--tn-ink); border-color: var(--tn-ink-3); background: var(--tn-paper-2) }\n\n/* ---------- 标签 ---------- */\n.tg{ display:inline-flex; align-items:center; white-space: nowrap; font-size: calc(14.5px * var(--tn-z)); line-height: 1.45; padding: 0 .42em; font-weight: 500; cursor: default; border-radius: 3px 7px 4px 6px / 6px 3px 7px 4px; transition: box-shadow .15s, opacity .15s; }\n.tg.hi{ background: oklch(var(--tn-hlL) var(--tn-hlC) var(--h, 250)); color: oklch(var(--tn-tgL) var(--tn-tgC) var(--h, 250)); }\n.tg.st{ color: var(--tn-ink-2); box-shadow: inset 0 0 0 1px var(--tn-line-2); border-radius: 4px; font-size: calc(13.5px * var(--tn-z)); font-weight: 500 }\n.tg.lo{ color: var(--tn-ink-2); border: 1px dashed var(--tn-line-2); border-radius: 4px; font-size: calc(13px * var(--tn-z)); font-style: italic; font-weight: 400 }\n.work .tg.lo::before, .hnode .tg.lo::before, .ltags .tg.lo::before, .dr-row .tg.lo::before{ content: \"低频·\"; font-style: normal; color: var(--tn-ink-3); font-size: .82em; }\n.tg.hi.gh{ background: transparent; color: var(--tn-ink-2); box-shadow: inset 0 -0.34em 0 oklch(var(--tn-hlL) var(--tn-hlC) var(--h, 250)); border-radius: 0; padding: 0 .12em; margin: 0 .18em; font-weight: 400 }\n.tg.st.gh{ opacity: .62 }\n.tg.neg{ background: transparent; color: var(--tn-ink-2); box-shadow: inset 0 0 0 1px oklch(var(--tn-lnL) var(--tn-lnC) var(--h, 250) / .55); border-radius: 4px; }\n.tg.neg::before{ content: \"非\"; color: var(--tn-ink-3); font-weight: 400; margin-right: .08em }\n.tg.neg.st{ box-shadow: inset 0 0 0 1px var(--tn-line-2) }\n.tg.plus::before{ content: \"+\"; font-family: var(--tn-f-mono); font-weight: 600; margin-right: .1em; opacity: .75 }\n.tg.minus{ background: transparent; color: var(--tn-ink-2); box-shadow: inset 0 0 0 1px oklch(var(--tn-lnL) var(--tn-lnC) var(--h, 250) / .6); border-radius: 4px; text-decoration: line-through; text-decoration-color: oklch(var(--tn-lnL) var(--tn-lnC) var(--h, 250)); text-decoration-thickness: 1.5px }\n.tg.minus::before{ content: \"−\"; font-family: var(--tn-f-mono); font-weight: 600; margin-right: .12em; text-decoration: none; display:inline-block }\n.tg.minus.st{ box-shadow: inset 0 0 0 1px var(--tn-line-2); text-decoration-color: var(--tn-ink-3) }\n.swap{ display:inline-flex; align-items:center; gap: 2px; font-size: calc(13px * var(--tn-z)); color: var(--tn-ink-3) }\n.tg.on, .dr-row .tg:hover{ box-shadow: 0 0 0 2px var(--tn-accent); }\n.tg.hi.gh.on{ box-shadow: inset 0 -0.34em 0 oklch(var(--tn-hlL) var(--tn-hlC) var(--h, 250)), 0 0 0 2px var(--tn-accent) }\n.none{ color: var(--tn-ink-3); font-size: calc(13.5px * var(--tn-z)); font-style: italic }\n\n/* ---------- 作品卡片 ---------- */\n.work{ position: absolute; display: grid; grid-template-columns: auto minmax(0,1fr); column-gap: 10px; align-items: start;\n  background: var(--tn-card); border: 1px solid var(--tn-line); border-radius: 10px; padding: 8px 11px 9px 8px; box-shadow: var(--tn-shadow); transition: opacity .18s, box-shadow .18s; }\n.work .cv{ grid-row: 1 / span 2; width: calc(40px * var(--tn-z)); height: calc(56px * var(--tn-z)); object-fit: cover; border-radius: 4px; display:block; background: var(--tn-paper-2); }\n.cv.ph{ display:flex; align-items:center; justify-content:center; font-family: var(--tn-f-display); font-weight: 900; color: var(--tn-ink-3); font-size: calc(17px * var(--tn-z)) }\n:host(.tn-nocover) .work{ grid-template-columns: minmax(0,1fr); padding-left: 12px }\n:host(.tn-nocover) .cv{ display: none !important }\n.wh{ display:flex; align-items: baseline; gap: 4px 10px; flex-wrap: wrap; min-width: 0 }\n.wt{ font-weight: 700; font-size: calc(17px * var(--tn-z)); line-height: 1.32; letter-spacing: .01em; overflow-wrap: anywhere; cursor: default }\n.wn{ font-weight: 500; font-size: .9em; color: var(--tn-ink-2); letter-spacing: 0; white-space: nowrap }  /* 用户手写备注，显示在作品名后的括号里 */\n.wm{ font-family: var(--tn-f-mono); font-size: calc(13px * var(--tn-z)); color: var(--tn-ink-2); white-space: nowrap; letter-spacing: -.01em }\n.wm .sc{ color: var(--tn-ink); font-weight: 600; margin-left: .55em }\n.wtags{ display:flex; flex-wrap: wrap; gap: 4px 5px; margin-top: 5px; align-items: center }\n.work.compact{ padding: 7px 9px 8px 7px; column-gap: 8px }\n.work.compact .cv{ width: calc(32px * var(--tn-z)); height: calc(45px * var(--tn-z)) }\n.work.compact .wt{ font-size: calc(16px * var(--tn-z)) }\n:host(.tn-openable) .wt{ cursor: pointer }\n\n/* 悬停作品时，近邻卡片角上的差别徽标：用与画板一致的标签样式 */\n.diff{ position: absolute; top: -13px; right: 8px; display: none; gap: 3px; align-items:center; background: var(--tn-card); border: 1.5px solid var(--tn-accent); border-radius: 999px; padding: 1px 4px; white-space: nowrap; z-index: 5; box-shadow: var(--tn-shadow); pointer-events: none }\n.diff.show{ display: inline-flex }\n.diff.t2{ border-color: var(--tn-line-2) }\n.diff .tg{ font-size: calc(12.5px * var(--tn-z)); line-height: 1.35 }\n.diff .eqx{ font-size: calc(12.5px * var(--tn-z)); color: var(--tn-ink-2); padding: 0 4px }\n\n/* ---------- 悬停状态 ---------- */\n.board .dm, .board .eg{ transition: opacity .18s }\n.board.hovering .dm:not(.hl){ opacity: .14 }\n.board.hovering .eg:not(.hl){ opacity: .1 }\n.board.hovering .work.hl{ box-shadow: 0 0 0 1.5px var(--tn-line-2), var(--tn-shadow) }\n.board.hovering .work.focus, .board.hovering .hnode.focus{ box-shadow: 0 0 0 2.5px var(--tn-accent), var(--tn-shadow); z-index: 4 }\n.board.hovering .hw.focus .wt, .board.hovering .lrow.focus .wt, .board.hovering .srow.focus .wt{ color: var(--tn-accent) }\n.board.hovering .lrow.focus, .board.hovering .srow.focus .ttl{ background: var(--tn-accent-2) }\n.eg.hl path, path.eg.hl{ stroke: var(--tn-accent) !important; stroke-opacity: 1 !important }\n/* 程序聚焦（focusWorks）：次要作品 = 虚线框、比主高亮淡、自己不变淡；flash = 作品框外闪 3 下（减少动效时一次淡入淡出） */\n.board.hovering .dm.sec{ opacity: 1 }\n.board.hovering .work.sec, .board.hovering .hw.sec, .board.hovering .lrow.sec, .board.hovering .srow.sec > .ttl{ outline: 2px dashed color-mix(in oklch, var(--tn-accent) 55%, transparent); outline-offset: 2px }\n.board.hovering .fl{ animation: tn-flash .5s ease-in-out 3 both }\n@keyframes tn-flash{ 0%, 100%{ outline: 3px solid transparent; outline-offset: 3px } 50%{ outline: 3px solid var(--tn-accent); outline-offset: 3px } }\n@media (prefers-reduced-motion: reduce){ .board.hovering .fl{ animation: tn-flash 1.5s ease-in-out 1 both } }\n\n/* ---------- 设计说明 ---------- */\n.notes{ display:grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr)); gap: 14px 30px; margin-top: 22px; }\n.notes section h3{ font-size: 13px; letter-spacing: .12em; color: var(--tn-ink-3); margin: 0 0 4px; font-weight: 500 }\n.notes section p{ margin: 0; color: var(--tn-ink-2); max-width: 62ch }\n\n/* ---------- 01 分支画布 ---------- */\n.cv-root{ position:absolute; background: var(--tn-ink); color: var(--tn-paper); border-radius: 12px; padding: 10px 16px 11px; box-shadow: var(--tn-shadow) }\n.cv-root .t{ font-family: var(--tn-f-display); font-weight: 900; font-size: calc(21px * var(--tn-z)); white-space: nowrap }\n.cv-root .m{ font-size: calc(13.5px * var(--tn-z)); opacity: .8; white-space: nowrap }\n.cv-box{ position:absolute; border: 1.5px solid var(--tn-line-2); border-radius: 18px; background: color-mix(in oklch, var(--tn-card) 55%, transparent) }\n.cv-tab{ position:absolute; display:flex; flex-direction: column; align-items:flex-start; gap: 1px; background: var(--tn-card); border: 1.5px solid var(--tn-line-2); border-radius: 999px; padding: 4px 14px 5px 8px; white-space: nowrap; box-shadow: var(--tn-shadow) }\n.cv-tab .tg{ font-size: calc(18px * var(--tn-z)); font-weight: 700 }\n.cv-tab .pc{ display:flex; align-items:center; gap: 9px }\n.cnt{ font-family: var(--tn-f-mono); font-size: calc(12.5px * var(--tn-z)); color: var(--tn-ink-3); white-space: nowrap }\n.pill{ position:absolute; display:flex; flex-direction: column; align-items:flex-start; gap: 1px; background: var(--tn-card); border: 1px solid var(--tn-line-2); border-radius: 14px; padding: 3px 10px 4px 5px; white-space: nowrap; box-shadow: var(--tn-shadow) }\n.pill .pc{ display:flex; align-items:center; gap: 5px }\n/* 大纲式分列时，列顶重复的上一列的标签：虚线框、不带阴影 */\n.pill.cont{ border-style: dashed; box-shadow: none }\n.pill .tg{ font-size: calc(15.5px * var(--tn-z)); font-weight: 600 }\n.rest{ font-size: calc(15px * var(--tn-z)); color: var(--tn-ink-2); padding-left: 6px }\n.abs{ display:inline-flex; align-items:center; gap: 3px; font-size: calc(12.5px * var(--tn-z)); color: var(--tn-ink-3); padding-left: 4px }\n.abs .tg{ font-size: calc(14px * var(--tn-z)) !important; font-weight: 500 !important }\nsvg .edge{ fill: none; stroke: var(--tn-edge); stroke-width: 1.8; stroke-linecap: round }\n\n/* ---------- 02 标签谱 ---------- */\n.score{ display: inline-block }\n.srow{ display:grid; grid-template-columns: var(--cols); align-items: stretch; position: relative }\n.srow.gap{ margin-top: 14px }\n.srow.hd .c{ display:flex; flex-direction: column; align-items:center; justify-content:flex-end; gap: 1px; padding-bottom: 6px; font-size: calc(13.5px * var(--tn-z)); color: var(--tn-ink-2); font-weight: 500 }\n.srow.hd .c .f{ font-family: var(--tn-f-mono); font-size: calc(11.5px * var(--tn-z)); color: var(--tn-ink-3) }\n.srow.seg .c{ font-size: calc(12px * var(--tn-z)); color: var(--tn-ink-3); letter-spacing: .1em; border-bottom: 1px solid var(--tn-line-2); margin: 0 4px; padding-bottom: 2px; text-align: center; white-space: nowrap }\n.srow.body:hover .ttl{ background: var(--tn-accent-2) }\n.ttl{ display:grid; grid-template-columns: auto minmax(0,1fr) auto; align-items:center; gap: 9px; padding: 4px 10px 4px 4px; border-radius: 8px; min-height: calc(46px * var(--tn-z)); position: relative }\n.ttl .cv{ width: calc(28px * var(--tn-z)); height: calc(39px * var(--tn-z)); object-fit: cover; border-radius: 3px; display:block; background: var(--tn-paper-2) }\n:host(.tn-nocover) .ttl{ grid-template-columns: minmax(0,1fr) auto }\n.ttl .wt{ font-size: calc(16.5px * var(--tn-z)); line-height: 1.28; padding-block: 2px }\n.ttl .wm{ text-align: right }\n.ttl .diff{ top: -10px; right: auto; left: 40px }\n.sc-cell{ display:flex; align-items:center; justify-content:center; margin: 3px 2px; border-radius: 6px; font-size: calc(14.5px * var(--tn-z)); font-weight: 500; white-space: nowrap; cursor: default }\n.sc-cell.on.hi{ background: oklch(var(--tn-hlL) var(--tn-hlC) var(--h,250)); color: oklch(var(--tn-tgL) var(--tn-tgC) var(--h,250)); }\n.sc-cell.on.st{ box-shadow: inset 0 0 0 1px var(--tn-line-2); color: var(--tn-ink-2); font-size: calc(13.5px * var(--tn-z)) }\n.sc-cell.on.lo{ border: 1px dashed var(--tn-line-2); color: var(--tn-ink-2); font-style: italic; font-size: calc(13px * var(--tn-z)) }\n.sc-cell.jt{ margin-top: 0; border-top-left-radius: 0; border-top-right-radius: 0 }\n.sc-cell.jb{ margin-bottom: 0; border-bottom-left-radius: 0; border-bottom-right-radius: 0 }\n.sc-cell.st.jt{ box-shadow: inset 1px 0 0 var(--tn-line-2), inset -1px 0 0 var(--tn-line-2), inset 0 -1px 0 var(--tn-line-2) }\n.sc-cell.st.jb{ box-shadow: inset 1px 0 0 var(--tn-line-2), inset -1px 0 0 var(--tn-line-2), inset 0 1px 0 var(--tn-line-2) }\n.sc-cell.st.jt.jb{ box-shadow: inset 1px 0 0 var(--tn-line-2), inset -1px 0 0 var(--tn-line-2) }\n.sc-cell.off::after{ content: \"·\"; color: var(--tn-line-2) }\n.sc-cell.off:hover::after, .sc-cell.off.on::after{ content: \"非\" attr(data-ntag); color: var(--tn-ink-3); font-size: calc(12.5px * var(--tn-z)) }\n.sc-cell.off.on{ box-shadow: inset 0 0 0 1.5px var(--tn-accent) }\n.sc-cell.on.on2{ box-shadow: 0 0 0 2px var(--tn-accent) }\n.dcell{ display:flex; align-items:center; gap: 4px; padding-left: 12px; flex-wrap: wrap; font-size: calc(13px * var(--tn-z)) }\n.dcell .tg{ font-size: calc(13.5px * var(--tn-z)) }\n.dcell .eq{ color: var(--tn-ink-3) }\n.dcell .up{ color: var(--tn-ink-3); font-size: 11.5px; margin-right: 2px }\n\n/* ---------- 03 卡诺图 ---------- */\n.kmap{ display:grid; gap: 0; }\n.kh{ display:flex; align-items:center; justify-content:center; gap: 6px; padding: 5px 6px; margin: 3px; border-radius: 8px; font-size: calc(15.5px * var(--tn-z)); white-space: nowrap; cursor: default; }\n.kh .tg{ font-size: calc(16px * var(--tn-z)); font-weight: 700 }\n.kh.pos{ background: color-mix(in oklch, oklch(var(--tn-hlL) var(--tn-hlC) var(--h,250)) 55%, transparent) }\n.kh.neg{ border: 1.5px dashed oklch(var(--tn-lnL) var(--tn-lnC) var(--h,250) / .5); color: var(--tn-ink-2) }\n.kh.neg .tg{ font-weight: 500 }\n.kh.vert{ flex-direction: column }\n.kc{ position: relative; border: 1px solid var(--tn-line-2); margin: -0.5px; padding: 30px 10px 10px; min-height: 92px; display:flex; flex-direction: column; gap: 9px; background: color-mix(in oklch, var(--tn-card) 40%, transparent) }\n.kc.empty{ background-image: repeating-linear-gradient(135deg, transparent 0 9px, var(--tn-line) 9px 10px); }\n.kc .cap{ position:absolute; left: 8px; top: 5px; display:flex; gap: 3px; align-items:center; flex-wrap: nowrap; font-size: calc(12.5px * var(--tn-z)); color: var(--tn-ink-3) }\n.kc .cap .tg{ font-size: calc(13px * var(--tn-z)) }\n.kc .work{ position: relative }\n.kc .ecap{ color: var(--tn-ink-3); font-size: calc(13px * var(--tn-z)); margin: auto; font-style: italic }\n.kwrap{ font-size: 12.5px; color: var(--tn-ink-3); text-align: center; padding-top: 4px }\n\n/* ---------- 04 增减阶梯 ---------- */\n.hnode{ position:absolute; background: var(--tn-card); border: 1px solid var(--tn-line); border-radius: 10px; box-shadow: var(--tn-shadow); padding: 7px 10px 9px 8px; display:flex; flex-direction: column; gap: 4px }\n.hnode.multi{ border-style: double; border-width: 3px }\n.hw{ position: relative; display:grid; grid-template-columns: auto minmax(0,1fr); column-gap: 9px; align-items: center; border-radius: 6px }\n.hw .cv{ width: calc(30px * var(--tn-z)); height: calc(42px * var(--tn-z)); object-fit: cover; border-radius: 3px; display:block; background: var(--tn-paper-2) }\n:host(.tn-nocover) .hw{ grid-template-columns: minmax(0,1fr) }\n.hw .wt{ font-size: calc(16.5px * var(--tn-z)) }\n.hw .diff{ top: -25px; right: -6px }\n.hnode .wtags{ margin-top: 2px }\n.hlab{ position:absolute; display:flex; gap: 3px; align-items:center; background: var(--tn-paper-2); padding: 1px 3px; border-radius: 6px; white-space: nowrap }\n.hlab .tg{ font-size: calc(14px * var(--tn-z)); font-weight: 600 }\n.hlab.faint .tg{ font-weight: 500 }\n.hlayer{ position:absolute; font-size: calc(12.5px * var(--tn-z)); color: var(--tn-ink-3); white-space: nowrap; line-height: 1.3 }\n.hlayer b{ display:block; font-family: var(--tn-f-mono); font-size: calc(20px * var(--tn-z)); color: var(--tn-ink-2); font-weight: 500 }\nsvg .hedge{ fill:none; stroke: var(--tn-edge); stroke-width: 2; }\nsvg .hedge.two{ stroke-dasharray: 6 5 }\nsvg .hswap{ fill:none; stroke: var(--tn-edge); stroke-width: 1.6; stroke-dasharray: 2 5; stroke-linecap: round }\n\n/* ---------- 05 领地图 ---------- */\nsvg .terr{ fill: oklch(var(--tn-hlL) var(--tn-hlC) var(--h,250) / .16); stroke: oklch(var(--tn-lnL) var(--tn-lnC) var(--h,250)); stroke-width: 2.2; transition: opacity .18s, stroke-width .18s }\nsvg .terr.neg{ fill: none; stroke-dasharray: 7 5; stroke-width: 2 }\nsvg .cellgrid{ stroke: var(--tn-line); stroke-width: 1; stroke-dasharray: 2 6 }\n.board.hovering svg .terr{ opacity: .18 }\n.board.hovering svg .terr.on{ opacity: 1; stroke-width: 3.4; fill: oklch(var(--tn-hlL) var(--tn-hlC) var(--h,250) / .32) }\n.tlab{ position:absolute; transform: translateY(-50%); background: var(--tn-paper-2); padding: 0 3px; border-radius: 6px; display:flex; z-index: 2 }\n.tlab .tg{ font-size: calc(15px * var(--tn-z)); font-weight: 700 }\n.tlab .tg.neg{ font-weight: 600; background: var(--tn-paper-2) }\n\n/* ---------- 06 谱系 ---------- */\n.lrow{ position:absolute; display:flex; align-items:center; gap: 10px; border-radius: 10px; padding: 3px 10px 3px 4px; }\n.lrow:hover{ background: color-mix(in oklch, var(--tn-accent-2) 70%, transparent) }\n.lrow .dl{ display:flex; gap: 3px; align-items:center; flex: none }\n.lrow .dl .tg{ font-size: calc(14px * var(--tn-z)); font-weight: 600 }\n.lrow .dl .same{ font-size: calc(13px * var(--tn-z)); color: var(--tn-ink-2); border: 1px solid var(--tn-line-2); border-radius: 4px; padding: 0 6px }\n.lrow .dl .start{ font-size: calc(13px * var(--tn-z)); color: var(--tn-paper); background: var(--tn-ink); border-radius: 4px; padding: 0 7px }\n.lrow .cv{ width: calc(28px * var(--tn-z)); height: calc(39px * var(--tn-z)); object-fit: cover; border-radius: 3px; display:block; background: var(--tn-paper-2); flex: none }\n.lrow .wt{ font-size: calc(16.5px * var(--tn-z)); white-space: nowrap }\n.lrow .diff{ top: -11px; right: auto; left: 30px }\n.ltags{ position:absolute; display:flex; flex-wrap: nowrap; gap: 4px 5px; align-items:center; }\nsvg .lline{ fill:none; stroke: var(--tn-edge); stroke-width: 1.6 }\n.lrule{ position:absolute; height: 1px; background: var(--tn-line) }\n\n/* 窄排版按导图自己所在区域的宽度判断，不按浏览器窗口：嵌进出题器主区或 Obsidian 分栏时同样适用 */\n@container tn (max-width: 720px){\n  .frame{ grid-template-columns: minmax(0,1fr) }\n  .drawer, .root.full .drawer{ position: static; width: auto; max-height: none; overflow: visible; order: -1; margin-bottom: 14px }\n  .dr-list{ overflow: visible; margin-right: 0; padding-right: 0 }\n  .board-wrap{ padding: 18px 14px 22px; border-radius: 10px }\n  .vhead h2{ font-size: 22px }\n}\n\n/* ---------- 'pane' 布局：占满宿主的高度，图区自己两个方向滚动，可以移动缩放 ---------- */\n/* 宿主要给引擎一个确定的高度（分屏里的格子）。顶栏在上；图区 = 剩下的高度；侧栏是独立的一列、自己滚动 */\n.root.pane{ height: 100%; min-height: 0; display:flex; flex-direction: column }\n.root.pane > .bar{ flex: none }\n.root.pane .frame{ flex: 1 1 auto; min-height: 0; position: relative; grid-template-rows: minmax(0,1fr); align-items: stretch; padding-block: 12px }\n.root.pane .main{ min-height: 0; display:flex; flex-direction: column }\n.root.pane .view{ flex: 1 1 auto; min-height: 0; display:flex; flex-direction: column }\n.root.pane .vhead{ flex: none }\n.root.pane .custom{ flex: 1 1 auto; min-height: 0; overflow: auto }\n.root.pane .notes{ flex: none; max-height: 30%; overflow-y: auto; margin-top: 14px; scrollbar-width: thin }\n.bw-box{ flex: 1 1 auto; min-height: 0; position: relative; display:flex }\n/* 占位层（.zsz）= 画板缩放后的尺寸；四周外边距由引擎按图区尺寸设（各留半个图区减内边距），平移时视区中心能到画板上任意一点；\n   画板贴在它左上角、transform 缩放。有了留白两个方向总能滚：滚动条一直留着（scroll，免得出现 / 消失时图区尺寸来回变），做细做淡 */\n.root.pane .board-wrap{ flex: 1 1 auto; min-width: 0; min-height: 0; display:flex; overflow: scroll; overflow-anchor: none; overscroll-behavior: contain;\n  scrollbar-width: thin; scrollbar-color: var(--tn-line-2) transparent; background-attachment: local }\n.zsz{ flex: none; margin: 0; position: relative }\n.root.pane .board{ position: absolute; left: 0; top: 0; margin: 0; transform-origin: 0 0 }\n/* 侧栏：撑满格子高度的一列，不吸顶、不靠页面滚动（覆盖上面 720px 容器查询里的窄排版） */\n.root.pane .drawer, .root.pane.full .drawer{ position: relative; top: auto; width: var(--tn-drawer-w, 248px); max-height: none; margin-bottom: 0; overflow: hidden; order: 0; align-self: stretch; min-height: 0 }\n.root.pane .dr-list{ overflow-y: auto; margin-right: -6px; padding: 0 6px 8px 0 }\n.root.pane.full{ overflow: hidden; padding: 0 20px }\n/* 窄宿主（≤ 720px，由引擎加 .narrow）：侧栏默认收起；「标签与近邻」把它作为浮层从右侧滑出，盖在图上，不挤压图区 */\n.root.pane.narrow .frame{ grid-template-columns: minmax(0,1fr); padding-block: 8px }\n.root.pane.narrow .drawer, .root.pane.narrow.full .drawer{ position: absolute; top: 8px; right: 0; bottom: 8px; z-index: 25;\n  width: min(var(--tn-drawer-w, 280px), calc(100% - 24px));\n  box-shadow: var(--tn-shadow), 0 18px 40px -18px oklch(0 0 0 / .45); animation: tn-slide-in .18s ease-out }\n@keyframes tn-slide-in{ from{ transform: translateX(16px); opacity: 0 } to{ transform: none; opacity: 1 } }\n/* 'pane' 的顶栏：视图标签放不下时横向滚动，哪边还有没露出来的标签哪边淡出（--tn-fl / --tn-fr 由引擎按滚动位置设，0px = 不淡出） */\n.root.pane .tabs.ovf{ -webkit-mask-image: linear-gradient(to right, transparent 0, #000 var(--tn-fl, 0px), #000 calc(100% - var(--tn-fr, 0px)), transparent 100%);\n  mask-image: linear-gradient(to right, transparent 0, #000 var(--tn-fl, 0px), #000 calc(100% - var(--tn-fr, 0px)), transparent 100%) }\n/* 封面 / 配色外面那层：平时不占位置（和没有这层一样）；「⋯」按钮和「标签与近邻」的图标只在窄宿主时出现 */\n.tset{ display: contents }\n.more-btn, .drawer-btn .ic{ display: none }\n/* 窄宿主的顶栏只占一行：标签在左（可横向滚动），工具在右，只留图标（悬停有 title）；封面 / 配色收进「⋯」菜单 */\n.root.pane.narrow > .bar{ flex-wrap: nowrap; gap: 0 8px }\n.root.pane.narrow .tabs{ flex: 1 1 auto; scrollbar-width: none; padding-top: 4px }\n.root.pane.narrow .tabs::-webkit-scrollbar{ display: none }\n.root.pane.narrow .tab{ padding: 6px 10px 7px; font-size: 14.5px }\n.root.pane.narrow .tab .no{ margin-right: 4px }\n.root.pane.narrow .tools{ flex: none; flex-wrap: nowrap; gap: 4px; padding-block: 4px 6px; position: relative; align-self: center }\n.root.pane.narrow .more-btn, .root.pane.narrow .drawer-btn, .root.pane.narrow .full-btn{ display: inline-flex; align-items: center; justify-content: center; flex: none;\n  width: 30px; height: 30px; padding: 0; gap: 0; border: 1px solid var(--tn-line-2); background: var(--tn-card); border-radius: 999px; color: var(--tn-ink-2) }\n.root.pane.narrow .more-btn:hover, .root.pane.narrow .drawer-btn:hover, .root.pane.narrow .full-btn:hover{ color: var(--tn-ink); border-color: var(--tn-ink-3) }\n.root.pane.narrow .drawer-btn > span, .root.pane.narrow .full-btn > span{ display: none }\n.root.pane.narrow .drawer-btn .ic{ display: block }\n.root.pane.narrow .drawer-btn[aria-expanded=\"true\"], .root.pane.narrow .more-btn[aria-expanded=\"true\"]{ background: var(--tn-ink); color: var(--tn-paper); border-color: var(--tn-ink) }\n.ic{ width: 14px; height: 14px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round }\n.ic.dots{ fill: currentColor; stroke: none }\n.root.pane.narrow .tset{ display: none }\n.root.pane.narrow .tset.open{ display: flex; flex-direction: column; align-items: stretch; gap: 6px; position: absolute; top: calc(100% + 4px); right: 0; z-index: 40;\n  padding: 8px; background: var(--tn-card); border: 1px solid var(--tn-line); border-radius: 14px; box-shadow: var(--tn-shadow), 0 18px 40px -18px oklch(0 0 0 / .45) }\n.root.pane.narrow .tset.open .ctl{ justify-content: space-between; white-space: nowrap }\n/* 不在初始位置（平移或缩放过）时图区右下角的小标签，显示缩放百分比；点它回到初始 */\n.zoom-badge{ position: absolute; right: 10px; bottom: 10px; z-index: 6; font-family: var(--tn-f-mono); font-size: 11.5px; line-height: 1; letter-spacing: .02em;\n  color: var(--tn-ink-3); background: color-mix(in oklch, var(--tn-card) 82%, transparent); border: 1px solid var(--tn-line); border-radius: 999px; padding: 4px 8px;\n  backdrop-filter: blur(2px) }\n.zoom-badge:hover{ color: var(--tn-ink); border-color: var(--tn-line-2); background: var(--tn-card) }\n/* 按住空格：抓手 */\n.root.pane.grab .board-wrap, .root.pane.grab .board-wrap *{ cursor: grab !important; user-select: none }\n.root.pane.grabbing .board-wrap, .root.pane.grabbing .board-wrap *{ cursor: grabbing !important }\n@media (prefers-reduced-motion: reduce){ *{ transition: none !important } .root.pane.narrow .drawer{ animation: none } }\n";

/* ====================================================================
   默认配置（mount 选项 config 可覆盖；hue 为逐项合并）
   ==================================================================== */
const DEFAULT_CONFIG = {
  // 标签 → OKLCH 色相。没列出的：第一档的按标签名算固定色相（见 nameHues），其余按 autoHues 依次分配。
  hue: { 日常: 150, 搞笑: 75, 萌: 352, 治愈: 205, 校园: 268, 奇幻: 305, 恋爱: 15, 战斗: 32, 科幻: 228, 后宫: 330,
         运动: 30, 音乐: 290, 偶像: 322, 悬疑: 250, 热血: 25, 青春: 120, 泡面番: 100 },
  autoHues: [180, 45, 285, 125, 335, 220, 60, 0, 250, 160],
  neutralGroups: ['G_format', 'G_source', 'G_else'],               // 不上荧光底色的分组
  segOrder: ['G_1', 'G_2', 'G_3', 'G_staff', 'G_format', 'G_source', 'G_4', 'G_else'], // 卡片上标签的先后
  splitPriority: { G_1: 0, G_2: 1, G_3: 2, G_staff: 3, G_format: 4, G_source: 4, G_4: 5 }, // 分支画布的提问顺序
  elseExclude: /19\d\d|20\d\d|年代/,  // 这些未定义标签永远不显示
  elseNearDist: 2,   // 两部作品已定义标签相差 ≤ 2 时，它们共有的低频标签才显示
  elseBonus: 0.3,    // 每个共有的可见低频标签让距离减少多少
  maxTerritories: 7, // 领地图最多几块领地
};

/* ====================================================================
   视图元数据（名称、读法、设计说明）
   ==================================================================== */
const VIEWS = [
  { key: 'canvas', no: '01', name: '分支画布', flow: false, g1: 3, g2: 2,
    howto: '从集合出发连线；第一次分出的每个分支各占一个方框，框里不再套框。卡片上，路径已经说明的标签用下划线淡显，作品自己多出来的标签用实色。',
    idea: '从集合出发连线，第一次分出的每个分支各占一个方框，框里只用连线继续分，不再套框。提问顺序按“类型 → 题材 → 制作 → 形式/来源 → 其它”；如果某一步只能剥离单独一部作品，就把这类条件并排列成一组（如「治愈 / 运动 / 非日常 / 其余」），不拖成一条长链。',
    goal1: '卡片本身就是完整的标签组：路径已说明的标签用下划线淡显，作品自己多出来的用实色，不用回溯整条路径。',
    goal2: '同一分岔下的兄弟作品只差分岔条件；悬停作品时，近邻卡片角上直接写出差别（+治愈 / −搞笑）。',
    pros: '“先问搞笑，再问日常”这种问答顺序本身就是记忆钩子；整张图横向展开，适合宽屏一眼看全。',
    cons: '树只能体现一种分法。同一个标签可能被拆进两个框；只差一个标签的两部作品可能分在两个框里，要靠悬停才看得出。' },
  { key: 'score', no: '02', name: '标签谱', flow: true, g1: 3, g2: 2,
    howto: '一行一部作品，每个标签固定一列，格子里直接写字。行序让相邻两行差别最小，相同标签连成竖条；最右栏写出与上一行的差别。',
    idea: '一行一部作品，每个标签固定在自己的一列，格子里直接写标签字，不用点。行序用“最短路径”排：相邻两行差别尽量小，同一个标签在相邻行里连成竖条。最右一栏写出与上一行相比多了、少了什么。',
    goal1: '横着读一行就是完整的标签组，没有图例可查。',
    goal2: '竖条断开的地方就是差别所在；右栏把差别直接写成文字；差别较大的地方空出一道缝，把作品自然分成几组。',
    pros: '完整、精确，适合逐格核对；作品再多也能读；当作“查表”用最可靠。',
    cons: '它是一张表，不太能形成“这部在左上角”的空间记忆；每部作品只能和上下两行比。' },
  { key: 'kmap', no: '03', name: '卡诺图', flow: true, g1: 3, g2: 3,
    howto: '四个主标签排成 4×4 格，相邻两格只差一个标签（左右两端、上下两端也相邻）。格子左上角写着这一格有哪些主标签，卡片上只写其余标签。',
    idea: '自动挑出最能把作品分开的 4 个主标签，排成 4×4 格，行列用格雷码排序：任意两个相邻格子恰好只差一个标签，左右两端、上下两端也相邻。作品放进它所属的格子，卡片上只写其余标签。',
    goal1: '位置就是 4 个主标签的组合，“作品 A 在‘日常·搞笑’列、‘萌·治愈’行”这类空间记忆很牢；空格子本身也是信息。',
    goal2: '同一格的作品主标签完全相同，差别只在卡片上；相邻格只差一个标签，表头告诉你差的是哪一个。',
    pros: '规则清楚、结构固定；不同作品集只要主标签相同，就能用同一张“地图”。',
    cons: '主轴最多 4 个标签，其余仍要读卡片；作品多时，热门格子会挤；需要先理解“相邻只差一个”这条规则。' },
  { key: 'hasse', no: '04', name: '增减阶梯', flow: false, g1: 2, g2: 3,
    howto: '越往下标签越多。从上一部作品画到下一部的线，表示下面那部包含上面那部的全部标签，线上写着多出来的那一两个。完全相同的作品合成一张双线卡片。',
    idea: '按已定义标签的个数分层，越往下标签越多。如果 A 的标签被 B 全部包含，就从 A 连一条线到 B，线上写 B 多出来的标签（只画多 1–2 个的直接关系）。标签组完全相同的作品合成一张双线卡片；完全没有包含关系的作品，补一条“一换一”的虚线。',
    goal1: '每张卡片写着完整标签组；它所在的层数就是标签个数。',
    goal2: '唯一把“谁比谁多一个标签”直接画成线的方案，例如 作品 A +搞笑 → 作品 B +治愈 → 作品 C。',
    pros: '对“辨析”最直接；几乎没有标签的作品自然落在最上层。',
    cons: '“一换一”的关系（漫画改⇄游戏改）一般不画；作品多了线会交叉；同一层左右的位置没有含义。' },
  { key: 'terr', no: '05', name: '领地图', flow: false, g1: 3, g2: 2,
    howto: '每个常见标签圈出一块领地；大多数作品都有的标签改圈它的反面（虚线，如「非日常」）。一部作品被哪几道线圈住，就带哪几个标签。',
    idea: '把作品排进方格，每个常见标签圈出一块领地。大多数作品都有的标签改圈它的反面（例如「非日常」），这样圈子小而少。排布用模拟退火自动求解：让每块领地尽量连成一片、边界尽量短、相邻作品尽量相似。',
    goal1: '一部作品被哪几道线圈住就有哪几个标签，像记一座城市属于哪个省；卡片上同时写着完整标签组。',
    goal2: '相邻格子的作品通常只差一两个标签，跨过一条边界就多了或少了一个标签。',
    pros: '一张图能表达比卡诺图更多的主标签，也最像“一张图”，适合当封面式的总览。',
    cons: '布局是算出来的（同一份数据结果固定，可缓存）；领地多于 6–7 块时线会变密；格子固定大小，卡片比其它视图窄一些。' },
  { key: 'line', no: '06', name: '谱系', flow: false, g1: 2, g2: 3,
    howto: '每部作品挂在与它最接近的作品下面，左边写“比上一级多了/少了什么”，右边一列整齐写出完整标签组。',
    idea: '每部作品挂在与它最接近的作品下面（最小生成树），从最“基础”的作品开始像族谱一样缩进展开。树枝上写变化：+萌、−日常、漫画改→游戏改；右侧一列整齐写出完整标签组。',
    goal1: '右边一列就是完整标签组，左右对齐，扫读方便。',
    goal2: '每部作品都被写成“某部作品 + 一处变化”，包括增减阶梯不画的一换一。',
    pros: '最紧凑、最“文字化”，适合截图贴在一边背；作品多时也只是行数增加。',
    cons: '生成树只保留一条亲缘线，其它近亲要靠悬停补上。' },
];

/* ==================================================================== */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtScore = s => (s == null || s === '' || isNaN(s)) ? '—' : Number(s).toFixed(1);
const SVGNS = 'http://www.w3.org/2000/svg';
const cssEsc = s => (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
function svgEl(tag, attrs = {}, parent) { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v); if (parent) parent.appendChild(e); return e; }
function mergeConfig(over) {
  const c = Object.assign({}, DEFAULT_CONFIG, over || {});
  c.hue = Object.assign({}, DEFAULT_CONFIG.hue, (over && over.hue) || {});
  c.splitPriority = Object.assign({}, DEFAULT_CONFIG.splitPriority, (over && over.splitPriority) || {});
  return c;
}

// 第一档里没有预设色相的标签（按自己的公式分档后新进第一档的）：按标签名算一个固定色相，不随作品集变；
// 和第一档已占用的色相相差不到 18° 就转一个黄金角（137°）再试。
function nameHues(g1Tags, preset) {
  const taken = g1Tags.filter(t => preset[t] != null).map(t => preset[t]);
  const out = new Map();
  for (const t of g1Tags.filter(t => preset[t] == null).sort()) {
    let h = 0; for (const ch of t) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    h %= 360;
    for (let i = 0; i < 20 && taken.some(x => Math.min(Math.abs(x - h), 360 - Math.abs(x - h)) < 18); i++) h = (h + 137) % 360;
    taken.push(h); out.set(t, h);
  }
  return out;
}

/* ====================================================================
   数据模型
   ==================================================================== */
function buildModel(raw, configOverride, coverOf) {
  const cfg = mergeConfig(configOverride);
  const tagGroup = new Map(), tagIdx = new Map();
  for (const [g, list] of Object.entries(raw.tag_groups || {})) (list || []).forEach((t, i) => { if (!tagGroup.has(t)) { tagGroup.set(t, g); tagIdx.set(t, i); } });
  const src = Array.isArray(raw.works) ? raw.works : [];
  let common = null;
  for (const w of src) { const s = new Set(w.tags || []); common = common ? new Set([...common].filter(t => s.has(t))) : s; }
  common = (common && src.length >= 2) ? common : new Set();
  const works = src.map((w, i) => {
    const tags = [...new Set(w.tags || [])];
    return {
      id: String(w.id ?? ('w' + i)), idx: i, title: w.title ?? '（无题）', note: w.note ? String(w.note) : '', years: w.years ?? '', score: w.score, sid: w.subject_id, link: w.link ?? null, raw: w,
      cover: (coverOf ? coverOf(w) : null) || w.cover || null,
      def: new Set(tags.filter(t => tagGroup.has(t) && !common.has(t))),
      rawElse: new Set(tags.filter(t => !tagGroup.has(t) && !common.has(t) && !cfg.elseExclude.test(t))),
      els: new Set(),
    };
  });
  const byId = new Map(works.map(w => [w.id, w]));
  // id 重复时卡片、近邻、布局都会对错作品（后一部盖掉前一部），宁可明确报错
  if (byId.size !== works.length) {
    const dup = [...new Set(works.map(w => w.id).filter((id, i, a) => a.indexOf(id) !== i))];
    throw new Error('TagNote：作品 id 重复：' + dup.slice(0, 5).join('、'));
  }
  const symd = (a, b) => { let c = 0; for (const t of a.def) if (!b.def.has(t)) c++; for (const t of b.def) if (!a.def.has(t)) c++; return c; };
  for (const a of works) for (const b of works) if (a !== b && symd(a, b) <= cfg.elseNearDist) for (const t of a.rawElse) if (b.rawElse.has(t)) a.els.add(t);
  const freq = new Map();
  for (const w of works) for (const t of [...w.def, ...w.els]) freq.set(t, (freq.get(t) || 0) + 1);
  const groupOf = t => tagGroup.get(t) || 'G_else';
  const seg = t => { const i = cfg.segOrder.indexOf(groupOf(t)); return i < 0 ? 5.5 : i; };
  const cmpTag = (a, b) => seg(a) - seg(b) || (freq.get(b) || 0) - (freq.get(a) || 0) || (tagIdx.get(a) ?? 99) - (tagIdx.get(b) ?? 99) || a.localeCompare(b, 'zh');
  const tags = [...freq.keys()].sort(cmpTag);
  const hue = new Map(); let k = 0;
  const g1Hue = nameHues([...tagGroup].filter(([, g]) => g === 'G_1').map(([t]) => t), cfg.hue);
  for (const t of tags) { if (cfg.neutralGroups.includes(groupOf(t))) continue; hue.set(t, cfg.hue[t] ?? g1Hue.get(t) ?? cfg.autoHues[k++ % cfg.autoHues.length]); }
  const sd = works.map(a => works.map(b => symd(a, b)));
  const D = works.map(a => works.map(b => { if (a === b) return 0; let sh = 0; for (const t of a.els) if (b.els.has(t)) sh++; return sd[a.idx][b.idx] - cfg.elseBonus * sh; }));
  for (const a of works) {
    const others = works.filter(b => b !== a).map(b => ({ b, d: D[a.idx][b.idx], ov: [...a.def].filter(t => b.def.has(t)).length }));
    others.sort((x, y) => x.d - y.d || y.ov - x.ov || x.b.idx - y.b.idx);
    const dmin = others.length ? others[0].d : 0;
    const t1 = others.filter(o => o.d <= dmin + 1e-9);
    const lim = Math.max(dmin, 0) + 1 + 1e-9;
    const t2 = others.filter(o => o.d > dmin + 1e-9 && o.d <= lim).slice(0, Math.max(0, 7 - t1.length));
    a.nb1 = t1.map(o => o.b.id); a.nb2 = t2.map(o => o.b.id);
  }
  return { raw, cfg, works, byId, n: works.length, common: [...common], tags, freq, groupOf, cmpTag, hue, D, sd, tagGroup,
    title: (raw.collection && raw.collection.title) || '作品集' };
}
function diffOf(M, from, to) {
  const plus = [...to.def].filter(t => !from.def.has(t)).sort(M.cmpTag);
  const minus = [...from.def].filter(t => !to.def.has(t)).sort(M.cmpTag);
  const sharedElse = [...to.els].filter(t => from.els.has(t));
  return { plus, minus, sharedElse };
}

/* ====================================================================
   通用片段
   ==================================================================== */
// bare = true：不带 data-tag（用于徽标、读数，避免悬停时互相触发）
function chip(M, t, cls = '', bare = false) {
  const h = M.hue.get(t), g = M.groupOf(t);
  const kind = h != null ? 'hi' : (g === 'G_else' ? 'lo' : 'st');
  const neg = /\b(neg|minus)\b/.test(cls);
  const data = bare ? '' : ` ${neg ? 'data-ntag' : 'data-tag'}="${esc(t)}"`;
  return `<span class="tg ${kind} ${cls}"${data}${h != null ? ` style="--h:${h}"` : ''}>${esc(t)}</span>`;
}
function tagChips(M, w, { ghost = new Set(), omit = new Set(), els = true } = {}) {
  const list = [...w.def].filter(t => !omit.has(t)).sort(M.cmpTag);
  const parts = list.map(t => chip(M, t, ghost.has(t) ? 'gh' : ''));
  if (els) for (const t of [...w.els].sort(M.cmpTag)) if (!omit.has(t)) parts.push(chip(M, t));
  if (!parts.length && !w.def.size && !w.els.size) parts.push(`<span class="none">只有共有标签${M.common.length ? '（' + esc(M.common.join(' ')) + '）' : ''}</span>`);
  return parts.join('');
}
function diffChips(M, from, to) {
  const df = diffOf(M, from, to);
  if (!df.plus.length && !df.minus.length) return `<span class="eqx">＝ 相同</span>`;
  return df.plus.map(t => chip(M, t, 'plus', true)).join('') + df.minus.map(t => chip(M, t, 'minus', true)).join('');
}
const firstChar = w => [...String(w.title)][0] || '?';
// 封面加载失败（离线、链接失效）时由挂载处的 error 监听换成首字，见 mount
function coverImg(w) { return w.cover ? `<img class="cv" src="${esc(w.cover)}" alt="" loading="lazy" decoding="async" data-ph="${esc(firstChar(w))}">` : `<span class="cv ph" aria-hidden="true">${esc(firstChar(w))}</span>`; }
function titleHTML(w) { return `<span class="wt">${esc(w.title)}${w.note ? `<span class="wn">（${esc(w.note)}）</span>` : ''}</span>`; }
function metaHTML(w) { return `<span class="wm"><span class="yr">${esc(w.years)}</span><span class="sc">${fmtScore(w.score)}</span></span>`; }
function workCard(M, w, o = {}) {
  return `<div class="work dm ${o.cls || ''}"${o.k ? ` data-k="${o.k}"` : ''} data-wid="${esc(w.id)}"${o.style ? ` style="${o.style}"` : ''}>${coverImg(w)}`
    + `<div class="wh">${titleHTML(w)}${metaHTML(w)}</div>`
    + `<div class="wtags">${tagChips(M, w, o)}</div><span class="diff"></span></div>`;
}
function boardParts(board) { const svg = board.querySelector('svg.edges'), layer = board.querySelector('.layer'); svg.innerHTML = ''; layer.innerHTML = ''; return { svg, layer }; }
function sizeBoard(board, W, H) { board.style.width = Math.ceil(W) + 'px'; board.style.height = Math.ceil(H) + 'px'; const svg = board.querySelector('svg.edges'); svg.setAttribute('width', Math.ceil(W)); svg.setAttribute('height', Math.ceil(H)); }
const finder = layer => k => layer.querySelector(`[data-k="${k}"]`);

/* ====================================================================
   01 分支画布
   ==================================================================== */
function buildSplitTree(M) {
  const PRI = M.cfg.splitPriority;
  const absorbable = t => { const g = M.groupOf(t); return g in PRI && g !== 'G_format' && g !== 'G_source'; };
  const sortLeaves = ws => [...ws].sort((a, b) => b.def.size - a.def.size || (b.score ?? 0) - (a.score ?? 0));
  function chooseSplit(ws, pos) {
    const n = ws.length, cands = [];
    for (const t of M.tags) {
      const g = M.groupOf(t); if (!(g in PRI) || pos.has(t)) continue;
      const k = ws.filter(w => w.def.has(t)).length; if (k === 0 || k === n) continue;
      const pri = PRI[g], bal = Math.min(k, n - k);
      if (pri >= 3 && bal < 2) continue;
      cands.push({ t, k, pri, bal });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.pri - b.pri || b.bal - a.bal || (M.freq.get(b.t) - M.freq.get(a.t)) || M.cmpTag(a.t, b.t));
    const best = cands[0];
    if (best.bal === 1 && best.pri <= 2) {
      const peels = new Map();
      for (const c of cands) {
        if (c.bal !== 1 || c.pri > 2) continue;
        const m = c.k === 1 ? ws.find(w => w.def.has(c.t)) : ws.find(w => !w.def.has(c.t));
        const e = peels.get(m.id) || { w: m, pos: [], neg: [] };
        (c.k === 1 ? e.pos : e.neg).push(c.t); peels.set(m.id, e);
      }
      const list = [...peels.values()];
      if (list.length > 1) {
        const ids = new Set(list.map(e => e.w.id));
        const rest = ws.filter(w => !ids.has(w.id));
        list.sort((a, b) => (b.pos.length > 0) - (a.pos.length > 0));
        const br = list.map(e => ({ ws: [e.w], cond: { pos: e.pos, neg: e.neg } }));
        if (rest.length) br.push({ ws: rest, cond: { pos: [], neg: [], rest: true } });
        return br;
      }
    }
    return [
      { ws: ws.filter(w => w.def.has(best.t)), cond: { pos: [best.t], neg: [] } },
      { ws: ws.filter(w => !w.def.has(best.t)), cond: { pos: [], neg: [best.t] } },
    ];
  }
  function make(ws, cond, parentPos) {
    const pos = new Set(parentPos); cond.pos.forEach(t => pos.add(t));
    let absorbed = [];
    if (!cond.root && ws.length >= 2) absorbed = [...ws[0].def].filter(t => !pos.has(t) && absorbable(t) && ws.every(w => w.def.has(t))).sort(M.cmpTag);
    absorbed.forEach(t => pos.add(t));
    const nd = { ws, cond, absorbed, pos, children: [], leaves: [] };
    const sp = ws.length <= 2 ? null : chooseSplit(ws, pos);
    if (!sp) { nd.leaves = sortLeaves(ws); return nd; }
    nd.children = sp.map(b => make(b.ws, b.cond, pos));
    return nd;
  }
  return make(M.works, { pos: [], neg: [], root: true }, new Set());
}
function condHTML(M, nd, count = '') {
  const c = nd.cond; let h = '';
  c.pos.forEach(t => h += chip(M, t));
  c.neg.forEach(t => h += chip(M, t, 'neg'));
  if (c.rest) h += `<span class="rest">其余</span>`;
  h = `<span class="pc">${h}${count}</span>`;
  if (nd.absorbed.length) h += `<span class="abs">都有 ${nd.absorbed.map(t => chip(M, t, 'gh')).join('')}</span>`;
  return h;
}
// 排布：每个大框里，同一深度的标签竖着对齐，作品卡片排在最右（树形）。一屏放得下时按这种方式排。
// 框太高时（超过一屏），框里的子项分成几列并排；某个子树单独就太高时，它也改成「标签在上、子项分列排在下面」。
// 这样还放不下（树太深，分列就超宽），改成大纲式：标签占一行，子项缩进排在下面，整串按高度均分成几列。
function renderCanvas(M, board, ctx) {
  const z = ctx.z;
  const { svg, layer } = boardParts(board);
  const q = finder(layer);
  const T = buildSplitTree(M);
  const boxes = T.children.length ? T.children : [T];
  const CARD_W = Math.round(300 * z), HG = Math.round(32 * z), VG = Math.round(9 * z), GG = Math.round(12 * z);
  const PADR = Math.round(18 * z), PADT = Math.round(32 * z), PADB = Math.round(18 * z);
  // TABX：框标签离框左边；TRK：竖线离列左边；IND：子项离列左边；CG：列间距；BUS：标签下沿到横线；HDR：标签下沿到子项
  const TABX = Math.round(22 * z), TRK = Math.round(18 * z), IND = Math.round(24 * z), CG = Math.round(28 * z), BUS = Math.round(10 * z), HDR = Math.round(20 * z);
  const MULTI_T = Math.round(8 * z), MIN_CAP = Math.round(160 * z);
  let html = `<div class="cv-root" data-k="root"><div class="t">${esc(M.title)}</div><div class="m">${M.n} 部 · 共有 ${esc(M.common.join(' ') || '—')}</div></div>`;
  let uid = 0; const all = [];
  const tops = boxes.map((b, bi) => {
    const wids = b.ws.map(w => w.id).join(' ');
    html += `<div class="cv-box dm" data-k="box${bi}" data-wids="${esc(wids)}"></div>`;
    html += `<div class="cv-tab dm" data-k="tab${bi}" data-wids="${esc(wids)}">${b.cond.root ? `<span class="pc"><span class="rest">全部</span><span class="cnt">${b.ws.length} 部</span></span>` : condHTML(M, b, `<span class="cnt">${b.ws.length} 部</span>`)}</div>`;
    const build = nd => (nd.children.length ? nd.children : nd.leaves).map(k => {
      const id = 'i' + (uid++);
      if (k.def) {
        const ghost = new Set([...nd.pos].filter(t => k.def.has(t)));
        html += workCard(M, k, { ghost, style: `width:${CARD_W}px`, k: id });
        const it = { id, kind: 'leaf', wids: k.id }; all.push(it); return it;
      }
      html += `<div class="pill dm" data-k="${id}" data-wids="${esc(k.ws.map(w => w.id).join(' '))}">${condHTML(M, k, `<span class="cnt">${k.ws.length}</span>`)}</div>`;
      const it = { id, kind: 'pill', wids: k.ws.map(w => w.id).join(' ') }; all.push(it);
      it.kids = build(k); return it;
    });
    return { bi, kids: build(b) };
  });
  layer.innerHTML = html;
  const root = q('root');
  const rootW = root.offsetWidth, rootH = root.offsetHeight;
  for (const it of all) { it.el = q(it.id); it.w = it.el.offsetWidth; it.h = it.el.offsetHeight; }
  tops.forEach(t => { t.tab = q('tab' + t.bi); t.tw = t.tab.offsetWidth; t.th = t.tab.offsetHeight; });

  // 一列兄弟子树（树形）。返回宽高；out 不为空时记下每项的位置和它连向谁（link）
  function forest(ps, out, ox, oy, link) {
    const colW = [];
    (function scan(list, d) { for (const p of list) if (p.kids) { colW[d] = Math.max(colW[d] || 0, p.it.w); scan(p.kids, d + 1); } })(ps, 0);
    const colX = [0]; colW.forEach((w, d) => colX.push(colX[d] + w + HG));
    const leafX = colX[colW.length];
    let y = 0, W = 0;
    (function place(list, d, lk) {
      const mids = [];
      for (const p of list) {
        let x, top, mid;
        if (p.block) { x = colX[d]; top = y; const r = block(p, out, ox + x, oy + y); W = Math.max(W, x + r.w); mid = y + p.it.h / 2; y += r.h + VG; }
        else if (p.kids) { mid = place(p.kids, d + 1, { kind: 'bez', from: p.it }); x = colX[d]; top = mid - p.it.h / 2; W = Math.max(W, x + p.it.w); }
        else { x = leafX; top = y; W = Math.max(W, x + p.it.w); mid = y + p.it.h / 2; y += p.it.h + VG; }
        if (out) out.push({ it: p.it, x: ox + x, y: oy + top, link: lk });
        mids.push(mid);
      }
      y += GG;
      return mids.length ? (mids[0] + mids[mids.length - 1]) / 2 : y;
    })(ps, 0, link);
    return { w: W, h: y - GG - VG };
  }
  // 分列的子树：标签在上，子项分列排在下面；每列左边一条竖线，竖线顶上用一条横线连到标签
  function block(p, out, ox, oy) {
    const top = p.it.h + HDR; let cx = 0, H = 0;
    const port = { x: ox + TRK, y: oy + p.it.h }, busY = oy + p.it.h + BUS;
    for (const col of p.cols) {
      const r = forest(col, out, ox + cx + IND, oy + top, { kind: 'trunk', port, busY, trunkX: ox + cx + TRK });
      H = Math.max(H, r.h); cx += IND + r.w + CG;
    }
    return { w: Math.max(p.it.w, cx - CG), h: top + H };
  }
  // 大框：框标签骑在框的上边线上，子项从标签左下角引出；分列时同样用横线连各列
  function boxLayout(t, cols, out, ox, oy) {
    const top = PADT + (cols.length > 1 ? MULTI_T : 0);
    const port = { x: ox + TABX + TRK, y: oy + t.th / 2 }, busY = port.y + BUS;
    let cx = TABX, H = 0;
    for (const col of cols) {
      const r = forest(col, out, ox + cx + IND, oy + top, { kind: 'trunk', port, busY, trunkX: ox + cx + TRK });
      H = Math.max(H, r.h); cx += IND + r.w + CG;
    }
    return { w: cx - CG + PADR, h: top + H + PADB };
  }
  const hOf = ps => forest(ps, null, 0, 0).h;
  // 按顺序把子项装进列，每列不超过 cap；列数定了以后再把上限往下压，让各列高度接近
  function group(ps, cap) {
    const fit = c => { const cols = [[]]; for (const p of ps) { const cur = cols[cols.length - 1]; if (cur.length && hOf(cur.concat([p])) > c) cols.push([p]); else cur.push(p); } return cols; };
    const cols = fit(cap); const K = cols.length; if (K < 2) return cols;
    let lo = Math.max(...ps.map(p => hOf([p]))), hi = cap;
    for (let i = 0; i < 12 && hi - lo > 4; i++) { const mid = (lo + hi) / 2; if (fit(mid).length <= K) hi = mid; else lo = mid; }
    return fit(hi);
  }
  // cap：一列最高多高；子树比它高、又能分成几列时，改成「标签在上、子项分列」
  const memo = new Map();
  function plan(it, cap) {
    if (it.kind === 'leaf') return { it };
    const key = it.id + '@' + cap; if (memo.has(key)) return memo.get(key);
    let res = { it, kids: it.kids.map(k => plan(k, cap)) };
    if (it.kids.length >= 2 && hOf([res]) > cap) {
      const inner = Math.max(cap - it.h - HDR, MIN_CAP);
      const cols = group(it.kids.map(k => plan(k, inner)), inner);
      if (cols.length > 1) res = { it, block: true, cols };
    }
    memo.set(key, res); return res;
  }
  // 大纲式：把框里的树摊成一串行（标签行、作品行），每行记下深度、祖先标签和它下面要空多少
  function outlineRows(t) {
    if (t.rows) return t.rows;
    const rows = [];
    (function walk(list, d, anc) {
      for (const it of list) { const r = { it, d, anc }; rows.push(r); if (it.kind === 'pill') walk(it.kids, d + 1, anc.concat([r])); }
    })(t.kids, 0, []);
    rows.forEach((r, i) => { const nx = rows[i + 1]; r.gap = (r.it.kind === 'pill' ? HDR : VG) + (nx && nx.d < r.d ? GG : 0); });
    return (t.rows = rows);
  }
  // 把这串行切成 K 列，让最高那列尽量矮。从上一列续过来的子树，列顶重复它的祖先标签（算进高度）；
  // 标签不能单独留在列底（它和第一个子项之间不切）。
  // 给了 lim 时改成：每列不超过 lim，先让拆开的「同一标签下直接挂的一组作品」最少，一样少时再让最高那列尽量矮
  function outlineChunks(t, K, lim) {
    const rows = outlineRows(t), n = rows.length; if (K > n) return null;
    const pre = [0]; rows.forEach(r => pre.push(pre[pre.length - 1] + r.it.h + r.gap));
    const contH = rows.map(r => r.anc.reduce((s, a) => s + a.it.h + HDR, 0));
    const okStart = i => i === 0 || rows[i - 1].it.kind !== 'pill';
    const byTear = lim !== undefined, L = byTear ? lim : Infinity;
    // bt：拆开了几组；bh：最高那列多高。不给 lim 时 bt 恒为 0，结果和只比高度时一样
    let bt = new Array(n + 1).fill(Infinity), bh = new Array(n + 1).fill(Infinity); bt[0] = 0; bh[0] = 0; const cut = [];
    for (let k = 1; k <= K; k++) {
      const nt = new Array(n + 1).fill(Infinity), nh = new Array(n + 1).fill(Infinity), ck = [];
      for (let j = 1; j <= n; j++) for (let i = k - 1; i < j; i++) {
        if (bt[i] === Infinity || !okStart(i)) continue;
        const h = contH[i] + pre[j] - pre[i] - rows[j - 1].gap; if (h > L) continue;
        const vt = bt[i] + (byTear && i > 0 && tearAt(rows, i) ? 1 : 0), vh = Math.max(bh[i], h);
        if (vt < nt[j] || (vt === nt[j] && vh < nh[j])) { nt[j] = vt; nh[j] = vh; ck[j] = i; }
      }
      bt = nt; bh = nh; cut.push(ck);
    }
    if (bt[n] === Infinity) return null;
    const chunks = []; for (let k = K - 1, j = n; k >= 0; k--) { const i = cut[k][j]; chunks.unshift([i, j]); j = i; }
    return chunks;
  }
  // 在第 i 行前面切开，会不会把同一个标签下直接挂的两部作品分到两列
  function tearAt(rows, i) {
    const a = rows[i - 1], b = rows[i];
    return a.it.kind === 'leaf' && b.it.kind === 'leaf' && a.anc[a.anc.length - 1] === b.anc[b.anc.length - 1];
  }
  const tears = (t, chunks) => { const rows = outlineRows(t); return chunks.filter(([i]) => i > 0 && tearAt(rows, i)).length; };
  function boxOutline(t, chunks, out, ox, oy) {
    const rows = outlineRows(t);
    const top = PADT + (chunks.length > 1 ? MULTI_T : 0);
    const tabPort = { x: ox + TABX + TRK, y: oy + t.th / 2 }, busY = tabPort.y + BUS;
    let cx = TABX, H = 0;
    for (const [i, j] of chunks) {
      const x0 = ox + cx, at = new Map();             // at：本列里每个标签行（原件或列顶重复的）的位置
      const list = rows[i].anc.map(r => ({ r, cont: true })).concat(rows.slice(i, j).map(r => ({ r })));
      let y = oy + top, W = 0;
      list.forEach((e, k) => {
        const r = e.r, x = x0 + IND + r.d * IND;
        let it = r.it;
        if (e.cont && out) {                          // 列顶重复的标签：复制原件，样式上淡一点
          const el = it.el.cloneNode(true); el.dataset.k = 'c' + (uid++); el.classList.add('cont'); layer.appendChild(el);
          it = { el, kind: 'pill', w: r.it.w, h: r.it.h, wids: r.it.wids };
        }
        const par = r.anc.length ? at.get(r.anc[r.anc.length - 1]) : null;
        const link = par ? { kind: 'trunk', port: { x: par.x + TRK, y: par.y + par.h }, busY: par.y + par.h, trunkX: par.x + TRK }
          : { kind: 'trunk', port: tabPort, busY, trunkX: x0 + TRK };
        if (out) out.push({ it, x, y, link });
        if (r.it.kind === 'pill') at.set(r, { x, y, h: r.it.h });
        W = Math.max(W, x - x0 + r.it.w);
        y += r.it.h + (e.cont ? HDR : k === list.length - 1 ? 0 : r.gap);
      });
      H = Math.max(H, y - oy - top); cx += W + CG;
    }
    return { w: cx - CG + PADR, h: top + H + PADB };
  }
  const BG = Math.round(40 * z), BY = rootH + Math.round(78 * z);
  function layoutAt(cap) {
    const bs = tops.map(t => {
      const inner = cap === Infinity ? cap : Math.max(cap - PADT - MULTI_T - PADB, MIN_CAP);
      const cols = group(t.kids.map(k => plan(k, inner)), inner);
      const g = boxLayout(t, cols, null, 0, 0);
      return { t, mode: 'tree', cols, w: g.w, h: g.h };
    });
    return { bs, W: bs.reduce((s, b) => s + b.w, 0) + BG * (bs.length - 1), H: Math.max(...bs.map(b => b.h)) };
  }
  // 宽度：画布容器的内容宽；一屏高度：窗口高减去顶栏和上下留白（'pane' 布局：图区自己的内容高，由 renderView 量好放在 ctx.fitH）
  const pe = board.closest('.board-wrap'), pcs = pe && getComputedStyle(pe);
  const avail = pe && pe.clientWidth ? pe.clientWidth - parseFloat(pcs.paddingLeft) - parseFloat(pcs.paddingRight) : 1400;
  const MAXW = Math.max(1500 * z, avail);            // 不分列时：两三个框宁可横向滚动，也不轻易折行
  const HFIT = Math.max(Math.round(420 * z), ctx.fitH != null ? ctx.fitH : (window.innerHeight || 900) - 120) - BY;
  // 把框排成一行；wrap 时一行超过 lim 就折到下一行（框之间的连线从左边的走道下来）
  const LANE = Math.round(36 * z);
  function arrange(bs, wrap, lim) {
    let bx = wrap ? LANE : 0, by = BY, rowBottom = 0, row = 0;
    const geo = bs.map(b => {
      if (wrap && bx > LANE && bx + b.w > lim) { bx = LANE; by = rowBottom + Math.round(86 * z); row++; }
      const g = Object.assign({}, b, { x: bx, y: by, row });
      bx += b.w + BG; rowBottom = Math.max(rowBottom, by + b.h);
      return g;
    });
    return { geo, H: rowBottom - BY };
  }
  const L0 = layoutAt(Infinity), wrap0 = L0.W > MAXW;
  let pick = arrange(L0.bs, wrap0, MAXW);
  if (pick.H > HFIT) {
    const WLIM = wrap0 ? avail : Math.max(avail, L0.W);   // 一行最多铺满可用宽度（原本就更宽的不再加宽）
    let fit = null, low = null;
    const consider = A => { if (A.H <= HFIT) return true; if (!low || A.H < low.H - 40 * z) low = A; return false; };
    // 先试树形分列：上限从高到低，第一个一屏放得下的改动最少
    for (const f of [3, 2.5, 2, 1.6, 1.3, 1.15, 1, 0.85, 0.7, 0.55, 0.45]) {
      const L = layoutAt(Math.round(HFIT * f));
      if (L.bs.some(b => b.w > WLIM)) continue;
      const A = arrange(L.bs, L.W > WLIM, WLIM);
      if (consider(A)) { fit = A; break; }
    }
    if (!fit) {
      // 再试大纲式：每个框可以是树形，或大纲式 1～8 列。找最低的高度 H，使每个框都取「不高于 H 的最窄排法」时一行放得下；
      // 然后能换回树形的框（树形也不高于 H、换了也不超宽）换回树形
      const opts = tops.map((t, bi) => {
        const list = [L0.bs[bi]];
        for (let K = 1; K <= 8; K++) { const ch = outlineChunks(t, K); if (!ch) break; const g = boxOutline(t, ch, null, 0, 0); list.push({ t, mode: 'outline', chunks: ch, w: g.w, h: g.h }); }
        return list;
      });
      const sumW = bs => bs.reduce((s, b) => s + b.w, 0) + BG * (bs.length - 1);
      const choose = H => {
        const bs = opts.map(l => l.filter(o => o.h <= H).sort((a, b) => a.w - b.w)[0]);
        return bs.every(Boolean) && sumW(bs) <= WLIM ? bs : null;
      };
      const Hs = [...new Set(opts.flat().map(o => o.h))].sort((a, b) => a - b);
      let cur = choose(Math.max(HFIT, Hs[0]));
      if (!cur) for (const H of Hs) { if (H <= HFIT) continue; cur = choose(H); if (cur) break; }
      if (!cur) cur = opts.map(l => l[0]);
      const Hc = Math.max(HFIT, ...cur.map(b => b.h));
      cur.forEach((b, bi) => { const tr = opts[bi][0]; if (b !== tr && tr.h <= Hc && sumW(cur) - b.w + tr.w <= WLIM) cur[bi] = tr; });
      // 大纲式的框：同一标签下直接挂的一组作品尽量不拆到两列。这一排的高度由最高的框决定，在这个高度以内
      // 换一种切法能少拆就换（少拆一样多时取最矮的），列数不变；少拆不了就保持原样。
      // 整排宽度不超过 Wrow：换之前没超出可用宽度的，换完也不超出；换之前就超出的，换完不比换之前宽
      const Hrow = Math.max(...cur.map(b => b.h)), Wrow = Math.min(WLIM, Math.max(sumW(cur), avail));
      cur.forEach((b, bi) => {
        if (b.mode !== 'outline' || b.chunks.length < 2 || !tears(b.t, b.chunks)) return;
        const ch = outlineChunks(b.t, b.chunks.length, Hrow - PADT - MULTI_T - PADB);
        if (!ch || tears(b.t, ch) >= tears(b.t, b.chunks)) return;
        const g = boxOutline(b.t, ch, null, 0, 0);
        if (g.h <= Hrow && sumW(cur) - b.w + g.w <= Wrow) cur[bi] = { t: b.t, mode: 'outline', chunks: ch, w: g.w, h: g.h };
      });
      const W = cur.reduce((s, b) => s + b.w, 0) + BG * (cur.length - 1);
      const A = arrange(cur, W > WLIM, WLIM);
      if (consider(A)) fit = A;
    }
    const best = fit || low;
    if (best && best.H < pick.H) pick = best;
  }
  const boxGeo = pick.geo;
  const totalW = Math.max(...boxGeo.map(g => g.x + g.w), rootW);
  let maxH = 0;
  boxGeo.forEach(g => {
    const bi = g.t.bi, box = q('box' + bi), tab = g.t.tab;
    Object.assign(box.style, { left: g.x + 'px', top: g.y + 'px', width: g.w + 'px', height: g.h + 'px' });
    g.tab = { x: g.x + TABX, y: g.y - g.t.th / 2, w: g.t.tw, h: g.t.th };
    Object.assign(tab.style, { left: g.tab.x + 'px', top: g.tab.y + 'px' });
    g.out = []; if (g.mode === 'outline') boxOutline(g.t, g.chunks, g.out, g.x, g.y); else boxLayout(g.t, g.cols, g.out, g.x, g.y);
    for (const e of g.out) { e.it.ax = e.x; e.it.ay = e.y; e.it.el.style.left = e.x + 'px'; e.it.el.style.top = e.y + 'px'; }
    maxH = Math.max(maxH, g.y + g.h);
  });
  root.style.left = '0px'; root.style.top = '0px';
  sizeBoard(board, totalW, maxH + 4);
  const R = 14;
  const trunkPath = (lk, cy, cx) => {
    const { port, busY, trunkX: tx } = lk;
    if (Math.abs(tx - port.x) < 1) return `M${port.x},${port.y} V${cy - R} Q${port.x},${cy} ${port.x + R},${cy} H${cx}`;
    const r = Math.max(0, Math.min(R, busY - port.y, (tx - port.x) / 2));
    return `M${port.x},${port.y} V${busY - r} Q${port.x},${busY} ${port.x + r},${busY} H${tx - r} Q${tx},${busY} ${tx},${busY + r} V${cy - R} Q${tx},${cy} ${tx + R},${cy} H${cx}`;
  };
  boxGeo.forEach(g => {
    const tx = g.tab.x + Math.min(g.tab.w / 2, 40 * z), ty = g.tab.y;
    let d;
    if (g.row === 0 && tx > rootW - 20) { const sy = rootH / 2; d = `M${rootW},${sy} H${tx - R} Q${tx},${sy} ${tx},${sy + R} V${ty}`; }
    else if (g.row === 0) d = `M${tx},${rootH} V${ty}`;
    else { const tr = Math.round(16 * z), gy = ty - Math.round(30 * z); d = `M${tr},${rootH} V${gy - R} Q${tr},${gy} ${tr + R},${gy} H${tx - R} Q${tx},${gy} ${tx},${gy + R} V${ty}`; }
    const g1 = svgEl('g', { class: 'eg', 'data-wids': g.out.map(e => e.it.wids).join(' ') }, svg);
    svgEl('path', { d, class: 'edge' }, g1);
    for (const e of g.out) {
      const it = e.it, txx = it.ax, tyy = it.ay + it.h / 2; let d2;
      if (e.link.kind === 'trunk') d2 = trunkPath(e.link, tyy, txx);
      else { const p = e.link.from; const sx = p.ax + p.w, sy = p.ay + p.h / 2, mx = (sx + txx) / 2; d2 = `M${sx},${sy} C${mx},${sy} ${mx},${tyy} ${txx},${tyy}`; }
      const ge = svgEl('g', { class: 'eg', 'data-wids': it.wids }, svg);
      svgEl('path', { d: d2, class: 'edge' }, ge);
    }
  });
}

/* ====================================================================
   02 标签谱
   ==================================================================== */
function seriate(M) {
  const n = M.n; if (n < 3) return M.works.slice();
  const wOf = t => ({ G_1: 2, G_2: 1.6, G_3: 1.6, G_staff: 1.3 }[M.groupOf(t)] || 1);
  const W = M.works.map(a => M.works.map(b => {
    if (a === b) return 0; let s = 0;
    for (const t of a.def) if (!b.def.has(t)) s += wOf(t);
    for (const t of b.def) if (!a.def.has(t)) s += wOf(t);
    for (const t of a.els) if (b.els.has(t)) s -= M.cfg.elseBonus;
    return s;
  }));
  const len = p => { let s = 0; for (let i = 1; i < p.length; i++) s += W[p[i - 1]][p[i]]; return s; };
  let best = null, bestL = Infinity;
  const starts = n <= 60 ? [...Array(n).keys()] : [0, 1, 2, 3, 4, 5, 6, 7].map(i => Math.floor(i * n / 8));
  for (const s of starts) {
    const used = new Uint8Array(n); const p = [s]; used[s] = 1;
    while (p.length < n) { const c = p[p.length - 1]; let bj = -1, bd = Infinity; for (let j = 0; j < n; j++) if (!used[j] && W[c][j] < bd) { bd = W[c][j]; bj = j; } used[bj] = 1; p.push(bj); }
    let imp = true, guard = 0;
    while (imp && guard++ < 200) {
      imp = false;
      for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
        const a = i > 0 ? W[p[i - 1]][p[i]] : 0, b = j < n - 1 ? W[p[j]][p[j + 1]] : 0;
        const a2 = i > 0 ? W[p[i - 1]][p[j]] : 0, b2 = j < n - 1 ? W[p[i]][p[j + 1]] : 0;
        if (a2 + b2 < a + b - 1e-9) { const seg = p.slice(i, j + 1).reverse(); p.splice(i, j - i + 1, ...seg); imp = true; }
      }
    }
    const L = len(p); if (L < bestL - 1e-9) { bestL = L; best = p; }
  }
  const order = best.map(i => M.works[i]);
  if (order[0].def.size < order[order.length - 1].def.size) order.reverse();
  return order;
}
function renderScore(M, board, ctx) {
  const z = ctx.z;
  const { layer } = boardParts(board);
  const order = seriate(M);
  const cols = M.tags.slice();
  const segName = { G_1: '类型', G_2: '题材', G_3: '题材', G_staff: '制作', G_format: '形式', G_source: '来源', G_4: '其它', G_else: '低频' };
  const segOf = t => { const g = M.groupOf(t); return (g === 'G_2' || g === 'G_3') ? 'G_23' : g; };
  const meas = document.createElement('span'); meas.className = 'tg hi'; meas.style.cssText = 'position:absolute;visibility:hidden;font-weight:500'; layer.appendChild(meas);
  const colW = cols.map(t => { meas.textContent = t; return Math.max(Math.round(38 * z), meas.offsetWidth + Math.round(4 * z)); });
  meas.remove();
  const TW = Math.round(282 * z), DW = Math.round(186 * z), SG = Math.round(10 * z);
  const gapIdx = new Set(); cols.forEach((t, i) => { if (i < cols.length - 1 && segOf(t) !== segOf(cols[i + 1])) gapIdx.add(i); });
  const tmpl = `${TW}px ` + colW.map((w, i) => `${w}px` + (gapIdx.has(i) ? ` ${SG}px` : '')).join(' ') + ` ${DW}px`;
  let html = `<div class="score" style="--cols:${tmpl}">`;
  let segRow = `<div class="srow seg"><div class="c" style="text-align:left;border:0;padding-left:6px;letter-spacing:.04em">共有：${esc(M.common.join(' ') || '—')}</div>`;
  let i = 0;
  while (i < cols.length) {
    let j = i; while (j + 1 < cols.length && segOf(cols[j + 1]) === segOf(cols[i])) j++;
    segRow += `<div class="c" style="grid-column: span ${j - i + 1}">${segName[M.groupOf(cols[i])] || '其它'}</div>`;
    if (j < cols.length - 1) segRow += `<div></div>`;
    i = j + 1;
  }
  html += segRow + `<div class="c" style="border:0;text-align:left;padding-left:12px">与上一行相比</div></div>`;
  let hd = `<div class="srow hd"><div class="c"></div>`;
  cols.forEach((t, k) => { hd += `<div class="c">${chip(M, t)}<span class="f">${M.freq.get(t)}</span></div>`; if (gapIdx.has(k)) hd += '<div></div>'; });
  html += hd + `<div class="c"></div></div>`;
  const has = (w, t) => w.def.has(t) || w.els.has(t);
  const brk = order.map((w, r) => r > 0 && M.sd[order[r - 1].idx][w.idx] >= 3);
  order.forEach((w, r) => {
    const prev = order[r - 1], next = order[r + 1];
    let row = `<div class="srow body dm${brk[r] ? ' gap' : ''}" data-wid="${esc(w.id)}"><div class="ttl">${coverImg(w)}${titleHTML(w)}${metaHTML(w)}<span class="diff"></span></div>`;
    cols.forEach((t, k) => {
      if (has(w, t)) {
        const h = M.hue.get(t), g = M.groupOf(t);
        const kind = h != null ? 'hi' : (g === 'G_else' ? 'lo' : 'st');
        const jt = prev && !brk[r] && has(prev, t), jb = next && !brk[r + 1] && has(next, t);
        row += `<div class="sc-cell on ${kind}${jt ? ' jt' : ''}${jb ? ' jb' : ''}" data-tag="${esc(t)}"${h != null ? ` style="--h:${h}"` : ''}>${esc(t)}</div>`;
      } else row += `<div class="sc-cell off" data-ntag="${esc(t)}"></div>`;
      if (gapIdx.has(k)) row += '<div></div>';
    });
    let dc;
    if (!prev || brk[r]) dc = `<span class="eq">${prev ? '（新的一组）' : '—'}</span>`;
    else {
      const df = diffOf(M, prev, w);
      dc = (!df.plus.length && !df.minus.length) ? `<span class="eq">＝ 完全相同</span>`
        : `<span class="up">↑</span>` + df.plus.map(t => chip(M, t, 'plus')).join('') + df.minus.map(t => chip(M, t, 'minus')).join('');
    }
    html += row + `<div class="dcell">${dc}</div></div>`;
  });
  layer.innerHTML = html + `</div>`;
  board.style.width = 'auto'; board.style.height = 'auto';
  board.style.width = layer.querySelector('.score').offsetWidth + 'px';
}

/* ====================================================================
   03 卡诺图
   ==================================================================== */
function pickAxes(M, k = 4) {
  const n = M.n;
  const H = p => p <= 0 || p >= 1 ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
  const c = M.tags.filter(t => ['G_1', 'G_2', 'G_3'].includes(M.groupOf(t))).map(t => ({ t, f: M.freq.get(t) })).filter(o => o.f >= 2 && o.f <= n - 2 + (n <= 4 ? 1 : 0));
  c.sort((a, b) => H(b.f / n) - H(a.f / n) || b.f - a.f || M.cmpTag(a.t, b.t));
  return c.slice(0, k).map(o => o.t).sort((a, b) => M.freq.get(b) - M.freq.get(a) || M.cmpTag(a, b));
}
const GRAY = { 1: [[0], [1]], 2: [[0, 0], [0, 1], [1, 1], [1, 0]] };
function renderKmap(M, board, ctx) {
  const z = ctx.z;
  const { layer } = boardParts(board);
  const ax = pickAxes(M, 4);
  if (ax.length < 2) { layer.innerHTML = `<p class="wait">这份数据里能当主轴的标签不足 2 个（需要出现在至少 2 部、至多 n−2 部作品里）。</p>`; board.style.width = 'auto'; return; }
  const colTags = ax.slice(0, 2), rowTags = ax.slice(2);
  const cseq = GRAY[colTags.length], rseq = rowTags.length ? GRAY[rowTags.length] : [[]];
  const nc = cseq.length, nr = rseq.length;
  const LW = Math.round(78 * z), lblCols = rowTags.length;
  const bw = board.closest('.board-wrap');
  const avail = (bw && bw.clientWidth || 1400) - 46;
  const CW = Math.round(Math.max(236 * z, Math.min(272 * z, (avail - lblCols * LW) / nc)));
  let html = `<div class="kmap" style="grid-template-columns:${Array(lblCols).fill(LW + 'px').join(' ')} ${Array(nc).fill(`minmax(${CW}px, 1fr)`).join(' ')}">`;
  colTags.forEach((t, ti) => {
    if (lblCols) html += `<div style="grid-column: 1 / span ${lblCols}"></div>`;
    let ci = 0;
    while (ci < nc) {
      const v = cseq[ci][ti]; let cj = ci; while (cj + 1 < nc && cseq[cj + 1][ti] === v) cj++;
      const h = M.hue.get(t);
      html += `<div class="kh ${v ? 'pos' : 'neg'}" style="grid-column: span ${cj - ci + 1};${h != null ? `--h:${h}` : ''}">${chip(M, t, v ? '' : 'neg')}</div>`;
      ci = cj + 1;
    }
  });
  const cellWorks = (rv, cv) => M.works.filter(w => colTags.every((t, i) => w.def.has(t) === !!cv[i]) && rowTags.every((t, i) => w.def.has(t) === !!rv[i]));
  const omit = new Set(ax);
  for (let r = 0; r < nr; r++) {
    rowTags.forEach((t, ti) => {
      const v = rseq[r][ti];
      if (!(r === 0 || rseq[r - 1][ti] !== v)) return;
      let rj = r; while (rj + 1 < nr && rseq[rj + 1][ti] === v) rj++;
      const h = M.hue.get(t);
      html += `<div class="kh vert ${v ? 'pos' : 'neg'}" style="grid-column:${ti + 1};grid-row: ${r + colTags.length + 1} / span ${rj - r + 1};${h != null ? `--h:${h}` : ''}">${chip(M, t, v ? '' : 'neg')}</div>`;
    });
    for (let c = 0; c < nc; c++) {
      const ws = cellWorks(rseq[r], cseq[c]).sort((a, b) => b.def.size - a.def.size || (b.score ?? 0) - (a.score ?? 0));
      const posT = [...colTags.filter((t, i) => cseq[c][i]), ...rowTags.filter((t, i) => rseq[r][i])].sort(M.cmpTag);
      const cap = posT.length ? posT.map(t => chip(M, t, 'gh')).join('') : `<span>${ax.length === 4 ? '四个都没有' : '都没有'}</span>`;
      html += `<div class="kc${ws.length ? '' : ' empty'}" style="grid-column:${lblCols + c + 1};grid-row:${r + colTags.length + 1}"><div class="cap">${cap}</div>`;
      if (!ws.length) html += `<span class="ecap">没有作品</span>`;
      ws.forEach(w => html += workCard(M, w, { omit, cls: 'compact' }));
      html += `</div>`;
    }
  }
  html += `</div><div class="kwrap">${nc === 4 ? '左右两端' : ''}${nc === 4 && nr === 4 ? '、' : ''}${nr === 4 ? '上下两端' : ''}${nc === 4 || nr === 4 ? '在逻辑上也相邻（各自只差一个标签）' : ''}</div>`;
  layer.innerHTML = html;
  board.style.width = 'auto'; board.style.height = 'auto';
  board.style.width = Math.max(layer.querySelector('.kmap').scrollWidth, lblCols * LW + nc * CW) + 'px';
}

/* ====================================================================
   04 增减阶梯（Hasse）
   ==================================================================== */
function renderHasse(M, board, ctx) {
  const z = ctx.z;
  const { svg, layer } = boardParts(board);
  const q = finder(layer);
  const MAXD = 2;
  const gm = new Map();
  for (const w of M.works) { const key = [...w.def].sort().join('|'); if (!gm.has(key)) gm.set(key, { key, set: w.def, works: [] }); gm.get(key).works.push(w); }
  const nodes = [...gm.values()];
  nodes.forEach((nd, i) => { nd.i = i; nd.size = nd.set.size; });
  const sizes = [...new Set(nodes.map(nd => nd.size))].sort((a, b) => a - b);
  nodes.forEach(nd => nd.L = sizes.indexOf(nd.size));
  const sub = (a, b) => a.size < b.size && [...a.set].every(t => b.set.has(t));
  const edges = [];
  for (const a of nodes) for (const b of nodes) if (sub(a, b) && !nodes.some(c => sub(a, c) && sub(c, b))) {
    const plus = [...b.set].filter(t => !a.set.has(t)).sort(M.cmpTag);
    if (plus.length <= MAXD) edges.push({ a, b, plus });
  }
  const deg = new Map(nodes.map(nd => [nd, 0])); edges.forEach(e => { deg.set(e.a, deg.get(e.a) + 1); deg.set(e.b, deg.get(e.b) + 1); });
  const swaps = [];
  for (const a of nodes) {
    if (deg.get(a)) continue;
    let best = null, bs = -1;
    for (const b of nodes) {
      if (b === a || b.L !== a.L) continue;
      const p = [...b.set].filter(t => !a.set.has(t)), m = [...a.set].filter(t => !b.set.has(t));
      if (p.length !== 1 || m.length !== 1) continue;
      const s = (M.groupOf(p[0]) === M.groupOf(m[0]) ? 10 : 0) + b.works.length;
      if (s > bs) { bs = s; best = { a, b, from: m[0], to: p[0] }; }
    }
    if (best) swaps.push(best);
  }
  const NODE_W = Math.round(228 * z);
  let html = '';
  nodes.forEach(nd => {
    html += `<div class="hnode dm${nd.works.length > 1 ? ' multi' : ''}" data-k="n${nd.i}" data-wids="${esc(nd.works.map(w => w.id).join(' '))}" style="width:${NODE_W}px">`;
    nd.works.forEach(w => { html += `<div class="hw" data-wid="${esc(w.id)}">${coverImg(w)}<div class="wh">${titleHTML(w)}${metaHTML(w)}</div><span class="diff"></span></div>`; });
    const els = [...new Set(nd.works.flatMap(w => [...w.els]))];
    html += `<div class="wtags">${tagChips(M, { def: nd.set, els: new Set(els) })}</div></div>`;
  });
  const wl = nd => esc(nd.works.map(w => w.id).join(' '));
  edges.forEach((e, k) => { html += `<div class="hlab eg${e.plus.length > 1 ? ' faint' : ''}" data-k="l${k}" data-wa="${wl(e.a)}" data-wb="${wl(e.b)}">${e.plus.map(t => chip(M, t, 'plus')).join('')}</div>`; });
  swaps.forEach((s, k) => { html += `<div class="hlab eg" data-k="s${k}" data-wa="${wl(s.a)}" data-wb="${wl(s.b)}">${chip(M, s.from)}<span class="swap">⇄</span>${chip(M, s.to)}</div>`; });
  sizes.forEach((s, L) => { html += `<div class="hlayer" data-k="y${L}"><b>${s}</b>个标签</div>`; });
  layer.innerHTML = html;
  nodes.forEach(nd => { nd.el = q('n' + nd.i); nd.w = nd.el.offsetWidth; nd.h = nd.el.offsetHeight; });
  edges.forEach((e, k) => { e.el = q('l' + k); e.lw = e.el.offsetWidth; e.lh = e.el.offsetHeight; });
  swaps.forEach((s, k) => { s.el = q('s' + k); s.lw = s.el.offsetWidth; s.lh = s.el.offsetHeight; });
  const NL = sizes.length;
  const layers = Array.from({ length: NL }, () => []);
  nodes.forEach(nd => { nd.item = { kind: 'node', nd, w: nd.w, up: [], dn: [] }; layers[nd.L].push(nd.item); });
  edges.forEach(e => {
    e.chain = [e.a.item];
    for (let L = e.a.L + 1; L < e.b.L; L++) { const d = { kind: 'dummy', e, w: e.lw + 16 * z, up: [], dn: [] }; layers[L].push(d); e.chain.push(d); }
    e.chain.push(e.b.item);
    for (let i = 1; i < e.chain.length; i++) { e.chain[i - 1].dn.push(e.chain[i]); e.chain[i].up.push(e.chain[i - 1]); }
  });
  // 排序：重心法起步，再对每层做穷举（≤7 个）或相邻交换，目标：交叉最少、一换一的伙伴相邻、连线最短
  layers.forEach((Ls, L) => Ls.forEach(u => u.L = L));
  layers.forEach(Ls => Ls.sort((p, r) => (p.kind === 'node' ? p.nd.key : '~').localeCompare(r.kind === 'node' ? r.nd.key : '~')));
  const idx = () => layers.forEach(Ls => Ls.forEach((it, i) => it.o = i));
  idx();
  for (let it = 0; it < 8; it++) {
    const down = it % 2 === 0;
    const seq = down ? [...Array(NL).keys()].slice(1) : [...Array(NL).keys()].reverse().slice(1);
    for (const L of seq) {
      const Ls = layers[L];
      Ls.forEach(u => { const nb = down ? u.up : u.dn; u.bc = nb.length ? nb.reduce((s, v) => s + v.o, 0) / nb.length : u.o; });
      Ls.sort((p, r) => p.bc - r.bc || p.o - r.o); Ls.forEach((u, i) => u.o = i);
    }
  }
  const swapPairs = swaps.map(sw => [sw.a.item, sw.b.item]);
  const pairCross = L => {
    const pairs = []; layers[L].forEach(u => u.dn.forEach(v => pairs.push([u.o, v.o])));
    let c = 0; for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) if ((pairs[i][0] - pairs[j][0]) * (pairs[i][1] - pairs[j][1]) < 0) c++;
    return c;
  };
  const nrm = u => u.o - (layers[u.L].length - 1) / 2;
  const layerCost = L => {
    let c = 1000 * ((L > 0 ? pairCross(L - 1) : 0) + (L < NL - 1 ? pairCross(L) : 0));
    for (const [a, b] of swapPairs) if (a.L === L) c += 50 * (Math.abs(a.o - b.o) - 1);
    layers[L].forEach(u => { u.up.forEach(v => c += Math.abs(nrm(u) - nrm(v))); u.dn.forEach(v => c += Math.abs(nrm(u) - nrm(v))); });
    return c;
  };
  function permute(arr, k, cb) { if (k === arr.length) { cb(arr); return; } for (let i = k; i < arr.length; i++) { [arr[k], arr[i]] = [arr[i], arr[k]]; permute(arr, k + 1, cb); [arr[k], arr[i]] = [arr[i], arr[k]]; } }
  for (let sweep = 0; sweep < 6; sweep++) {
    let improved = false;
    for (let L = 0; L < NL; L++) {
      const Ls = layers[L]; if (Ls.length < 2) continue;
      let bestC = layerCost(L), best = Ls.slice();
      if (Ls.length <= 7) {
        permute(Ls.slice(), 0, perm => { perm.forEach((u, i) => u.o = i); layers[L] = perm; const c = layerCost(L); if (c < bestC - 1e-9) { bestC = c; best = perm.slice(); improved = true; } });
      } else {
        let again = true;
        while (again) { again = false; for (let i = 0; i + 1 < best.length; i++) { const t = best.slice();[t[i], t[i + 1]] = [t[i + 1], t[i]]; t.forEach((u, j) => u.o = j); layers[L] = t; const c = layerCost(L); if (c < bestC - 1e-9) { bestC = c; best = t; again = improved = true; } } }
      }
      layers[L] = best; best.forEach((u, i) => u.o = i);
    }
    if (!improved) break;
  }
  idx();
  // 横坐标：块合并逼近相邻节点的重心，限制在最宽一层的宽度内
  const GAP = Math.round(20 * z);
  const natW = Ls => Ls.reduce((s, u) => s + u.w, 0) + GAP * Math.max(0, Ls.length - 1);
  const WMAX = Math.max(...layers.map(natW));
  layers.forEach(Ls => { let x = (WMAX - natW(Ls)) / 2; Ls.forEach(u => { u.x = x + u.w / 2; x += u.w + GAP; }); });
  const swapPartner = new Map(); swaps.forEach(sw => { swapPartner.set(sw.a.item, sw.b.item); swapPartner.set(sw.b.item, sw.a.item); });
  function placeLayer(Ls) {
    const want = Ls.map(u => { const nb = [...u.up, ...u.dn]; const sp = swapPartner.get(u); if (!nb.length && sp) return sp.x + (sp.o < u.o ? 1 : -1) * (sp.w / 2 + u.w / 2 + GAP); return nb.length ? nb.reduce((s, v) => s + v.x, 0) / nb.length : u.x; });
    const blocks = [];
    Ls.forEach((u, i) => {
      blocks.push({ items: [i], off: [0], width: u.w, pos: want[i] });
      while (blocks.length > 1) {
        const B = blocks[blocks.length - 1], A = blocks[blocks.length - 2];
        if (B.pos - Ls[B.items[0]].w / 2 >= A.pos - Ls[A.items[0]].w / 2 + A.width + GAP) break;
        const shift = A.width + GAP;
        const merged = { items: [...A.items, ...B.items], width: A.width + GAP + B.width, off: [...A.off, ...B.off.map(o => o + shift)] };
        const w0 = Ls[merged.items[0]].w;
        let sum = 0; merged.items.forEach((ii, k) => { sum += want[ii] - merged.off[k] - (Ls[ii].w - w0) / 2; });
        merged.pos = sum / merged.items.length;
        blocks.pop(); blocks.pop(); blocks.push(merged);
      }
    });
    blocks.forEach(b => { const w0 = Ls[b.items[0]].w; b.items.forEach((ii, k) => { Ls[ii].x = b.pos + b.off[k] + (Ls[ii].w - w0) / 2; }); });
    for (let i = 0; i < Ls.length; i++) { const lo = i ? Ls[i - 1].x + Ls[i - 1].w / 2 + GAP + Ls[i].w / 2 : Ls[i].w / 2; if (Ls[i].x < lo) Ls[i].x = lo; }
    for (let i = Ls.length - 1; i >= 0; i--) { const hi = i < Ls.length - 1 ? Ls[i + 1].x - Ls[i + 1].w / 2 - GAP - Ls[i].w / 2 : WMAX - Ls[i].w / 2; if (Ls[i].x > hi) Ls[i].x = hi; }
  }
  for (let it = 0; it < 30; it++) (it % 2 ? [...layers].reverse() : layers).forEach(placeLayer);
  let minX = Infinity, maxX = -Infinity;
  layers.forEach(Ls => Ls.forEach(u => { minX = Math.min(minX, u.x - u.w / 2); maxX = Math.max(maxX, u.x + u.w / 2); }));
  const LEFT = Math.round(70 * z);
  layers.forEach(Ls => Ls.forEach(u => u.x += LEFT - minX));
  const VGAP = Math.round(84 * z);
  let y = Math.round(26 * z); const layerY = [], layerH = [];
  layers.forEach((Ls, L) => { const h = Math.max(30, ...Ls.filter(u => u.kind === 'node').map(u => u.nd.h)); layerY[L] = y; layerH[L] = h; y += h + VGAP; });
  sizeBoard(board, maxX - minX + LEFT + Math.round(20 * z), y - VGAP + Math.round(20 * z));
  nodes.forEach(nd => { nd.x = nd.item.x - nd.w / 2; nd.y = layerY[nd.L]; nd.el.style.left = nd.x + 'px'; nd.el.style.top = nd.y + 'px'; });
  sizes.forEach((s, L) => { const e = q('y' + L); e.style.left = '0px'; e.style.top = (layerY[L] + 4) + 'px'; });
  const placed = [];
  const overlaps = r => placed.some(p => r.x < p.x + p.w && p.x < r.x + r.w && r.y < p.y + p.h && p.y < r.y + r.h) || nodes.some(nd => r.x < nd.x + nd.w && nd.x < r.x + r.w && r.y < nd.y + nd.h && nd.y < r.y + r.h);
  const bez = (p0, p1, p2, p3, t) => { const m = 1 - t; return m * m * m * p0 + 3 * m * m * t * p1 + 3 * m * t * t * p2 + t * t * t * p3; };
  edges.forEach(e => {
    const pts = [];
    e.chain.forEach((u, i) => {
      if (u.kind === 'node') pts.push(i === 0 ? [u.x, u.nd.y + u.nd.h] : [u.x, u.nd.y]);
      else { const L = e.a.L + i; pts.push([u.x, layerY[L] - 6]); pts.push([u.x, layerY[L] + layerH[L] + 6]); }
    });
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      if (x0 === x1 && i % 2 === 0 && e.chain.length > 2) { d += ` L${x1},${y1}`; continue; }
      const my = (y0 + y1) / 2; d += ` C${x0},${my} ${x1},${my} ${x1},${y1}`;
    }
    const g = svgEl('g', { class: 'eg', 'data-wa': e.a.works.map(w => w.id).join(' '), 'data-wb': e.b.works.map(w => w.id).join(' ') }, svg);
    svgEl('path', { d, class: 'hedge' + (e.plus.length > 1 ? ' two' : '') }, g);
    let lx, ly;
    if (e.chain.length > 2) { const u = e.chain[1]; lx = u.x - e.lw / 2; ly = layerY[e.a.L + 1] + layerH[e.a.L + 1] / 2 - e.lh / 2; }
    else {
      const [x0, y0] = pts[0], [x1, y1] = pts[1]; const my = (y0 + y1) / 2;
      for (const t of [0.5, 0.36, 0.64, 0.26, 0.74]) {
        const px = bez(x0, x0, x1, x1, t), py = bez(y0, my, my, y1, t);
        lx = px - e.lw / 2; ly = py - e.lh / 2; if (!overlaps({ x: lx, y: ly, w: e.lw, h: e.lh })) break;
      }
    }
    placed.push({ x: lx, y: ly, w: e.lw, h: e.lh });
    e.el.style.left = lx + 'px'; e.el.style.top = ly + 'px';
  });
  swaps.forEach(s => {
    const ax = s.a.item.x, bx = s.b.item.x, y0 = layerY[s.a.L], top = y0 - Math.round(30 * z);
    const g = svgEl('g', { class: 'eg', 'data-wa': s.a.works.map(w => w.id).join(' '), 'data-wb': s.b.works.map(w => w.id).join(' ') }, svg);
    svgEl('path', { d: `M${ax},${y0} C${ax},${top} ${bx},${top} ${bx},${y0}`, class: 'hswap' }, g);
    s.el.style.left = ((ax + bx) / 2 - s.lw / 2) + 'px'; s.el.style.top = (y0 - Math.round(23 * z) - s.lh / 2) + 'px';
  });
}

/* ====================================================================
   05 领地图
   ==================================================================== */
const TERR_CACHE = new WeakMap();
const FULL_OWNER = { inst: null };                    // 正在全屏的实例（同一时间最多一个）
const ESC_REC = new WeakMap();                        // Esc 按键事件 → { owner：第一个实例收到它时谁在全屏，cur：这次 Esc 归哪个实例（'pane' 用），used：有没有实例用掉它 }
const LIVE = new Set();                               // 页面上还没 destroy 的实例
const SEQ = { n: 0 };                                 // 交互序号：实例被点击 / 获得焦点时记 inst._seq = ++SEQ.n（Esc 找「最后交互的」用）
const GRAB = { inst: null };                          // 按住空格时处在抓手模式的 'pane' 实例（同一时间最多一个，跟着鼠标换）
// 最后已知的指针坐标（focusWorks 判断「鼠标真正移动了没有」的基准）。有实例时在 document 上挂一个被动监听，只记坐标，
// 所有实例共用；最后一个实例 destroy 时摘掉。页面打开后鼠标没动过 = 不知道（null）
const PTR = { x: null, y: null, n: 0 };
const onPtr = e => { PTR.x = e.clientX; PTR.y = e.clientY; };
const PTR_EV = ['pointermove', 'pointerover', 'pointerdown'], PTR_OPT = { capture: true, passive: true };
function ptrOn() { if (PTR.n++ === 0) PTR_EV.forEach(t => document.addEventListener(t, onPtr, PTR_OPT)); }
function ptrOff() { if (PTR.n > 0 && --PTR.n === 0) { PTR_EV.forEach(t => document.removeEventListener(t, onPtr, PTR_OPT)); PTR.x = PTR.y = null; } }
function territories(M) {
  const n = M.n, T = [];
  for (const t of M.tags) {
    const g = M.groupOf(t); if (!['G_1', 'G_2', 'G_3', 'G_4', 'G_staff'].includes(g)) continue;
    const f = M.freq.get(t);
    if (f > n / 2) { if (n - f >= 2) T.push({ tag: t, neg: true, members: M.works.filter(w => !w.def.has(t)).map(w => w.idx) }); }
    else if (f >= 2) T.push({ tag: t, neg: false, members: M.works.filter(w => w.def.has(t)).map(w => w.idx) });
  }
  const pri = { G_1: 0, G_2: 1, G_3: 2, G_staff: 3, G_4: 4 };
  T.sort((a, b) => pri[M.groupOf(a.tag)] - pri[M.groupOf(b.tag)] || b.members.length - a.members.length);
  return T.slice(0, M.cfg.maxTerritories);
}
function territorySignature(M, T) {
  return 'v2:' + hashStr(JSON.stringify([M.works.map(w => [w.id, [...w.def].sort()]), T.map(t => (t.neg ? '!' : '') + t.tag)]));
}
// 网格：一格（卡片加四周留白）大约宽 2 高 1，取 2～6 列让整张图略横；格子数 = 作品数补满最后一行，空格不超过一行
function terrGrid(n) {
  const cols = Math.max(2, Math.min(6, Math.round(Math.sqrt(n * 0.8))));
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}
// 缓存来自笔记文件，可能被手改坏：行列数不超过本该有的网格、坐标是格内整数且互不重叠，才用；否则现算。
function cacheFits(cache, sig, M, maxCols, maxRows) {
  if (!cache || cache.sig !== sig || !cache.pos || typeof cache.pos !== 'object') return false;
  const { cols, rows } = cache;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > maxCols || rows > maxRows) return false;
  const seen = new Set();
  for (const w of M.works) {
    const p = cache.pos[w.id];
    if (!Array.isArray(p) || p.length !== 2) return false;
    const [x, y] = p;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= cols || y >= rows) return false;
    const c = y * cols + x; if (seen.has(c)) return false; seen.add(c);
  }
  // 和现算的结果同样的形状：前面各行占满，空格只在最后一行；最后一行不空；没有整列空着
  for (let c = 0; c < (rows - 1) * cols; c++) if (!seen.has(c)) return false;
  const colUsed = new Set([...seen].map(c => c % cols));
  if (![...seen].some(c => c >= (rows - 1) * cols) || colUsed.size !== cols) return false;
  return true;
}
// 模拟退火：每步交换两个格子（一半随机、一半相邻），只重算受影响的领地。空格只许待在最后一行。
// 代价 = 每块领地（断成几块、周长、洞、外接矩形里的空位）+ 没有领地的作品和空格（聚成一块、靠边）+ 相邻作品的标签差别。
function solveTerritory(M, cache) {
  if (TERR_CACHE.has(M)) return TERR_CACHE.get(M);
  const n = M.n, T = territories(M);
  const sig = territorySignature(M, T);
  const { cols, rows } = terrGrid(n);
  if (cacheFits(cache, sig, M, cols, rows)) {
    const res = { T, cols: cache.cols, rows: cache.rows, pos: M.works.map(w => cache.pos[w.id].slice()), sig, fromCache: true };
    TERR_CACHE.set(M, res); return res;
  }
  const C = cols * rows, NT = T.length, D = M.D;
  const nb = []; for (let c = 0; c < C; c++) { const x = c % cols, y = (c / cols) | 0; nb.push([y > 0 ? c - cols : -1, x < cols - 1 ? c + 1 : -1, y < rows - 1 ? c + cols : -1, x > 0 ? c - 1 : -1]); }
  const LAST = (rows - 1) * cols;                      // 最后一行第一格；空格只能在 c >= LAST
  const memb = T.map(t => t.members);
  const tOf = Array.from({ length: n }, () => []); memb.forEach((mem, k) => mem.forEach(i => tOf[i].push(k)));
  const inT = memb.map(mem => { const a = new Uint8Array(n); mem.forEach(i => { a[i] = 1; }); return a; });
  const orph = new Uint8Array(n); for (let i = 0; i < n; i++) orph[i] = tOf[i].length ? 0 : 1;
  const hasRest = C > n || orph.some(v => v);
  const W = { comp: 90, per: 1.5, hole: 12, box: 1.5, adj: 0.35, ocomp: 40, oper: 1.2, gap: 8, t0: 6 };
  const cellOf = new Int32Array(n), occ = new Int32Array(C);
  const mark = new Int32Array(C), stack = new Int32Array(C); let stamp = 0;
  const isRest = c => { const o = occ[c]; return o < 0 || orph[o] === 1; };
  function terrCost(k) {
    const mem = memb[k], inn = inT[k];
    let per = 0, comps = 0, holes = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
    const s1 = ++stamp;
    for (const i of mem) {
      const c = cellOf[i], q = nb[c], x = c % cols, y = (c / cols) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let j = 0; j < 4; j++) { const d = q[j]; if (d < 0) per++; else { const o = occ[d]; if (o < 0 || !inn[o]) per++; } }
      if (mark[c] === s1) continue;
      comps++; let sp = 0; stack[sp++] = c; mark[c] = s1;
      while (sp) { const qu = nb[stack[--sp]]; for (let j = 0; j < 4; j++) { const v = qu[j]; if (v >= 0 && mark[v] !== s1) { const o = occ[v]; if (o >= 0 && inn[o]) { mark[v] = s1; stack[sp++] = v; } } } }
    }
    // 洞：不属于本领地、上下左右都属于本领地的格子（本领地的格子此时都标成了 s1）
    const s2 = ++stamp;
    for (const i of mem) {
      const q = nb[cellOf[i]];
      for (let j = 0; j < 4; j++) {
        const d = q[j]; if (d < 0 || mark[d] === s1 || mark[d] === s2) continue;
        mark[d] = s2; const qd = nb[d]; let all = true;
        for (let h = 0; h < 4; h++) { const v = qd[h]; if (v < 0 || mark[v] !== s1) { all = false; break; } }
        if (all) holes++;
      }
    }
    return W.comp * (comps - 1) + W.per * per + W.hole * holes + W.box * ((x1 - x0 + 1) * (y1 - y0 + 1) - mem.length);
  }
  // 没有领地的作品和空格：连成一块（断开要罚）、和领地作品的接触边越少越好（贴边不算接触）；
  // 最后一行里，左右两边都有作品的空格算夹在中间，要罚
  function restCost() {
    if (!hasRest) return 0;
    let per = 0, comps = 0, gap = 0; const s1 = ++stamp;
    if (C > n) {
      let l = C, r = -1; for (let c = LAST; c < C; c++) if (occ[c] >= 0) { if (c < l) l = c; r = c; }
      for (let c = l + 1; c < r; c++) if (occ[c] < 0) gap++;
    }
    for (let c = 0; c < C; c++) {
      if (!isRest(c)) continue;
      const q = nb[c]; for (let j = 0; j < 4; j++) { const d = q[j]; if (d >= 0 && !isRest(d)) per++; }
      if (mark[c] === s1) continue;
      comps++; let sp = 0; stack[sp++] = c; mark[c] = s1;
      while (sp) { const qu = nb[stack[--sp]]; for (let j = 0; j < 4; j++) { const v = qu[j]; if (v >= 0 && mark[v] !== s1 && isRest(v)) { mark[v] = s1; stack[sp++] = v; } } }
    }
    return W.ocomp * (comps - 1) + W.oper * per + W.gap * gap;
  }
  // 格子 c 上的作品和相邻作品的标签差别之和（不算 skip 那一格）
  function adjAt(c, skip) {
    const a = occ[c]; if (a < 0) return 0;
    let s = 0; const q = nb[c];
    for (let j = 0; j < 4; j++) { const d = q[j]; if (d < 0 || d === skip) continue; const b = occ[d]; if (b >= 0) s += D[a][b]; }
    return s;
  }
  function adjAll() { let s = 0; for (let c = 0; c < C; c++) { const a = occ[c]; if (a < 0) continue; const r = nb[c][1], d = nb[c][2]; if (r >= 0 && occ[r] >= 0) s += D[a][occ[r]]; if (d >= 0 && occ[d] >= 0) s += D[a][occ[d]]; } return s; }
  function total() { let s = restCost() + W.adj * adjAll(); for (let k = 0; k < NT; k++) s += terrCost(k); return s; }
  const tc = new Float64Array(NT), keep = new Float64Array(NT), seenK = new Int32Array(NT), aff = new Int32Array(NT);
  let affStamp = 0;
  let best = null, bestS = Infinity;
  const restarts = n > 40 ? 6 : 10, ITER = Math.round(40000 * Math.max(1, n / 19));
  for (let rs = 0; rs < restarts; rs++) {
    const rng = mulberry32(1234 + rs * 7919);
    // 先在最后一行随机挑出空格，其余格子随机放作品
    const lastRow = []; for (let c = LAST; c < C; c++) lastRow.push(c);
    for (let i = lastRow.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0;[lastRow[i], lastRow[j]] = [lastRow[j], lastRow[i]]; }
    const empty = new Set(lastRow.slice(0, C - n));
    const cells = [...Array(C).keys()].filter(c => !empty.has(c)); for (let i = cells.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0;[cells[i], cells[j]] = [cells[j], cells[i]]; }
    occ.fill(-1); for (let i = 0; i < n; i++) { cellOf[i] = cells[i]; occ[cells[i]] = i; }
    for (let k = 0; k < NT; k++) tc[k] = terrCost(k);
    let rc = restCost(), cur = rc + W.adj * adjAll(); for (let k = 0; k < NT; k++) cur += tc[k];
    let temp = W.t0; const cool = Math.pow(0.02 / temp, 1 / ITER);
    for (let it = 0; it < ITER; it++, temp *= cool) {
      const a = (rng() * C) | 0;
      const b = rng() < 0.5 ? (rng() * C) | 0 : nb[a][(rng() * 4) | 0];
      if (b < 0 || a === b) continue;
      const ia = occ[a], ib = occ[b]; if (ia < 0 && ib < 0) continue;
      if ((ia < 0 && b < LAST) || (ib < 0 && a < LAST)) continue;    // 空格不离开最后一行
      const adj0 = adjAt(a, b) + adjAt(b, a);
      occ[a] = ib; occ[b] = ia; if (ia >= 0) cellOf[ia] = b; if (ib >= 0) cellOf[ib] = a;
      let nx = cur + W.adj * (adjAt(a, b) + adjAt(b, a) - adj0);
      const st = ++affStamp; let na = 0;
      for (const i of [ia, ib]) if (i >= 0) for (const k of tOf[i]) if (seenK[k] !== st) { seenK[k] = st; aff[na++] = k; }
      for (let j = 0; j < na; j++) { const k = aff[j]; keep[k] = tc[k]; tc[k] = terrCost(k); nx += tc[k] - keep[k]; }
      const restMoved = ia < 0 || ib < 0 || orph[ia] || orph[ib];
      const rcNew = restMoved ? restCost() : rc; nx += rcNew - rc;
      if (nx <= cur || rng() < Math.exp((cur - nx) / temp)) { cur = nx; rc = rcNew; }
      else {
        occ[a] = ia; occ[b] = ib; if (ia >= 0) cellOf[ia] = a; if (ib >= 0) cellOf[ib] = b;
        for (let j = 0; j < na; j++) tc[aff[j]] = keep[aff[j]];
      }
    }
    const fin = total();                                // 增量累加有浮点误差：比较各轮时按全量重算
    if (fin < bestS - 1e-9) { bestS = fin; best = Array.from(cellOf); }
  }
  const pos0 = best.map(c => [c % cols, (c / cols) | 0]);
  const usedC = [...new Set(pos0.map(p => p[0]))].sort((a, b) => a - b), usedR = [...new Set(pos0.map(p => p[1]))].sort((a, b) => a - b);
  const res = { T, cols: usedC.length, rows: usedR.length, pos: pos0.map(([x, y]) => [usedC.indexOf(x), usedR.indexOf(y)]), sig, fromCache: false, cost: bestS };
  TERR_CACHE.set(M, res);
  return res;
}
function gridLoops(mask, cols, rows) {
  const isM = (c, r) => c >= 0 && r >= 0 && c < cols && r < rows && mask[r * cols + c];
  const E = new Map(); const add = (x1, y1, x2, y2) => { const k = x1 + ',' + y1; if (!E.has(k)) E.set(k, []); E.get(k).push([x2, y2]); };
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (isM(c, r)) {
    if (!isM(c, r - 1)) add(c, r, c + 1, r);
    if (!isM(c + 1, r)) add(c + 1, r, c + 1, r + 1);
    if (!isM(c, r + 1)) add(c + 1, r + 1, c, r + 1);
    if (!isM(c - 1, r)) add(c, r + 1, c, r);
  }
  const loops = [];
  while (E.size) {
    const k0 = E.keys().next().value; let [x, y] = k0.split(',').map(Number);
    const sx = x, sy = y; const pts = [[x, y]];
    let arr = E.get(k0); let nx = arr.shift(); if (!arr.length) E.delete(k0);
    let dir = [nx[0] - x, nx[1] - y]; x = nx[0]; y = nx[1];
    let guard = 0;
    while (!(x === sx && y === sy) && guard++ < 100000) {
      pts.push([x, y]);
      const k = x + ',' + y; arr = E.get(k); if (!arr) break;
      let i = 0;
      if (arr.length > 1) { const rt = [-dir[1], dir[0]]; i = arr.findIndex(p => p[0] - x === rt[0] && p[1] - y === rt[1]); if (i < 0) i = 0; }
      nx = arr.splice(i, 1)[0]; if (!arr.length) E.delete(k);
      dir = [nx[0] - x, nx[1] - y]; x = nx[0]; y = nx[1];
    }
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[(i - 1 + pts.length) % pts.length], qq = pts[i], r = pts[(i + 1) % pts.length];
      if ((qq[0] - p[0]) * (r[1] - qq[1]) - (qq[1] - p[1]) * (r[0] - qq[0]) !== 0) out.push(qq);
    }
    if (out.length >= 4) loops.push(out);
  }
  return loops;
}
// 把格点 (gx, gy) 换成画布坐标 (X[gx], Y[gy])，再往领地里缩 d、拐角倒圆 R
function insetLoopPath(loop, X, Y, d, R) {
  const n = loop.length; const P = [];
  for (let i = 0; i < n; i++) {
    const a = loop[(i - 1 + n) % n], b = loop[i], c = loop[(i + 1) % n];
    const din = [Math.sign(b[0] - a[0]), Math.sign(b[1] - a[1])], dout = [Math.sign(c[0] - b[0]), Math.sign(c[1] - b[1])];
    P.push([X[b[0]] + d * (-din[1] - dout[1]), Y[b[1]] + d * (din[0] + dout[0])]);
  }
  let s = '';
  for (let i = 0; i < n; i++) {
    const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n];
    const l1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const r = Math.min(R, l1 / 2, l2 / 2);
    const a = [p1[0] + (p0[0] - p1[0]) * r / l1, p1[1] + (p0[1] - p1[1]) * r / l1], b = [p1[0] + (p2[0] - p1[0]) * r / l2, p1[1] + (p2[1] - p1[1]) * r / l2];
    s += (i === 0 ? 'M' : 'L') + a[0].toFixed(1) + ',' + a[1].toFixed(1) + ' Q' + p1[0].toFixed(1) + ',' + p1[1].toFixed(1) + ' ' + b[0].toFixed(1) + ',' + b[1].toFixed(1) + ' ';
  }
  return s + 'Z';
}
function renderTerritory(M, board, ctx) {
  const inst = ctx.inst;
  if (!TERR_CACHE.has(M)) {
    const { layer } = boardParts(board); sizeBoard(board, 600, 120);
    layer.innerHTML = '<p class="wait">正在排布领地……</p>';
    setTimeout(() => {
      if (inst.destroyed || inst.M !== M) return;
      const res = solveTerritory(M, inst.layoutCache('terr'));
      if (!res.fromCache) inst.saveLayoutCache('terr', { sig: res.sig, cols: res.cols, rows: res.rows, pos: Object.fromEntries(M.works.map((w, i) => [w.id, res.pos[i]])) });
      // 等的时候切到了别的视图：标为没画过，切回来时直接用算好的结果画（不然会一直停在「正在排布」）
      if (inst.view === 'terr' && board.isConnected) { renderTerritory(M, board, ctx); inst.afterDraw('terr', board); }
      else inst.rendered.delete('terr');
    }, 30);
    return;
  }
  const z = ctx.z;
  const { svg, layer } = boardParts(board);
  const { T, cols, rows, pos } = solveTerritory(M);
  const order = T.map((t, i) => i).sort((a, b) => T[b].members.length - T[a].members.length);
  const level = new Array(T.length).fill(-1);
  for (const i of order) {
    const used = new Set(); const mi = new Set(T[i].members);
    for (let j = 0; j < T.length; j++) if (level[j] >= 0 && T[j].members.some(m => mi.has(m))) used.add(level[j]);
    let l = 0; while (used.has(l)) l++; level[i] = l;
  }
  const inset = l => Math.round(7 * z) + l * Math.round(10 * z);
  const CARD_W = Math.round(210 * z), GAP = Math.round(6 * z), BASE = Math.round(9 * z), PAD = Math.round(6 * z), R = Math.round(16 * z);
  let html = '';
  M.works.forEach(w => { html += workCard(M, w, { cls: 'compact', style: `width:${CARD_W}px` }); });
  T.forEach((t, i) => { html += `<div class="tlab dm" data-k="t${i}" data-wids="${esc(t.members.map(k => M.works[k].id).join(' '))}">${chip(M, t.tag, t.neg ? 'neg' : '')}</div>`; });
  layer.innerHTML = html;
  const q = finder(layer);
  const cards = M.works.map(w => layer.querySelector(`.work[data-wid="${cssEsc(w.id)}"]`));
  const at = new Int32Array(cols * rows).fill(-1); pos.forEach(([x, y], i) => { at[y * cols + x] = i; });
  const masks = T.map(t => { const m = new Uint8Array(cols * rows); t.members.forEach(k => { const [x, y] = pos[k]; m[y * cols + x] = 1; }); return m; });
  const loops = masks.map(m => gridLoops(m, cols, rows));

  // 每条格线两侧各留多宽，只看真正沿这条线走的领地边：缩进 + 6；没有领地边的缝只留 9。
  // Lft[g]/Rgt[g]：竖线 g 左边/右边的留白；Up[g]/Dn[g]：横线 g 上边/下边的留白。外框外侧不用留。
  const Lft = new Array(cols + 1).fill(BASE), Rgt = new Array(cols + 1).fill(BASE), Up = new Array(rows + 1).fill(BASE), Dn = new Array(rows + 1).fill(BASE);
  Lft[0] = 0; Rgt[cols] = 0; Up[0] = 0; Dn[rows] = 0;
  T.forEach((t, i) => {
    const m = masks[i], need = inset(level[i]) + GAP;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if (!m[y * cols + x]) continue;
      if (x === 0 || !m[y * cols + x - 1]) Rgt[x] = Math.max(Rgt[x], need);
      if (x === cols - 1 || !m[y * cols + x + 1]) Lft[x + 1] = Math.max(Lft[x + 1], need);
      if (y === 0 || !m[(y - 1) * cols + x]) Dn[y] = Math.max(Dn[y], need);
      if (y === rows - 1 || !m[(y + 1) * cols + x]) Up[y + 1] = Math.max(Up[y + 1], need);
    }
  });
  // 标签骑在领地最上、最左那个角的上边线上（竖直居中），所以这条线上下都要给它让出半个标签高
  const labs = T.map((t, i) => {
    let best = null;
    loops[i].forEach(lp => lp.forEach(p => { if (!best || p[1] < best[1] || (p[1] === best[1] && p[0] < best[0])) best = p; }));
    const el = q('t' + i); if (!best) return null;
    const d = inset(level[i]), lh = el.offsetHeight;
    Dn[best[1]] = Math.max(Dn[best[1]], d + Math.ceil(lh / 2) + Math.round(3 * z));
    Up[best[1]] = Math.max(Up[best[1]], Math.ceil(lh / 2) - d + Math.round(3 * z));
    return { el, gx: best[0], gy: best[1], d, lw: el.offsetWidth, lh };
  });
  const rowH = new Array(rows).fill(0);
  cards.forEach((el, i) => { const y = pos[i][1]; rowH[y] = Math.max(rowH[y], el.offsetHeight); });
  const X = [PAD + Lft[0]], Y = [PAD + Up[0]];
  for (let x = 0; x < cols; x++) X.push(X[x] + Rgt[x] + CARD_W + Lft[x + 1]);
  for (let y = 0; y < rows; y++) Y.push(Y[y] + Dn[y] + rowH[y] + Up[y + 1]);
  const BW = X[cols] + Rgt[cols] + PAD, BH = Y[rows] + Dn[rows] + PAD;
  sizeBoard(board, BW, BH);
  // 虚线格子只画在有作品的格子边上，最后一行的空格不画框
  const seg = (x1, y1, x2, y2) => svgEl('line', { x1, y1, x2, y2, class: 'cellgrid' }, svg);
  const occ = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows && at[y * cols + x] >= 0;
  for (let gy = 0; gy <= rows; gy++) for (let x = 0; x < cols; x++) if (occ(x, gy - 1) || occ(x, gy)) seg(X[x], Y[gy], X[x + 1], Y[gy]);
  for (let gx = 0; gx <= cols; gx++) for (let y = 0; y < rows; y++) if (occ(gx - 1, y) || occ(gx, y)) seg(X[gx], Y[y], X[gx], Y[y + 1]);
  M.works.forEach((w, i) => { const [x, y] = pos[i]; const el = cards[i]; el.style.left = (X[x] + Rgt[x]) + 'px'; el.style.top = (Y[y] + Dn[y] + (rowH[y] - el.offsetHeight) / 2) + 'px'; });
  const labRects = [];
  for (const i of T.map((t, k) => k).sort((a, b) => level[a] - level[b])) {
    const t = T[i], d = inset(level[i]);
    svgEl('path', { d: loops[i].map(lp => insetLoopPath(lp, X, Y, d, R)).join(''), class: 'terr' + (t.neg ? ' neg' : ''), style: `--h:${M.hue.get(t.tag) ?? 250}`, 'data-terr': t.tag, 'data-neg': t.neg ? '1' : '0', 'fill-rule': 'evenodd' }, svg);
    const L = labs[i]; if (!L) continue;
    const { lw, lh } = L;
    let lx = X[L.gx] + d + Math.round(18 * z); const ly = Y[L.gy] + d;
    if (lx + lw > BW - 2) lx = Math.max(X[L.gx] + d + Math.round(4 * z), BW - 2 - lw);   // 靠右边的领地，标签往回收，别伸出画布
    for (let tries = 0; tries < 12; tries++) {
      const r = { x: lx, y: ly - lh / 2, w: lw, h: lh };
      const hit = labRects.find(p => r.x < p.x + p.w + 4 && p.x < r.x + r.w + 4 && r.y < p.y + p.h && p.y < r.y + r.h);
      if (!hit) break; lx = hit.x + hit.w + 8;
    }
    labRects.push({ x: lx, y: ly - lh / 2, w: lw, h: lh });
    L.el.style.left = lx + 'px'; L.el.style.top = ly + 'px';
  }
}

/* ====================================================================
   06 谱系（最小生成树）
   ==================================================================== */
function buildLineage(M) {
  const n = M.n, D = M.D, sd = M.sd; if (!n) return { root: null, parent: [], kids: [] };
  let root = 0, bs = Infinity;
  M.works.forEach((w, i) => { const s = sd[i].reduce((a, b) => a + b, 0) + w.def.size * 0.01; if (s < bs) { bs = s; root = i; } });
  const inT = new Uint8Array(n); inT[root] = 1; const parent = new Array(n).fill(-1), depth = new Array(n).fill(0);
  const less = (a, b) => { for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-9) return a[i] < b[i]; return false; };
  for (let k = 1; k < n; k++) {
    let best = null;
    for (let u = 0; u < n; u++) if (inT[u]) for (let v = 0; v < n; v++) if (!inT[v]) {
      const minus = [...M.works[u].def].filter(t => !M.works[v].def.has(t)).length;
      const key = [D[u][v], minus, depth[u], u, v];
      if (!best || less(key, best)) best = key;
    }
    const u = best[3], v = best[4]; inT[v] = 1; parent[v] = u; depth[v] = depth[u] + 1;
  }
  const kids = Array.from({ length: n }, () => []);
  parent.forEach((p, v) => { if (p >= 0) kids[p].push(v); });
  const size = new Array(n).fill(1); (function sz(u) { for (const v of kids[u]) { sz(v); size[u] += size[v]; } })(root);
  kids.forEach(ks => ks.sort((a, b) => D[parent[a]][a] - D[parent[b]][b] || size[b] - size[a] || a - b));
  return { root, parent, kids, depth };
}
function deltaHTML(M, from, to) {
  const { plus, minus, sharedElse } = diffOf(M, from, to);
  if (!plus.length && !minus.length) return `<span class="same">完全相同${sharedElse.length ? '，也共有 ' + sharedElse.map(esc).join(' ') : ''}</span>`;
  const out = [], usedP = new Set(), usedM = new Set();
  for (const p of plus) { const m = minus.find(x => !usedM.has(x) && M.groupOf(x) === M.groupOf(p)); if (m) { usedP.add(p); usedM.add(m); out.push(`${chip(M, m, 'minus')}<span class="swap">→</span>${chip(M, p, 'plus')}`); } }
  plus.filter(p => !usedP.has(p)).forEach(p => out.push(chip(M, p, 'plus')));
  minus.filter(m => !usedM.has(m)).forEach(m => out.push(chip(M, m, 'minus')));
  return out.join('');
}
function renderLineage(M, board, ctx) {
  const z = ctx.z;
  const { svg, layer } = boardParts(board);
  const q = finder(layer);
  const L = buildLineage(M); if (L.root == null) return;
  const rows = [];
  (function dfs(u, d) { rows.push({ u, d }); for (const v of L.kids[u]) dfs(v, d + 1); })(L.root, 0);
  const IND = Math.round(34 * z);
  let html = '';
  rows.forEach((r, i) => {
    const w = M.works[r.u];
    const dl = r.d === 0 ? `<span class="start">起点</span>` : deltaHTML(M, M.works[L.parent[r.u]], w);
    html += `<div class="lrow dm" data-k="r${i}" data-wid="${esc(w.id)}"><span class="dl">${dl}</span>${coverImg(w)}${titleHTML(w)}${metaHTML(w)}<span class="diff"></span></div>`;
    html += `<div class="ltags dm" data-k="g${i}" data-wids="${esc(w.id)}">${tagChips(M, w)}</div><div class="lrule dm" data-k="u${i}" data-wids="${esc(w.id)}"></div>`;
  });
  layer.innerHTML = html;
  let y = Math.round(4 * z), maxR = 0;
  const RG = Math.round(6 * z);
  rows.forEach((r, i) => { r.el = q('r' + i); r.tg = q('g' + i); r.ru = q('u' + i); r.h = Math.max(r.el.offsetHeight, r.tg.offsetHeight); r.x = r.d * IND + Math.round(6 * z); r.y = y; y += r.h + RG; maxR = Math.max(maxR, r.x + r.el.offsetWidth); });
  const TX = maxR + Math.round(36 * z);
  let maxT = 0; rows.forEach(r => maxT = Math.max(maxT, r.tg.offsetWidth));
  rows.forEach(r => {
    r.el.style.left = r.x + 'px'; r.el.style.top = r.y + 'px';
    r.tg.style.left = TX + 'px'; r.tg.style.top = (r.y + (r.h - r.tg.offsetHeight) / 2) + 'px';
    const rx = r.x + r.el.offsetWidth + 8; r.ru.style.left = rx + 'px'; r.ru.style.width = Math.max(0, TX - rx - 10) + 'px'; r.ru.style.top = (r.y + r.h / 2) + 'px';
  });
  sizeBoard(board, TX + maxT + Math.round(10 * z), y);
  const rowOf = new Map(rows.map(r => [r.u, r]));
  rows.forEach(r => {
    if (r.d === 0) return;
    const p = rowOf.get(L.parent[r.u]);
    const x = p.x + Math.round(16 * z), y0 = p.y + p.h / 2 + Math.round(12 * z), y1 = r.y + r.h / 2;
    const g = svgEl('g', { class: 'eg', 'data-wa': M.works[p.u].id, 'data-wb': M.works[r.u].id }, svg);
    svgEl('path', { d: `M${x},${y0} V${y1 - 8} Q${x},${y1} ${x + 8},${y1} H${r.x}`, class: 'lline' }, g);
  });
}

const RENDER = { canvas: renderCanvas, score: renderScore, kmap: renderKmap, hasse: renderHasse, terr: renderTerritory, line: renderLineage };

/* ====================================================================
   实例：挂载、外壳、悬停
   ==================================================================== */
const DEFAULT_PREFS = { cover: true, scale: 1, color: true, drawer: false, view: null };
const ICON_FULL = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>';
const ICON_EXIT = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4"/></svg>';
const ICON_PANEL = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.6"/><path d="M10 2.5v11"/></svg>';
const ICON_MORE = '<svg class="ic dots" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.2" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.8" cy="8" r="1.3"/></svg>';

function mount(host, data, options) {
  if (!host) throw new Error('TagNote.mount：缺少挂载元素');
  const o = Object.assign({
    views: null,            // 要显示的内置视图 key 数组（默认全部、按此顺序）
    view: null,             // 初始视图
    customViews: [],        // [{ key, name, no?, render(el, inst) }]，排在内置视图前面
    notes: false,           // 画板下方是否显示设计说明
    heads: true,            // 是否显示视图标题和“读法”
    toolbar: true,          // 是否显示封面/配色/侧栏/全屏按钮
    theme: 'auto',          // 'auto' | 'light' | 'dark'
    prefs: null,            // 初始偏好 { cover, scale, color, drawer, view }
    config: null,           // 覆盖 DEFAULT_CONFIG（如 { hue: { 日常: 140 } }）
    coverOf: null,          // (原始作品对象) => 封面 URL
    extraCSS: '',           // 追加进 Shadow DOM 的样式
    layoutCache: null,      // 已保存的布局缓存 { terr: {...} }，保证领地图形状稳定
    onLayoutCache: null,    // (kind, value) => void，算出新布局时回调，宿主可存起来
    onPrefsChange: null,    // (prefs) => void
    onViewChange: null,     // (viewKey) => void
    onWorkOpen: null,       // (work, event) => void；双击或 Ctrl/⌘+单击作品名时触发
    layout: 'page',         // 'page' | 'pane'
    fullscreen: 'engine',   // 'engine' | 'host'
    onFullRequest: null,    // () => void；fullscreen:'host' 时全屏按钮只调它
    viewports: null,        // { [view]: { zoom, cx, cy } } 初始视区
    onViewportChange: null, // (view, vp, { by: 'user' | 'focus' | 'host' }) => void
  }, options || {});
  const PANE = o.layout === 'pane';                  // 格子布局：图区自己两个方向滚动，可以移动缩放
  const HOSTFS = o.fullscreen === 'host';            // 全屏交给宿主：按钮只回调 onFullRequest
  const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '';
  const inst = {
    host, shadow, o, M: null, raw: data, view: null, destroyed: false, rendered: new Set(), pinned: null, hoverKey: null,
    prefs: Object.assign({}, DEFAULT_PREFS, o.prefs || {}), cacheStore: Object.assign({}, (data && data.layout_cache) || {}, o.layoutCache || {}),
  };
  inst.layoutCache = kind => inst.cacheStore[kind] || null;
  inst.saveLayoutCache = (kind, v) => { inst.cacheStore[kind] = v; if (o.onLayoutCache) try { o.onLayoutCache(kind, v); } catch (e) { console.error(e); } };
  const builtins = (o.views || VIEWS.map(v => v.key)).map(k => VIEWS.find(v => v.key === k)).filter(Boolean);
  const allViews = [...(o.customViews || []).map(c => Object.assign({ custom: true }, c)), ...builtins];
  inst.views = allViews;

  // ---------- DOM ----------
  const style = document.createElement('style'); style.textContent = CSS_TEXT + (o.extraCSS || '');
  shadow.appendChild(style);
  const wrap = document.createElement('div'); wrap.className = PANE ? 'root pane' : 'root';
  // 'pane' 比 'page' 多两样东西（'page' 的 DOM 里没有）：封面 / 配色外面包一层 .tset（平时 display:contents，窄宿主时变成「⋯」菜单的弹出层），
  // 「⋯」按钮（窄宿主时才显示）；「标签与近邻」多一个图标（窄宿主时只显示图标）
  const ctls = `<div class="ctl" role="group" aria-label="封面"><span>封面</span><button data-act="cover" data-v="1">显示</button><button data-act="cover" data-v="0">隐藏</button></div>
      <div class="ctl" role="group" aria-label="配色"><span>配色</span><button data-act="color" data-v="1">彩色</button><button data-act="color" data-v="0">单色</button></div>`;
  wrap.innerHTML = `<div class="bar" part="bar"><nav class="tabs" role="tablist"></nav><div class="tools"${o.toolbar ? '' : ' hidden'}>
      ${PANE ? `<div class="tset" role="group" aria-label="显示设置">${ctls}</div><button class="more-btn" data-act="more" aria-expanded="false" aria-haspopup="true" title="显示设置" aria-label="显示设置">${ICON_MORE}</button>` : ctls}
      <button class="drawer-btn" data-act="drawer" aria-expanded="false"${PANE ? ' title="标签与近邻" aria-label="标签与近邻"' : ''}>${PANE ? ICON_PANEL : ''}<span>标签与近邻</span><span class="ar">›</span></button>
      <button class="full-btn" data-act="full" aria-pressed="false"${PANE ? ' title="全屏" aria-label="全屏"' : ''}>${ICON_FULL}<span>全屏</span></button>
    </div></div>
    <div class="frame"><div class="main"></div><aside class="drawer" hidden aria-label="标签与近邻"></aside></div>`;
  shadow.appendChild(wrap);
  const $ = s => wrap.querySelector(s), $$ = s => [...wrap.querySelectorAll(s)];
  const main = $('.main'), drawer = $('.drawer');
  allViews.forEach(v => {
    const sec = document.createElement('section'); sec.className = 'view'; sec.dataset.view = v.key; sec.hidden = true;
    if (v.custom) sec.innerHTML = `<div class="custom"></div>`;
    else sec.innerHTML = (o.heads ? `<div class="vhead"><h2><span class="no">${v.no}</span>${v.name}</h2><p class="howto">${v.howto}</p></div>` : '')
      + (PANE
        // 'pane'：图区（.board-wrap）里放一个按缩放后尺寸撑开的占位层（.zsz），画板绝对定位在它左上角、用 transform 缩放；
        // 平移 = 改图区的 scrollLeft/Top。右下角的百分比小标签放在图区外面一层，不跟着滚动；不在初始位置时显示，点它回到初始
        ? `<div class="bw-box"><div class="board-wrap"><div class="zsz"><div class="board${v.flow ? ' flow' : ''}" data-board="${v.key}"><svg class="edges"></svg><div class="layer"></div></div></div></div>`
          + `<button class="zoom-badge" data-act="home" hidden title="Shift+0 回到初始 · Shift+1 显示全图" aria-label="回到初始位置（Shift+0）">100%</button></div>`
        : `<div class="board-wrap"><div class="board${v.flow ? ' flow' : ''}" data-board="${v.key}"><svg class="edges"></svg><div class="layer"></div></div></div>`)
      + (o.notes ? `<div class="notes">${[['核心思路', v.idea], ['帮你记住标签组', v.goal1], ['帮你辨析异同', v.goal2], ['长处', v.pros], ['短处', v.cons]].map(([h, p]) => `<section><h3>${h}</h3><p>${p}</p></section>`).join('')}</div>` : '');
    main.appendChild(sec);
  });
  $('.tabs').innerHTML = allViews.map(v => `<button class="tab" role="tab" data-goto="${v.key}" aria-selected="false">${v.no ? `<span class="no">${v.no}</span>` : ''}${esc(v.name)}</button>`).join('');

  const boardOf = k => main.querySelector(`[data-board="${k}"]`);
  const activeBoard = () => boardOf(inst.view);
  const emitPrefs = () => { if (o.onPrefsChange) try { o.onPrefsChange(Object.assign({}, inst.prefs)); } catch (e) { console.error(e); } };

  // ---------- 侧栏 ----------
  function renderDrawer() {
    const M = inst.M; const segName = { G_1: '类型', G_2: '题材', G_3: '题材', G_staff: '制作', G_4: '其它', G_format: '形式', G_source: '来源', G_else: '低频（相近作品共有）' };
    const groups = [];
    M.tags.forEach(t => { const g = M.groupOf(t); const k = segName[g] || '其它'; let grp = groups.find(x => x.k === k); if (!grp) groups.push(grp = { k, tags: [] }); grp.tags.push(t); });
    drawer.innerHTML = `<div class="dr-h"><b>标签与近邻</b><button class="dr-x" data-act="drawer">收起</button></div><div class="now"></div><div class="dr-list">`
      + groups.map(g => `<div class="dr-grp"><h4>${g.k}</h4>${g.tags.map(t => { const f = M.freq.get(t); return `<div class="dr-row">${chip(M, t)}<span class="n">${f}</span>${M.groupOf(t) === 'G_else' ? '' : `<span class="nx" data-ntag="${esc(t)}">非 ${M.n - f}</span>`}</div>`; }).join('')}</div>`).join('') + `</div>`;
    nowSized = false;
    renderNow(null);
    sizeNow();
  }
  // 读数区固定高度：取所有可能读数里最高的那个（有封顶，见下；超出时读数区内部滚动）。
  // 这样悬停不同的标签、作品时，下面的标签列表一像素都不会移动，鼠标不会因为列表跳动而滑到别的标签上。
  // 分两步：sizeNow 把每条读数画一遍、量出最高的（慢，内容或侧栏宽度变了才做）；fitNow 按侧栏现在的高度上限封顶（快，面板变高变矮都做）。
  let nowSized = false, nowMx = 0, nowW = 0, nowT = 0;
  const NOW_MIN_H = 64;                              // 和 tagnote.css 里 .now 的 min-height 一致
  function sizeNow() {
    const el = drawer.querySelector('.now'); const M = inst.M;
    if (!el || !M || drawer.hidden || !drawer.getClientRects().length) return;
    const keep = el.innerHTML, keepPin = inst.pinned, keepTop = el.scrollTop;
    el.style.height = 'auto'; el.style.minHeight = '';
    inst.pinned = keepPin || { key: '' };            // 按“已固定”的样子量，徽标也占位
    const states = [null];
    for (const t of M.tags) { states.push(tagState(t, false)); if (M.groupOf(t) !== 'G_else') states.push(tagState(t, true)); }
    for (const w of M.works) states.push(workState(w));
    let mx = 0;
    for (const st of states) { renderNow(st); mx = Math.max(mx, el.getBoundingClientRect().height); }
    inst.pinned = keepPin;
    el.innerHTML = keep;
    nowMx = mx; nowW = drawer.getBoundingClientRect().width; nowSized = true;
    clearTimeout(nowT); nowT = 0;                    // 刚量完，之前排着的重量不用再做
    fitNow();
    el.scrollTop = keepTop;                          // 量的时候滚动位置被清零了：用户可能正往下读固定的读数，恢复原位，不拉回顶部
  }
  // 封顶：侧栏有高度上限（吸顶）时，先让下面的标签列表整段放得下，读数区用剩下的高度，但不少于侧栏的 30%、不多于 46%。
  // 侧栏没有高度上限（窄屏时侧栏不吸顶）时，按窗口高度的 46%，不少于 160px。
  function fitNow() {
    const el = drawer.querySelector('.now');
    if (!el || !nowSized || drawer.hidden || !drawer.getClientRects().length) return;
    // 'pane'：侧栏是撑满格子高度的一列（窄宿主时是浮层），它自己的高度就是上限
    const cs = getComputedStyle(drawer); const dmax = PANE ? drawer.offsetHeight : parseFloat(cs.maxHeight);
    let cap;
    if (isFinite(dmax)) {
      const list = drawer.querySelector('.dr-list'), head = drawer.querySelector('.dr-h');
      const box = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      const used = box + (head ? head.getBoundingClientRect().height + parseFloat(getComputedStyle(head).marginBottom) : 0) + parseFloat(getComputedStyle(el).marginBottom);
      const room = dmax - used - (list ? list.scrollHeight : 0);
      cap = Math.min(Math.round(dmax * 0.46), Math.max(Math.round(dmax * 0.30), Math.floor(room)));
    } else cap = Math.max(160, Math.round((window.innerHeight || 800) * 0.46));
    const h = Math.ceil(Math.min(nowMx, cap)) + 'px';
    if (el.style.height !== h) el.style.height = h;
    // 侧栏极矮（例如 Obsidian 里分屏分得很小）时，CSS 的 64px 下限会把标签列表挤没：这时下限跟着封顶一起降下来
    const minH = cap < NOW_MIN_H ? h : '';
    if (el.style.minHeight !== minH) el.style.minHeight = minH;
  }
  // 尺寸可能变了：只是高度上限变了就只重新封顶；侧栏宽度变了还要重量。
  // 重量要把每条读数画一遍，拖动窗口时每一像素都量会卡，所以先按上一次量的结果封顶，停下 150ms 后再量一次。
  // sync：打开侧栏这类一次性的操作，宽度变了就马上量，免得侧栏打开后读数区再变一次高度。
  function refitNow(sync) {
    if (!nowSized) { sizeNow(); return; }
    clearTimeout(nowT); nowT = 0;                    // 宽度又回到量过的值时，排着的重量也不用做了
    if (drawer.getBoundingClientRect().width === nowW) { fitNow(); return; }
    if (sync) { sizeNow(); return; }
    fitNow();
    nowT = setTimeout(() => { nowT = 0; if (!inst.destroyed) sizeNow(); }, 150);
  }
  function renderNow(st) {
    const el = drawer.querySelector('.now'); if (!el) return;
    const M = inst.M; const pin = inst.pinned ? '<span class="pin">已固定</span>' : '';
    el.scrollTop = 0;                                  // 换了内容就从头看（上一次可能在读数区里往下滚过）
    if (!st) { el.innerHTML = `<div class="hint">把鼠标移到标签、“非”或作品上：这里会列出命中的作品，或最接近的几部和差别。点击可以固定，Esc 取消。</div>`; return; }
    if (st.kind === 'tag') {
      const names = M.works.filter(w => st.lit.has(w.id)).map(w => `<span>${esc(w.title)}</span>`).join('');
      el.innerHTML = `<div class="k">${chip(M, st.tag, st.neg ? 'neg' : '', true)}<span class="n">${st.lit.size} 部</span>${pin}</div><div class="names">${names}</div>`;
    } else {
      const w = st.work; const li = id => { const b = M.byId.get(id); return `<li><span class="t">${esc(b.title)}</span><span class="d">${diffChips(M, w, b)}</span></li>`; };
      el.innerHTML = `<div class="k">${esc(w.title)}${w.note ? `<span class="wn">（${esc(w.note)}）</span>` : ''}${pin}</div><h5>最近</h5><ul>${w.nb1.map(li).join('')}</ul>${w.nb2.length ? `<h5>其次</h5><ul>${w.nb2.map(li).join('')}</ul>` : ''}`;
    }
  }

  // ---------- 高亮 ----------
  function clearHL(board) {
    if (!board) return;
    board.classList.remove('hovering');
    board.querySelectorAll('.hl, .focus, .on, .on2, .sec, .fl').forEach(e => e.classList.remove('hl', 'focus', 'on', 'on2', 'sec', 'fl'));
    board.querySelectorAll('.diff.show').forEach(e => { e.classList.remove('show', 't2'); e.innerHTML = ''; });
    drawer.querySelectorAll('.on').forEach(e => e.classList.remove('on'));
  }
  function applyHL(board, st) {
    if (!board) return;
    clearHL(board); board.classList.add('hovering');
    const M = inst.M, any = (arr, set) => arr.some(i => set.has(i));
    board.querySelectorAll('[data-wid],[data-wids]').forEach(el => {
      const ids = el.dataset.wid != null ? [el.dataset.wid] : (el.dataset.wids || '').split(' ').filter(Boolean);
      if (any(ids, st.lit)) el.classList.add('hl');
      if (st.focus && any(ids, st.focus)) el.classList.add('focus');
    });
    board.querySelectorAll('[data-wa]').forEach(el => {
      const a = el.dataset.wa.split(' '), b = el.dataset.wb.split(' ');
      const on = st.focus ? ((any(a, st.focus) && any(b, st.lit)) || (any(b, st.focus) && any(a, st.lit))) : (any(a, st.lit) && any(b, st.lit));
      if (on) el.classList.add('hl');
    });
    if (st.kind === 'tag') {
      const sel = st.neg ? `[data-ntag="${cssEsc(st.tag)}"]` : `[data-tag="${cssEsc(st.tag)}"]`;
      board.querySelectorAll(sel).forEach(el => el.classList.add(el.classList.contains('sc-cell') && !st.neg ? 'on2' : 'on'));
      drawer.querySelectorAll(sel).forEach(el => el.classList.add('on'));
      board.querySelectorAll('svg .terr').forEach(p => { if (p.dataset.terr === st.tag && (p.dataset.neg === '1') === !!st.neg) p.classList.add('on'); });
    } else {
      const w = st.work;
      const put = (ids, cls) => ids.forEach(id => {
        const html = diffChips(M, w, M.byId.get(id));
        board.querySelectorAll(`[data-wid="${cssEsc(id)}"] > .diff, [data-wid="${cssEsc(id)}"] .ttl > .diff`).forEach(e => { e.innerHTML = html; e.classList.add('show'); if (cls) e.classList.add(cls); });
      });
      if (w) { put(w.nb1, ''); put(w.nb2, 't2'); }   // 程序聚焦几部作品一起时没有单一的参照，不显示差别
    }
    // 程序聚焦：次要作品的虚线框（增减阶梯里它所在的节点也不变淡）；flash 的闪框按开始闪的时间接着闪（重画、悬停移开后不从头数）
    if (st.sec && st.sec.size) board.querySelectorAll('[data-wid]').forEach(el => {
      if (!st.sec.has(el.dataset.wid)) return;
      el.classList.add('sec'); const hn = el.closest('.hnode'); if (hn) hn.classList.add('sec');
    });
    if (st.fl != null) {
      const d = -Math.round(performance.now() - st.fl) + 'ms';
      board.querySelectorAll('.work.focus, .hnode.focus, .lrow.focus, .srow.focus > .ttl').forEach(el => { el.classList.add('fl'); el.style.animationDelay = d; });
    }
  }
  function tagState(tag, neg) {
    const M = inst.M;
    const lit = new Set(M.works.filter(w => (w.def.has(tag) || w.els.has(tag)) !== neg).map(w => w.id));
    return { kind: 'tag', tag, neg, lit, focus: null, key: (neg ? '!' : '') + tag };
  }
  function workState(w) { return { kind: 'work', work: w, lit: new Set([w.id, ...w.nb1, ...w.nb2]), focus: new Set([w.id]), key: 'w:' + w.id }; }
  function stateFromTarget(t) {
    const M = inst.M;
    const tg = t.closest('[data-tag],[data-ntag]');
    if (tg) { const neg = tg.dataset.ntag != null; return tagState(neg ? tg.dataset.ntag : tg.dataset.tag, neg); }
    const we = t.closest('[data-wid]');
    if (we && M.byId.has(we.dataset.wid)) return workState(M.byId.get(we.dataset.wid));
    return null;
  }
  function setHover(st) {
    // 移开时只清掉画板上的高亮；侧栏读数保留到下一次悬停，方便把鼠标移过去细看
    if (!st) { if (inst.hoverKey) { inst.hoverKey = null; if (pf && !inst.pinned) pfShow(); else clearHL(activeBoard()); } return; }
    if (st.key === inst.hoverKey) return;
    inst.hoverKey = st.key; applyHL(activeBoard(), st); renderNow(st);
  }
  function unpin() { inst.pinned = null; inst.hoverKey = null; clearHL(activeBoard()); renderNow(null); }
  // ---------- 'pane' 交互状态 ----------
  let overArea = false;        // 鼠标在图区（.board-wrap）上方
  let hostHover = false;       // 鼠标在这个实例上方（Esc 归属用）
  let spaceOn = false;         // 这个实例接管了按住的空格（抓手）
  let drag = null;             // 空格 + 拖动：{ id, x, y, sl, st, moved, s }
  let grabPress = false;       // 这次按下鼠标时处在抓手模式：随后的 click / dblclick 都不算（松开空格再松手也一样）
  let pressN = 0;              // 按下鼠标的次数：清 grabPress 的定时器只清自己那次按下的
  let barPress = false;        // 这次按下按在图区的滚动条上
  let narrow = false;          // 'pane' 且宿主（.root 内容宽）≤ 720px：侧栏改成盖在图上的浮层，默认收起
  let overlayOpen = false;     // 窄宿主时浮层侧栏开着没有（不改 prefs.drawer：宿主变宽后侧栏照原偏好）
  let domVp = null;            // 哪个视图的图区滚动位置是有效的（正在显示、已恢复视区）；切视图时清掉，免得读到隐藏时被清零的滚动
  let hostFull = false;        // fullscreen:'host' 时宿主报告的全屏状态
  const onOver = e => {
    hostHover = true;
    overArea = !!(e.target.closest && e.target.closest('.board-wrap'));
    if (drag) return;                                  // 拖动中冻结悬停高亮，不闪
    if (inst.pinned || !inst.M || hold) return;       // focusWorks 之后鼠标还没真正动过：浏览器补发的悬停不算（见 onHoldPt）
    const area = e.target.closest && e.target.closest('.board, .drawer');
    setHover(area ? stateFromTarget(e.target) : null);
  };
  // 按住空格时鼠标进了另一个 'pane' 实例：抓手模式跟过来，前一个实例恢复普通光标（它正在拖动时不换）
  const onEnter = () => {
    hostHover = true;
    if (PANE && GRAB.inst && GRAB.inst !== inst && GRAB.inst._dropGrab()) { GRAB.inst = inst; setGrab(true); }
  };
  const onLeave = () => { hostHover = false; overArea = false; if (drag) return; if (!inst.pinned) setHover(null); };
  // focusWorks 之后、鼠标真正移动之前：切标签、切视图、重画后光标下面换了元素，浏览器会补发 pointerover / pointermove，
  // 这种悬停不是用户动的，不盖住程序聚焦。「真正移动」= 指针坐标离 focusWorks 时最后已知的坐标（PTR）≥ 2px
  // （在 document 上量，鼠标离开图区再回来也会被量到）。那时还不知道鼠标在哪（页面打开后鼠标没动过）的：
  // focus / 重画后 HOLD_SYNTH_MS 以内到的第一个事件当成浏览器补发的，只记下坐标；更晚到的算用户真的动了。
  // 动了就恢复正常悬停：按这时光标下面的东西（在本实例里的话）设悬停
  let hold = null;
  const HOLD_SYNTH_MS = 50;
  const onHoldPt = e => {
    const h = hold; if (!h) return;
    if (h.x == null) {
      if (performance.now() - h.t <= HOLD_SYNTH_MS) { h.x = e.clientX; h.y = e.clientY; return; }
    } else if (Math.hypot(e.clientX - h.x, e.clientY - h.y) < 2) return;
    holdEnd();
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    if (!t || t.nodeType !== 1 || !wrap.contains(t) || drag || inst.pinned || !inst.M) return;
    const area = t.closest('.board, .drawer');
    setHover(area ? stateFromTarget(t) : null);
  };
  function holdStart() {
    if (hold) { holdTouch(); return; }               // 上次记下的位置以后鼠标没动过：接着用
    hold = { x: PTR.x, y: PTR.y, t: performance.now() };
    document.addEventListener('pointermove', onHoldPt, true); document.addEventListener('pointerover', onHoldPt, true);
  }
  // 不知道鼠标在哪时，重画 / 显示出来也会让浏览器补发悬停：从这时重新计 HOLD_SYNTH_MS
  function holdTouch() { if (hold && hold.x == null) hold.t = performance.now(); }
  function holdEnd() {
    if (!hold) return;
    hold = null;
    document.removeEventListener('pointermove', onHoldPt, true); document.removeEventListener('pointerover', onHoldPt, true);
  }
  const openWork = (e) => {
    if (!o.onWorkOpen) return false;
    const we = e.target.closest && e.target.closest('.board [data-wid]');
    if (!we || !inst.M.byId.has(we.dataset.wid)) return false;
    try { o.onWorkOpen(inst.M.byId.get(we.dataset.wid).raw, e); } catch (err) { console.error(err); }
    return true;
  };
  const onClick = e => {
    const go = e.target.closest('[data-goto]'); if (go) { setView(go.dataset.goto); return; }
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act, v = act.dataset.v;
      if (a === 'cover') setPrefs({ cover: v === '1' });
      else if (a === 'color') setPrefs({ color: v === '1' });
      else if (a === 'drawer') { if (PANE && narrow) setOverlay(!overlayOpen); else setPrefs({ drawer: !inst.prefs.drawer }); }
      else if (a === 'full') { if (HOSTFS) requestHostFull(); else if (fullMode || wantFull) exitFull(); else enterFull(); }
      else if (a === 'home') goHome();
      else if (a === 'more') setMore(!moreOpen);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && openWork(e)) return;
    if (!inst.M) return;
    const area = e.target.closest('.board, .drawer');
    const st = area ? stateFromTarget(e.target) : null;
    if (st && (!inst.pinned || inst.pinned.key !== st.key)) {
      const took = !!pf;                               // 用户点击固定 = 接管：程序聚焦清掉，状态都改完再告诉宿主
      if (pf) { pfEnd(); stopReveal(); }
      inst.pinned = st; inst.hoverKey = null; setHover(st);
      if (took) takeover('pin');
    }
    else if (inst.pinned) unpin();
  };
  // 程序聚焦被用户操作（点击固定 / 本实例的 Esc）清掉了：告诉宿主。被吞掉的点击（抓手模式、拖动后的 click）到不了这里；
  // flash 结束、宿主 clearFocus、新的 focusWorks 都不走这里
  function takeover(reason) { if (o.onFocusTakeover && !inst.destroyed) try { o.onFocusTakeover(reason); } catch (err) { console.error(err); } }
  const onDbl = e => { openWork(e); };
  // Esc：先取消固定，再退出全屏（浏览器全屏时浏览器自己也会退，这里再退一次不出错；Obsidian 等宿主未必自己退）。
  // 宿主已经用掉这次 Esc（defaultPrevented，且不是 TagNote 实例标的）就不管；用掉了就 preventDefault，让宿主知道。
  // 同页几个实例：平时各自取消各自的固定；有一个在全屏时它盖住了整个屏幕，这次 Esc 只归它
  // （只算引擎自己的全屏；fullscreen:'host' 时全屏的是宿主的容器，里面可能有好几个实例，不独占）。
  // 「谁在全屏」按这次按键第一个实例收到时算：全屏的实例先收到、退出了全屏，排在后面的实例也不会接着取消固定。
  // 'pane' 实例（分屏里会有好几个）：没有实例全屏时，这次 Esc 只归「当前实例」——鼠标在它上面的；没有就是焦点在它里面的；
  // 再没有就是最后一次被点击 / 获得焦点的。只在看得见的实例里找（宿主藏起来保活的实例不算）。'page' 实例：各自取消各自的固定；
  // 但清程序聚焦（focusWorks）这一步 'page' 也只归当前实例（或全屏的那个），别的 'page' 实例的程序聚焦不动。
  const escCur = e => {
    const live = [...LIVE];
    const path = e.composedPath ? e.composedPath() : [];
    const shown = live.filter(i => i._shown());       // 隐藏的实例（宽或高为 0、display:none、visibility:hidden）永远拿不到
    return shown.find(i => i._hovered()) || shown.find(i => path.includes(i.host))
      || shown.filter(i => i._seq).sort((a, b) => b._seq - a._seq)[0] || null;
  };
  const onKey = e => {
    if (e.key !== 'Escape') return;
    let rec = ESC_REC.get(e);
    if (!rec) { rec = { owner: FULL_OWNER.inst, cur: escCur(e), used: false }; ESC_REC.set(e, rec); }
    if ((e.defaultPrevented && !rec.used) || (rec.owner && rec.owner !== inst)) return;
    if (PANE && !rec.owner && rec.cur !== inst) return;
    let took = false;
    if (PANE && moreOpen) setMore(false); else if (inst.pinned) unpin(); else if (pf && (PANE || rec.owner === inst || rec.cur === inst)) { clearFocus(); took = true; } else if (PANE && narrow && overlayOpen) setOverlay(false); else if (fullMode) exitFull(); else return;
    rec.used = true; e.preventDefault();
    if (took) takeover('esc');
  };
  // Shift+1 显示全图、Shift+0 回到初始（照 Obsidian 白板）。只归鼠标所在的看得见的 'pane' 实例，没有就归焦点所在的；
  // 焦点在输入框里、带 Ctrl / Alt / ⌘、宿主已经用掉这次按键时都不管。按物理键位（e.code）认，不受键盘布局的 Shift 符号影响
  const navCur = e => {
    const path = e.composedPath ? e.composedPath() : [];
    const shown = [...LIVE].filter(i => i._pane && i._shown());
    return shown.find(i => i._hovered()) || shown.find(i => path.includes(i.host)) || null;
  };
  const onNavKey = e => {
    if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    const fit = e.code === 'Digit1', home = e.code === 'Digit0';
    if (!fit && !home) return;
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    if (editable(t) || navCur(e) !== inst) return;
    if (fit ? fitAll() : goHome()) e.preventDefault();
  };
  // 空格：鼠标在本实例图区上方时接管（抓手光标、不滚页面、不让焦点按钮被「点击」）；焦点在输入框里时不拦
  const isSpace = e => e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
  const editable = el => {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return tag === 'INPUT' && !/^(button|submit|reset|checkbox|radio|range|color|file|image|hidden)$/i.test(el.type || '');
  };
  const setGrab = on => { spaceOn = on; wrap.classList.toggle('grab', on); if (!on) wrap.classList.remove('grabbing'); };
  // 同页几个 'pane' 实例：按下空格时鼠标在哪个实例的图区上，哪个接管（GRAB）；之后鼠标进了别的实例，抓手跟过去（见 onEnter）。
  // 按住期间的自动重复 keydown、松开的 keyup 都只由当时的接管者处理
  const onSpaceDown = e => {
    if (!isSpace(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (GRAB.inst) { if (GRAB.inst === inst) e.preventDefault(); return; }
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    if (editable(t) || !overArea || !viewBoard()) return;
    GRAB.inst = inst; setGrab(true);
    e.preventDefault();
  };
  const onSpaceUp = e => {
    if (!isSpace(e) || GRAB.inst !== inst) return;
    e.preventDefault();
    releaseSpace();
  };
  const releaseSpace = () => { if (drag) endDrag(); if (spaceOn) setGrab(false); if (GRAB.inst === inst) GRAB.inst = null; };
  const onBlur = () => releaseSpace();
  inst._dropGrab = () => { if (drag) return false; setGrab(false); return true; };
  // 松手后清掉 grabPress：随后的 click / dblclick 和 pointerup 在同一个任务里派发，下一轮再清，免得以后键盘触发的 click 被吞。
  // 机器忙时 Chrome 会先处理输入、后跑定时器，这个定时器可能排到下一次按下之后：只清自己那次按下的标记
  const clearPressSoon = () => { const n = pressN; setTimeout(() => { if (n === pressN) grabPress = false; }, 0); };
  // 空格 + 拖动：移动视区。按下时捕获指针，移动超过 3px 才算拖动。抓手模式下的单击不算点击（onGrabCap 吞掉）
  const onPDown = e => {
    inst._seq = ++SEQ.n;
    pressN++; grabPress = PANE && spaceOn;
    // 按住图区的滚动条（准备拖滚动条）：当场去掉 home
    barPress = PANE && !spaceOn && e.button === 0 && e.target === viewWrap() && onScrollbar(e.target, e);
    if (barPress) { stopReveal(); userScroll(inst.view); }
    if (!PANE || !spaceOn || e.button !== 0 || drag) return;
    const s = e.target.closest && e.target.closest('.board-wrap');
    if (!s || s !== viewWrap()) return;
    e.preventDefault();
    stopReveal();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sl: s.scrollLeft, st: s.scrollTop, moved: false, s };
    // 按下就捕获指针：从图区边上开始、一下甩到实例外面时，之后的 move / up 也还送到这里（3px 只用来判断算不算拖动）
    try { s.setPointerCapture(e.pointerId); } catch (_) { /* 指针已经没了 */ }
    wrap.classList.add('grabbing');
  };
  const onPMove = e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!(e.buttons & 1)) { endDrag(); return; }        // 左键其实已经松开（松手事件丢了）：结束拖动
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 3) drag.moved = true;
    if (drag.moved) {
      const s = drag.s, l = s.scrollLeft, t = s.scrollTop;
      s.scrollLeft = drag.sl - dx; s.scrollTop = drag.st - dy;
      // 用户平移：当场去掉 home，不等滚动事件（同一帧里画板也变了大小时，滚动事件里分不清是谁挪的）
      if (s.scrollLeft !== l || s.scrollTop !== t) leaveHome(inst.view);
    }
  };
  const onPUp = e => {
    if (drag && e.pointerId === drag.id) endDrag();
    if (grabPress) clearPressSoon();
    if (barPress) { barPress = false; if (recheckT[inst.view]) recheck(inst.view); }   // 松开滚动条：马上按位置重新判断（按了没拖就恢复 home）
  };
  // 捕获被浏览器收回（窗口失焦、元素被移走等）：拖动到此为止
  const onLostCap = e => { if (drag && e.pointerId === drag.id) endDrag(); };
  function endDrag() {
    const d = drag; drag = null; wrap.classList.remove('grabbing');
    if (!d) return;
    try { if (d.s.hasPointerCapture(d.id)) d.s.releasePointerCapture(d.id); } catch (_) { /* 无所谓 */ }
  }
  // 抓手模式（按住空格）下 click / dblclick 一律不算：不固定高亮、不点按钮、不打开作品
  const onGrabCap = e => {
    if (!PANE || !(spaceOn || (grabPress && e.detail > 0))) return;    // detail 0 = 键盘触发的 click，不归按下鼠标那次管
    e.stopPropagation(); e.preventDefault();
    if (grabPress) clearPressSoon();
  };
  // 空格 + 滚轮：以鼠标所在点为中心缩放（按 deltaY 指数缩放，触控板也顺）。Ctrl + 滚轮不拦（浏览器整页缩放）。
  // 不按空格照常滚动（浏览器滚），这个滚轮会滚到图区的话当场去掉 home
  const onWheel = e => {
    if (e.ctrlKey) return;
    const s = e.target.closest && e.target.closest('.board-wrap');
    if (!s || s !== viewWrap()) return;
    if (rv) stopReveal();                              // reveal 缓动中用户滚轮：以用户为准
    if (!spaceOn) { if (homeOf[inst.view] && wheelScrolls(s, e)) userScroll(inst.view); return; }
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 33; else if (e.deltaMode === 2) dy *= s.clientHeight;
    dy = Math.max(-300, Math.min(300, dy));
    zoomAt(inst.view, (vz[inst.view] || 1) * Math.exp(-dy * 0.0018), e.clientX, e.clientY);
  };
  // 图区滚动（拖动、滚轮、滚动条、程序设置）：记下当前视区，停下约 200ms 后回调宿主
  const onScroll = e => {
    const s = e.target; const k = inst.view;
    if (!s || !s.classList || !s.classList.contains('board-wrap') || !k || s !== viewWrap() || !drawn.has(k) || domVp !== k || !s.clientWidth) return;
    // 滚动位置和引擎上次读到 / 写下的不一样 = 用户滚的（滚轮、空格拖动、滚动条、键盘）；一样 = 引擎自己写的那一下引起的
    const by = userMoved(k) ? 'user' : 'host';
    if (by === 'user' && rv && rv.k === k) stopReveal();   // 键盘滚动、触屏等没有单独入口的用户滚动
    syncVp(k); emitVp(k, by);
  };
  const onFocusIn = () => { inst._seq = ++SEQ.n; };
  // 窄宿主的浮层侧栏
  function setOverlay(on) { overlayOpen = !!on; applyPrefs(); }
  // 窄宿主的「⋯」菜单（封面 / 配色）：点外面、按 Esc、宿主变宽都收起
  const tset = $('.tset'), moreBtn = $('.more-btn');
  let moreOpen = false;
  function setMore(on) {
    if (!tset) return;
    moreOpen = !!on && narrow;
    tset.classList.toggle('open', moreOpen); moreBtn.setAttribute('aria-expanded', String(moreOpen));
    if (moreOpen) document.addEventListener('pointerdown', onDocDown, true); else document.removeEventListener('pointerdown', onDocDown, true);
  }
  function onDocDown(e) { const p = e.composedPath ? e.composedPath() : []; if (!p.includes(tset) && !p.includes(moreBtn)) setMore(false); }
  // 视图标签行放不下时：横向滚动（竖向滚轮也能滚它），哪边还有没露出来的标签，哪边就淡出
  const tabsEl = $('.tabs');
  function updTabsFade() {
    if (!PANE) return;
    const t = tabsEl, ovf = t.scrollWidth > t.clientWidth + 1;
    t.classList.toggle('ovf', ovf);
    t.style.setProperty('--tn-fl', ovf && t.scrollLeft > 1 ? '28px' : '0px');
    t.style.setProperty('--tn-fr', ovf && t.scrollLeft + t.clientWidth < t.scrollWidth - 1 ? '28px' : '0px');
  }
  const onTabsWheel = e => {
    const t = tabsEl;
    if (e.ctrlKey || t.scrollWidth <= t.clientWidth + 1 || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    const max = t.scrollWidth - t.clientWidth, d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    if ((d < 0 && t.scrollLeft <= 0) || (d > 0 && t.scrollLeft >= max - 1)) return;   // 滚到头了：交还给页面
    e.preventDefault(); t.scrollLeft += d;
  };
  if (PANE) { tabsEl.addEventListener('scroll', updTabsFade, { passive: true }); tabsEl.addEventListener('wheel', onTabsWheel, { passive: false }); }
  // 选中的标签整个露出来（不压在两边的淡出里）
  function showTab() {
    const tb = inst.view && $(`.tab[data-goto="${cssEsc(inst.view)}"]`); if (!tb || !tabsEl.clientWidth) return;
    const t = tabsEl, r = t.getBoundingClientRect(), b = tb.getBoundingClientRect(), pad = 30;
    if (b.left < r.left + pad) t.scrollLeft -= r.left + pad - b.left;
    else if (b.right > r.right - pad) t.scrollLeft += b.right - (r.right - pad);
  }
  function requestHostFull() { if (o.onFullRequest) try { o.onFullRequest(); } catch (e) { console.error(e); } }
  inst._hovered = () => hostHover;
  inst._pane = PANE;
  inst._shown = () => {
    if (!host.isConnected) return false;
    const r = host.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(host).visibility !== 'hidden';
  };
  // 封面加载失败 → 换成作品名首字（error 事件不冒泡，用捕获）
  const onImgErr = e => {
    const im = e.target; if (!im || !im.matches || !im.matches('img.cv')) return;
    const ph = document.createElement('span'); ph.className = 'cv ph'; ph.setAttribute('aria-hidden', 'true'); ph.textContent = im.dataset.ph || '?';
    im.replaceWith(ph);
  };
  wrap.addEventListener('error', onImgErr, true);
  wrap.addEventListener('pointerover', onOver);
  host.addEventListener('pointerenter', onEnter);
  host.addEventListener('pointerleave', onLeave);
  wrap.addEventListener('click', onGrabCap, true);
  wrap.addEventListener('dblclick', onGrabCap, true);
  wrap.addEventListener('click', onClick);
  wrap.addEventListener('dblclick', onDbl);
  wrap.addEventListener('pointerdown', onPDown);
  wrap.addEventListener('focusin', onFocusIn);
  document.addEventListener('keydown', onKey);
  if (PANE) {
    wrap.addEventListener('pointermove', onPMove);
    wrap.addEventListener('pointerup', onPUp);
    wrap.addEventListener('pointercancel', onPUp);
    wrap.addEventListener('lostpointercapture', onLostCap);
    wrap.addEventListener('wheel', onWheel, { passive: false });
    wrap.addEventListener('scroll', onScroll, true);
    document.addEventListener('keydown', onSpaceDown);
    document.addEventListener('keydown', onNavKey);
    document.addEventListener('keyup', onSpaceUp);
    window.addEventListener('blur', onBlur);
  }

  // ---------- 视区（'pane'：移动缩放） ----------
  // 每个视图各有一个视区 { zoom, cx, cy, home? }：cx/cy 是图区可见部分中心点对应的图上坐标（未缩放的画板像素）。
  // 平移范围：占位层（.zsz）四周的外边距由 fitSizer 按图区尺寸设——左右各「图区宽的一半 − 那边的内边距」，上下同理，
  // 所以滚动范围正好让视区中心走遍缩放后的画板（中心出不了画板：滚动位置被浏览器夹住）。
  // home：还在初始位置（缩放 1；画板比图区内容区大就贴左上、小就居中）。带 home 的视区
  // 还原、格子变大小、画板变大小时都重新按初始规则摆；滚动 / 缩放后按位置重新判断（syncVp、writeVp 里的 atHome）。
  // 没有 home 的视区（平移或缩放过的图）按 cx/cy 还原。
  // vz：各视图的缩放；vpLive：各视图最近一次的视区（看着时随滚动更新，离开时就是离开前的样子）；homeOf：各视图是不是 home；
  // vpPending：还没画过的视图要用的初始视区（mount 选项 viewports、setViewport 排的队）；drawn：画过的视图（重排时不清）。
  const ZMIN = 0.25, ZMAX = 3;
  const vz = {}, vpLive = {}, vpPending = {}, drawn = new Set(), emitT = {}, homeOf = {}, recheckT = {};
  if (o.viewports) for (const [k, vp] of Object.entries(o.viewports)) { const c = cleanVp(vp); if (c) vpPending[k] = c; }
  function cleanVp(vp) {
    if (!vp || typeof vp !== 'object') return null;
    const out = {};
    for (const f of ['zoom', 'cx', 'cy']) if (typeof vp[f] === 'number' && isFinite(vp[f])) out[f] = vp[f];
    if (vp.home === true) out.home = true;
    return out;
  }
  // 把部分视区 patch 合并到 base 上（缺的字段保持原值）。patch 带 home = 回到初始（缩放 1，patch 里别的字段不管）；
  // patch 给了 zoom / cx / cy 就不再是 home（按给的位置摆）
  function mergeVp(base, patch) {
    if (patch.home) return Object.assign({}, base, { zoom: 1, home: true });
    const out = Object.assign({}, base, patch);
    if ('zoom' in patch || 'cx' in patch || 'cy' in patch) delete out.home;
    return out;
  }
  const clampZ = z => Math.min(ZMAX, Math.max(ZMIN, +z || 1));
  const clampN = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const padOf = s => { const cs = getComputedStyle(s); return { l: parseFloat(cs.paddingLeft) || 0, r: parseFloat(cs.paddingRight) || 0, t: parseFloat(cs.paddingTop) || 0, b: parseFloat(cs.paddingBottom) || 0 }; };
  const wrapOf = k => { const b = k && boardOf(k); return b ? b.closest('.board-wrap') : null; };
  const viewBoard = () => (inst.view && boardOf(inst.view)) || null;
  const viewWrap = () => wrapOf(inst.view);
  const visible = k => { const s = wrapOf(k); return !!(s && s.clientWidth && s.clientHeight); };
  // 占位层 = 画板尺寸 × 缩放，外边距 = 半个图区减内边距（见上）；画板 transform 缩放（offsetWidth 这类测量不受 transform 影响，所以排版代码按未缩放的尺寸计算即可）。
  // 图区看不见（宽高为 0）时外边距是 0，重新看得见时 ResizeObserver / writeVp 会补上
  function fitSizer(k) {
    const b = boardOf(k); if (!b) return;
    if (b.style.width === 'auto') b.style.width = 'max-content';   // 绝对定位的画板没有明确宽度时，别让它跟着占位层缩成一条
    const z = vz[k] || 1, zsz = b.parentElement, s = zsz.parentElement, st = zsz.style;
    const w = Math.ceil(b.offsetWidth * z) + 'px', h = Math.ceil(b.offsetHeight * z) + 'px';
    if (st.width !== w) st.width = w;
    if (st.height !== h) st.height = h;
    const tf = z === 1 ? '' : `scale(${z})`;
    if (b.style.transform !== tf) b.style.transform = tf;
    const p = padOf(s), w0 = s.clientWidth, h0 = s.clientHeight;
    const px = v => Math.max(0, v) + 'px';
    const axes = [['marginLeft', 'marginRight', px(w0 / 2 - p.l), px(w0 / 2 - p.r), 'clientWidth', w0],
      ['marginTop', 'marginBottom', px(h0 / 2 - p.t), px(h0 / 2 - p.b), 'clientHeight', h0]];
    let changed = false;
    for (const [a, b2, va, vb] of axes) { if (st[a] !== va) { st[a] = va; changed = true; } if (st[b2] !== vb) { st[b2] = vb; changed = true; } }
    if (!changed) return;
    // 宿主没给定高度（或宽度）时图区是被内容撑开的：留白会反过来把图区撑得更大，再按更大的图区留更多白，越撑越大。
    // 改了留白以后量一下：图区在这个方向上跟着变了 = 这个方向是被内容撑开的，这个方向不留白（整张图都摊开）。
    // 宿主给定了尺寸时图区不随内容变，这里量到的和改留白之前相同
    for (const [a, b2, , , dim, before] of axes) {
      if (s[dim] !== before && (st[a] !== '0px' || st[b2] !== '0px')) { st[a] = '0px'; st[b2] = '0px'; }
    }
  }
  // readVp 顺便记下量的时候图区的尺寸和滚动位置（vpDim）。图区尺寸变了、ResizeObserver 还没来得及恢复中心时，
  // 滚动事件和 getViewport 读到的是被挤偏的中心，不能拿来覆盖 vpLive：syncVp 在尺寸没变时才更新（也才重新判断 home）
  const vpDim = {};
  const liveVp = k => !!k && k === inst.view && drawn.has(k) && domVp === k && visible(k);
  // home 只能被用户的平移、缩放去掉，而且当场去掉、不等滚动事件：空格拖动（onPMove）、空格+滚轮（zoomAt）、Shift+1（fitAll）
  // 是引擎自己挪的，挪完就改 homeOf；普通滚轮、拖滚动条由浏览器滚，开始时（wheel / 按下滚动条）就去掉（userScroll）。
  // 画板尺寸变了（改封面等样式、封面图加载完、重画前）而占位层还没跟上时，滚动位置和初始规则对不上是画板变了、不是用户挪的，
  // 这时不按初始规则重新判断，只信上面同步记下的 homeOf，再加一条：滚动位置和引擎上次读到 / 写下的不一样 = 用户挪过（movedOff）。
  // 还是 home 的直接按新尺寸重新摆
  function syncVp(k) {
    const s = wrapOf(k), d = vpDim[k];
    if (d && (d[0] !== s.clientWidth || d[1] !== s.clientHeight)) return;
    userCheck(k);
    if (!sized(k)) { if (homeOf[k] && !movedOff(k)) placeHome(k, 1); }
    else { const h = atHome(k); if (h !== !!homeOf[k]) { homeOf[k] = h; updBadge(k); } }
    vpLive[k] = readVp(k);
  }
  function leaveHome(k) { if (homeOf[k]) { homeOf[k] = false; updBadge(k); } }
  // 滚动位置离开了引擎上次读到 / 写下的位置：是用户挪的（键盘滚动、Tab 把作品滚进来这类没有单独入口的也算）。
  // 图区 overflow-anchor: none、占位层只由引擎改，图区尺寸没变时浏览器不会自己挪滚动位置；图区尺寸变了就分不清，不算
  function userMoved(k) {
    const s = wrapOf(k), d = vpDim[k];
    if (!s || !d || d[0] !== s.clientWidth || d[1] !== s.clientHeight) return false;
    return Math.abs(s.scrollLeft - d[2]) > 1 || Math.abs(s.scrollTop - d[3]) > 1;
  }
  function movedOff(k) { if (!userMoved(k)) return false; leaveHome(k); return true; }
  // 用户滚了、滚动事件还没到时有人先读了视区（宿主调 getViewport、重画前记中心）：读之前先把这次挪动记成用户的
  // （停下进行中的 reveal、回调 by:'user'），不然记录跟上以后，随后的滚动事件就分不出是用户滚的了
  function userCheck(k) {
    if (!userMoved(k)) return;
    if (rv && rv.k === k) stopReveal();
    emitVp(k, 'user');
  }
  // 引擎自己改了画板 / 占位层（重画、画板变大小），浏览器因此夹住了滚动位置：这不是用户挪的。
  // 改之前位置和记录一致（recOk）的，改完把记录里的位置跟上（recPos），之后的滚动事件、movedOff 不会当成用户挪的
  const recOk = k => PANE && !!vpDim[k] && !!wrapOf(k) && !userMoved(k);
  function recPos(k) { const s = wrapOf(k), d = vpDim[k]; if (s && d) { d[2] = s.scrollLeft; d[3] = s.scrollTop; } }
  // 浏览器原生滚动开始（普通滚轮、按住滚动条）：当场去掉 home——滚动位置要过一两帧才变，这期间画板变了大小也不会被拉回初始位置。
  // 最后其实没滚的（宿主拦下了滚轮、按了滚动条没拖）：过一会儿（或松开滚动条时）按位置重新判断一次，还在初始位置就恢复 home
  function userScroll(k) {
    if (!homeOf[k] || !liveVp(k)) return;
    leaveHome(k);
    clearTimeout(recheckT[k]);
    recheckT[k] = setTimeout(() => recheck(k), 300);
  }
  function recheck(k) {
    clearTimeout(recheckT[k]); delete recheckT[k];
    if (!inst.destroyed && !homeOf[k] && liveVp(k)) syncVp(k);
  }
  // 普通滚轮会不会滚到这个图区：按 deltaX / deltaY 的方向，图区还能不能往那边滚；路上有自己还能往那边滚的元素时滚的是它
  function wheelScrolls(s, e) {
    let dx = e.deltaX, dy = e.deltaY;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }      // Shift + 滚轮 = 横向
    const can = el => {
      const cs = getComputedStyle(el), sc = v => v === 'auto' || v === 'scroll' || v === 'overlay';
      return (dx && sc(cs.overflowX) && (dx < 0 ? el.scrollLeft > 0.5 : el.scrollLeft < el.scrollWidth - el.clientWidth - 0.5)) ||
        (dy && sc(cs.overflowY) && (dy < 0 ? el.scrollTop > 0.5 : el.scrollTop < el.scrollHeight - el.clientHeight - 0.5));
    };
    for (let el = e.target; el && el !== s; el = el.parentElement) if (el.nodeType === 1 && can(el)) return false;
    return !!can(s);
  }
  // 按在了图区自己的滚动条上：内容区右边 / 下边、边框以内的那一条（浮层滚动条不占位置，这一条宽 0，不会算上）
  function onScrollbar(s, e) {
    const r = s.getBoundingClientRect(), x = e.clientX - r.left - s.clientLeft, y = e.clientY - r.top - s.clientTop;
    return (x >= s.clientWidth && x < s.offsetWidth - 2 * s.clientLeft) || (y >= s.clientHeight && y < s.offsetHeight - 2 * s.clientTop);
  }
  // 占位层是不是已经跟上了画板现在的尺寸（fitSizer 之后才是）
  function sized(k) {
    const b = boardOf(k), st = b.parentElement.style, z = vz[k] || 1;
    return st.width === Math.ceil(b.offsetWidth * z) + 'px' && st.height === Math.ceil(b.offsetHeight * z) + 'px';
  }
  function readVp(k) {
    const s = wrapOf(k), zsz = boardOf(k).parentElement, z = vz[k] || 1;
    vpDim[k] = [s.clientWidth, s.clientHeight, s.scrollLeft, s.scrollTop];
    const vp = { zoom: z, cx: (s.scrollLeft + s.clientWidth / 2 - zsz.offsetLeft) / z, cy: (s.scrollTop + s.clientHeight / 2 - zsz.offsetTop) / z };
    if (homeOf[k]) vp.home = true;
    return vp;
  }
  // 初始位置（fit = false）/「显示全图」（fit = true）的滚动位置：画板放进图区内容区（扣掉内边距），放得下就居中；
  // 放不下时初始位置贴左上（scrollLeft/Top = 0），显示全图照样居中。已按滚动范围夹好
  function placeScroll(k, fit) {
    const s = wrapOf(k), b = boardOf(k), zsz = b.parentElement, p = padOf(s), z = vz[k] || 1;
    // 用画板缩放后的实际大小（占位层向上取整过，缩放不是 1 时会大出不到 1px）
    const dx = (s.clientWidth - p.l - p.r - b.offsetWidth * z) / 2, dy = (s.clientHeight - p.t - p.b - b.offsetHeight * z) / 2;
    const x = zsz.offsetLeft - p.l - (fit ? dx : Math.max(0, dx)), y = zsz.offsetTop - p.t - (fit ? dy : Math.max(0, dy));
    return [clampN(x, 0, s.scrollWidth - s.clientWidth), clampN(y, 0, s.scrollHeight - s.clientHeight)];
  }
  // 现在是不是在初始位置：缩放 1，滚动位置和初始规则差不到 1px
  function atHome(k) {
    if (Math.abs((vz[k] || 1) - 1) > 0.004) return false;
    const s = wrapOf(k), h = placeScroll(k, false);
    return Math.abs(s.scrollLeft - h[0]) <= 1 && Math.abs(s.scrollTop - h[1]) <= 1;
  }
  // 按初始规则摆在缩放 z 上（第一次画、回到初始）
  function placeHome(k, z) {
    const s = wrapOf(k);
    vz[k] = clampZ(z); fitSizer(k);
    const h = placeScroll(k, false); s.scrollLeft = h[0]; s.scrollTop = h[1];
  }
  // 把视区写进 DOM。vp.home：按初始规则摆（缩放 1）。否则图上 (cx, cy) 落在锚点 ax/ay（可见区域里的位置，默认可见区域中心）上
  function writeVp(k, vp, ax, ay) {
    const s = wrapOf(k), zsz = boardOf(k).parentElement;
    if (vp.home) { placeHome(k, 1); homeOf[k] = true; }
    else {
      vz[k] = clampZ(vp.zoom); fitSizer(k);
      const z = vz[k], px = ax == null ? s.clientWidth / 2 : ax, py = ay == null ? s.clientHeight / 2 : ay;
      if (vp.cx != null) s.scrollLeft = zsz.offsetLeft + vp.cx * z - px;
      if (vp.cy != null) s.scrollTop = zsz.offsetTop + vp.cy * z - py;
      homeOf[k] = atHome(k);
    }
    updBadge(k);
  }
  // 右下角小标签：不在初始位置（平移过或缩放过）就显示，内容是缩放百分比；点它 = 回到初始
  function updBadge(k) {
    const s = wrapOf(k); if (!s) return;
    const badge = s.parentElement.querySelector('.zoom-badge'); if (!badge) return;
    const z = vz[k] || 1, off = !homeOf[k];
    badge.hidden = !off;
    if (!off) return;
    badge.textContent = Math.round(z * 100) + '%';
    // 让开图区的滚动条
    const sbw = Math.max(0, s.offsetWidth - s.clientWidth - 2 * s.clientLeft), sbh = Math.max(0, s.offsetHeight - s.clientHeight - 2 * s.clientTop);
    let right = 8 + s.clientLeft + sbw;
    // 窄宿主的浮层侧栏开着时它盖住图区右边一整条：小标签挪到浮层左边（浮层左边按排版位置算，不受滑入动画的位移影响）
    if (narrow && !drawer.hidden && drawer.offsetParent) {
      const op = drawer.offsetParent, box = s.parentElement.getBoundingClientRect();
      const dl = op.getBoundingClientRect().left + op.clientLeft + drawer.offsetLeft;
      right = Math.max(right, Math.min(box.right - dl + 8, box.width - badge.offsetWidth - 8));
    }
    badge.style.right = right + 'px'; badge.style.bottom = (8 + s.clientTop + sbh) + 'px';
  }
  function zoomAt(k, nz, clientX, clientY) {
    if (!k || !drawn.has(k) || domVp !== k || !visible(k)) return;
    const s = wrapOf(k), zsz = boardOf(k).parentElement, z0 = vz[k] || 1;
    const r = s.getBoundingClientRect(), ax = clientX - r.left - s.clientLeft, ay = clientY - r.top - s.clientTop;
    const bx = (s.scrollLeft + ax - zsz.offsetLeft) / z0, by = (s.scrollTop + ay - zsz.offsetTop) / z0;
    nz = clampZ(nz); if (nz === z0) return;
    writeVp(k, { zoom: nz, cx: bx, cy: by }, ax, ay);
    vpLive[k] = readVp(k); emitVp(k, 'user');
  }
  // 停下约 200ms 后回调宿主。by = 谁动的：'user' 用户、'focus' focusWorks 的 reveal、'host' setViewport / 格子变大小重摆等；
  // 合并的这段时间里有过 'user' 就报 'user'，其次 'focus'
  const BY_RANK = { host: 0, focus: 1, user: 2 }, emitBy = {};
  function emitVp(k, by) {
    if (!o.onViewportChange) return;
    by = BY_RANK[by] != null ? by : 'host';
    if (!emitBy[k] || BY_RANK[by] > BY_RANK[emitBy[k]]) emitBy[k] = by;
    clearTimeout(emitT[k]);
    emitT[k] = setTimeout(() => {
      delete emitT[k]; const b = emitBy[k] || 'host'; delete emitBy[k];
      if (inst.destroyed) return;
      const vp = getViewport(k); if (!vp) return;
      try { o.onViewportChange(k, vp, { by: b }); } catch (e) { console.error(e); }
    }, 200);
  }
  // 视图画完（或重画完）以后：先用排着的初始视区；重画的（尺寸变了）回到重画前的视区（home 的重新按初始规则摆）；
  // 第一次画、没有初始视区的在初始位置
  function paneDrawn(k) {
    fitSizer(k);
    if (k === 'terr' && !TERR_CACHE.has(inst.M)) return;  // 领地图还在排布，只是占位
    if (k !== inst.view || !visible(k)) return;
    const first = !drawn.has(k); drawn.add(k);
    const p = vpPending[k]; delete vpPending[k];
    if (p && !p.home) {
      // 排着的视区（缺的字段 = 现在的值：第一次画时 = 按初始规则摆在排着的缩放上）
      let base;
      if (!first && vpLive[k]) base = domVp !== k ? Object.assign({}, vpLive[k]) : readVp(k);
      else { placeHome(k, p.zoom != null ? p.zoom : 1); homeOf[k] = atHome(k); base = readVp(k); }
      writeVp(k, mergeVp(base, p));
    } else if (p || first || !vpLive[k]) writeVp(k, { home: true });
    else writeVp(k, vpLive[k]);
    vpLive[k] = readVp(k); domVp = k;
    pfKick();                                          // 排着的程序聚焦在排着的视区之后执行
  }
  function getViewport(view) {
    const k = view || inst.view; if (!k || !drawn.has(k)) return null;
    if (!PANE) {
      // 'page' 不缩放：只有横向滚动是图区自己的（reveal 缓动中按终点算）
      const s = wrapOf(k), b = boardOf(k), sl = rv && rv.page && rv.k === k ? rv.to : s.scrollLeft;
      return { zoom: 1, cx: s.clientWidth ? sl + s.clientWidth / 2 - b.offsetLeft : b.offsetWidth / 2, cy: b.offsetHeight / 2 };
    }
    if (rv && rv.k === k && liveVp(k)) userCheck(k);                   // 用户刚滚了（滚动事件还没到）：缓动到此为止
    if (rv && rv.k === k) return Object.assign({}, rv.to);             // reveal 缓动中：返回终点
    if (k === inst.view && domVp === k && visible(k)) syncVp(k);
    return vpLive[k] ? Object.assign({}, vpLive[k]) : null;
  }
  function setViewport(vp, view, by) {
    const k = view || inst.view; const c = cleanVp(vp); if (!k || !c || !allViews.some(v => v.key === k && !v.custom)) return;
    if (rv && rv.k === k) stopReveal(true);
    if (!PANE) {
      if (c.cx == null || !drawn.has(k)) return;
      const s = wrapOf(k), b = boardOf(k);
      if (s.clientWidth) s.scrollLeft = b.offsetLeft + c.cx - s.clientWidth / 2;
      return;
    }
    if (!drawn.has(k)) { vpPending[k] = mergeVp(vpPending[k] || {}, c); return; }   // 还没画完：画完再应用
    const nv = mergeVp(getViewport(k) || { zoom: 1, cx: 0, cy: 0 }, c);
    nv.zoom = clampZ(nv.zoom);
    if (k === inst.view && domVp === k && visible(k)) { writeVp(k, nv); vpLive[k] = readVp(k); }
    else { vz[k] = nv.zoom; vpLive[k] = nv; homeOf[k] = !!nv.home; }                   // 下次显示时应用
    emitVp(k, by || 'host');
  }
  function resetZoom() {
    if (!PANE) return;
    const k = inst.view; if (!k || !drawn.has(k)) return;
    const cur = getViewport(k); if (!cur || cur.zoom === 1) return;
    setViewport({ zoom: 1, cx: cur.cx, cy: cur.cy }, k);
  }
  // Shift+0 / 点右下角小标签：回到初始（100%、初始位置）
  function goHome() {
    const k = inst.view; if (!PANE || !k || !drawn.has(k)) return false;
    setViewport({ home: true }, k, 'user');
    return true;
  }
  // Shift+1：显示全图——缩放到整张图刚好放进图区内容区（最大 100%，不放大），居中
  function fitAll() {
    const k = inst.view; if (!PANE || !k || !drawn.has(k) || domVp !== k || !visible(k)) return false;
    const s = wrapOf(k), b = boardOf(k), p = padOf(s);
    const iw = s.clientWidth - p.l - p.r, ih = s.clientHeight - p.t - p.b;
    if (!b.offsetWidth || !b.offsetHeight || iw <= 0 || ih <= 0) return false;
    stopReveal(true);
    vz[k] = clampZ(Math.min(1, iw / b.offsetWidth, ih / b.offsetHeight)); fitSizer(k);
    const f = placeScroll(k, true); s.scrollLeft = f[0]; s.scrollTop = f[1];
    homeOf[k] = atHome(k); updBadge(k);
    vpLive[k] = readVp(k); emitVp(k, 'user');
    return true;
  }

  // ---------- 程序聚焦（focusWorks / clearFocus / drawnWorkIds：做题联动把答案作品显示出来并高亮） ----------
  // 效果和悬停作品卡一样（applyHL：作品框、标签近邻、其他作品变淡），另有次要作品的虚线框（sec）、flash 的闪框（fl）。
  // 显示谁：用户固定的高亮 > 鼠标悬停 > 程序聚焦——悬停临时盖住它，移开回到它。最后一次操作说了算：
  // focusWorks 取消用户的固定；用户点击固定（接管）、Esc 清掉程序聚焦。
  // pf：{ ids, sec, mode, reveal, pending, flashT0, flashT }。pending = reveal、开始闪还没做：实例没画完 / 看不见时排着，
  // 画完（paneDrawn / afterDraw）、重新看得见（ResizeObserver）时做（pfKick）
  let pf = null;
  // rv：进行中的 reveal 缓动 { k, page, from, to, t0, raf, done, last }
  let rv = null;
  const FLASH_MS = 1500, REVEAL_MS = 250, REVEAL_PAD = 24;
  const reduced = () => { try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; } };
  const uniq = a => [...new Set((Array.isArray(a) ? a : []).filter(x => x != null && x !== '').map(String))];
  // 视图画完了没有（领地图还在排布时只是占位，不算）
  const isDrawn = k => !!k && !!boardOf(k) && inst.rendered.has(k) && drawn.has(k) && !(k === 'terr' && !TERR_CACHE.has(inst.M));
  const pfReady = () => isDrawn(inst.view) && (PANE ? liveVp(inst.view) : visible(inst.view));
  function drawnWorkIds() {
    const k = inst.view; if (!isDrawn(k)) return null;
    return uniq([...boardOf(k).querySelectorAll('[data-wid]')].map(e => e.dataset.wid));
  }
  function pfState() {
    const M = inst.M; if (!pf || !M) return null;
    const ws = pf.ids.filter(id => M.byId.has(id)).map(id => M.byId.get(id));
    const lit = new Set(), focus = new Set();
    for (const w of ws) { focus.add(w.id); lit.add(w.id); w.nb1.forEach(i => lit.add(i)); w.nb2.forEach(i => lit.add(i)); }
    return { kind: 'work', work: ws.length === 1 ? ws[0] : null, lit, focus, key: 'pf', sec: new Set(pf.sec), fl: pf.flashT0 };
  }
  // 把程序聚焦画到当前视图上。用户固定了高亮、鼠标正悬停在别的东西上时不画（轮到它时再画）；
  // 这个视图里一部主作品都没画出来时不画（不然整张图都变淡）。reading：侧栏读数也换成它（第一部）
  function pfShow(reading) {
    if (!pf || inst.pinned || inst.hoverKey) return;
    const b = activeBoard(), st = pfState(); if (!b || !st) return;
    if ([...st.focus].some(id => b.querySelector(`[data-wid="${cssEsc(id)}"]`))) applyHL(b, st); else clearHL(b);
    if (reading) renderNow(st.focus.size ? workState(inst.M.byId.get([...st.focus][0])) : null);
  }
  // 执行排着的：reveal，结束（或被用户打断）后 flash 开始闪
  function pfKick() {
    holdTouch();                                     // 调用点都是画完 / 尺寸变了 / 切视图之后
    if (!pf || !pf.pending || !pfReady()) return;
    const me = pf; me.pending = false;
    pfShow();
    const go = () => { if (pf === me && me.mode === 'flash' && me.flashT0 == null) pfFlash(); };
    if (me.reveal) reveal(me.ids, go); else go();
  }
  function pfFlash() {
    const me = pf;
    me.flashT0 = performance.now();
    pfShow();
    me.flashT = setTimeout(() => { if (pf === me) clearFocus(); }, FLASH_MS);
  }
  // 去掉程序聚焦的记录（不动画板）
  function pfEnd() { const old = pf; pf = null; if (old) clearTimeout(old.flashT); return old; }
  function clearFocus() {
    if (!pf) return;
    const shown = !inst.pinned && !inst.hoverKey;
    pfEnd(); stopReveal();
    if (shown) clearHL(activeBoard());
  }
  function focusWorks(ids, opts) {
    opts = opts || {};
    const list = uniq(ids);
    if (!list.length) { clearFocus(); return { found: [], secondaryFound: [], queued: false }; }
    pfEnd(); stopReveal();
    inst.pinned = null; inst.hoverKey = null;        // 用户固定的高亮让位（最后一次操作说了算）；正悬停的先让程序聚焦显示出来
    holdStart();                                     // 鼠标真正移动之前，浏览器补发的悬停不盖住它
    pf = { ids: list, sec: uniq(opts.secondary).filter(id => !list.includes(id)), mode: opts.mode === 'flash' ? 'flash' : 'stay',
      reveal: opts.reveal !== false, pending: true, flashT0: null, flashT: 0 };
    const M = inst.M, ready = pfReady(), have = ready ? new Set(drawnWorkIds()) : null;
    const has = id => !!M && M.byId.has(id) && (!have || have.has(id));   // 排队时按数据判断
    const res = { found: pf.ids.filter(has), secondaryFound: pf.sec.filter(has), queued: !ready };
    pfShow(true);
    pfKick();
    return res;
  }

  // reveal：让 ids（这个视图里画出来的）完整显示在图区可见矩形里，四周留 REVEAL_PAD。
  // 本来就完整可见 → 不动（home 保留，不回调）；不完整 → 最小平移；当前缩放装不下 → 缩小到刚好装下（不低于最小缩放），绝不放大；
  // 几部的外接矩形在最小缩放下也装不下 → 只保证第一部。动了：去掉 home，约 250ms 缓动（prefers-reduced-motion 时瞬间），
  // 结束后 onViewportChange(…, { by: 'focus' })。'page' 只做横向滚动。done：结束或被打断后调用
  function reveal(ids, done) {
    const k = inst.view, b = boardOf(k);
    const els = ids.map(id => b.querySelector(`[data-wid="${cssEsc(id)}"]`)).filter(Boolean).map(frameOf);
    if (!els.length) return done();
    return PANE ? revealPane(k, els, done) : revealPage(k, els, done);
  }
  // 作品的「框」：增减阶梯是整个节点，标签谱是标题格（整行很宽），其余是作品卡 / 行本身
  const frameOf = el => el.closest('.hnode') || (el.classList.contains('srow') && el.querySelector('.ttl')) || el;
  // 一组元素的外接矩形（屏幕坐标）
  function boxOf(els) {
    let R = null;
    for (const el of els) {
      const q = el.getBoundingClientRect(); if (!q.width && !q.height) continue;
      R = R ? { l: Math.min(R.l, q.left), t: Math.min(R.t, q.top), r: Math.max(R.r, q.right), b: Math.max(R.b, q.bottom) } : { l: q.left, t: q.top, r: q.right, b: q.bottom };
    }
    return R;
  }
  // 最小平移：把 [a0, a1] 移进 [lo, hi] 要挪多少；放不下时对齐 lo
  const panBy = (a0, a1, lo, hi) => a0 < lo ? a0 - lo : a1 > hi ? Math.min(a1 - hi, a0 - lo) : 0;
  // 图区可见矩形（屏幕坐标，扣掉边框和滚动条；窄宿主的浮层侧栏开着时扣掉它盖住的右边）
  function visBox(k) {
    const s = wrapOf(k), sr = s.getBoundingClientRect(), l = sr.left + s.clientLeft, t = sr.top + s.clientTop;
    let r = l + s.clientWidth;
    if (PANE && narrow && !drawer.hidden && drawer.offsetParent) {
      const op = drawer.offsetParent;
      r = Math.min(r, op.getBoundingClientRect().left + op.clientLeft + drawer.offsetLeft);
    }
    return { l, t, r: Math.max(l, r), b: t + s.clientHeight };
  }
  function revealPane(k, els, done) {
    const s = wrapOf(k), bd = boardOf(k), zsz = bd.parentElement, z0 = vz[k] || 1, V = visBox(k), P = REVEAL_PAD;
    const aw = Math.max(1, V.r - V.l - 2 * P), ah = Math.max(1, V.b - V.t - 2 * P), br = bd.getBoundingClientRect();
    const toB = R => R && { x0: (R.l - br.left) / z0, y0: (R.t - br.top) / z0, x1: (R.r - br.left) / z0, y1: (R.b - br.top) / z0 };   // 未缩放的画板坐标
    const need = R => Math.min(aw / Math.max(1e-6, R.x1 - R.x0), ah / Math.max(1e-6, R.y1 - R.y0));                       // 刚好装下的缩放
    let R = toB(boxOf(els)); if (!R) return done();
    if (els.length > 1 && need(R) < ZMIN) R = toB(boxOf([els[0]])) || R;
    const z1 = need(R) >= z0 ? z0 : clampZ(need(R));
    // 视区中心（画板坐标）不动地换到 z1，再算作品在屏幕上的位置、要平移多少
    const cx0 = (s.scrollLeft + s.clientWidth / 2 - zsz.offsetLeft) / z0, cy0 = (s.scrollTop + s.clientHeight / 2 - zsz.offsetTop) / z0;
    const sr = s.getBoundingClientRect(), Cx = sr.left + s.clientLeft + s.clientWidth / 2, Cy = sr.top + s.clientTop + s.clientHeight / 2;
    const dx = panBy(Cx + (R.x0 - cx0) * z1, Cx + (R.x1 - cx0) * z1, V.l + P, V.r - P);
    const dy = panBy(Cy + (R.y0 - cy0) * z1, Cy + (R.y1 - cy0) * z1, V.t + P, V.b - P);
    if (z1 === z0 && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return done();
    const to = { zoom: z1, cx: clampN(cx0 + dx / z1, 0, bd.offsetWidth), cy: clampN(cy0 + dy / z1, 0, bd.offsetHeight) };
    leaveHome(k);
    if (reduced()) { writeVp(k, to); vpLive[k] = readVp(k); emitVp(k, 'focus'); return done(); }
    rv = { k, page: false, from: { zoom: z0, cx: cx0, cy: cy0 }, to, t0: performance.now(), raf: 0, done };
    rv.raf = requestAnimationFrame(revealTick);
  }
  function revealPage(k, els, done) {
    const s = wrapOf(k), R = boxOf(els), P = REVEAL_PAD;
    if (!R || !s.clientWidth || s.scrollWidth <= s.clientWidth) return done();
    const V = visBox(k);
    let r = R;
    if (els.length > 1 && r.r - r.l > V.r - V.l - 2 * P) r = boxOf([els[0]]) || R;
    const dx = panBy(r.l, r.r, V.l + P, V.r - P);
    const from = s.scrollLeft, to = clampN(from + dx, 0, s.scrollWidth - s.clientWidth);
    if (Math.abs(to - from) < 0.5) return done();
    if (reduced()) { s.scrollLeft = to; return done(); }
    rv = { k, page: true, from, to, t0: performance.now(), raf: 0, done, last: from };
    rv.raf = requestAnimationFrame(revealTick);
  }
  function revealTick(now) {
    const r = rv; if (!r || inst.destroyed) return;
    const t = Math.min(1, Math.max(0, (now - r.t0) / REVEAL_MS)), e = 1 - Math.pow(1 - t, 3);
    if (r.page) {
      const s = wrapOf(r.k);
      if (Math.abs(s.scrollLeft - r.last) > 1) { stopReveal(); return; }   // 用户自己滚了：以用户为准
      s.scrollLeft = t >= 1 ? r.to : r.from + (r.to - r.from) * e; r.last = s.scrollLeft;
    } else {
      if (!liveVp(r.k)) { stopReveal(); return; }
      const f = r.from, g = r.to;
      writeVp(r.k, t >= 1 ? g : { zoom: f.zoom * Math.pow(g.zoom / f.zoom, e), cx: f.cx + (g.cx - f.cx) * e, cy: f.cy + (g.cy - f.cy) * e });
      vpLive[r.k] = readVp(r.k);
    }
    if (t < 1) { r.raf = requestAnimationFrame(revealTick); return; }
    rv = null;
    if (!r.page) emitVp(r.k, 'focus');
    r.done();
  }
  // 停下 reveal 缓动，停在当前位置（用户接手、宿主改视区、切视图、新的聚焦……）。quiet：调用方自己会回调宿主
  function stopReveal(quiet) {
    const r = rv; if (!r) return;
    rv = null; cancelAnimationFrame(r.raf);
    if (inst.destroyed) return;
    if (!r.page) { if (liveVp(r.k)) vpLive[r.k] = readVp(r.k); if (!quiet) emitVp(r.k, 'focus'); }
    r.done();
  }

  // ---------- 视图与偏好 ----------
  // 分支画布、卡诺图的排版跟着可用宽度走，分支画布的「一屏」还按窗口高算。laid 记下它们各自上次排版时 .root 的宽和窗口的高。
  // 'pane'：「一屏」按图区自己的高度；laid 里记的是 .main 的宽和高（各视图共用，切走的视图也量得到；侧栏开合、窄宿主都反映在 .main 上）。
  const WIDE = ['canvas', 'kmap'];
  const laid = {};
  const areaWH = () => PANE ? [main.clientWidth, main.clientHeight] : [wrap.getBoundingClientRect().width, window.innerHeight || 0];
  function renderView(k) {
    const v = allViews.find(x => x.key === k); if (!v) return;
    const sec = main.querySelector(`[data-view="${k}"]`);
    if (v.custom) { try { v.render(sec.querySelector('.custom'), inst); } catch (e) { console.error(e); } inst.rendered.add(k); return; }
    if (!inst.M) return;
    const board = boardOf(k);
    if (!host.isConnected || host.getBoundingClientRect().width === 0) return; // 不可见时推迟，ResizeObserver 会补画
    const ctx = { z: inst.prefs.scale, inst }, keep = recOk(k);
    if (PANE) {
      // 重画前记下中心，画完回到那里；排版按缩放 1 时的图区尺寸算：宽度不够时 width:auto 的画板也像 'page' 里一样至少铺满图区
      if (drawn.has(k) && k === inst.view && domVp === k && visible(k)) syncVp(k);
      // 'page' 里 width:auto 的画板是块级、铺满图区的内容宽；这里画板绝对定位，排版期间让占位层和画板都至少有图区内容宽，结果一样
      const s = board.closest('.board-wrap'), cs = getComputedStyle(s);
      ctx.fitH = Math.max(0, s.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
      const aw = Math.max(0, s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) + 'px';
      board.style.minWidth = aw; board.parentElement.style.width = aw; board.style.transform = '';
    }
    try { RENDER[k](inst.M, board, ctx); }
    catch (err) { console.error(err); board.querySelector('.layer').innerHTML = `<p class="wait">这个视图没能画出来：${esc(err.message)}</p>`; board.style.width = 'auto'; }
    if (PANE) { board.style.minWidth = ''; fitSizer(k); }
    inst.rendered.add(k);
    if (WIDE.includes(k)) { const [w, h] = areaWH(); laid[k] = { w, h }; }
    afterDraw(k, board);
    if (keep) recPos(k);
  }
  // 重画了正在看的视图（尺寸变了、领地图异步排完）：固定的高亮跟着新画板走；悬停的高亮随旧画板没了，清掉记号，下次悬停重新高亮
  function afterDraw(k, board) {
    if (k !== inst.view) return;
    if (PANE) { const keep = recOk(k); paneDrawn(k); if (keep) recPos(k); }
    else drawn.add(k);
    if (inst.pinned && inst.pinned.lit) applyHL(board, inst.pinned); else { inst.hoverKey = null; pfShow(); }
    pfKick();
  }
  inst.afterDraw = afterDraw;
  function setView(k) {
    if (!allViews.some(v => v.key === k)) k = allViews[0] && allViews[0].key;
    if (inst.pinned) unpin();
    const changed = inst.view !== k, prev = inst.view;
    if (changed) stopReveal();
    if (PANE && changed && inst.view && drawn.has(inst.view) && domVp === inst.view && visible(inst.view)) syncVp(inst.view);  // 切走前记下视区
    if (changed && drag) endDrag();
    if (changed) domVp = null;
    inst.view = k;
    $$('.view').forEach(s => s.hidden = s.dataset.view !== k);
    $$('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.goto === k)));
    if (PANE) { showTab(); updTabsFade(); }
    else { const tb = $(`.tab[data-goto="${cssEsc(k)}"]`); if (tb) { const nav = tb.parentElement; if (tb.offsetLeft < nav.scrollLeft || tb.offsetLeft + tb.offsetWidth > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = Math.max(0, tb.offsetLeft - 40); } }
    if (!inst.rendered.has(k)) renderView(k);
    else if (PANE && changed && visible(k)) {                                    // 切回来：恢复这个视图自己的视区
      if (!drawn.has(k) || vpPending[k] || !vpLive[k]) paneDrawn(k);
      else { writeVp(k, vpLive[k]); vpLive[k] = readVp(k); domVp = k; }
    }
    if (changed && pf) { const ob = prev && boardOf(prev); if (ob) clearHL(ob); inst.hoverKey = null; pfShow(); pfKick(); }
    if (changed) { inst.prefs.view = k; emitPrefs(); if (o.onViewChange) try { o.onViewChange(k); } catch (e) { console.error(e); } }
  }
  function applyPrefs() {
    const p = inst.prefs;
    host.classList.toggle('tn-nocover', !p.cover);
    host.classList.toggle('tn-mono', !p.color);
    host.classList.toggle('tn-openable', !!o.onWorkOpen);
    host.style.setProperty('--tn-z', String(p.scale));
    $$('[data-act="cover"]').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.v === '1') === !!p.cover)));
    $$('[data-act="color"]').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.v === '1') === !!p.color)));
    const dOpen = PANE && narrow ? overlayOpen : !!p.drawer;   // 窄宿主的 'pane'：侧栏是浮层，开合不改偏好
    drawer.hidden = !dOpen;
    if (PANE && inst.view) updBadge(inst.view);     // 窄宿主浮层开合：小标签让开 / 回到右下角
    if (dOpen) refitNow(true);
    const db = $('.drawer-btn'); db.setAttribute('aria-expanded', String(dOpen)); db.querySelector('.ar').textContent = dOpen ? '‹' : '›';
    if (o.theme === 'light' || o.theme === 'dark') host.setAttribute('data-theme', o.theme); else host.removeAttribute('data-theme');
  }
  function setPrefs(patch) {
    const before = Object.assign({}, inst.prefs);
    Object.assign(inst.prefs, patch || {});
    // 改样式（封面、配色、侧栏）会马上改画板 / 图区尺寸：先按改之前的样子记下视区和 home，重排后照它还原
    if (PANE && inst.view && drawn.has(inst.view) && domVp === inst.view && visible(inst.view)) syncVp(inst.view);
    applyPrefs(); emitPrefs();
    const p = inst.prefs;
    if (before.cover !== p.cover || +before.scale !== +p.scale) rerender();
    else if (before.drawer !== p.drawer && ['canvas', 'kmap'].includes(inst.view)) rerender();
  }
  function rerender() {
    inst.rendered.clear(); if (inst.pinned) unpin(); inst.hoverKey = null;
    if (inst.view) renderView(inst.view);
    nowSized = false; sizeNow();
  }
  function setData(raw) {
    inst.raw = raw;
    inst.cacheStore = Object.assign({}, (raw && raw.layout_cache) || {});
    inst.M = buildModel(raw || { works: [] }, o.config, o.coverOf);
    inst.pinned = null; inst.hoverKey = null;
    renderDrawer(); rerender();
  }
  function setTheme(t) { o.theme = t; applyPrefs(); }

  // ---------- 尺寸变化 ----------
  // 量的是 .root：平时和宿主一样宽；全屏时它铺满屏幕，宿主宽度不变。
  // 分支画布、卡诺图和自己排版时（laid）比：宽差 > 30px，或分支画布的窗口高差 > 60px，就重排。
  // 慢慢拖动时每次只差几像素，也会在累计超过阈值时重排。
  let fitRaf = 0, wideRaf = 0, wideForce = false;
  const stale = (k, w, h) => !laid[k] || Math.abs(w - laid[k].w) > 30 || (k === 'canvas' && Math.abs(h - laid[k].h) > 60);
  // 下一帧重排：正在看的那个马上画，没在看的那个标为没画过、切过去时再画。同一帧里多次请求只排一次。
  // force：不比尺寸，画过的都重排（进出全屏时内容区的宽变了，外框宽度却未必变）。
  // 'pane'：拖分隔线时格子连续变大小，不能每帧重排：停下 160ms 后再排（force 时马上）。
  let wideT = 0;
  function relayoutWide(force) {
    if (force) wideForce = true;
    const run = () => {
      const f = wideForce; wideForce = false;
      if (inst.destroyed) return;
      const [w, h] = areaWH();
      if (!w) { if (f) WIDE.forEach(k => inst.rendered.delete(k)); return; }   // 看不见时不画，等 ResizeObserver 发现有了宽度再画
      WIDE.forEach(k => {
        if (!inst.rendered.has(k) || !(f || stale(k, w, h))) return;
        inst.rendered.delete(k); if (k === inst.view) renderView(k);
      });
    };
    if (PANE) { clearTimeout(wideT); wideT = setTimeout(() => { wideT = 0; run(); }, wideForce ? 0 : 160); return; }
    if (wideRaf) return;
    wideRaf = requestAnimationFrame(() => { wideRaf = 0; run(); });
  }
  function checkWide() {
    const [w, h] = areaWH();
    if (w && WIDE.some(k => inst.rendered.has(k) && stale(k, w, h))) relayoutWide();
  }
  // 'pane'：.root 内容宽 ≤ 720px（和 CSS 里 @container tn (max-width: 720px) 同一个界）时进入窄宿主模式，浮层侧栏先收起
  function checkNarrow() {
    if (!PANE || !wrap.clientWidth) return;
    const cs = getComputedStyle(wrap);
    const n = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) <= 720;
    if (n === narrow) return;
    narrow = n; overlayOpen = false;
    wrap.classList.toggle('narrow', n);
    setMore(false);
    applyPrefs();
    showTab(); updTabsFade();
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
    const w = wrap.getBoundingClientRect().width;
    if (!w) return;
    checkNarrow();
    // 读数区改高度会改变宿主的高度，在本回调里直接改会引出 “ResizeObserver loop” 警告，所以放到下一帧
    if (!fitRaf) fitRaf = requestAnimationFrame(() => { fitRaf = 0; if (!inst.destroyed) refitNow(); });
    checkWide();
    if (inst.view && !inst.rendered.has(inst.view)) renderView(inst.view);
    pfKick();
  }) : null;
  if (ro) ro.observe(wrap);
  // 'pane'：.main 变了 → 也许要重排（侧栏开合、拖分隔线）；画板变了（封面图加载完、重画）→ 占位层跟着变；
  // 图区变了 → 保持视区中心不动（格子变大变小时还对着同一块）；还没画完（当时图区没有高度）的视图补上
  const paneRO = PANE && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(entries => {
    if (inst.destroyed) return;
    for (const en of entries) {
      const t = en.target;
      if (t === main) { if (main.clientWidth) checkWide(); continue; }
      if (t === tabsEl || t.classList.contains('tab')) { updTabsFade(); continue; }   // 标签行变宽变窄、字体加载完标签变宽
      if (t.classList.contains('board')) {
        if (!t.offsetWidth && !t.offsetHeight) continue;
        // 还在初始位置的：画板变了大小（封面图加载完等）也重新按初始规则摆（放得下时要重新居中）。
        // 用户挪过没有要在 fitSizer 之前看（改了占位层，浏览器可能夹住滚动位置，就分不清了）
        const bk = t.dataset.board, home = homeOf[bk] && liveVp(bk) && !movedOff(bk), keep = recOk(bk);
        fitSizer(bk);
        if (home) { writeVp(bk, { home: true }); vpLive[bk] = readVp(bk); }
        else if (keep) recPos(bk);
        continue;
      }
      const k = inst.view; if (!k || t !== viewWrap() || !t.clientWidth || !t.clientHeight) continue;
      const d = vpDim[k];
      if (rv && rv.k === k && d && (d[0] !== t.clientWidth || d[1] !== t.clientHeight)) stopReveal();   // 缓动中格子变了大小：停在当前位置
      if (!drawn.has(k) || vpPending[k]) { if (inst.rendered.has(k)) paneDrawn(k); }
      else if (domVp === k && vpLive[k]) { writeVp(k, vpLive[k]); vpLive[k] = readVp(k); }
      else updBadge(k);
      pfKick();
    }
  }) : null;
  if (paneRO) {
    paneRO.observe(main); paneRO.observe(tabsEl); $$('.tab').forEach(b => paneRO.observe(b));
    $$('.board').forEach(b => { paneRO.observe(b); paneRO.observe(b.closest('.board-wrap')); });
  }
  const onWinResize = () => { refitNow(); checkWide(); };
  window.addEventListener('resize', onWinResize);

  // ---------- 全屏 ----------
  // 优先用浏览器全屏（连浏览器、Obsidian 的标签栏都盖住）；宿主不允许时退而铺满窗口。
  // 两种都只是给 .root 加 class：它自己滚动。进出全屏时内容区的宽（全屏有左右留白）和窗口高都可能变，
  // 外框宽度却未必变（宿主本来就铺满窗口时），所以切换后主动重排，不等 ResizeObserver。
  let fullMode = null, fullBack = null;              // fullMode：null | 'api' | 'overlay'；fullBack：进全屏前页面的滚动位置
  let wantFull = false;                              // 最近一次要的是进还是退：浏览器全屏请求出结果前又要求退出时，结果出来后照这个办
  function scrollerOf(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && p.scrollHeight > p.clientHeight) return p;
    }
    return document.scrollingElement || document.documentElement;
  }
  function saveBack() { const sc = scrollerOf(host); fullBack = { sc, top: sc.scrollTop, left: sc.scrollLeft }; }
  // 全屏按钮的图标和文字（'pane' 窄宿主时只显示图标，所以 title / aria-label 也跟着改）
  function paintFullBtn(on) {
    const b = $('.full-btn'), t = on ? '退出全屏' : '全屏';
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML = `${on ? ICON_EXIT : ICON_FULL}<span>${t}</span>`;
    if (PANE) { b.title = t; b.setAttribute('aria-label', t); }
  }
  function setFull(mode) {
    if (mode === fullMode) return;
    if (mode && !fullMode && !fullBack) saveBack();  // 一般已在 enterFull 里记过；宿主自己调起浏览器全屏时在这里记
    fullMode = mode;
    if (mode) FULL_OWNER.inst = inst; else if (FULL_OWNER.inst === inst) FULL_OWNER.inst = null;
    wrap.classList.toggle('full', !!mode); wrap.classList.toggle('overlay', mode === 'overlay');
    paintFullBtn(!!mode);
    if (mode) wrap.scrollTop = 0;
    relayoutWide(true);
    // 全屏时引擎离开了页面，页面变矮、滚动位置被压回去；退出后等重排完（两帧）再恢复
    if (!mode && fullBack) { const f = fullBack; fullBack = null; requestAnimationFrame(() => requestAnimationFrame(() => { f.sc.scrollTop = f.top; f.sc.scrollLeft = f.left; })); }
  }
  const fsEl = () => (shadow.fullscreenElement !== undefined ? shadow.fullscreenElement : (document.fullscreenElement === host ? wrap : null));
  function enterFull() {
    wantFull = true;
    // 浏览器全屏生效时（fullscreenchange）页面已经变矮、滚动位置已被压回去，所以在请求之前就记下
    if (!fullMode) saveBack();
    if (!wrap.requestFullscreen || document.fullscreenEnabled === false) { setFull('overlay'); return; }
    let p; try { p = wrap.requestFullscreen(); } catch (e) { setFull('overlay'); return; }
    if (p && p.then) p.then(
      () => { if (!wantFull && !inst.destroyed && fsEl() === wrap && document.exitFullscreen) document.exitFullscreen().catch(() => {}); },
      () => { if (wantFull && !inst.destroyed && !fullMode) setFull('overlay'); });
  }
  function exitFull() {
    wantFull = false;
    if (fullMode === 'api' && fsEl() === wrap && document.exitFullscreen) { const p = document.exitFullscreen(); if (p && p.catch) p.catch(() => setFull(null)); }
    else setFull(null);
  }
  // fullscreen:'host' 时浏览器全屏是宿主的事（它可能让包着引擎的格子全屏），不跟着进出
  const onFsChange = () => { if (inst.destroyed || HOSTFS) return; if (fsEl() === wrap) setFull('api'); else if (fullMode === 'api') { wantFull = false; setFull(null); } };
  document.addEventListener('fullscreenchange', onFsChange);
  // fullscreen:'host'：宿主报告全屏状态。只改按钮，不占 FULL_OWNER；Esc 归哪个实例，按下面注释里的规则定。
  // 引擎不会因为 Esc 让宿主退出全屏：Esc 用来取消了固定高亮时 preventDefault，宿主看 defaultPrevented 决定要不要退。
  function setHostFull(on) {
    if (!HOSTFS || inst.destroyed) return;
    hostFull = !!on;
    // 不占 FULL_OWNER：宿主可能让整个工作区（好几个格子）一起全屏，Esc 照常按「鼠标 / 焦点 / 最后交互」归当前实例
    paintFullBtn(hostFull);
  }

  Object.assign(inst, {
    setView, setData, setPrefs, setTheme, rerender,
    fit: () => refitNow(),
    getPrefs: () => Object.assign({}, inst.prefs),
    isFull: () => HOSTFS ? hostFull : !!fullMode,
    setFull: on => {
      if (HOSTFS) { if (!!on !== hostFull) requestHostFull(); return; }
      if (on && !fullMode) enterFull(); else if (!on && (fullMode || wantFull)) exitFull();
    },
    getLayoutCache: () => JSON.parse(JSON.stringify(inst.cacheStore)),
    getViewport, setViewport: (vp, view) => setViewport(vp, view, 'host'), resetZoom, setHostFull,
    focusWorks, clearFocus, drawnWorkIds,
    destroy() {
      if (rv) { cancelAnimationFrame(rv.raf); rv = null; }
      pfEnd(); holdEnd(); if (!inst.destroyed) ptrOff();
      if (fullMode === 'api' && fsEl() === wrap && document.exitFullscreen) document.exitFullscreen().catch(() => {});
      inst.destroyed = true; if (ro) ro.disconnect(); if (paneRO) paneRO.disconnect();
      if (FULL_OWNER.inst === inst) FULL_OWNER.inst = null;
      LIVE.delete(inst); if (GRAB.inst === inst) GRAB.inst = null;
      cancelAnimationFrame(fitRaf); cancelAnimationFrame(wideRaf); clearTimeout(nowT); clearTimeout(wideT);
      Object.keys(emitT).forEach(k => clearTimeout(emitT[k]));
      document.removeEventListener('keydown', onKey); document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('keydown', onSpaceDown); document.removeEventListener('keydown', onNavKey); document.removeEventListener('keyup', onSpaceUp); window.removeEventListener('blur', onBlur);
      document.removeEventListener('pointerdown', onDocDown, true);
      host.removeEventListener('pointerenter', onEnter);
      host.removeEventListener('pointerleave', onLeave); window.removeEventListener('resize', onWinResize);
      shadow.innerHTML = '';
      ['tn-nocover', 'tn-mono', 'tn-openable'].forEach(c => host.classList.remove(c));
    },
  });

  applyPrefs();
  checkNarrow();
  inst.M = buildModel(data || { works: [] }, o.config, o.coverOf);
  renderDrawer();
  LIVE.add(inst); ptrOn();
  setView(inst.prefs.view || o.view || (allViews[0] && allViews[0].key));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!inst.destroyed) rerender(); });
  return inst;
}

/* 预先算好布局缓存（纯计算，不需要浏览器，可在 Node 里批量跑）。
   结果写进作品集 JSON 的 layout_cache 字段后，任何宿主打开都直接用它，形状永远一致。 */
function computeLayoutCache(raw, configOverride) {
  const M = buildModel(raw, configOverride);
  const res = solveTerritory(M, null);
  return { terr: { sig: res.sig, cols: res.cols, rows: res.rows, pos: Object.fromEntries(M.works.map((w, i) => [w.id, res.pos[i]])) } };
}

return { mount, buildModel, diffOf, computeLayoutCache, VIEWS, DEFAULT_CONFIG, VERSION };
});
