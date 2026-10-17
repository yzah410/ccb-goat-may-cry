// TagNote 'pane' 布局 / 移动缩放 / 宿主全屏 的自动化检查，外加 'page' 布局的回归对照（Playwright 无头 Chromium）。
//
// 用法（先 python build.py，生成 engine/tagnote.js 和 examples/pane.html）：
//   node test/pane.js --pw <装了 playwright 的目录> [--shots <截图目录>] [--baseline <对照用的 engine/tagnote.js>]
//   也可以用环境变量 PLAYWRIGHT_DIR / TN_SHOTS / TN_BASELINE。
//   --pw 指向的目录里要有 node_modules/playwright，并装好它的 chromium（例如在一个空目录里 npm i playwright，再 npx playwright install chromium）。
//   不给 --baseline 时，用 git HEAD 里的 tagnote/engine/tagnote.js 做 'page' 回归的对照。
//   不给 --shots 时不截图。--only pane,host 只跑其中几组（pane / pan / bar / dark / host / narrow / page）。
//   bar 组要真的有滚动条，另开一个显示滚动条的无头浏览器（无头默认隐藏滚动条）。
// 只开 Playwright 自己的无头浏览器；启动失败直接退出（退出码 2），不重试；结束时 finally 里关浏览器（两个都关）。
// 退出码：0 全部通过；1 有失败项。
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const { pathToFileURL } = require('url');

const arg = (name, env) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : process.env[env]; };
const PW = arg('pw', 'PLAYWRIGHT_DIR'), SHOTS = arg('shots', 'TN_SHOTS'), BASELINE = arg('baseline', 'TN_BASELINE');
const ONLY = (arg('only', 'TN_ONLY') || '').split(',').filter(Boolean);   // 只跑某几组：pane,pan,bar,dark,host,narrow,page
let chromium;
try { ({ chromium } = PW ? require(require.resolve('playwright', { paths: [PW] })) : require('playwright')); }
catch (e) { console.error('找不到 playwright：用 --pw <目录> 或环境变量 PLAYWRIGHT_DIR 指向装了 playwright 的目录。' + e.message); process.exit(2); }

const ROOT = path.resolve(__dirname, '..');
const PANE_HTML = path.join(ROOT, 'examples', 'pane.html');
const STANDALONE = path.join(ROOT, 'examples', '2018百合标签笔记.html');
const MULTI_HTML = path.join(__dirname, 'multi.html');
const ENGINE = path.join(ROOT, 'engine', 'tagnote.js');
const VIEWS = ['canvas', 'score', 'kmap', 'hasse', 'terr', 'line'];

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  const d = detail === undefined ? '' : '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail));
  console.log((ok ? 'PASS ' : 'FAIL ') + name + d);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const maxDiff = (A, B) => { let m = 0; for (let i = 0; i < Math.min(A.length, B.length); i++) for (let j = 0; j < A[i].length; j++) if (typeof A[i][j] === 'number') m = Math.max(m, Math.abs(A[i][j] - B[i][j])); return A.length === B.length ? m : Infinity; };
const IGNORE = /Failed to load resource|ERR_FAILED|ERR_BLOCKED|ERR_INTERNET|net::/;

async function open(browser, url, viewport, opts) {
  const ctx = await browser.newContext(Object.assign({ viewport: viewport || { width: 1800, height: 900 } }, opts || {}));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !IGNORE.test(m.text())) errs.push(m.type() + ': ' + m.text()); });
  await page.route(/^https?:\/\//, r => r.abort());                       // 不联网（Google Fonts 之类）
  await page.goto(url);
  return { page, errs, ctx };
}
async function shot(page, name, clip) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.jpg'), type: 'jpeg', quality: 55, clip });
}

// ---------- 页面里用的小工具 ----------
const HELPERS = () => {
  const T = window.T = {};
  T.board = (i, k) => i.shadow.querySelector(`[data-board="${k || i.view}"]`);
  T.wrapOf = (i, k) => T.board(i, k).closest('.board-wrap');
  T.root = i => i.shadow.querySelector('.root');
  T.badge = (i, k) => T.wrapOf(i, k).parentElement.querySelector('.zoom-badge');
  T.z = i => i.getViewport().zoom;
  T.center = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  T.boardPt = (i, x, y) => { const r = T.board(i).getBoundingClientRect(), z = T.z(i); return { x: (x - r.left) / z, y: (y - r.top) / z }; };
  T.widAt = (i, x, y) => { const el = i.shadow.elementFromPoint(x, y); const w = el && el.closest && el.closest('[data-wid]'); return w ? w.dataset.wid : null; };
  T.inArea = (i, x, y) => { const r = T.wrapOf(i).getBoundingClientRect(); return x > r.left + 6 && x < r.right - 24 && y > r.top + 6 && y < r.bottom - 24; };
  // 中心点确实落在它自己身上、并且在图区可见范围内的作品元素（离图区中心最近的那个）
  T.pickWork = (i, sel) => {
    const els = [...T.board(i).querySelectorAll(sel || '[data-wid]')];
    const c = T.center(T.wrapOf(i));
    els.sort((a, b) => { const p = T.center(a), q = T.center(b); return Math.hypot(p.x - c.x, p.y - c.y) - Math.hypot(q.x - c.x, q.y - c.y); });
    for (const e of els) { const p = T.center(e); if (T.inArea(i, p.x, p.y) && T.widAt(i, p.x, p.y) === e.dataset.wid) return { wid: e.dataset.wid, x: p.x, y: p.y }; }
    return null;
  };
  // 一个作品元素在画板上的中心（未缩放的画板坐标）
  T.workCenter = (i, wid) => { const e = T.board(i).querySelector(`[data-wid="${wid}"]`), r = T.board(i).getBoundingClientRect(), q = e.getBoundingClientRect(), z = T.z(i); return { x: (q.left + q.width / 2 - r.left) / z, y: (q.top + q.height / 2 - r.top) / z }; };
  // 作品元素相对画板左上角的位置，按缩放换回未缩放的像素
  T.layout = i => { const r = T.board(i).getBoundingClientRect(), z = T.z(i); return [...T.board(i).querySelectorAll('[data-wid]')].map(e => { const q = e.getBoundingClientRect(); return [e.dataset.wid, (q.left - r.left) / z, (q.top - r.top) / z, q.width / z, q.height / z]; }); };
  T.edges = i => { const r = T.board(i).getBoundingClientRect(), z = T.z(i); return [...T.board(i).querySelectorAll('svg.edges path')].map(p => { const q = p.getBoundingClientRect(); return ['p', (q.left - r.left) / z, (q.top - r.top) / z, q.width / z, q.height / z]; }).filter(a => a[3] + a[4] > 0).slice(0, 80); };
  // 显示中的差异徽章相对所在作品卡的位置（未缩放像素）
  T.diffs = i => [...T.board(i).querySelectorAll('.diff.show')].map(d => { const c = d.parentElement.closest('[data-wid]'), q = d.getBoundingClientRect(), r = c.getBoundingClientRect(), z = T.z(i); return [c.dataset.wid, (q.left - r.left) / z, (q.top - r.top) / z, q.width / z, q.height / z]; });
  // 谱系连线的终点（屏幕坐标）和子行左边中点的偏差
  T.lineEnds = i => { const b = T.board(i), r = b.getBoundingClientRect(), z = T.z(i); return [...b.querySelectorAll('g.eg[data-wb]')].map(g => { const p = g.querySelector('path.lline'), e = p.getPointAtLength(p.getTotalLength()), row = b.querySelector(`.lrow[data-wid="${g.dataset.wb}"]`).getBoundingClientRect(); return [r.left + e.x * z - row.left, r.top + e.y * z - (row.top + row.height / 2)]; }); };
  T.scroll = i => { const s = T.wrapOf(i); return { l: s.scrollLeft, t: s.scrollTop, ml: s.scrollWidth - s.clientWidth, mt: s.scrollHeight - s.clientHeight }; };
  T.frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  // 图区内容区（扣掉边框、滚动条、内边距）在屏幕上的位置
  T.inner = (i, k) => {
    const s = T.wrapOf(i, k), cs = getComputedStyle(s), sr = s.getBoundingClientRect();
    const pl = parseFloat(cs.paddingLeft), pr = parseFloat(cs.paddingRight), pt = parseFloat(cs.paddingTop), pb = parseFloat(cs.paddingBottom);
    const l = sr.left + s.clientLeft + pl, t = sr.top + s.clientTop + pt;
    return { l, t, r: l + s.clientWidth - pl - pr, b: t + s.clientHeight - pt - pb, w: s.clientWidth - pl - pr, h: s.clientHeight - pt - pb };
  };
  // 画板的位置和初始规则差几像素：在图区内容区里，放得下就居中，放不下贴左上（fit = true：显示全图，放不下也居中）
  T.homeDiff = (i, k, fit) => {
    const n = T.inner(i, k), br = T.board(i, k).getBoundingClientRect();
    const dx = (n.w - br.width) / 2, dy = (n.h - br.height) / 2;
    const ex = n.l + (fit ? dx : Math.max(0, dx)), ey = n.t + (fit ? dy : Math.max(0, dy));
    return Math.max(Math.abs(br.left - ex), Math.abs(br.top - ey));
  };
  // 图区可见部分的中心（屏幕坐标）
  T.vcenter = (i, k) => { const s = T.wrapOf(i, k), sr = s.getBoundingClientRect(); return { x: sr.left + s.clientLeft + s.clientWidth / 2, y: sr.top + s.clientTop + s.clientHeight / 2 }; };
};
// 记下 document / window 上还挂着的监听，destroy 以后应回到原数
const LISTENER_COUNTER = () => {
  const live = new Map();
  for (const tgt of [document, window]) {
    const add = tgt.addEventListener, rm = tgt.removeEventListener, tag = tgt === document ? 'doc' : 'win';
    tgt.addEventListener = function (t, f, o) { const k = tag + ':' + t; const s = live.get(k) || new Set(); s.add(f); live.set(k, s); return add.call(this, t, f, o); };
    tgt.removeEventListener = function (t, f, o) { const s = live.get(tag + ':' + t); if (s) s.delete(f); return rm.call(this, t, f, o); };
  }
  window.__listeners = () => Object.fromEntries([...live].map(([k, s]) => [k, s.size]).filter(([, n]) => n));
};

async function ready(page) {
  await page.waitForFunction(() => window.A && window.B && A.getViewport() && B.getViewport(), null, { timeout: 15000 });
  await page.evaluate(HELPERS);
  await page.waitForTimeout(250);
}
const vpOf = (page, who, view) => page.evaluate(([w, v]) => window[w].getViewport(v), [who, view]);

// ================= 'pane'：两个格子并排 =================
async function paneTests(browser) {
  const { page, errs, ctx } = await open(browser, pathToFileURL(PANE_HTML).href + '?a=canvas&b=hasse&theme=light', { width: 1800, height: 900 });
  await page.addInitScript(LISTENER_COUNTER);
  await page.reload();
  await ready(page);

  // ---- 布局 ----
  const lay = await page.evaluate(() => {
    const host = document.getElementById('a'), root = T.root(A), s = T.wrapOf(A), cs = getComputedStyle(s);
    return { cls: root.className, hostH: host.getBoundingClientRect().height, rootH: root.getBoundingClientRect().height, ox: cs.overflowX, oy: cs.overflowY,
      docScroll: document.scrollingElement.scrollHeight - innerHeight, areaH: s.clientHeight, bCls: T.root(B).className, sbw: cs.scrollbarWidth, sbc: cs.scrollbarColor };
  });
  check('pane：根元素是 .root.pane、高度 = 宿主高度', /\bpane\b/.test(lay.cls) && near(lay.rootH, lay.hostH, 1), lay);
  check('pane：图区两个方向都自己滚动（滚动条常驻、细、淡）；页面不滚动', lay.ox === 'scroll' && lay.oy === 'scroll' && lay.sbw === 'thin' && /transparent|rgba\(0, 0, 0, 0\)/.test(lay.sbc) && lay.docScroll <= 0 && lay.areaH > 400, lay);
  check('pane：宽格子（> 720px）不是窄模式', !/\bnarrow\b/.test(lay.cls) && !/\bnarrow\b/.test(lay.bCls), lay.cls);
  let r = await page.evaluate(() => {
    const q = s => A.shadow.querySelector(s), disp = el => getComputedStyle(el).display, tabs = q('.tabs'), cs = getComputedStyle(tabs);
    return { more: disp(q('.more-btn')), icon: disp(q('.drawer-btn .ic')), drawerText: disp(q('.drawer-btn > span')), fullText: disp(q('.full-btn > span')),
      ctl: [...A.shadow.querySelectorAll('.ctl')].map(disp), ovf: tabs.classList.contains('ovf'), mask: cs.webkitMaskImage || cs.maskImage };
  });
  check('宽格子顶栏完整显示：没有「⋯」、按钮带文字、封面 / 配色照常显示、标签行不淡出', r.more === 'none' && r.icon === 'none' && r.drawerText !== 'none' && r.fullText !== 'none' && r.ctl.every(d => d !== 'none') && !r.ovf && r.mask === 'none', r);

  // ---- 两个实例各自缩放 ----
  r = await page.evaluate(() => { A.setViewport({ zoom: 1.5 }); return { a: A.getViewport().zoom, b: B.getViewport().zoom, ba: T.badge(A).hidden ? null : T.badge(A).textContent, bb: T.badge(B).hidden ? null : T.badge(B).textContent }; });
  check('setViewport 只缩放这个实例；小标签只在它上面显示', r.a === 1.5 && r.b === 1 && r.ba === '150%' && r.bb === null, r);
  let c = await page.evaluate(() => T.center(T.wrapOf(B)));
  await page.mouse.move(c.x, c.y);
  await page.keyboard.down('Space');
  await page.mouse.wheel(0, -240);
  await page.keyboard.up('Space');
  r = await page.evaluate(() => ({ a: A.getViewport().zoom, b: B.getViewport().zoom, bb: T.badge(B).hidden ? null : T.badge(B).textContent }));
  check('空格+滚轮缩放 B，A 不动', r.a === 1.5 && near(r.b, Math.exp(240 * 0.0018), 0.01) && r.bb === Math.round(r.b * 100) + '%', r);

  // ---- 空格+滚轮以鼠标为中心 ----
  await page.evaluate(() => { const b = T.board(A); A.setViewport({ zoom: 1.3, cx: b.offsetWidth / 2, cy: b.offsetHeight / 2 }); });
  for (const [dy, label] of [[-200, '放大'], [150, '缩小']]) {
    const p = await page.evaluate(() => { const w = T.pickWork(A); return w && Object.assign(w, { bp: T.boardPt(A, w.x, w.y), z: T.z(A) }); });
    await page.mouse.move(p.x, p.y);
    await page.keyboard.down('Space');
    await page.mouse.wheel(0, dy);
    await page.keyboard.up('Space');
    const q = await page.evaluate(([x, y]) => ({ wid: T.widAt(A, x, y), bp: T.boardPt(A, x, y), z: T.z(A), sc: T.scroll(A) }), [p.x, p.y]);
    const clamped = q.sc.l <= 0 || q.sc.t <= 0 || q.sc.l >= q.sc.ml || q.sc.t >= q.sc.mt;
    check(`空格+滚轮${label}：鼠标下的作品和画板坐标不变`, q.z !== p.z && q.wid === p.wid && (clamped || (near(q.bp.x, p.bp.x, 1) && near(q.bp.y, p.bp.y, 1))),
      { before: { wid: p.wid, z: +p.z.toFixed(3), bp: [+p.bp.x.toFixed(1), +p.bp.y.toFixed(1)] }, after: { wid: q.wid, z: +q.z.toFixed(3), bp: [+q.bp.x.toFixed(1), +q.bp.y.toFixed(1)] }, clamped });
  }
  // 缩放范围 25%–300%
  r = await page.evaluate(() => { A.setViewport({ zoom: 10 }); const hi = A.getViewport().zoom; A.setViewport({ zoom: 0.01 }); const lo = A.getViewport().zoom; return { hi, lo }; });
  check('缩放夹在 25%–300%', r.hi === 3 && r.lo === 0.25, r);

  // ---- 点小标签 = 回到初始（100%、初始位置） ----
  await page.evaluate(() => { const b = T.board(A); A.setViewport({ zoom: 1.8, cx: b.offsetWidth * 0.45, cy: b.offsetHeight * 0.5 }); });
  r = await page.evaluate(() => ({ title: T.badge(A).title, text: T.badge(A).textContent }));
  check('小标签：显示缩放百分比，title 写着两个快捷键', r.text === '180%' && /Shift\+0 回到初始/.test(r.title) && /Shift\+1 显示全图/.test(r.title), r);
  await page.locator('#a .zoom-badge:not([hidden])').click();
  r = await page.evaluate(() => ({ vp: A.getViewport(), hidden: T.badge(A).hidden, home: T.homeDiff(A) }));
  check('点右下角百分比 = 回到初始：100%、按初始规则摆、getViewport 带 home、小标签收起', r.vp.zoom === 1 && r.vp.home === true && r.hidden && r.home <= 1, r);

  // ---- 缩放后：悬停高亮、差异徽章、连线位置 ----
  await page.mouse.move(5, 5);
  const z1 = await page.evaluate(() => { A.resetZoom(); return { layout: T.layout(A), edges: T.edges(A) }; });
  let w = await page.evaluate(() => T.pickWork(A, '.work'));
  await page.mouse.move(w.x, w.y);
  const d1 = await page.evaluate(() => T.diffs(A));
  await page.mouse.move(5, 5);
  await page.evaluate(wid => { const p = T.workCenter(A, wid); A.setViewport({ zoom: 1.8, cx: p.x, cy: p.y }); }, w.wid);
  const z2 = await page.evaluate(() => ({ layout: T.layout(A), edges: T.edges(A) }));
  check('缩放 180% 后作品位置按比例（相对画板 ÷ zoom 与 100% 时一致）', maxDiff(z1.layout, z2.layout) < 0.75, { n: z1.layout.length, maxDiff: +maxDiff(z1.layout, z2.layout).toFixed(3) });
  check('缩放 180% 后分支连线位置按比例', z1.edges.length > 0 && maxDiff(z1.edges, z2.edges) < 0.75, { n: z1.edges.length, maxDiff: +maxDiff(z1.edges, z2.edges).toFixed(3) });
  const w2 = await page.evaluate(wid => { const e = T.board(A).querySelector(`[data-wid="${wid}"]`); return T.center(e); }, w.wid);
  await page.mouse.move(w2.x, w2.y);
  r = await page.evaluate(([wid, x, y]) => ({ under: T.widAt(A, x, y), focus: !!T.board(A).querySelector(`[data-wid="${wid}"].focus`), hovering: T.board(A).classList.contains('hovering'), diffs: T.diffs(A) }), [w.wid, w2.x, w2.y]);
  check('缩放 180% 后悬停：鼠标下就是这部作品，高亮的是它', r.under === w.wid && r.focus && r.hovering, { wid: w.wid, under: r.under, focus: r.focus });
  check('缩放 180% 后差异徽章贴在原来的位置（相对作品卡 ÷ zoom 一致）', d1.length > 0 && r.diffs.length === d1.length && maxDiff(d1, r.diffs) < 0.75, { n: d1.length, maxDiff: +maxDiff(d1, r.diffs).toFixed(3) });
  await page.mouse.move(5, 5);

  // 谱系：连线终点落在子行左边中点（100%、160%、60%）
  await page.evaluate(() => A.setView('line'));
  await page.waitForFunction(() => A.getViewport('line'));
  for (const zz of [1, 1.6, 0.6]) {
    const ends = await page.evaluate(z => { A.setViewport({ zoom: z }); return T.lineEnds(A); }, zz);
    const m = Math.max(...ends.map(e => Math.max(Math.abs(e[0]), Math.abs(e[1]))));
    check(`谱系 ${Math.round(zz * 100)}%：连线终点对准子行左边中点`, ends.length > 0 && m < 1.5, { n: ends.length, maxOff: +m.toFixed(2) });
  }
  // 每个视图：缩放 150% 后悬停到一部作品上，命中并高亮的就是它
  for (const v of VIEWS) {
    await page.evaluate(v => A.setView(v), v);
    await page.waitForFunction(v => A.getViewport(v), v, { timeout: 10000 });
    const p = await page.evaluate(() => {
      const pre = T.pickWork(A); if (!pre) return null;
      const c = T.workCenter(A, pre.wid); A.setViewport({ zoom: 1.5, cx: c.x, cy: c.y });
      const e = T.board(A).querySelector(`[data-wid="${pre.wid}"]`); return Object.assign({ wid: pre.wid }, T.center(e));
    });
    if (!p) { check(`${v}：缩放后悬停`, false, '找不到可悬停的作品'); continue; }
    await page.mouse.move(5, 5); await page.mouse.move(p.x, p.y);
    r = await page.evaluate(([wid, x, y]) => ({ under: T.widAt(A, x, y), focus: !!T.board(A).querySelector(`[data-wid="${wid}"].focus, [data-wid="${wid}"].hl`), z: T.z(A) }), [p.wid, p.x, p.y]);
    check(`${v}：缩放 150% 后悬停命中并高亮同一部作品`, r.under === p.wid && r.focus && r.z === 1.5, Object.assign({ wid: p.wid }, r));
  }
  await page.mouse.move(5, 5);

  // ---- getViewport / setViewport 往返；onViewportChange 防抖 ----
  await page.evaluate(() => A.setView('canvas'));
  r = await page.evaluate(() => {
    const b = T.board(A), W = b.offsetWidth, H = b.offsetHeight;
    A.setViewport({ zoom: 1.7, cx: W * 0.5, cy: H * 0.5 }); const g1 = A.getViewport();
    A.setViewport({ cx: W * 0.42 }); const g2 = A.getViewport();
    return { W, H, g1, g2 };
  });
  check('setViewport → getViewport 往返一致', r.g1.zoom === 1.7 && near(r.g1.cx, r.W * 0.5, 1) && near(r.g1.cy, r.H * 0.5, 1), r.g1);
  check('setViewport 只给 cx：zoom、cy 保持原值', r.g2.zoom === 1.7 && near(r.g2.cx, r.W * 0.42, 1) && near(r.g2.cy, r.g1.cy, 1), r.g2);
  await page.waitForTimeout(400);
  r = await page.evaluate(async () => {
    log.length = 0;
    const b = T.board(A);
    A.setViewport({ zoom: 1.2 }); A.setViewport({ zoom: 1.4 }); A.setViewport({ cx: b.offsetWidth * 0.5 });
    await new Promise(r => setTimeout(r, 120)); const early = log.filter(e => e[0] === 'vp').length;
    await new Promise(r => setTimeout(r, 300));
    return { early, calls: log.filter(e => e[0] === 'vp'), now: A.getViewport() };
  });
  const last = r.calls[r.calls.length - 1];
  check('onViewportChange：停下约 200ms 后只回调一次，带视图名和当前视区', r.early === 0 && r.calls.length === 1 && last[1] === 'a' && last[2] === 'canvas' && near(last[3].zoom, r.now.zoom, 1e-9) && near(last[3].cx, r.now.cx, 0.5),
    { early: r.early, calls: r.calls.length, last: last && last.slice(1, 3) });
  // 不按空格：滚轮照常滚动图区、不缩放，也会回调
  c = await page.evaluate(() => { log.length = 0; return Object.assign(T.center(T.wrapOf(A)), { sc: T.scroll(A), z: T.z(A) }); });
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel(0, 160);
  await page.waitForTimeout(350);
  r = await page.evaluate(() => ({ sc: T.scroll(A), z: T.z(A), vp: log.filter(e => e[0] === 'vp' && e[1] === 'a').length }));
  check('不按空格：滚轮滚动图区，不缩放；停下后回调', r.z === c.z && r.sc.t !== c.sc.t && r.vp === 1, { before: c.sc.t, after: r.sc.t, z: r.z, vp: r.vp });
  // Ctrl+滚轮不拦；空格+滚轮拦
  r = await page.evaluate(() => { window.__wheel = []; window.addEventListener('wheel', e => __wheel.push([e.ctrlKey, e.defaultPrevented]), { passive: true }); return T.z(A); });
  await page.keyboard.down('Space');
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Space');
  const wh = await page.evaluate(() => ({ log: __wheel, z: T.z(A) }));
  check('Ctrl+滚轮不拦（不 preventDefault）；空格+滚轮拦', wh.log.length === 2 && wh.log[0][0] === true && wh.log[0][1] === false && wh.log[1][1] === true, wh.log);

  // ---- viewports 初始视区；没画过的视图排队 ----
  const hb = await page.evaluate(() => { const b = T.board(B, 'hasse'); return { W: b.offsetWidth, H: b.offsetHeight }; });
  await page.evaluate(([W, H]) => { B.destroy(); window.B = mountPane('b', { view: 'hasse', viewports: { hasse: { zoom: 1.4, cx: W * 0.5, cy: H * 0.5 }, kmap: { zoom: 0.7 } } }); }, [hb.W, hb.H]);
  await page.waitForFunction(() => B.getViewport());
  r = await page.evaluate(() => { const g = B.getViewport(), k0 = B.getViewport('kmap'), s0 = B.getViewport('score'); B.setViewport({ zoom: 0.9 }, 'score'); return { g, k0, s0, score: B.getViewport('score') }; });
  check('mount 选项 viewports：视图画完后应用', near(r.g.zoom, 1.4, 1e-9) && near(r.g.cx, hb.W * 0.5, 1) && near(r.g.cy, hb.H * 0.5, 1), r.g);
  check('没画过的视图 getViewport 返回 null；setViewport 先排队', r.k0 === null && r.s0 === null && r.score === null, r);
  r = await page.evaluate(async () => { B.setView('kmap'); await T.frame(); const k = B.getViewport(); B.setView('score'); await T.frame(); return { k, s: B.getViewport() }; });
  check('排队的视区在视图第一次画完时应用（kmap 70%、score 90%）', r.k && near(r.k.zoom, 0.7, 1e-9) && r.s && near(r.s.zoom, 0.9, 1e-9), r);
  await page.evaluate(() => B.setView('hasse'));

  // ---- 切视图：视区各自保留 ----
  r = await page.evaluate(async () => {
    A.setView('canvas'); let b = T.board(A); A.setViewport({ zoom: 1.6, cx: b.offsetWidth * 0.4, cy: b.offsetHeight * 0.55 }); const v1 = A.getViewport();
    A.setView('line'); b = T.board(A); A.setViewport({ zoom: 1.25, cx: b.offsetWidth * 0.3, cy: b.offsetHeight * 0.6 }); const v2 = A.getViewport();
    A.setView('canvas'); await T.frame(); const b1 = A.getViewport(), t1 = T.badge(A).textContent;
    A.setView('line'); await T.frame(); const b2 = A.getViewport();
    return { v1, v2, b1, b2, t1, other: A.getViewport('canvas') };
  });
  const same = (a, b) => a && b && near(a.zoom, b.zoom, 1e-9) && near(a.cx, b.cx, 1) && near(a.cy, b.cy, 1);
  check('切视图：每个视图的视区各自保留', same(r.v1, r.b1) && same(r.v2, r.b2) && r.t1 === '160%' && same(r.other, r.v1), { canvas: [r.v1, r.b1], line: [r.v2, r.b2] });

  // ---- 空格+拖动 ----
  await page.evaluate(() => { A.setView('canvas'); const b = T.board(A); A.setViewport({ zoom: 2, cx: b.offsetWidth / 2, cy: b.offsetHeight / 2 }); });
  w = await page.evaluate(() => T.pickWork(A, '.work'));
  await page.mouse.move(5, 5); await page.mouse.move(w.x, w.y);
  const s0 = await page.evaluate(() => ({ sc: T.scroll(A), hk: A.hoverKey, pinned: !!A.pinned }));
  await page.keyboard.down('Space');
  const grab = await page.evaluate(() => ({ cls: T.root(A).className, cur: getComputedStyle(T.wrapOf(A)).cursor, bcls: T.root(B).className }));
  await page.mouse.down();
  await page.mouse.move(w.x - 60, w.y - 40, { steps: 4 });
  const mid = await page.evaluate(() => ({ hk: A.hoverKey, cls: T.root(A).className }));
  await page.mouse.move(w.x - 150, w.y - 100, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  const s1 = await page.evaluate(() => ({ sc: T.scroll(A), hk: A.hoverKey, pinned: !!A.pinned, cls: T.root(A).className }));
  check('按住空格（鼠标在图区上）：抓手光标，只在这个实例', /\bgrab\b/.test(grab.cls) && grab.cur === 'grab' && !/\bgrab\b/.test(grab.bcls), grab);
  check('空格+拖动：图区跟着鼠标移动', near(s1.sc.l - s0.sc.l, 150, 2) && near(s1.sc.t - s0.sc.t, 100, 2), { dl: s1.sc.l - s0.sc.l, dt: s1.sc.t - s0.sc.t });
  check('拖动中悬停高亮冻结（不闪）', mid.hk === s0.hk && s0.hk && /\bgrabbing\b/.test(mid.cls), { before: s0.hk, during: mid.hk });
  check('拖动后松手：没有固定高亮；松开空格退出抓手', !s1.pinned && !/\bgrab\b/.test(s1.cls), { pinned: s1.pinned, cls: s1.cls });
  // 对照：普通点击会固定高亮
  w = await page.evaluate(() => T.pickWork(A, '.work'));
  await page.mouse.click(w.x, w.y);
  r = await page.evaluate(() => !!A.pinned);
  check('对照：不按空格点一下作品 = 固定高亮', r === true);
  await page.evaluate(() => { if (A.pinned) T.board(A).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); });

  // 抓手模式下 click 一律不算：空格+单击（不拖动）、按着空格按下鼠标后先松空格再松鼠标、双击、点工具栏按钮
  w = await page.evaluate(() => T.pickWork(A, '.work'));
  await page.mouse.move(w.x, w.y);
  await page.keyboard.down('Space');
  await page.mouse.click(w.x, w.y);
  const gp1 = await page.evaluate(() => !!A.pinned);
  await page.mouse.dblclick(w.x, w.y);
  const gp2 = await page.evaluate(() => !!A.pinned);
  await page.mouse.down(); await page.keyboard.up('Space'); await page.mouse.up();
  const gp3 = await page.evaluate(() => !!A.pinned);
  await page.keyboard.down('Space');
  const btn = await page.evaluate(() => T.center(A.shadow.querySelector('[data-act="color"][data-v="0"]')));
  await page.mouse.move(btn.x, btn.y, { steps: 4 });
  await page.mouse.click(btn.x, btn.y);
  const gColor = await page.evaluate(() => A.getPrefs().color);
  await page.keyboard.up('Space');
  check('抓手模式：空格+单击（不拖动）不固定高亮', gp1 === false, { click: gp1 });
  check('抓手模式：空格+双击也不算', gp2 === false, { dblclick: gp2 });
  check('抓手模式：按着空格按下、先松空格再松鼠标，这次点击也不算', gp3 === false, { pressThenRelease: gp3 });
  check('抓手模式：点工具栏按钮也不算', gColor === true, { color: gColor });
  await page.evaluate(() => { if (A.pinned) T.board(A).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); });
  await page.mouse.click(w.x, w.y);
  r = await page.evaluate(() => !!A.pinned);
  check('松开空格后普通点击照常固定高亮', r === true);
  await page.evaluate(() => { if (A.pinned) T.board(A).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); });

  // 上一次点击留下的「下一轮清标记」定时器晚到（机器忙时 Chrome 先处理输入和 DevTools 消息、后跑定时器）：
  // 不能清掉这一次按下的标记。把 0ms 定时器扣下、等这次按下之后才放出来，确定地复现这个顺序
  await page.evaluate(() => { if (A.pinned) T.board(A).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); });
  await page.evaluate(() => { const st = window.setTimeout; window.__st = st; window.__held = []; window.setTimeout = (f, d, ...a) => { if (!d) { window.__held.push(() => f(...a)); return 0; } return st(f, d, ...a); }; });
  await page.mouse.move(w.x, w.y);
  await page.keyboard.down('Space');
  await page.mouse.click(w.x, w.y);
  const held = await page.evaluate(() => window.__held.length);
  await page.mouse.down(); await page.keyboard.up('Space');
  await page.evaluate(() => window.__held.splice(0).forEach(f => f()));
  await page.mouse.up();
  const gp4 = await page.evaluate(() => { window.setTimeout = window.__st; window.__held.splice(0).forEach(f => f()); return !!A.pinned; });
  check('抓手模式：上一次点击的清标记晚到（排在这次按下之后），这次先松空格再松鼠标的点击也不算', held > 0 && gp4 === false, { held, pinned: gp4 });
  await page.evaluate(() => { if (A.pinned) T.board(A).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); });

  // 抓手跟着鼠标换实例：按住空格从 A 的图区移到 B 的图区，B 进抓手、A 恢复普通光标；滚轮缩放的是 B；再移回 A 又换回来
  const gs = () => ({ a: /\bgrab\b/.test(T.root(A).className), b: /\bgrab\b/.test(T.root(B).className), ca: getComputedStyle(T.wrapOf(A)).cursor, cb: getComputedStyle(T.wrapOf(B)).cursor });
  const ca = await page.evaluate(() => T.center(T.wrapOf(A))), cb = await page.evaluate(() => T.center(T.wrapOf(B)));
  await page.mouse.move(ca.x, ca.y);
  await page.keyboard.down('Space');
  const g1 = await page.evaluate(gs);
  await page.mouse.move(cb.x, cb.y, { steps: 10 });
  const g2 = await page.evaluate(gs);
  const zz0 = await page.evaluate(() => [T.z(A), T.z(B)]);
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(60);
  const zz1 = await page.evaluate(() => [T.z(A), T.z(B)]);
  const pb = await page.evaluate(() => T.pickWork(B));
  if (pb) { await page.mouse.move(pb.x, pb.y); await page.mouse.click(pb.x, pb.y); }
  const bPinned = await page.evaluate(() => !!B.pinned);
  await page.mouse.move(ca.x, ca.y, { steps: 10 });
  const g3 = await page.evaluate(gs);
  await page.keyboard.up('Space');
  const g4 = await page.evaluate(gs);
  check('按住空格：鼠标在 A 的图区，只有 A 是抓手', g1.a && !g1.b && g1.ca === 'grab' && g1.cb !== 'grab', g1);
  check('按住空格移到 B：抓手转到 B，A 恢复普通光标', !g2.a && g2.b && g2.cb === 'grab' && g2.ca !== 'grab', g2);
  check('抓手转到 B 后：空格+滚轮缩放的是 B，A 不动', zz1[0] === zz0[0] && zz1[1] > zz0[1] * 1.2, { before: zz0, after: zz1 });
  check('抓手转到 B 后：在 B 上单击也不算', !!pb && bPinned === false, { pb: !!pb, bPinned });
  check('再移回 A：抓手换回 A；松开空格两个都退出', g3.a && !g3.b && !g4.a && !g4.b, { back: g3, released: g4 });
  await page.evaluate(() => B.resetZoom());

  // 从图区左边缘内侧按下、一下甩到实例外面再松手：松手也收得到（按下就捕获指针）；之后按着空格移回图区，画布不再跟着动
  await page.evaluate(() => { A.setView('canvas'); const b = T.board(A); A.setViewport({ zoom: 2, cx: b.offsetWidth / 2, cy: b.offsetHeight / 2 }); });
  const edge = await page.evaluate(() => { const r = T.wrapOf(A).getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2 }; });
  await page.mouse.move(edge.x + 40, edge.y); await page.mouse.move(edge.x, edge.y);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(2, 6);                                    // 一步跳到实例外面（页头左上角）
  await page.mouse.up();
  const e1 = await page.evaluate(() => ({ sc: T.scroll(A), cls: T.root(A).className }));
  await page.mouse.move(ca.x, ca.y, { steps: 8 });
  const e2 = await page.evaluate(() => ({ sc: T.scroll(A), cls: T.root(A).className }));
  await page.keyboard.up('Space');
  check('从图区边上开始拖、甩到实例外面松手：松手收得到，移回图区画布不再跟着动', !/\bgrabbing\b/.test(e1.cls) && e1.sc.l === e2.sc.l && e1.sc.t === e2.sc.t && /\bgrab\b/.test(e2.cls), { e1, e2 });
  // 拖动中 move 报告左键已经松开（buttons = 0，松手事件丢了）：结束拖动
  await page.evaluate(() => { window.__pid = null; A.shadow.addEventListener('pointerdown', e => { window.__pid = e.pointerId; }, true); });
  await page.keyboard.down('Space');
  await page.mouse.down();
  r = await page.evaluate(() => {
    const before = T.root(A).className;
    T.wrapOf(A).dispatchEvent(new PointerEvent('pointermove', { pointerId: window.__pid, pointerType: 'mouse', isPrimary: true, buttons: 0, clientX: 30, clientY: 30, bubbles: true, composed: true }));
    return { before, after: T.root(A).className, sc: T.scroll(A) };
  });
  await page.mouse.move(ca.x - 90, ca.y - 60, { steps: 5 });
  const e3 = await page.evaluate(() => T.scroll(A));
  await page.mouse.up(); await page.keyboard.up('Space');
  check('拖动中 move 报告左键已松开（buttons=0）：结束拖动，之后不再跟着动', /\bgrabbing\b/.test(r.before) && !/\bgrabbing\b/.test(r.after) && r.sc.l === e3.l && r.sc.t === e3.t, { r, e3 });

  // 空格不点击获得焦点的按钮；鼠标不在图区时空格照常
  await page.evaluate(() => A.shadow.querySelector('[data-act="color"][data-v="0"]').focus());
  c = await page.evaluate(() => T.center(T.wrapOf(A)));
  await page.mouse.move(c.x, c.y);
  await page.keyboard.press('Space');
  const colorKept = await page.evaluate(() => A.getPrefs().color);
  await page.mouse.move(5, 5);
  await page.keyboard.press('Space');
  const colorToggled = await page.evaluate(() => A.getPrefs().color);
  await page.evaluate(() => A.setPrefs({ color: true }));
  check('鼠标在图区上按空格：不「点击」获得焦点的按钮', colorKept === true);
  check('对照：鼠标不在图区上，空格照常点击按钮', colorToggled === false);
  // 焦点在输入框里：空格不拦
  await page.evaluate(() => { const i = document.createElement('input'); i.id = 'inp'; document.querySelector('header').appendChild(i); i.focus(); });
  await page.mouse.move(c.x, c.y);
  await page.keyboard.down('Space');
  r = await page.evaluate(() => ({ grab: /\bgrab\b/.test(T.root(A).className) }));
  await page.keyboard.up('Space');
  r.val = await page.evaluate(() => document.getElementById('inp').value);
  check('焦点在输入框：空格照常输入，不进抓手', !r.grab && r.val === ' ', r);
  await page.evaluate(() => { const i = document.getElementById('inp'); i.blur(); i.remove(); });
  // 窗口失焦退出抓手
  await page.mouse.move(5, 5); await page.mouse.move(c.x, c.y);
  await page.keyboard.down('Space');
  r = await page.evaluate(() => { const on = /\bgrab\b/.test(T.root(A).className); window.dispatchEvent(new Event('blur')); return { on, after: /\bgrab\b/.test(T.root(A).className) }; });
  await page.keyboard.up('Space');
  check('窗口失焦：退出抓手', r.on && !r.after, r);

  // ---- Esc 只作用于当前实例 ----
  await page.evaluate(() => { const b = T.board(A); A.setViewport({ zoom: 1, cx: b.offsetWidth / 2, cy: b.offsetHeight / 2 }); });
  const pinBoth = async () => {
    const pa = await page.evaluate(() => T.pickWork(A, '.work')); await page.mouse.click(pa.x, pa.y);
    const pb = await page.evaluate(() => T.pickWork(B)); await page.mouse.click(pb.x, pb.y);
    return page.evaluate(() => [!!A.pinned, !!B.pinned]);
  };
  let pins = await pinBoth();
  c = await page.evaluate(() => T.center(T.wrapOf(B)));
  await page.mouse.move(c.x, 140);
  await page.keyboard.press('Escape');
  r = await page.evaluate(() => [!!A.pinned, !!B.pinned]);
  check('Esc（鼠标在 B 上）：只取消 B 的固定高亮', pins[0] && pins[1] && r[0] && !r[1], { before: pins, after: r });
  await page.evaluate(() => A.shadow.querySelector('.tab').focus());
  await page.mouse.move(5, 5);
  await page.keyboard.press('Escape');
  r = await page.evaluate(() => [!!A.pinned, !!B.pinned]);
  check('Esc（焦点在 A 里，鼠标不在任何实例上）：取消 A 的', !r[0], r);
  pins = await pinBoth();
  await page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); });
  await page.mouse.move(5, 5);
  await page.keyboard.press('Escape');
  r = await page.evaluate(() => [!!A.pinned, !!B.pinned]);
  check('Esc（鼠标、焦点都不在实例上）：只归最后一次交互的 B', pins[0] && pins[1] && r[0] && !r[1], { before: pins, after: r });
  await page.mouse.move(c.x - 400, 140); await page.keyboard.press('Escape');

  // ---- 格子变大小：保持视区中心；分支画布按图区高度重排，而且防抖 ----
  await page.mouse.move(5, 5);
  r = await page.evaluate(async () => {
    B.setView('hasse'); const b = T.board(B); B.setViewport({ zoom: 1.5, cx: b.offsetWidth * 0.5, cy: b.offsetHeight * 0.4 }); const v0 = B.getViewport();
    document.getElementById('cellB').style.height = '480px'; await T.frame(); await T.frame();
    const v1 = B.getViewport();
    document.getElementById('cellB').style.height = ''; await T.frame(); await T.frame();
    return { v0, v1, v2: B.getViewport() };
  });
  check('格子变矮再恢复：视区中心不变', same(r.v0, r.v1) && same(r.v0, r.v2), r);
  r = await page.evaluate(async () => {
    A.setView('canvas'); await T.frame();
    let renders = 0; const mo = new MutationObserver(ms => { if (ms.some(m => m.target.classList && m.target.classList.contains('layer') && m.addedNodes.length > 3)) renders++; });
    mo.observe(T.board(A), { childList: true, subtree: true });
    const H0 = T.board(A).offsetHeight, cell = document.getElementById('cellA');
    for (let h = 640; h >= 400; h -= 24) { cell.style.height = h + 'px'; await new Promise(r => setTimeout(r, 30)); }
    const during = renders;
    await new Promise(r => setTimeout(r, 450));
    const after = renders, H1 = T.board(A).offsetHeight, area = T.wrapOf(A).clientHeight;
    cell.style.height = ''; await new Promise(r => setTimeout(r, 450)); mo.disconnect();
    return { during, after, H0, H1, area, back: T.board(A).offsetHeight };
  });
  check('拖动改格子高度：重排防抖（拖动过程中不重排，停下后重排一次）', r.during === 0 && r.after === 1, r);

  // ---- 没动过的图（home）：分屏变窄、变宽、还原都按初始规则摆；动过的按 cx/cy 还原 ----
  const settle = () => page.evaluate(async () => { await T.frame(); await T.frame(); await new Promise(r => setTimeout(r, 450)); });
  const cellBFlex = f => page.evaluate(f => { document.getElementById('cellB').style.flex = f; }, f);
  // 新挂一个没缩放、没平移过的 B（canvas），宽格子
  await page.evaluate(() => { B.destroy(); window.B = mountPane('b', { view: 'canvas' }); });
  await page.waitForFunction(() => B.getViewport()); await settle();
  r = await page.evaluate(() => ({ vp: B.getViewport(), d: T.homeDiff(B), hidden: T.badge(B).hidden, w: T.wrapOf(B).clientWidth }));
  const fresh = r.vp;
  check('没动过的图：getViewport 带 home、100%、按初始规则摆、不显示小标签', r.vp.home === true && r.vp.zoom === 1 && r.d <= 1 && r.hidden && r.w > 700, r);
  await cellBFlex('0 0 430px'); await settle();
  r = await page.evaluate(() => ({ vp: B.getViewport(), d: T.homeDiff(B), w: T.wrapOf(B).clientWidth, narrow: T.root(B).classList.contains('narrow'), hidden: T.badge(B).hidden }));
  check('格子从宽变窄（分屏）：没动过的图仍按初始规则摆、仍是 home', r.narrow && r.w < 450 && r.d <= 1 && r.vp.home === true && r.hidden, r);
  await cellBFlex(''); await settle();
  r = await page.evaluate(() => ({ vp: B.getViewport(), d: T.homeDiff(B), w: T.wrapOf(B).clientWidth }));
  check('再变宽：仍按初始规则摆、仍是 home', r.w > 700 && r.d <= 1 && r.vp.home === true, r);
  // 分屏复制 / 刷新：宿主存下的 home 视区（宽格子里读的）拿到窄格子里还原
  r = await page.evaluate(async vp => {
    document.getElementById('cellB').style.flex = '0 0 430px'; B.destroy(); window.B = mountPane('b', { view: 'canvas', viewports: { canvas: vp } });
    await T.frame(); await T.frame(); await new Promise(r => setTimeout(r, 450));
    return { d: T.homeDiff(B), w: T.wrapOf(B).clientWidth, vp: B.getViewport(), hidden: T.badge(B).hidden };
  }, fresh);
  check('带 home 的视区（宽格子里存的）在窄格子里还原：按窄格子的初始规则摆', r.w < 450 && r.d <= 1 && r.vp.home === true && r.hidden, r);
  // 没有 home（平移或缩放过的图）：按 cx/cy 还原
  r = await page.evaluate(async vp => {
    B.destroy(); window.B = mountPane('b', { view: 'canvas', viewports: { canvas: { zoom: vp.zoom, cx: vp.cx, cy: vp.cy } } });
    await T.frame(); await T.frame(); await new Promise(r => setTimeout(r, 450));
    return { d: T.homeDiff(B), vp: B.getViewport(), hidden: T.badge(B).hidden, text: T.badge(B).textContent };
  }, fresh);
  check('没有 home 的视区（平移或缩放过的图）：按 cx/cy 还原；不在初始位置，小标签显示 100%', near(r.vp.cx, fresh.cx, 1) && near(r.vp.cy, fresh.cy, 1) && !r.vp.home && r.d > 50 && !r.hidden && r.text === '100%', r);
  // setViewport 带 home / 不带 home；onViewportChange 报 home
  r = await page.evaluate(async () => {
    log.length = 0;
    const b = T.board(B), W = b.offsetWidth, H = b.offsetHeight, lastVp = () => { const e = log.filter(e => e[0] === 'vp' && e[1] === 'b').pop(); return e && e[3]; };
    B.setViewport({ home: true }); const v1 = B.getViewport(), d1 = T.homeDiff(B), h1 = T.badge(B).hidden;
    await new Promise(r => setTimeout(r, 350)); const e1 = lastVp();
    B.setViewport({ zoom: 1.5, cx: W * 0.6, cy: H * 0.5 }); const v2 = B.getViewport(), h2 = T.badge(B).hidden;
    await new Promise(r => setTimeout(r, 350)); const e2 = lastVp();
    B.setViewport({ home: true, zoom: 2, cx: 5 }); const v3 = B.getViewport(), d3 = T.homeDiff(B);
    B.setViewport({ cx: v3.cx + 40 }); const v4 = B.getViewport(), h4 = T.badge(B).hidden;
    return { W, H, v1, d1, h1, e1, v2, h2, e2, v3, d3, v4, h4 };
  });
  check('setViewport({home:true})：回到初始（100%、初始规则），带 home，小标签收起', r.v1.home === true && r.v1.zoom === 1 && r.d1 <= 1 && r.h1, { v1: r.v1, d1: r.d1 });
  check('onViewportChange 报上来的视区带 home', r.e1 && r.e1.home === true && r.e1.zoom === 1, r.e1);
  check('setViewport 给了 zoom/cx/cy：不是 home；onViewportChange 也不带 home', r.v2.zoom === 1.5 && !('home' in r.v2) && !r.h2 && r.e2 && !('home' in r.e2) && near(r.e2.cx, r.W * 0.6, 1), { v2: r.v2, e2: r.e2 });
  check('setViewport 同时给 home 和 zoom/cx：以 home 为准', r.v3.home === true && r.v3.zoom === 1 && r.d3 <= 1, { v3: r.v3, d3: r.d3 });
  check('100% 下只平移（setViewport 只给 cx）：不是 home，小标签出现', !r.v4.home && r.v4.zoom === 1 && !r.h4, { v4: r.v4 });
  // 动过的视区：格子变宽再变窄，按中心还原
  r = await page.evaluate(async () => {
    const wait = async () => { await T.frame(); await T.frame(); await new Promise(r => setTimeout(r, 450)); };
    const b = T.board(B); B.setViewport({ zoom: 1.5, cx: b.offsetWidth * 0.5, cy: b.offsetHeight * 0.5 }); const v0 = B.getViewport();
    document.getElementById('cellB').style.flex = '0 0 620px'; await wait(); const v1 = B.getViewport(), w1 = T.wrapOf(B).clientWidth;
    document.getElementById('cellB').style.flex = '0 0 430px'; await wait();
    return { v0, v1, w1, v2: B.getViewport() };
  });
  check('动过的视区：格子变宽再变窄，中心不变、不变成 home', r.w1 > 560 && same(r.v0, r.v1) && same(r.v0, r.v2) && !r.v1.home && !r.v2.home, r);
  // 保活：格子藏起来（display:none，图区 0 尺寸）再显示——home 的、动过的都保持；藏着时 setViewport({home:true}) 显示时生效
  r = await page.evaluate(async () => {
    const wait = async () => { await T.frame(); await T.frame(); await new Promise(r => setTimeout(r, 450)); };
    const cell = document.getElementById('cellB');
    B.setViewport({ home: true });
    cell.style.display = 'none'; await wait(); const hv = B.getViewport();
    cell.style.display = ''; await wait(); const v1 = B.getViewport(), d1 = T.homeDiff(B);
    const b = T.board(B); B.setViewport({ zoom: 1.3, cx: b.offsetWidth * 0.55, cy: b.offsetHeight * 0.45 }); const v2 = B.getViewport();
    cell.style.display = 'none'; await wait();
    cell.style.display = ''; await wait(); const v3 = B.getViewport(), t3 = T.badge(B).textContent, h3 = T.badge(B).hidden;
    cell.style.display = 'none'; await wait(); B.setViewport({ home: true }); const hv2 = B.getViewport();
    cell.style.display = ''; await wait(); const v4 = B.getViewport(), d4 = T.homeDiff(B), h4 = T.badge(B).hidden;
    return { hv, v1, d1, v2, v3, t3, h3, hv2, v4, d4, h4 };
  });
  check('保活（藏起再显示）：home 的仍按初始规则摆', r.hv && r.hv.home === true && r.v1.home === true && r.d1 <= 1, { hv: r.hv, v1: r.v1, d1: r.d1 });
  check('保活（藏起再显示）：动过的按原来的中心和缩放还原', same(r.v2, r.v3) && !r.v3.home && !r.h3 && r.t3 === '130%', { v2: r.v2, v3: r.v3 });
  check('保活：藏着时 setViewport({home:true})，显示时回到初始', r.hv2 && r.hv2.home === true && r.v4.home === true && r.d4 <= 1 && r.h4, { hv2: r.hv2, v4: r.v4, d4: r.d4 });
  // 还原：B 回到宽格子、看 hasse
  await cellBFlex('');
  await page.evaluate(() => { B.destroy(); window.B = mountPane('b', { view: 'hasse' }); });
  await page.waitForFunction(() => B.getViewport()); await settle();

  // ---- Shift+1 显示全图、Shift+0 回到初始：归鼠标所在的实例，没有就归焦点所在的；焦点在输入框、带 Ctrl 时不拦 ----
  await page.evaluate(() => {
    window.__keys = []; window.addEventListener('keydown', e => __keys.push([e.code, e.shiftKey, e.defaultPrevented]));
    A.setView('canvas'); const b = T.board(A); A.setViewport({ zoom: 1.6, cx: b.offsetWidth * 0.3, cy: b.offsetHeight * 0.3 });
    const hb = T.board(B); B.setViewport({ zoom: 1.2, cx: hb.offsetWidth * 0.4, cy: hb.offsetHeight * 0.4 });
  });
  const keyState = () => page.evaluate(() => {
    const n = T.inner(A), br = T.board(A).getBoundingClientRect(), b = T.board(A);
    return { a: A.getViewport(), b: B.getViewport(), dFit: T.homeDiff(A, null, true), dHome: T.homeDiff(A), badge: T.badge(A).hidden ? null : T.badge(A).textContent,
      inside: br.left >= n.l - 1 && br.right <= n.r + 1 && br.top >= n.t - 1 && br.bottom <= n.b + 1, want: Math.min(1, n.w / b.offsetWidth, n.h / b.offsetHeight), keys: __keys.slice(-1) };
  });
  c = await page.evaluate(() => T.center(T.wrapOf(A)));
  await page.mouse.move(c.x, c.y);
  const kb0 = await vpOf(page, 'B');
  await page.keyboard.press('Shift+Digit1');
  r = await keyState();
  check('Shift+1（鼠标在 A 上）：A 显示全图——缩放到刚好放进图区（不到 100%）、居中（误差 ≤1.5px）', r.a.zoom < 1 && near(r.a.zoom, r.want, 0.002) && r.inside && r.dFit <= 1.5 && !r.a.home && r.badge === Math.round(r.a.zoom * 100) + '%' && r.keys[0][2] === true, r);
  check('Shift+1 只作用于鼠标所在的 A：B 不变', same(kb0, r.b) && r.b.zoom === 1.2, { before: kb0, after: r.b });
  await page.keyboard.press('Shift+Digit0');
  r = await keyState();
  check('Shift+0（鼠标在 A 上）：A 回到初始（100%、初始规则、home、小标签收起），B 不变', r.a.zoom === 1 && r.a.home === true && r.dHome <= 1 && r.badge === null && same(kb0, r.b) && r.keys[0][2] === true, r);
  // 带 Ctrl：不拦（浏览器自己的快捷键）
  await page.evaluate(() => { const b = T.board(A); A.setViewport({ zoom: 1.4, cx: b.offsetWidth * 0.5, cy: b.offsetHeight * 0.5 }); });
  const ka0 = await vpOf(page, 'A');
  await page.keyboard.press('Control+Shift+Digit1');
  r = await keyState();
  check('Ctrl+Shift+1：不拦、不缩放', same(ka0, r.a) && r.keys[0][2] === false, { a: r.a, keys: r.keys });
  // 焦点在输入框里（鼠标在 A 上）：照常输入，不拦
  await page.evaluate(() => { const i = document.createElement('input'); i.id = 'inp2'; document.querySelector('header').appendChild(i); i.focus(); });
  await page.keyboard.press('Shift+Digit1');
  r = await keyState();
  r.val = await page.evaluate(() => document.getElementById('inp2').value);
  check('焦点在输入框里：Shift+1 照常输入「!」，A 不变', r.val === '!' && same(ka0, r.a) && r.keys[0][2] === false, { val: r.val, a: r.a });
  await page.evaluate(() => { const i = document.getElementById('inp2'); i.blur(); i.remove(); });
  // 鼠标不在任何实例上、焦点在 B 里：只有 B 变
  await page.mouse.move(5, 5);
  await page.evaluate(() => B.shadow.querySelector('.tab').focus());
  await page.keyboard.press('Shift+Digit1');
  r = await page.evaluate(() => ({ a: A.getViewport(), b: B.getViewport(), dFit: T.homeDiff(B, null, true) }));
  check('焦点在 B 里、鼠标不在实例上：Shift+1 只让 B 显示全图，A 不变', r.b.zoom < 1 && r.dFit <= 1.5 && same(ka0, r.a), r);
  await page.keyboard.press('Shift+Digit0');
  r = await page.evaluate(() => ({ a: A.getViewport(), b: B.getViewport(), d: T.homeDiff(B) }));
  check('焦点在 B 里：Shift+0 让 B 回到初始，A 不变', r.b.home === true && r.b.zoom === 1 && r.d <= 1 && same(ka0, r.a), r);
  // 鼠标、焦点都不在实例上：谁都不管
  await page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); });
  await page.keyboard.press('Shift+Digit1');
  r = await keyState();
  check('鼠标、焦点都不在实例上：Shift+1 不拦，两个都不变', same(ka0, r.a) && r.b.home === true && r.keys[0][2] === false, { a: r.a, b: r.b, keys: r.keys });

  // ---- 截图（浅色）：A 缩放中显示小标签，B 打开侧栏 ----
  await page.evaluate(() => { const b = T.board(A); A.setViewport({ zoom: 1.35, cx: b.offsetWidth * 0.5, cy: b.offsetHeight * 0.45 }); B.setPrefs({ drawer: true }); });
  await page.waitForTimeout(300);
  r = await page.evaluate(() => { const dr = B.shadow.querySelector('.drawer'), fr = B.shadow.querySelector('.frame'), cs = getComputedStyle(dr); return { pos: cs.position, h: dr.getBoundingClientRect().height, fh: fr.clientHeight, list: getComputedStyle(B.shadow.querySelector('.dr-list')).overflowY, mainW: B.shadow.querySelector('.main').clientWidth }; });
  check('宽格子侧栏：独立一列、撑满格子高度、标签列表自己滚动', r.pos === 'relative' && near(r.h, r.fh - 24, 2) && r.list === 'auto', r);
  await shot(page, '1-pane-light', { x: 0, y: 0, width: 1800, height: 700 });

  // ---- destroy 移除 document / window 上的监听 ----
  // 只看引擎会挂的几种（Playwright 自己也会在 window 上挂鼠标监听）
  r = await page.evaluate(() => { const pick = o => Object.fromEntries(Object.entries(o).filter(([k]) => /^(doc:(keydown|keyup|fullscreenchange)|win:(blur|resize))$/.test(k))); const before = pick(__listeners()); A.destroy(); B.destroy(); return { before, after: pick(__listeners()) }; });
  check('destroy：引擎挂在 document / window 上的监听全部移除', Object.keys(r.before).length >= 4 && Object.keys(r.after).length === 0, r);
  await page.keyboard.press('Space'); await page.keyboard.press('Escape');

  check('pane 页面没有报错', errs.length === 0, errs.slice(0, 5));
  await ctx.close();
}

// ================= 平移范围：视区中心走遍整张图、出不了图 =================
// A 看领地图，格子很高（100% 就放得下）；B 窄
async function panTests(browser) {
  const { page, errs, ctx } = await open(browser, pathToFileURL(PANE_HTML).href + '?a=terr&b=hasse&theme=light', { width: 1800, height: 1400 });
  await ready(page);
  await page.evaluate(async () => {
    document.getElementById('cellA').style.height = '1300px'; document.getElementById('cellB').style.flex = '0 0 430px';
    await T.frame(); await T.frame(); await new Promise(r => setTimeout(r, 450));
  });
  const st = () => page.evaluate(() => {
    const n = T.inner(A), br = T.board(A).getBoundingClientRect(), vc = T.vcenter(A), b = T.board(A);
    return { vp: A.getViewport(), n, br: { l: br.left, t: br.top, r: br.right, b: br.bottom }, vc, W: b.offsetWidth, H: b.offsetHeight, d: T.homeDiff(A),
      badge: T.badge(A).hidden ? null : T.badge(A).textContent };
  });
  let s = await st();
  const fits = s.W <= s.n.w && s.H <= s.n.h;
  check('平移：领地图 100% 放得下；没动过时居中、是 home', fits && s.vp.home === true && s.d <= 1 && near(s.br.l - s.n.l, s.n.r - s.br.r, 1) && near(s.br.t - s.n.t, s.n.b - s.br.b, 1), { W: s.W, H: s.H, n: s.n, d: s.d });
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y);
    await page.keyboard.down('Space');
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Space');
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  };
  // 四个角：从初始位置出发，空格+拖动把这个角拖到图区中心；再往外拖 150px，角仍在中心（中心出不了图）
  let badge100 = null;
  for (const [sx, sy, name] of [[-1, -1, '左上'], [1, -1, '右上'], [-1, 1, '左下'], [1, 1, '右下']]) {
    await page.evaluate(() => A.setViewport({ home: true }));
    s = await st();
    const corner = { x: sx < 0 ? s.br.l : s.br.r, y: sy < 0 ? s.br.t : s.br.b };
    const from = { x: corner.x - sx * 3, y: corner.y - sy * 3 };           // 从角内侧一点按下
    await drag(from, { x: s.vc.x + from.x - corner.x, y: s.vc.y + from.y - corner.y });
    const s1 = await st();
    const c1 = { x: sx < 0 ? s1.br.l : s1.br.r, y: sy < 0 ? s1.br.t : s1.br.b };
    if (badge100 === null) badge100 = s1.badge;
    await drag(s1.vc, { x: s1.vc.x - sx * 150, y: s1.vc.y - sy * 150 });
    const s2 = await st();
    const c2 = { x: sx < 0 ? s2.br.l : s2.br.r, y: sy < 0 ? s2.br.t : s2.br.b };
    const ex = sx < 0 ? 0 : s.W, ey = sy < 0 ? 0 : s.H;
    check(`空格+拖动：图的${name}角能拖到图区中心；再往外拖也出不了图（中心停在角上）`,
      near(c1.x, s1.vc.x, 1.5) && near(c1.y, s1.vc.y, 1.5) && near(c2.x, s2.vc.x, 1.5) && near(c2.y, s2.vc.y, 1.5) && near(s2.vp.cx, ex, 1) && near(s2.vp.cy, ey, 1) && s2.vp.zoom === 1 && !s2.vp.home,
      { c1: [+(c1.x - s1.vc.x).toFixed(1), +(c1.y - s1.vc.y).toFixed(1)], c2: [+(c2.x - s2.vc.x).toFixed(1), +(c2.y - s2.vc.y).toFixed(1)], vp: s2.vp });
  }
  s = await st();
  check('100% 下平移过：小标签出现，显示 100%', badge100 === '100%' && s.badge === '100%', { badge100, now: s.badge });
  await page.locator('#a .zoom-badge:not([hidden])').click();
  s = await st();
  check('点小标签：回到初始（home、居中、小标签收起）', s.vp.home === true && s.vp.zoom === 1 && s.d <= 1 && s.badge === null, { vp: s.vp, d: s.d });
  // 先拖到某处，再空格+滚轮放大：鼠标下的作品和画板坐标不变
  s = await st();
  await drag(s.vc, { x: s.vc.x + 380, y: s.vc.y + 300 });
  const p = await page.evaluate(() => { const w = T.pickWork(A); return w && Object.assign(w, { bp: T.boardPt(A, w.x, w.y), z: T.z(A) }); });
  if (!p) check('拖到某处后空格+滚轮放大', false, '找不到可悬停的作品');
  else {
    await page.mouse.move(p.x, p.y);
    await page.keyboard.down('Space');
    await page.mouse.wheel(0, -260);
    await page.keyboard.up('Space');
    const q = await page.evaluate(([x, y]) => ({ wid: T.widAt(A, x, y), bp: T.boardPt(A, x, y), z: T.z(A) }), [p.x, p.y]);
    check('先拖到某处再空格+滚轮放大：鼠标下的作品和画板坐标不变', q.z > p.z * 1.3 && q.wid === p.wid && near(q.bp.x, p.bp.x, 1) && near(q.bp.y, p.bp.y, 1),
      { before: { wid: p.wid, z: p.z, bp: [+p.bp.x.toFixed(1), +p.bp.y.toFixed(1)] }, after: { wid: q.wid, z: +q.z.toFixed(3), bp: [+q.bp.x.toFixed(1), +q.bp.y.toFixed(1)] } });
  }
  // 放得下的图按 Shift+1：不放大（100%）、居中 = 回到初始
  const ac = await page.evaluate(() => T.center(T.wrapOf(A)));
  await page.mouse.move(ac.x, ac.y);
  await page.keyboard.press('Shift+Digit1');
  s = await st();
  const dFit = await page.evaluate(() => T.homeDiff(A, null, true));
  check('放得下的图按 Shift+1：不放大（100%），居中', s.vp.zoom === 1 && dFit <= 1 && s.vp.home === true && s.badge === null, { vp: s.vp, dFit });
  // 窄的 B：100% 放不下，初始从左上角开始；能把右下角拖到中心
  await page.mouse.move(5, 5);
  let rb = await page.evaluate(() => { const n = T.inner(B), br = T.board(B).getBoundingClientRect(); return { vp: B.getViewport(), d: T.homeDiff(B), l: br.left - n.l, t: br.top - n.t, w: br.width, nw: n.w }; });
  check('窄格子 B（100% 放不下）：初始从左上角开始', rb.vp.home === true && rb.d <= 1 && near(rb.l, 0, 1) && near(rb.t, 0, 1) && rb.w > rb.nw, rb);
  rb = await page.evaluate(() => { const b = T.board(B); B.setViewport({ cx: 1e6, cy: 1e6 }); return { vp: B.getViewport(), W: b.offsetWidth, H: b.offsetHeight }; });
  check('setViewport 给的中心超出图：夹到图的边上（右下角）', near(rb.vp.cx, rb.W, 1) && near(rb.vp.cy, rb.H, 1) && !rb.vp.home, rb);
  // 画板尺寸变了（隐藏 / 显示封面、配色、侧栏开关、数据更新、封面图加载完）：没动过的图仍是 home、重新按初始规则摆；
  // 动过的仍不是 home；之后用户一滚动 home 照常去掉
  await page.evaluate(async () => { document.getElementById('cellB').style.flex = '0 0 200px'; await T.frame(); await T.frame(); await new Promise(r => setTimeout(r, 450)); });
  const homeNow = () => page.evaluate(async () => { await T.frame(); await T.frame(); await new Promise(r => setTimeout(r, 120));
    const n = T.inner(A), b = T.board(A); return { vp: A.getViewport(), d: T.homeDiff(A), badge: T.badge(A).hidden ? null : T.badge(A).textContent, fits: b.offsetHeight <= n.h, W: b.offsetWidth, H: b.offsetHeight }; });
  const okHome = q => q.vp.home === true && q.vp.zoom === 1 && q.d <= 1 && q.badge === null;
  for (const v of ['score', 'kmap', 'terr']) {
    await page.evaluate(async v => { A.setView(v); await T.frame(); A.setViewport({ home: true }); }, v);
    await page.waitForFunction(v => A.getViewport(v), v, { timeout: 10000 });
    const q0 = await homeNow();
    await page.locator('#a [data-act="cover"][data-v="0"]').click();
    const q1 = await homeNow();
    await page.locator('#a [data-act="cover"][data-v="1"]').click();
    const q2 = await homeNow();
    check(`${v}（100% 时上下放得下、在初始位置）：隐藏封面、再显示封面后仍是 home、重新居中、没有小标签`, q0.fits && okHome(q0) && q1.fits && okHome(q1) && q1.H !== q0.H && okHome(q2),
      { before: [q0.W, q0.H, q0.d], hidden: [q1.W, q1.H, q1.d, q1.vp.home, q1.badge], shown: [q2.W, q2.H, q2.d, q2.vp.home, q2.badge] });
  }
  await page.evaluate(async () => { A.setView('kmap'); await T.frame(); A.setViewport({ home: true }); });
  const steps = {};
  await page.locator('#a [data-act="color"][data-v="0"]').click(); steps.mono = await homeNow();
  await page.locator('#a [data-act="color"][data-v="1"]').click(); steps.color = await homeNow();
  await page.locator('#a .drawer-btn').click(); steps.drawerOn = await homeNow();
  await page.locator('#a .drawer-btn').click(); steps.drawerOff = await homeNow();
  await page.evaluate(() => A.setData(JSON.parse(document.getElementById('data').textContent))); steps.setData = await homeNow();
  // 封面图加载完之类：画板自己变大
  await page.evaluate(() => { const b = T.board(A); b.style.height = (b.offsetHeight + 90) + 'px'; }); steps.grow = await homeNow();
  const bad = Object.entries(steps).filter(([, q]) => !okHome(q)).map(([k, q]) => [k, q.d, q.vp.home, q.badge]);
  check('kmap 在初始位置：切配色、开关侧栏、setData、画板自己变大以后仍是 home、按初始规则摆', bad.length === 0, bad.length ? bad : Object.keys(steps));
  // 用户滚动：home 照常去掉
  const ka = await page.evaluate(() => T.center(T.wrapOf(A)));
  await page.mouse.move(ka.x, ka.y);
  await page.mouse.wheel(0, 120);
  let q = await homeNow();
  check('之后用户滚轮滚动：home 照常去掉、小标签出现', !q.vp.home && q.badge === '100%', { vp: q.vp, badge: q.badge });
  // 同一帧里用户平移 + 画板变大（封面图恰好这时加载完）：平移不能被吞，home 当场去掉（不等滚动事件）
  const growOnce = type => page.evaluate(type => { window.addEventListener(type, () => { const b = T.board(A); b.style.height = (b.offsetHeight + 90) + 'px'; }, { once: true }); }, type);
  const fromHome = async () => { await page.evaluate(async () => { A.setViewport({ home: true }); await T.frame(); }); return homeNow(); };
  const kc = await page.evaluate(() => T.center(T.wrapOf(A)));
  const h0 = await page.evaluate(() => T.board(A).style.height);
  let f0 = await fromHome();
  await page.mouse.move(kc.x, kc.y);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await growOnce('pointermove');
  await page.mouse.move(kc.x - 100, kc.y - 70);
  await page.mouse.up();
  await page.keyboard.up('Space');
  let f1 = await homeNow();
  check('从初始位置空格+拖动 100×70，同一个 pointermove 里画板加高 90px：平移不被吞，home 去掉、小标签出现',
    okHome(f0) && f1.H - f0.H >= 89 && !f1.vp.home && f1.badge === '100%' && near(f1.vp.cx - f0.vp.cx, 100, 1.5) && near(f1.vp.cy - f0.vp.cy, 70, 1.5),
    { before: f0.vp, after: f1.vp, H: [f0.H, f1.H], badge: f1.badge });
  // 普通滚轮：wheel 事件里画板变大（滚动位置这时还没变）
  f0 = await fromHome();
  await page.mouse.move(kc.x, kc.y);
  await growOnce('wheel');
  await page.mouse.wheel(0, 120);
  f1 = await homeNow();
  check('从初始位置普通滚轮往下滚，同一个 wheel 里画板加高 90px：滚动不被吞，home 去掉、小标签出现',
    okHome(f0) && f1.H - f0.H >= 89 && !f1.vp.home && f1.badge === '100%' && f1.vp.cy - f0.vp.cy > 30 && near(f1.vp.cx, f0.vp.cx, 1),
    { before: f0.vp, after: f1.vp, H: [f0.H, f1.H], badge: f1.badge });
  // 宿主把滚轮拦下（preventDefault），图区其实没滚：home 不去掉
  f0 = await fromHome();
  await page.evaluate(() => document.getElementById('a').addEventListener('wheel', e => e.preventDefault(), { passive: false, once: true }));
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(400);
  f1 = await homeNow();
  check('宿主拦下了滚轮（图区没滚）：仍是 home、没有小标签', okHome(f0) && okHome(f1), { before: f0.vp, after: f1.vp, d: f1.d, badge: f1.badge });
  await page.evaluate(h => { T.board(A).style.height = h; }, h0);
  await page.mouse.move(5, 5);
  // 动过的图：隐藏封面后仍不是 home
  await page.evaluate(() => { const b = T.board(A); A.setViewport({ zoom: 1, cx: b.offsetWidth * 0.3, cy: b.offsetHeight * 0.3 }); });
  await page.locator('#a [data-act="cover"][data-v="0"]').click();
  q = await homeNow();
  await page.locator('#a [data-act="cover"][data-v="1"]').click();
  const q3 = await homeNow();
  check('动过的图：隐藏 / 显示封面后仍不是 home，小标签还在', !q.vp.home && q.badge === '100%' && !q3.vp.home && q3.badge === '100%', { hidden: q.vp, shown: q3.vp });
  await page.mouse.move(5, 5);

  check('平移页面没有报错', errs.length === 0, errs.slice(0, 5));
  await ctx.close();
}

// ================= 拖图区滚动条：home 当场去掉 =================
// 无头浏览器默认隐藏滚动条（宽 0），这一组用另开的、显示滚动条的无头浏览器跑
async function barTests(browser) {
  const { page, errs, ctx } = await open(browser, pathToFileURL(PANE_HTML).href + '?a=kmap&b=hasse&theme=light', { width: 1800, height: 1400 });
  await ready(page);
  await page.evaluate(async () => {
    document.getElementById('cellA').style.height = '1300px'; document.getElementById('cellB').style.flex = '0 0 430px';
    await T.frame(); await T.frame(); await new Promise(r => setTimeout(r, 450));
    A.setViewport({ home: true }); await T.frame();
  });
  // 竖滚动条的滑块中间
  const thumb = () => page.evaluate(() => {
    const s = T.wrapOf(A), r = s.getBoundingClientRect(), sbw = s.offsetWidth - s.clientWidth - 2 * s.clientLeft;
    return { sbw, x: r.left + s.clientLeft + s.clientWidth + sbw / 2, y: r.top + s.clientTop + (s.scrollTop + s.clientHeight / 2) / s.scrollHeight * s.clientHeight };
  });
  const badge = () => page.evaluate(() => T.badge(A).hidden ? null : T.badge(A).textContent);
  let t = await thumb();
  const vp0 = await page.evaluate(() => A.getViewport());
  await page.mouse.move(t.x, t.y);
  await page.mouse.down();
  const b1 = await badge();
  await page.mouse.up();
  const b2 = await badge(), vp1 = await page.evaluate(() => A.getViewport());
  check('按住图区滚动条：小标签当场出现；没拖就松开：马上恢复 home、小标签收起', t.sbw > 0 && vp0.home === true && b1 === '100%' && b2 === null && vp1.home === true, { sbw: t.sbw, b1, b2, vp1 });
  // 按下滚动条的同一个任务里画板加高 90px（封面图恰好这时加载完），再往下拖
  await page.evaluate(() => window.addEventListener('pointerdown', () => { const b = T.board(A); b.style.height = (b.offsetHeight + 90) + 'px'; }, { once: true }));
  t = await thumb();
  await page.mouse.move(t.x, t.y);
  await page.mouse.down();
  await page.mouse.move(t.x, t.y + 60, { steps: 4 });
  await page.mouse.up();
  const r = await page.evaluate(async () => { await T.frame(); await T.frame(); return { vp: A.getViewport(), badge: T.badge(A).hidden ? null : T.badge(A).textContent }; });
  check('拖图区滚动条往下（按下的同时画板加高 90px）：图跟着滚，home 去掉、小标签出现', !r.vp.home && r.badge === '100%' && r.vp.cy - vp1.cy > 40, { before: vp1, after: r.vp, badge: r.badge });
  await page.mouse.move(5, 5);
  check('滚动条页面没有报错', errs.length === 0, errs.slice(0, 5));
  await ctx.close();
}

// ================= 深色主题、引擎全屏 =================
async function darkAndEngineFull(browser) {
  const { page, errs, ctx } = await open(browser, pathToFileURL(PANE_HTML).href + '?a=hasse&b=line&theme=dark', { width: 1800, height: 900 });
  await ready(page);
  await page.evaluate(() => { const b = T.board(A); A.setViewport({ zoom: 0.8, cx: b.offsetWidth / 2, cy: b.offsetHeight / 2 }); B.setPrefs({ drawer: true }); });
  await page.waitForTimeout(300);
  const st = await page.evaluate(() => { const bd = T.badge(A), cs = getComputedStyle(bd); return { text: bd.textContent, color: cs.color, bg: cs.backgroundColor, theme: A.host.getAttribute('data-theme') }; });
  check('深色主题：小标签显示 80%', st.text === '80%' && st.theme === 'dark', st);
  await shot(page, '2-pane-dark', { x: 0, y: 0, width: 1800, height: 700 });
  // 引擎自己的全屏（fullscreen 默认 'engine'）在 'pane' 下也能用
  await page.locator('#a .full-btn').click();
  await page.waitForTimeout(400);
  let r = await page.evaluate(() => { const root = T.root(A), rr = root.getBoundingClientRect(); return { full: A.isFull(), cls: root.className, w: rr.width, h: rr.height, area: T.wrapOf(A).clientHeight, vp: A.getViewport() }; });
  check('pane + 引擎全屏：铺满窗口、图区跟着变高、视区还在', r.full && /\bfull\b/.test(r.cls) && near(r.w, 1800, 2) && near(r.h, 900, 2) && r.area > 700 && near(r.vp.zoom, 0.8, 1e-9), r);
  const c = await page.evaluate(() => T.center(T.wrapOf(A)));
  await page.mouse.move(c.x, c.y);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  r = await page.evaluate(() => ({ full: A.isFull(), cls: T.root(A).className }));
  check('pane + 引擎全屏：Esc 退出', !r.full && !/\bfull\b/.test(r.cls), r);
  check('深色 / 全屏页面没有报错', errs.length === 0, errs.slice(0, 5));
  await ctx.close();
}

// ================= fullscreen:'host' =================
async function hostFsTests(browser) {
  const { page, errs, ctx } = await open(browser, pathToFileURL(PANE_HTML).href + '?hostfs=1&theme=light', { width: 1800, height: 900 });
  await ready(page);
  await page.evaluate(() => { log.length = 0; });
  await page.locator('#a .full-btn').click();
  await page.waitForTimeout(200);
  let r = await page.evaluate(() => { const b = A.shadow.querySelector('.full-btn'); return { log: log.filter(e => e[0] === 'full'), full: A.isFull(), text: b.textContent.trim(), pressed: b.getAttribute('aria-pressed'), fsEl: !!document.fullscreenElement, rootFull: /\bfull\b/.test(T.root(A).className), cellMax: document.getElementById('cellA').classList.contains('max') }; });
  check("fullscreen:'host'：全屏按钮只调 onFullRequest，引擎自己不进全屏", r.log.length === 1 && r.log[0][1] === 'a' && !r.fsEl && !r.rootFull, r);
  check("fullscreen:'host'：setHostFull(true) 后按钮变「退出全屏」，isFull() = true", r.full && r.text === '退出全屏' && r.pressed === 'true', r);
  r = await page.evaluate(async () => {
    const m = () => ({ area: T.wrapOf(A).clientHeight, cell: document.getElementById('cellA').getBoundingClientRect().height });
    await T.frame(); const a = m(); await new Promise(r => setTimeout(r, 300)); await T.frame(); const b = m(); await new Promise(r => setTimeout(r, 300)); await T.frame(); const c = m();
    return { a, b, c, h: innerHeight };
  });
  check("fullscreen:'host'：宿主把格子铺满后，图区跟着变高、不超过窗口高度、隔几帧再量不变", r.a.area > 700 && r.a.area <= r.h && near(r.a.cell, r.h, 1) && r.a.area === r.b.area && r.b.area === r.c.area && r.c.cell === r.a.cell, r);
  // 宿主不给定高度（格子高度按内容算）：留白不会反过来把图区越撑越高
  r = await page.evaluate(async () => {
    const box = document.createElement('div'); box.id = 'freeBox';
    box.style.cssText = 'position:absolute; left:0; top:0; width:900px; background:#fff';   // 高度 auto：由内容撑开
    const el = document.createElement('div'); el.id = 'free'; box.appendChild(el); document.body.appendChild(box);
    window.F = mountPane('free', { view: 'hasse' });
    const m = () => ({ host: Math.round(el.getBoundingClientRect().height), area: T.wrapOf(F).clientHeight, board: T.board(F).offsetHeight });
    await T.frame(); await T.frame(); await new Promise(r => setTimeout(r, 300)); const a = m();
    await new Promise(r => setTimeout(r, 400)); await T.frame(); const b = m();
    F.setViewport({ zoom: 1.5 }); await T.frame(); await T.frame(); await new Promise(r => setTimeout(r, 300)); const c = m();
    await new Promise(r => setTimeout(r, 400)); await T.frame(); const d = m();
    F.destroy(); box.remove();
    return { a, b, c, d };
  });
  check("宿主不给定高度的 'pane' 实例：高度按内容算、有上限，隔几帧再量不变（缩放后也一样）",
    r.a.board > 0 && r.a.host < r.a.board + 400 && r.a.host === r.b.host && r.a.area === r.b.area && r.c.host < r.c.board * 1.5 + 400 && r.c.host === r.d.host, r);
  // Esc：没有固定高亮时不处理（交给宿主），不 preventDefault
  r = await page.evaluate(() => { let dp = null; const f = e => { if (e.key === 'Escape') dp = e.defaultPrevented; }; window.addEventListener('keydown', f); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.removeEventListener('keydown', f); return { dp, full: A.isFull() }; });
  check("fullscreen:'host'：Esc 不替宿主退出全屏（没 preventDefault）", r.dp === false && r.full === true, r);
  await page.locator('#a .full-btn').click();
  await page.waitForTimeout(200);
  r = await page.evaluate(() => ({ calls: log.filter(e => e[0] === 'full').length, full: A.isFull(), text: A.shadow.querySelector('.full-btn').textContent.trim() }));
  check("fullscreen:'host'：再点一次 → 回调，宿主 setHostFull(false)", r.calls === 2 && !r.full && r.text === '全屏', r);
  r = await page.evaluate(() => { A.setFull(true); const n1 = log.filter(e => e[0] === 'full').length; A.setFull(true); const n2 = log.filter(e => e[0] === 'full').length; A.setFull(false); return { n1, n2, full: A.isFull() }; });
  check("fullscreen:'host'：setFull(on) 只在状态不同时调 onFullRequest", r.n1 === 3 && r.n2 === 3 && !r.full, r);

  // 整个工作区一起全屏（宿主对外层容器 requestFullscreen，各实例都收到 setHostFull(true)）：Esc 仍归鼠标 / 焦点所在的实例，
  // 不归最后一个收到 setHostFull 的
  const unpinAll = () => page.evaluate(() => [A, B].forEach(i => { if (i.pinned) T.board(i).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); }));
  const pinAB = async () => {
    await unpinAll();
    const pa = await page.evaluate(() => T.pickWork(A, '.work')); await page.mouse.click(pa.x, pa.y);
    const pb = await page.evaluate(() => T.pickWork(B)); await page.mouse.click(pb.x, pb.y);
    return page.evaluate(() => [!!A.pinned, !!B.pinned]);
  };
  await page.evaluate(() => { A.setHostFull(true); B.setHostFull(true); });
  let pins = await pinAB();
  const ca = await page.evaluate(() => { const r = T.wrapOf(A).getBoundingClientRect(); return { x: r.left + 20, y: r.top + 20 }; });
  await page.mouse.move(ca.x, ca.y);
  await page.evaluate(() => A.shadow.querySelector('.tab').focus());
  await page.keyboard.press('Escape');
  r = await page.evaluate(() => [!!A.pinned, !!B.pinned]);
  check("工作区整体全屏（A、B 都 setHostFull(true)，B 最后）：鼠标和焦点在 A，Esc 只取消 A 的固定", pins[0] && pins[1] && !r[0] && r[1], { before: pins, after: r });
  // 被宿主藏起来保活的实例拿不到 Esc：A 最后交互、最后收到 setHostFull，然后被藏起来；鼠标、焦点都不在实例上 → 归看得见的 B
  pins = await pinAB();
  await page.evaluate(() => { A.shadow.querySelector('.tab').focus(); A.shadow.activeElement.blur(); B.setHostFull(true); A.setHostFull(true); document.getElementById('cellA').style.display = 'none'; });
  await page.mouse.move(5, 5);
  await page.keyboard.press('Escape');
  r = await page.evaluate(() => [!!A.pinned, !!B.pinned]);
  await page.evaluate(() => { document.getElementById('cellA').style.display = ''; A.setHostFull(false); B.setHostFull(false); });
  check('藏起来的实例（display:none）拿不到 Esc：归看得见的 B', pins[0] && pins[1] && r[0] && !r[1], { before: pins, after: r });
  await unpinAll();
  check('host 全屏页面没有报错', errs.length === 0, errs.slice(0, 5));
  await ctx.close();
}

// ================= 窄宿主：侧栏浮层 =================
async function narrowTests(browser) {
  for (const theme of ['light', 'dark']) {
    const { page, errs, ctx } = await open(browser, pathToFileURL(PANE_HTML).href + `?a=kmap&b=canvas&theme=${theme}`, { width: 1200, height: 900 });
    await ready(page);
    let r = await page.evaluate(() => ({ cls: T.root(A).className, hidden: A.shadow.querySelector('.drawer').hidden, exp: A.shadow.querySelector('.drawer-btn').getAttribute('aria-expanded'), mainW: A.shadow.querySelector('.main').clientWidth, rootW: T.root(A).clientWidth }));
    if (theme === 'light') check('窄宿主（< 720px）：.narrow，侧栏默认收起', /\bnarrow\b/.test(r.cls) && r.hidden && r.exp === 'false', r);
    const mainW = r.mainW;
    await page.locator('#a .drawer-btn').click();
    await page.waitForTimeout(250);
    r = await page.evaluate(() => { const dr = A.shadow.querySelector('.drawer'), fr = A.shadow.querySelector('.frame').getBoundingClientRect(), d = dr.getBoundingClientRect(); return { hidden: dr.hidden, pos: getComputedStyle(dr).position, mainW: A.shadow.querySelector('.main').clientWidth, right: fr.right - d.right, top: d.top - fr.top, h: d.height, fh: fr.height, w: d.width, prefs: A.getPrefs().drawer, exp: A.shadow.querySelector('.drawer-btn').getAttribute('aria-expanded'), bHidden: B.shadow.querySelector('.drawer').hidden }; });
    if (theme === 'light') check('窄宿主：「标签与近邻」把侧栏作为浮层从右侧滑出，盖在图上、不挤压图区', !r.hidden && r.pos === 'absolute' && r.mainW === mainW && near(r.right, 0, 1) && near(r.h, r.fh - 16, 2) && r.exp === 'true', r);
    if (theme === 'light') check('窄宿主：开浮层不改 prefs.drawer，也不影响另一个实例', r.prefs === false && r.bHidden, r);
    // 悬停图上的作品，浮层里的读数跟着变
    const w = await page.evaluate(() => { const b = T.board(A); A.setViewport({ zoom: 0.5, cx: b.offsetWidth / 2, cy: b.offsetHeight / 2 }); return T.pickWork(A, '.work'); });
    if (w) { await page.mouse.move(w.x, w.y); }
    await page.waitForTimeout(150);
    await shot(page, `${theme === 'light' ? 3 : 4}-narrow-overlay-${theme}`, { x: 0, y: 0, width: 620, height: 720 });
    if (theme === 'light') {
      const now = await page.evaluate(() => A.shadow.querySelector('.drawer .now .k') ? A.shadow.querySelector('.drawer .now .k').textContent : null);
      check('窄宿主：浮层开着时悬停作品，读数更新', !!now, now);
      // 百分比小标签不被浮层盖住：挪到浮层左边、仍在图区里、它的中心点上最上层就是它自己
      const badgeAt = () => { const bd = T.badge(A), b = bd.getBoundingClientRect(), dr = A.shadow.querySelector('.drawer'), d = dr.getBoundingClientRect(), box = bd.parentElement.getBoundingClientRect();
        return { hidden: bd.hidden, text: bd.textContent, bL: b.left, bR: b.right, dL: dr.hidden ? null : d.left, boxL: box.left, boxR: box.right, top: A.shadow.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) === bd }; };
      r = await page.evaluate(badgeAt);
      check('窄宿主：浮层开着时右下角百分比小标签挪到浮层左边，不被盖住', !r.hidden && r.bR <= r.dL - 4 && r.bL >= r.boxL && r.top, r);
      await page.keyboard.press('Escape');
      r = await page.evaluate(() => ({ hidden: A.shadow.querySelector('.drawer').hidden }));
      check('窄宿主：Esc 收起浮层', r.hidden, r);
      r = await page.evaluate(badgeAt);
      check('窄宿主：浮层收起后小标签回到右下角', !r.hidden && r.boxR - r.bR < 30 && r.top, r);
      // 宿主变宽：退出窄模式，侧栏回到偏好（收起）；再打开是独立一列
      await page.setViewportSize({ width: 1800, height: 900 });
      await page.waitForTimeout(400);
      r = await page.evaluate(() => ({ cls: T.root(A).className, hidden: A.shadow.querySelector('.drawer').hidden }));
      check('宿主变宽：退出窄模式，侧栏按偏好（收起）', !/\bnarrow\b/.test(r.cls) && r.hidden, r);
    }
    check(`窄宿主页面（${theme}）没有报错`, errs.length === 0, errs.slice(0, 5));
    await ctx.close();
  }
  await narrowBarTests(browser);
}

// 窄格子（格子约 313px 宽、宿主内容宽约 289px）的顶栏：一行；标签行横向滚动 + 淡出提示；工具只留图标，封面 / 配色收进「⋯」菜单
async function narrowBarTests(browser) {
  const barInfo = () => {
    const q = s => A.shadow.querySelector(s), rr = el => el.getBoundingClientRect(), tabs = q('.tabs'), bar = rr(q('.bar')), cs = getComputedStyle(tabs);
    const btns = ['.more-btn', '.drawer-btn', '.full-btn'].map(s => rr(q(s)));
    return { hostW: A.host.clientWidth, cls: T.root(A).className, barH: bar.height, barR: bar.right, tops: btns.map(b => Math.round(b.top)), widths: btns.map(b => b.width), fullR: btns[2].right,
      sw: tabs.scrollWidth, cw: tabs.clientWidth, ovf: tabs.classList.contains('ovf'), mask: cs.webkitMaskImage || cs.maskImage,
      fl: tabs.style.getPropertyValue('--tn-fl'), fr: tabs.style.getPropertyValue('--tn-fr'),
      area: T.wrapOf(A).clientHeight, hostH: A.host.clientHeight, titles: ['.more-btn', '.drawer-btn', '.full-btn'].map(s => q(s).title) };
  };
  const oneRow = r => /\bnarrow\b/.test(r.cls) && r.hostW < 300 && r.barH <= 48 && new Set(r.tops).size === 1 && r.widths.every(w => w > 20) && r.fullR <= r.barR + 0.5;
  for (const theme of ['light', 'dark']) {
    const { page, errs, ctx } = await open(browser, pathToFileURL(PANE_HTML).href + `?a=kmap&b=canvas&theme=${theme}`, { width: 660, height: 900 });
    await ready(page);
    let r = await page.evaluate(barInfo);
    const L = theme === 'light' ? '' : '（深色）';
    check(`窄格子${L}：顶栏只占一行（标签和工具同一行），工具不换行、「全屏」在格子里`, oneRow(r), r);
    check(`窄格子${L}：图区高度 ≥ 宿主高度 − 70px`, r.area >= r.hostH - 70, { area: r.area, hostH: r.hostH, barH: r.barH });
    if (theme === 'light') {
      check('窄格子：只显示图标的按钮都有 title', r.titles.every(Boolean), r.titles);
      check('窄格子：标签行放不下时可以横向滚动，带淡出遮罩', r.ovf && r.sw > r.cw + 20 && r.mask !== 'none', r);
      r = await page.evaluate(async () => { const t = A.shadow.querySelector('.tabs'); t.scrollLeft = 0; await T.frame(); await T.frame(); return { sl: t.scrollLeft, fl: t.style.getPropertyValue('--tn-fl'), fr: t.style.getPropertyValue('--tn-fr') }; });
      check('标签行滚到最左：只有右边淡出', r.fl === '0px' && r.fr === '28px', r);
      const tc = await page.evaluate(() => T.center(A.shadow.querySelector('.tabs')));
      await page.mouse.move(tc.x, tc.y);
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(150);
      r = await page.evaluate(() => {
        const t = A.shadow.querySelector('.tabs'), all = [...t.querySelectorAll('.tab')], last = all[all.length - 1].getBoundingClientRect(), tr = t.getBoundingClientRect();
        return { sl: t.scrollLeft, max: t.scrollWidth - t.clientWidth, lastIn: last.right <= tr.right + 1, fl: t.style.getPropertyValue('--tn-fl'), fr: t.style.getPropertyValue('--tn-fr') };
      });
      check('标签行上竖向滚轮 = 横向滚动；滚到最右：最后一个标签整个露出来，只有左边淡出', r.sl >= r.max - 1 && r.max > 0 && r.lastIn && r.fl === '28px' && r.fr === '0px', r);
      r = await page.evaluate(async () => {
        const out = [];
        for (const b of [...A.shadow.querySelectorAll('.tab')]) {
          A.setView(b.dataset.goto); await T.frame();
          const t = A.shadow.querySelector('.tabs').getBoundingClientRect(), x = b.getBoundingClientRect();
          out.push([b.dataset.goto, x.left >= t.left - 0.5 && x.right <= t.right + 0.5]);
        }
        A.setView('kmap'); return out;
      });
      check('切到任何一个视图：它的标签整个露出来（全部标签都够得着）', r.length >= 6 && r.every(x => x[1]), r);
      // 「⋯」菜单
      await page.locator('#a .more-btn').click();
      r = await page.evaluate(() => {
        const ts = A.shadow.querySelector('.tset'), b = ts.getBoundingClientRect(), h = A.host.getBoundingClientRect();
        return { open: ts.classList.contains('open'), disp: getComputedStyle(ts).display, h: b.height, exp: A.shadow.querySelector('.more-btn').getAttribute('aria-expanded'),
          inHost: b.left >= h.left - 1 && b.right <= h.right + 1, ctls: ts.querySelectorAll('.ctl').length };
      });
      check('「⋯」：打开菜单，里面是封面 / 配色，菜单在格子里', r.open && r.disp === 'flex' && r.h > 40 && r.exp === 'true' && r.inHost && r.ctls === 2, r);
      await shot(page, '5-narrow-bar-menu-light', { x: 0, y: 0, width: 660, height: 360 });
      await page.locator('#a .tset [data-act="color"][data-v="0"]').click();
      r = await page.evaluate(() => ({ color: A.getPrefs().color, open: A.shadow.querySelector('.tset').classList.contains('open') }));
      check('「⋯」菜单里点「单色」：生效，菜单还开着', r.color === false && r.open, r);
      await page.mouse.click(5, 5);
      r = await page.evaluate(() => ({ open: A.shadow.querySelector('.tset').classList.contains('open'), disp: getComputedStyle(A.shadow.querySelector('.tset')).display }));
      check('点菜单外面：菜单收起', !r.open && r.disp === 'none', r);
      await page.locator('#a .more-btn').click();
      await page.keyboard.press('Escape');
      r = await page.evaluate(() => ({ open: A.shadow.querySelector('.tset').classList.contains('open') }));
      check('Esc：收起「⋯」菜单', !r.open, r);
      await page.evaluate(() => A.setPrefs({ color: true }));
      // 宿主字体更宽（例如宿主主题换了字体）：顶栏仍是一行
      await page.evaluate(() => { A.host.style.setProperty('--tn-f-body', '"Courier New", monospace'); A.host.style.setProperty('--tn-f-mono', '"Courier New", monospace'); });
      await page.waitForTimeout(200);
      r = await page.evaluate(barInfo);
      check('宿主换成更宽的字体：顶栏仍是一行，「全屏」在格子里', oneRow(r), r);
    }
    check(`窄格子顶栏页面（${theme}）没有报错`, errs.length === 0, errs.slice(0, 5));
    await ctx.close();
  }
}

// ================= 'page' 布局回归：当前引擎和对照引擎（git HEAD 里的版本）逐项比较 =================
function baselineEngine() {
  if (BASELINE) return fs.readFileSync(BASELINE, 'utf8');
  const repo = path.resolve(ROOT, '..');
  const out = cp.spawnSync('git', ['-C', repo, 'show', 'HEAD:tagnote/engine/tagnote.js'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (out.status !== 0) throw new Error('取不到对照引擎（git show 失败）：' + out.stderr);
  return out.stdout;
}
const SNAP = () => {
  window.__snap = (sr, k) => {
    const root = sr.querySelector('.root'), b = sr.querySelector(`[data-board="${k}"]`), s = b.closest('.board-wrap'), dr = sr.querySelector('.drawer');
    const rr = root.getBoundingClientRect();
    const R = el => { const q = el.getBoundingClientRect(); return [Math.round((q.left - rr.left) * 10) / 10, Math.round((q.top - rr.top) * 10) / 10, Math.round(q.width * 10) / 10, Math.round(q.height * 10) / 10]; };
    return { root: [Math.round(rr.width * 10) / 10, Math.round(rr.height * 10) / 10], board: R(b), wrap: [s.clientWidth, s.clientHeight, s.scrollWidth, s.scrollHeight], drawer: dr.hidden ? null : R(dr),
      works: [...b.querySelectorAll('[data-wid]')].map(e => [e.dataset.wid, ...R(e)]), paths: [...b.querySelectorAll('svg path')].map(p => p.getAttribute('d')).join('|').length };
  };
};
function firstDiff(a, b, p) {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], p + '.' + k); if (d) return d; } }
  return { at: p, old: JSON.stringify(a).slice(0, 160), new: JSON.stringify(b).slice(0, 160) };
}
async function pageRegression(browser) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tagnote-page-'));
  try {
    const oldEng = baselineEngine(), newEng = fs.readFileSync(ENGINE, 'utf8');
    // 1) 示例页（2018 百合，'page' 布局）：同一个页面，只换内联的引擎
    const html = fs.readFileSync(STANDALONE, 'utf8'), esc = s => s.replace(/<\/script/g, '<\\/script');
    if (!html.includes(esc(newEng))) throw new Error('examples/2018百合标签笔记.html 里的引擎不是当前 engine/tagnote.js，先 python build.py');
    fs.writeFileSync(path.join(tmp, 'new.html'), html);
    fs.writeFileSync(path.join(tmp, 'old.html'), html.split(esc(newEng)).join(esc(oldEng)));
    const snaps = {};
    for (const which of ['old', 'new']) {
      for (const [vw, vh] of [[1500, 1000], [700, 900]]) {
        const { page, errs, ctx } = await open(browser, pathToFileURL(path.join(tmp, which + '.html')).href, { width: vw, height: vh });
        await page.evaluate(SNAP);
        const out = {};
        for (const v of VIEWS) {
          await page.evaluate(v => { location.hash = v; }, v);
          await page.waitForFunction(v => { const sr = document.getElementById('app').shadowRoot, b = sr.querySelector(`[data-board="${v}"]`); return b && !b.closest('.view').hidden && b.querySelectorAll('[data-wid]').length > 0; }, v, { timeout: 10000 });
          await page.waitForTimeout(150);
          out[v] = await page.evaluate(v => __snap(document.getElementById('app').shadowRoot, v), v);
        }
        // 打开侧栏再量一次分支画布（侧栏吸顶、挤窄画布）
        await page.evaluate(() => { location.hash = 'canvas'; document.getElementById('app').shadowRoot.querySelector('.drawer-btn').click(); });
        await page.waitForTimeout(300);
        out.canvasDrawer = await page.evaluate(() => __snap(document.getElementById('app').shadowRoot, 'canvas'));
        snaps[which + vw] = out;
        if (which === 'new') check(`示例页（'page'，${vw}px 宽）跑一遍没有报错`, errs.length === 0, errs.slice(0, 5));
        await ctx.close();
      }
    }
    for (const vw of [1500, 700]) {
      const d = firstDiff(snaps['old' + vw], snaps['new' + vw], 'standalone' + vw);
      check(`'page' 布局回归（示例页，${vw}px）：各视图尺寸、作品位置、侧栏和对照引擎完全一致`, !d, d || { views: Object.keys(snaps['new' + vw]).length });
    }
    // 2) 两个 'page' 实例在可滚动容器里（像 Obsidian 面板）：尺寸一致；Esc 各自取消各自的固定
    const mhtml = fs.readFileSync(MULTI_HTML, 'utf8');
    fs.writeFileSync(path.join(tmp, 'eng-old.js'), oldEng); fs.writeFileSync(path.join(tmp, 'eng-new.js'), newEng);
    fs.copyFileSync(path.join(ROOT, 'data', 'works_2018_yuri.json'), path.join(tmp, 'data.json'));
    const res = {};
    for (const which of ['old', 'new']) {
      fs.writeFileSync(path.join(tmp, `multi-${which}.html`), mhtml.replace('../engine/tagnote.js', `eng-${which}.js`));
      const { page, errs, ctx } = await open(browser, pathToFileURL(path.join(tmp, `multi-${which}.html`)).href, { width: 1400, height: 1400 });
      const data = JSON.parse(fs.readFileSync(path.join(tmp, 'data.json'), 'utf8'));
      await page.evaluate(SNAP);
      res[which] = await page.evaluate(async data => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const a = TagNote.mount(document.getElementById('a'), data, { prefs: { drawer: true }, notes: true });
        const b = TagNote.mount(document.getElementById('b'), data, { toolbar: false, heads: false });
        await wait(300);
        const out = {};
        for (const v of ['canvas', 'score', 'kmap', 'hasse', 'terr', 'line']) {
          a.setView(v); b.setView(v);
          for (let i = 0; i < 100 && (a.shadow.querySelectorAll(`[data-board="${v}"] [data-wid]`).length === 0 || b.shadow.querySelectorAll(`[data-board="${v}"] [data-wid]`).length === 0); i++) await wait(50);
          out[v] = { a: __snap(a.shadow, v), b: __snap(b.shadow, v) };
        }
        a.setView('hasse'); b.setView('hasse');
        const click = (i) => { const el = i.shadow.querySelector('[data-board="hasse"] [data-wid]'); el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); };
        click(a); click(b);
        const pinned = [!!a.pinned, !!b.pinned];
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        out.esc = { pinned, after: [!!a.pinned, !!b.pinned] };
        a.destroy(); b.destroy();
        return out;
      }, data);
      if (which === 'new') check("两个 'page' 实例（可滚动容器里）没有报错", errs.length === 0, errs.slice(0, 5));
      await ctx.close();
    }
    const d = firstDiff(res.old, res.new, 'multi');
    check("'page' 布局回归（两个实例在可滚动容器里，含 Esc）：和对照引擎完全一致", !d, d || res.new.esc);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

(async () => {
  let browser, barBrowser, launchFail = false;
  try { browser = await chromium.launch(); }
  catch (e) { console.error('启动 Playwright 无头浏览器失败：' + e.message); process.exit(2); }
  try {
    for (const [name, fn] of [['pane', paneTests], ['pan', panTests], ['bar', barTests], ['dark', darkAndEngineFull], ['host', hostFsTests], ['narrow', narrowTests], ['page', pageRegression]]) {
      if (ONLY.length && !ONLY.includes(name)) continue;
      let b = browser;
      if (name === 'bar') {
        try { b = barBrowser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] }); }
        catch (e) { console.error('启动显示滚动条的无头浏览器失败：' + e.message); launchFail = true; break; }
      }
      try { await fn(b); } catch (e) { check(`[${name}] 脚本执行`, false, e.stack.split('\n').slice(0, 4).join(' | ')); }
    }
  } finally { await browser.close(); if (barBrowser) await barBrowser.close(); }
  if (launchFail) process.exit(2);
  const bad = results.filter(r => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} 通过` + (bad.length ? '；失败：\n  ' + bad.map(r => r.name).join('\n  ') : ''));
  process.exitCode = bad.length ? 1 : 0;
})();
