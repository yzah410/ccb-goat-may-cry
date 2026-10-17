// TagNote 程序聚焦（focusWorks / clearFocus / drawnWorkIds）和 onViewportChange 的 info.by 自动化检查（Playwright 无头 Chromium）。
//
// 用法（先 python build.py，生成 engine/tagnote.js 和 examples/pane.html）：
//   node test/focus.js --pw <装了 playwright 的目录> [--only views,reveal,flash,queue,user,hold,takeover,by,motion,page]
//   也可以用环境变量 PLAYWRIGHT_DIR / TN_ONLY。
// 只开 Playwright 自己的无头浏览器；启动失败直接退出（退出码 2），不重试；结束时 finally 里关浏览器。
// 退出码：0 全部通过；1 有失败项。
'use strict';
const path = require('path'), fs = require('fs');
const { pathToFileURL } = require('url');

const arg = (name, env) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : process.env[env]; };
const PW = arg('pw', 'PLAYWRIGHT_DIR');
const ONLY = (arg('only', 'TN_ONLY') || '').split(',').filter(Boolean);
let chromium;
try { ({ chromium } = PW ? require(require.resolve('playwright', { paths: [PW] })) : require('playwright')); }
catch (e) { console.error('找不到 playwright：用 --pw <目录> 或环境变量 PLAYWRIGHT_DIR 指向装了 playwright 的目录。' + e.message); process.exit(2); }

const ROOT = path.resolve(__dirname, '..');
const PANE_HTML = path.join(ROOT, 'examples', 'pane.html');
const MULTI_HTML = path.join(__dirname, 'multi.html');
const DATA = path.join(ROOT, 'data', 'works_2018_yuri.json');
const VIEWS = ['canvas', 'score', 'kmap', 'hasse', 'terr', 'line'];

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  const d = detail === undefined ? '' : '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail));
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : d));
}
const IGNORE = /Failed to load resource|ERR_FAILED|ERR_BLOCKED|ERR_INTERNET|net::/;

async function open(browser, url, viewport, opts) {
  const ctx = await browser.newContext(Object.assign({ viewport: viewport || { width: 1800, height: 900 } }, opts || {}));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !IGNORE.test(m.text())) errs.push(m.type() + ': ' + m.text()); });
  await page.route(/^https?:\/\//, r => r.abort());
  await page.goto(url);
  return { page, errs, ctx };
}

// ---------- 页面里用的小工具（window.F） ----------
const HELPERS = () => {
  const F = window.F = {};
  F.board = (i, k) => i.shadow.querySelector(`[data-board="${k || i.view}"]`);
  F.wrap = (i, k) => F.board(i, k).closest('.board-wrap');
  // 作品的「框」：增减阶梯是节点，标签谱是标题格，其余是作品元素本身（和引擎一致）
  F.frame = el => el.closest('.hnode') || (el.classList.contains('srow') && el.querySelector('.ttl')) || el;
  F.el = (i, id, k) => F.board(i, k).querySelector(`[data-wid="${CSS.escape(id)}"]`);
  F.vis = i => { const s = F.wrap(i), r = s.getBoundingClientRect(), l = r.left + s.clientLeft, t = r.top + s.clientTop; return { l, t, r: l + s.clientWidth, b: t + s.clientHeight }; };
  // 作品框超出「可见矩形缩进 pad」多少像素（≤ 0 = 完整在里面）
  F.out = (i, ids, pad, axis) => {
    const V = F.vis(i); let m = -Infinity;
    for (const id of ids) {
      const q = F.frame(F.el(i, id)).getBoundingClientRect();
      m = Math.max(m, V.l + pad - q.left, q.right - (V.r - pad));
      if (axis !== 'x') m = Math.max(m, V.t + pad - q.top, q.bottom - (V.b - pad));
    }
    return m;
  };
  // 外接矩形（未缩放的画板像素）
  F.box = (i, ids) => {
    const br = F.board(i).getBoundingClientRect(), z = i.getViewport().zoom; let R = null;
    for (const id of ids) { const q = F.frame(F.el(i, id)).getBoundingClientRect(); R = R ? { l: Math.min(R.l, q.left), t: Math.min(R.t, q.top), r: Math.max(R.r, q.right), b: Math.max(R.b, q.bottom) } : { l: q.left, t: q.top, r: q.right, b: q.bottom }; }
    return { w: (R.r - R.l) / z, h: (R.b - R.t) / z, x: (R.l - br.left) / z, y: (R.t - br.top) / z };
  };
  // 高亮的样子：哪些元素带 hl / focus / sec / fl、几个差别徽章、画板是不是 hovering
  F.sig = i => {
    const b = F.board(i);
    return [...b.querySelectorAll('.hl, .focus, .sec, .fl')].map(e => (e.dataset.wid || e.dataset.wids || e.dataset.k || (e.getAttribute('class') || '').split(' ')[0]) + ':' + ['hl', 'focus', 'sec', 'fl'].filter(c => e.classList.contains(c)).join('+')).sort().join('|')
      + '#diff' + b.querySelectorAll('.diff.show').length + '#hov' + b.classList.contains('hovering');
  };
  F.wait = ms => new Promise(r => setTimeout(r, ms));
  F.frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  F.ids = i => [...new Set([...F.board(i).querySelectorAll('[data-wid]')].map(e => e.dataset.wid))];
  // 离可见区中心最远的作品
  F.farthest = i => {
    const V = F.vis(i), cx = (V.l + V.r) / 2, cy = (V.t + V.b) / 2; let best = null, bd = -1;
    for (const id of F.ids(i)) { const q = F.frame(F.el(i, id)).getBoundingClientRect(); if (!q.width) continue; const d = Math.hypot(q.left + q.width / 2 - cx, q.top + q.height / 2 - cy); if (d > bd) { bd = d; best = id; } }
    return best;
  };
  F.visible = (i, pad) => F.ids(i).filter(id => F.out(i, [id], pad) <= -1);
  F.drawn = async (i, v) => { for (let n = 0; n < 200 && !(i.view === v && i.drawnWorkIds() && i.drawnWorkIds().length); n++) await F.wait(50); await F.frames(); };
  F.home = async i => { i.setViewport({ home: true }); await F.wait(320); window.vlog.length = 0; };
  F.vp = i => i.getViewport();
  F.dist = (a, b) => Math.max(Math.abs(a.cx - b.cx), Math.abs(a.cy - b.cy)) + Math.abs(a.zoom - b.zoom) * 1000;
  // 用户把鼠标移到 el 上：先在旁边动一下（focusWorks 之后引擎只把离原位置 ≥ 2px 的移动当成用户动了鼠标），再进入 el
  F.over = el => {
    const q = el.getBoundingClientRect(), x = q.left + Math.min(10, q.width / 2), y = q.top + Math.min(10, q.height / 2);
    el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, composed: true, clientX: x + 7, clientY: y + 7 }));
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, composed: true, clientX: x, clientY: y }));
  };
  F.leave = i => i.host.dispatchEvent(new PointerEvent('pointerleave'));
};
// 重新挂载 A、B：onViewportChange 记下 info.by；onFocusTakeover 记到 window.tlog
const REMOUNT = () => {
  window.vlog = []; window.tlog = [];
  for (const [id, view] of [['a', 'canvas'], ['b', 'hasse']]) {
    const key = id.toUpperCase();
    if (window[key]) window[key].destroy();
    window[key] = mountPane(id, { view, onViewportChange: (v, vp, info) => window.vlog.push({ id, v, vp, by: info && info.by }),
      onFocusTakeover: reason => window.tlog.push(id + ':' + reason + ':' + (window[key].pinned ? 'pinned' : '-')) });
  }
};
async function readyPane(page) {
  await page.evaluate(REMOUNT);
  await page.waitForFunction(() => window.A && window.B && A.getViewport() && B.getViewport(), null, { timeout: 15000 });
  await page.evaluate(HELPERS);
  await page.mouse.move(3, 3);                       // 鼠标放在页头，不悬停任何实例
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.vlog.length = 0; });
}
const paneURL = () => pathToFileURL(PANE_HTML).href + '?a=canvas&b=hasse&theme=light';

// ================= 6 种视图：reveal 后完整可见、高亮和悬停一致 =================
async function viewTests(browser) {
  const { page, errs, ctx } = await open(browser, paneURL());
  await readyPane(page);
  for (const v of VIEWS) {
    const r = await page.evaluate(async v => {
      A.clearFocus(); A.setView(v); await F.drawn(A, v); await F.home(A);
      const id = F.farthest(A), before = F.out(A, [id], 24), z0 = F.vp(A).zoom;
      const res = A.focusWorks([id], { mode: 'stay' });
      const mid = F.vp(A);
      await F.wait(600);
      const after = F.vp(A), el = F.el(A, id);
      return { id, before, res, out: F.out(A, [id], 24), focus: el.classList.contains('focus'), hov: F.board(A).classList.contains('hovering'),
        home: !!after.home, by: vlog.filter(x => x.id === 'a').map(x => x.by), midEq: F.dist(mid, after) < 1, z0, z: after.zoom,
        drawn: A.drawnWorkIds().includes(id), fits: F.box(A, [id]).w * z0 <= F.vis(A).r - F.vis(A).l - 48 };
    }, v);
    check(`${v}：focusWorks 后作品框完整在图区可见矩形里（留 24px），带 focus 标记、其余变淡；found = [id]`, r.res.found.length === 1 && r.res.found[0] === r.id && !r.res.queued && r.out <= 1 && r.focus && r.hov && r.drawn, r);
    if (r.before > 0) {
      check(`${v}：要移动时去掉 home、停下后只回调一次 by:'focus'、缓动中 getViewport 返回终点`, !r.home && r.by.length === 1 && r.by[0] === 'focus' && r.midEq, r);
      if (r.fits) check(`${v}：当前缩放装得下的单个作品只平移、不缩放`, Math.abs(r.z - r.z0) < 1e-6, r);
    }
    // 和悬停同一个作品的效果一模一样；悬停别的作品临时盖住，移开回到程序聚焦
    const h = await page.evaluate(async id => {
      A.clearFocus(); await F.frames();
      const el = F.el(A, id);
      F.over(el); const hov = F.sig(A);
      F.leave(A); const cleared = F.sig(A);
      A.focusWorks([id], { mode: 'stay', reveal: false }); const pf = F.sig(A);
      const other = F.visible(A, 0).find(x => x !== id);
      let ov = null, back = null;
      if (other) {
        F.over(F.el(A, other)); ov = F.el(A, other).classList.contains('focus') && !el.classList.contains('focus');
        F.leave(A); back = F.sig(A) === pf;
      }
      A.clearFocus(); await F.frames();
      return { same: hov === pf, hovOn: hov.endsWith('#hovtrue'), hov: hov.slice(0, 300), pf: pf.slice(0, 300), cleared, other, ov, back, after: F.sig(A) };
    }, r.id);
    check(`${v}：程序聚焦的框、近邻、变淡、差别徽章和鼠标悬停这个作品完全一样`, h.same && h.hovOn, h);
    if (h.other) check(`${v}：悬停别的作品临时盖住程序聚焦，移开后回到程序聚焦；clearFocus 后全清`, h.ov && h.back && /#diff0#hovfalse$/.test(h.after) && h.after.startsWith('#'), h);
  }
  check('views：没有报错', errs.length === 0, errs.slice(0, 5));
  await ctx.close();
}

// ================= reveal 的几种情况 =================
async function revealTests(browser) {
  const { page, errs, ctx } = await open(browser, paneURL());
  await readyPane(page);
  await page.evaluate(async () => { A.setView('canvas'); await F.drawn(A, 'canvas'); });
  // 1) 本来就完整可见：不动，home 保留，不回调
  let r = await page.evaluate(async () => {
    await F.home(A);
    const id = F.visible(A, 40)[0], s = F.wrap(A), sl = s.scrollLeft, st = s.scrollTop;
    const res = A.focusWorks([id], { mode: 'stay' });
    await F.wait(600);
    return { id, res, moved: Math.abs(s.scrollLeft - sl) + Math.abs(s.scrollTop - st), home: !!F.vp(A).home, cb: vlog.length, focus: F.el(A, id).classList.contains('focus'), badge: A.shadow.querySelector('.view:not([hidden]) .zoom-badge').hidden };
  });
  check('reveal：作品本来就完整可见 → 视区不动、home 保留、不回调 onViewportChange', r.id && r.moved === 0 && r.home && r.cb === 0 && r.focus && r.badge, r);
  // 2) 要平移：缩放不变，最小平移（作品贴着可见矩形的边缘停下，不居中）
  r = await page.evaluate(async () => {
    A.clearFocus(); await F.home(A);
    const id = F.farthest(A); const before = F.out(A, [id], 24);
    A.focusWorks([id], { mode: 'stay' }); await F.wait(600);
    const V = F.vis(A), q = F.frame(F.el(A, id)).getBoundingClientRect();
    const gaps = [q.left - V.l, V.r - q.right, q.top - V.t, V.b - q.bottom];
    return { id, before, out: F.out(A, [id], 24), zoom: F.vp(A).zoom, home: !!F.vp(A).home, gaps, by: vlog.map(x => x.by) };
  });
  check('reveal：要平移时缩放不变、作品完整可见、去掉 home、by:focus', r.before > 0 && r.out <= 1 && r.zoom === 1 && !r.home && r.by.join() === 'focus', r);
  check('reveal：最小平移——至少一边正好停在 24px 边距上（不刻意居中）', r.gaps.some(g => Math.abs(g - 24) <= 1.5), r.gaps);
  // 3) 要缩小：两部离得远的作品，外接矩形在 100% 装不下、0.25 装得下 → 缩小到刚好装下
  r = await page.evaluate(async () => {
    A.clearFocus(); await F.home(A);
    const V = F.vis(A), aw = V.r - V.l - 48, ah = V.b - V.t - 48, ids = F.ids(A);
    let pick = null;
    for (let i = 0; i < ids.length && !pick; i++) for (let j = i + 1; j < ids.length; j++) {
      const b = F.box(A, [ids[i], ids[j]]);
      if ((b.w > aw || b.h > ah) && b.w * 0.5 <= aw && b.h * 0.5 <= ah && Math.min(aw / b.w, ah / b.h) < 0.85) { pick = [ids[i], ids[j]]; break; }
    }
    if (!pick) return { pick };
    const b = F.box(A, pick), want = Math.min(aw / b.w, ah / b.h);
    A.focusWorks(pick, { mode: 'stay' }); await F.wait(600);
    return { pick, want, zoom: F.vp(A).zoom, out: F.out(A, pick, 24), by: vlog.map(x => x.by), focus: pick.every(id => F.el(A, id).classList.contains('focus')) };
  });
  check('reveal：几部的外接矩形装不下 → 缩小到刚好装下（≥ 0.25）、都完整可见、都高亮', r.pick && r.zoom < 1 && r.zoom >= 0.25 && Math.abs(r.zoom - r.want) < 0.01 && r.out <= 1.5 && r.focus && r.by.join() === 'focus', r);
  // 4) 绝不放大：先缩到 0.5，再聚焦一部看不见的作品 → 还是 0.5
  r = await page.evaluate(async () => {
    A.clearFocus(); await F.home(A);
    A.setViewport({ zoom: 0.5, cx: 0, cy: 0 }); await F.wait(320); vlog.length = 0;
    const id = F.farthest(A), before = F.out(A, [id], 24);
    A.focusWorks([id], { mode: 'stay' }); await F.wait(600);
    return { before, zoom: F.vp(A).zoom, out: F.out(A, [id], 24) };
  });
  check('reveal：绝不放大（0.5 下聚焦，缩放还是 0.5，作品完整可见）', r.before > 0 && r.zoom === 0.5 && r.out <= 1, r);
  // 5) 0.25 下也装不下 → 只保证 ids[0]：把格子压矮
  r = await page.evaluate(async () => {
    A.clearFocus();
    document.getElementById('cellA').style.height = '260px'; await F.wait(500); await F.home(A);
    const V = F.vis(A), aw = V.r - V.l - 48, ah = V.b - V.t - 48, ids = F.ids(A);
    let pick = null;
    for (let i = 0; i < ids.length && !pick; i++) for (let j = ids.length - 1; j > i; j--) {
      const b = F.box(A, [ids[i], ids[j]]);
      if ((b.w * 0.25 > aw || b.h * 0.25 > ah) && F.out(A, [ids[i]], 24) > 0) { pick = [ids[i], ids[j]]; break; }
    }
    if (!pick) { document.getElementById('cellA').style.height = ''; return { pick }; }
    A.focusWorks(pick, { mode: 'stay' }); await F.wait(600);
    const out = { pick, first: F.out(A, [pick[0]], 24), zoom: F.vp(A).zoom, fit0: F.box(A, [pick[0]]).h <= ah };
    A.clearFocus(); document.getElementById('cellA').style.height = ''; await F.wait(500);
    return out;
  });
  check('reveal：0.25 下也装不下所有作品 → 只保证第一部完整可见（缩放不低于 0.25、不放大）', r.pick && r.first <= 1 && r.zoom >= 0.25 && r.zoom <= 1, r);
  // 6) secondary：虚线框、不变淡、不参与 reveal、和主作品重复的忽略、跟主高亮同生同灭
  r = await page.evaluate(async () => {
    A.clearFocus(); await F.home(A);
    const main = F.visible(A, 40)[0], far = F.farthest(A), s = F.wrap(A), sl = s.scrollLeft, st = s.scrollTop;
    const res = A.focusWorks([main], { mode: 'stay', secondary: [far, main, '不存在的作品'] });
    await F.wait(600);
    const fe = F.el(A, far), cs = getComputedStyle(fe);
    const out = { res, moved: Math.abs(s.scrollLeft - sl) + Math.abs(s.scrollTop - st), sec: fe.classList.contains('sec'), secFocus: fe.classList.contains('focus'), mainSec: F.el(A, main).classList.contains('sec'),
      outline: cs.outlineStyle, op: cs.opacity, mainFocus: F.el(A, main).classList.contains('focus') };
    A.clearFocus(); out.after = F.board(A).querySelectorAll('.sec, .focus, .hl').length;
    return out;
  });
  check('secondary：虚线框、不变淡、不当主作品；secondaryFound 去掉重复和不存在的；不参与 reveal；clearFocus 一起清', r.res.found.length === 1 && r.res.secondaryFound.length === 1 && r.sec && !r.secFocus && !r.mainSec && r.outline === 'dashed' && r.op === '1' && r.mainFocus && r.moved === 0 && r.after === 0, r);
  // 7) 重画、切视图后仍保持
  r = await page.evaluate(async () => {
    await F.home(A);
    const id = F.visible(A, 40)[0];
    A.focusWorks([id], { mode: 'stay', reveal: false });
    A.rerender(); await F.frames();
    const afterRedraw = F.el(A, id).classList.contains('focus') && F.board(A).classList.contains('hovering');
    A.setView('line'); await F.drawn(A, 'line');
    const inLine = !!F.el(A, id) && F.el(A, id).classList.contains('focus');
    const oldClean = F.board(A, 'canvas').querySelectorAll('.focus').length === 0;
    A.setView('canvas'); await F.frames();
    const back = F.el(A, id).classList.contains('focus');
    A.clearFocus();
    return { afterRedraw, inLine, oldClean, back };
  });
  check('stay：重画后仍高亮；切到别的视图在那里继续高亮、旧视图清掉；切回来仍高亮', r.afterRedraw && r.inLine && r.oldClean && r.back, r);
  // 8) drawnWorkIds / 空 ids = clearFocus / 不存在的 id
  r = await page.evaluate(async () => {
    const ids = A.drawnWorkIds();
    A.focusWorks([ids[0]], { mode: 'stay', reveal: false });
    const empty = A.focusWorks([], { mode: 'stay' });
    const cleared = F.board(A).querySelectorAll('.focus').length === 0 && !F.board(A).classList.contains('hovering');
    const none = A.focusWorks(['不存在的作品'], { mode: 'stay' });
    const noDim = !F.board(A).classList.contains('hovering');
    A.clearFocus();
    return { n: ids.length, uniq: new Set(ids).size === ids.length, all: F.ids(A).length === ids.length, empty, cleared, none, noDim };
  });
  check('drawnWorkIds = 当前视图画出来的作品（不重复）；focusWorks([]) = clearFocus；不存在的 id 不高亮也不让整张图变淡', r.n > 0 && r.uniq && r.all && r.empty.found.length === 0 && !r.empty.queued && r.cleared && r.none.found.length === 0 && r.noDim, r);
  check('reveal：没有报错', errs.length === 0, errs.slice(0, 5));
  await ctx.close();
}

// ================= flash =================
async function flashTests(browser) {
  const { page, errs, ctx } = await open(browser, paneURL());
  await readyPane(page);
  const r = await page.evaluate(async () => {
    A.setView('canvas'); await F.drawn(A, 'canvas'); await F.home(A);
    const id = F.farthest(A);
    A.focusWorks([id], { mode: 'flash' });
    await F.wait(450);
    const fe = F.frame(F.el(A, id)), cs = getComputedStyle(fe);
    const mid = { fl: fe.classList.contains('fl'), name: cs.animationName, n: cs.animationIterationCount, dur: cs.animationDuration, focus: F.el(A, id).classList.contains('focus'), out: F.out(A, [id], 24) };
    const vp1 = F.vp(A);
    await F.wait(1700);
    const vp2 = F.vp(A);
    return { mid, gone: F.board(A).querySelectorAll('.focus, .hl, .fl').length === 0 && !F.board(A).classList.contains('hovering'), still: F.dist(vp1, vp2) < 0.5, home: !!vp2.home, by: vlog.map(x => x.by) };
  });
  check('flash：先 reveal（完整可见），框闪 3 下（0.5s × 3）', r.mid.fl && r.mid.name === 'tn-flash' && r.mid.n === '3' && r.mid.dur === '0.5s' && r.mid.focus && r.mid.out <= 1, r.mid);
  check('flash：约 1.5 秒后高亮自动消失，视区停在原地不回弹', r.gone && r.still && !r.home && r.by.join() === 'focus', r);
  check('flash：没有报错', errs.length === 0, errs.slice(0, 5));
  await ctx.close();
}

// ================= 隐藏实例排队 =================
async function queueTests(browser) {
  const { page, errs, ctx } = await open(browser, paneURL());
  await readyPane(page);
  // 1) 画过、被藏起来（display:none）的实例
  let r = await page.evaluate(async () => {
    await F.drawn(B, 'hasse'); await F.home(B);
    const id = F.farthest(B), before = F.out(B, [id], 24);
    const cell = document.getElementById('cellB'); cell.style.display = 'none'; await F.frames();
    const res = B.focusWorks([id], { mode: 'stay' });
    await F.wait(400);
    const hiddenVp = F.vp(B);
    cell.style.display = ''; await F.wait(700);
    return { id, before, res, hiddenHome: !!hiddenVp.home, out: F.out(B, [id], 24), focus: F.el(B, id).classList.contains('focus'), by: vlog.filter(x => x.id === 'b').map(x => x.by) };
  });
  check('排队：隐藏的实例 focusWorks → queued、found 按数据；藏着时不动视区；显示后 reveal + 高亮', r.res.queued && r.res.found[0] === r.id && r.hiddenHome && r.before > 0 && r.out <= 1 && r.focus && r.by.includes('focus'), r);
  // 2) setViewport 和 focusWorks 都排着：先 setViewport 后 focus
  r = await page.evaluate(async () => {
    B.clearFocus(); await F.home(B);
    const cell = document.getElementById('cellB'); cell.style.display = 'none'; await F.frames();
    B.setViewport({ zoom: 0.5, cx: 0, cy: 0 });
    const ids = F.ids(B), id = ids[ids.length - 1];
    const res = B.focusWorks([id], { mode: 'stay' });
    cell.style.display = ''; await F.wait(800);
    const out = { res, zoom: F.vp(B).zoom, out: F.out(B, [id], 24), focus: F.el(B, id).classList.contains('focus') };
    B.clearFocus();
    return out;
  });
  check('排队：setViewport 和 focusWorks 都排着 → 先应用视区（0.5）再 reveal（作品可见、不放大）', r.res.queued && r.zoom === 0.5 && r.out <= 1 && r.focus, r);
  // 3) 从没画过的实例（挂在隐藏的宿主里）
  r = await page.evaluate(async () => {
    const cell = document.getElementById('cellB'); cell.style.display = 'none';
    B.destroy(); window.B = mountPane('b', { view: 'canvas', onViewportChange: (v, vp, info) => vlog.push({ id: 'b', v, vp, by: info && info.by }) });
    const drawn0 = B.drawnWorkIds();
    const data = JSON.parse(document.getElementById('data').textContent);
    const wid = String(data.works[data.works.length - 1].id);
    const res = B.focusWorks([wid], { mode: 'stay', secondary: [String(data.works[0].id)] });
    cell.style.display = ''; await F.drawn(B, 'canvas'); await F.wait(700);
    const out = { drawn0, res, out: F.out(B, [wid], 24), focus: F.el(B, wid).classList.contains('focus'), sec: F.el(B, String(data.works[0].id)).classList.contains('sec') };
    B.clearFocus();
    return out;
  });
  check('排队：从没画过的实例 drawnWorkIds = null；focusWorks 排队，显示画完后 reveal + 高亮（含 secondary）', r.drawn0 === null && r.res.queued && r.res.found.length === 1 && r.res.secondaryFound.length === 1 && r.out <= 1 && r.focus && r.sec, r);
  check('排队：没有报错', errs.length === 0, errs.slice(0, 5));
  await ctx.close();
}

// ================= 用户接管：点击固定、Esc、缓动中用户动视区 =================
async function userTests(browser) {
  const { page, errs, ctx } = await open(browser, paneURL());
  await readyPane(page);
  await page.evaluate(async () => { A.setView('canvas'); await F.drawn(A, 'canvas'); await F.home(A); });
  // 1) 点击固定别的作品 = 接管
  const p = await page.evaluate(() => {
    const vis = F.visible(A, 40), x = vis[0], y = vis.find(id => id !== x && F.el(A, id).getBoundingClientRect().width > 40);
    A.focusWorks([x], { mode: 'stay', reveal: false });
    const q = F.el(A, y).getBoundingClientRect();
    return { x, y, cx: q.left + 20, cy: q.top + q.height / 2 };
  });
  await page.mouse.move(p.cx, p.cy); await page.mouse.click(p.cx, p.cy);
  let r = await page.evaluate(({ x, y }) => ({ pinned: A.pinned && A.pinned.key, xFocus: F.el(A, x).classList.contains('focus'), yFocus: F.el(A, y).classList.contains('focus') }), p);
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  const r2 = await page.evaluate(() => ({ pinned: !!A.pinned, hov: F.board(A).classList.contains('hovering') }));
  check('用户点击固定别的作品 = 接管：程序聚焦清掉；Esc 取消固定后不回到程序聚焦', r.pinned === 'w:' + p.y && !r.xFocus && r.yFocus && !r2.pinned && !r2.hov, { r, r2 });
  // 2) focusWorks 取消用户已固定的高亮（最后一次操作说了算）
  r = await page.evaluate(({ x, y }) => {
    F.el(A, y).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    const pinned = !!A.pinned;
    A.focusWorks([x], { mode: 'stay', reveal: false });
    return { pinned, after: !!A.pinned, xFocus: F.el(A, x).classList.contains('focus'), yFocus: F.el(A, y).classList.contains('focus') };
  }, p);
  check('focusWorks 取消用户已固定的高亮，显示程序聚焦', r.pinned && !r.after && r.xFocus && !r.yFocus, r);
  // 3) Esc 只清当前实例（鼠标所在）的程序聚焦
  await page.evaluate(async () => { await F.drawn(B, 'hasse'); B.focusWorks([F.visible(B, 0)[0]], { mode: 'stay', reveal: false }); });
  const tab = await page.evaluate(() => { const q = A.shadow.querySelector('.tabs').getBoundingClientRect(); return { x: q.left + 8, y: q.top + q.height / 2 }; });
  await page.mouse.move(tab.x, tab.y);
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  r = await page.evaluate(() => ({ a: F.board(A).classList.contains('hovering'), aF: F.board(A).querySelectorAll('.focus').length, b: F.board(B).classList.contains('hovering'), bF: F.board(B).querySelectorAll('.focus').length }));
  check('Esc 清掉程序聚焦，只作用于当前实例（鼠标所在的 A；B 不变）', !r.a && r.aF === 0 && r.b && r.bF > 0, r);
  await page.evaluate(() => B.clearFocus());
  await page.mouse.move(3, 3);
  // 4) 缓动中用户动视区：立刻停，以用户为准（滚轮 / 键盘等滚动 / 空格拖动）
  const kinds = ['wheel', 'scroll', 'drag'];
  for (const kind of kinds) {
    r = await page.evaluate(async kind => {
      A.clearFocus(); await F.home(A);
      const id = F.farthest(A);
      A.focusWorks([id], { mode: 'stay' });
      const target = F.vp(A);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));   // 缓动走了一两帧
      // 宿主在用户滚动后、滚动事件到达前就调 getViewport（vp1）：也要当场停下缓动、返回当前位置，回调仍记成 'user'
      const s = F.wrap(A), dbg = [], c0 = { l: s.scrollLeft, t: s.scrollTop };
      if (kind === 'wheel') s.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true, composed: true }));
      else if (kind === 'scroll') s.scrollTop += 60;
      else {
        F.over(s);                                    // 鼠标在图区上（空格才由这个实例接管）
        document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }));
        const c = s.getBoundingClientRect(), x = c.left + 200, y = c.top + 200;
        s.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, composed: true, cancelable: true }));
        s.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, buttons: 1, clientX: x + 90, clientY: y + 70, bubbles: true, composed: true }));
        dbg.push(s.scrollLeft !== c0.l || s.scrollTop !== c0.t);   // 拖动真的挪了滚动位置
        s.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, button: 0, buttons: 0, clientX: x + 90, clientY: y + 70, bubbles: true, composed: true }));
        document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true, cancelable: true }));
      }
      const p1 = { l: s.scrollLeft, t: s.scrollTop }, vp1 = F.vp(A);
      await F.wait(600);
      const p2 = { l: s.scrollLeft, t: s.scrollTop };
      return { kind, stayed: Math.abs(p2.l - p1.l) + Math.abs(p2.t - p1.t), offTarget: F.dist(F.vp(A), target), vpNow: F.dist(vp1, F.vp(A)) < 0.5, by: vlog.map(x => x.by), focus: F.el(A, id).classList.contains('focus'), dbg };
    }, kind);
    const byOk = kind === 'wheel' ? r.by.length === 1 : r.by.join() === 'user';
    check(`缓动中用户${{ wheel: '滚轮', scroll: '键盘等滚动', drag: '空格拖动' }[kind]}：缓动立刻停下、停在用户的位置（不再被拉向终点），getViewport 不再返回终点；回调 ${kind === 'wheel' ? '一次' : "by:'user'"}`, r.stayed === 0 && r.offTarget > 5 && r.vpNow && byOk && r.focus && (kind !== 'drag' || r.dbg[0] === true), r);
  }
  check('user：没有报错', errs.length === 0, errs.slice(0, 5));
  await ctx.close();
}

// ================= 鼠标静止时浏览器补发的悬停不盖住程序聚焦 =================
async function holdTests(browser) {
  const { page, errs, ctx } = await open(browser, paneURL());
  await readyPane(page);
  // 在增减阶梯里挑两部看得见的作品：Z 将来在光标下面，Y 是要聚焦的
  const p = await page.evaluate(async () => {
    A.setView('hasse'); await F.drawn(A, 'hasse'); await F.home(A);
    const vis = F.visible(A, 30).filter(id => { const q = F.frame(F.el(A, id)).getBoundingClientRect(); return q.width > 60 && q.height > 30; });
    const z = vis[0], y = vis.find(id => id !== z);
    const q = F.frame(F.el(A, z)).getBoundingClientRect();
    A.setView('canvas'); await F.drawn(A, 'canvas');
    return { z, y, x: Math.round(q.left + 20), yy: Math.round(q.top + q.height / 2) };
  });
  // 鼠标停在那个位置（画布视图下），然后不动鼠标：切到增减阶梯（光标下面换成了 Z），再 focusWorks(Y)
  await page.mouse.move(p.x, p.yy); await page.waitForTimeout(100);
  const r1 = await page.evaluate(async ({ z, y, x, yy }) => {
    A.setView('hasse'); await F.drawn(A, 'hasse');
    A.focusWorks([y], { mode: 'stay', reveal: false });
    await F.wait(300);                               // 留时间给浏览器自己补发的悬停事件
    // 再模拟一次浏览器补发：同一个坐标上的 pointerover / pointermove
    const under = A.shadow.elementFromPoint(x, yy);
    for (const type of ['pointerover', 'pointermove']) under.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, clientX: x, clientY: yy }));
    await F.frames();
    return { underZ: !!(under.closest && under.closest(`[data-wid="${CSS.escape(z)}"]`)), yF: F.el(A, y).classList.contains('focus'), zF: F.el(A, z).classList.contains('focus'), hov: F.board(A).classList.contains('hovering') };
  }, p);
  check('悬停：鼠标静止停在作品卡上，切视图后 focusWorks → 程序聚焦看得见，浏览器补发的悬停不盖住它', r1.underZ && r1.yF && !r1.zF && r1.hov, r1);
  // 动 1px 不算；动 ≥ 2px → 正常悬停，盖住程序聚焦；移出作品卡回到程序聚焦
  await page.mouse.move(p.x + 1, p.yy); await page.waitForTimeout(80);
  const r2a = await page.evaluate(({ z, y }) => ({ yF: F.el(A, y).classList.contains('focus'), zF: F.el(A, z).classList.contains('focus') }), p);
  await page.mouse.move(p.x + 3, p.yy + 2); await page.waitForTimeout(80);
  const r2b = await page.evaluate(({ z, y }) => ({ yF: F.el(A, y).classList.contains('focus'), zF: F.el(A, z).classList.contains('focus') }), p);
  await page.mouse.move(3, 3); await page.waitForTimeout(80);
  const r2c = await page.evaluate(({ y }) => ({ yF: F.el(A, y).classList.contains('focus'), hov: F.board(A).classList.contains('hovering') }), p);
  check('悬停：鼠标动了不到 2px 不算；动 ≥ 2px 后悬停照常盖住程序聚焦，移开后回到程序聚焦', r2a.yF && !r2a.zF && r2b.zF && !r2b.yF && r2c.yF && r2c.hov, { r2a, r2b, r2c });
  // 光标在图区外 → focusWorks → 真鼠标一次移到另一张卡上：第一次真实移动就生效
  const t = await page.evaluate(({ z, y }) => { A.clearFocus(); A.focusWorks([y], { mode: 'stay', reveal: false }); const q = F.frame(F.el(A, z)).getBoundingClientRect(); return { x: q.left + 20, y: q.top + q.height / 2 }; }, p);
  await page.waitForTimeout(150);
  await page.mouse.move(t.x, t.y); await page.waitForTimeout(80);
  const r3 = await page.evaluate(({ z, y }) => ({ zF: F.el(A, z).classList.contains('focus'), yF: F.el(A, y).classList.contains('focus') }), p);
  check('悬停：光标在图区外时 focusWorks，之后鼠标一次移到另一张卡上 → 悬停马上生效（不吞第一次移动）', r3.zF && !r3.yF, r3);
  await page.evaluate(() => A.clearFocus());
  check('悬停：没有报错', errs.length === 0, errs.slice(0, 5));
  await ctx.close();
  // 页面打开后鼠标从没动过（不知道光标在哪）：focusWorks 过一会儿后的第一次真实移动也算
  const o2 = await open(browser, paneURL());
  await o2.page.evaluate(REMOUNT);
  await o2.page.waitForFunction(() => window.A && A.getViewport(), null, { timeout: 15000 });
  await o2.page.evaluate(HELPERS);
  const q2 = await o2.page.evaluate(async () => {
    A.setView('hasse'); await F.drawn(A, 'hasse'); await F.wait(200);
    const vis = F.visible(A, 30).filter(id => F.frame(F.el(A, id)).getBoundingClientRect().width > 60);
    const z = vis[0], y = vis.find(id => id !== z);
    A.focusWorks([y], { mode: 'stay', reveal: false });
    const q = F.frame(F.el(A, z)).getBoundingClientRect();
    return { z, y, x: q.left + 20, yy: q.top + q.height / 2 };
  });
  await o2.page.waitForTimeout(150);
  await o2.page.mouse.move(q2.x, q2.yy); await o2.page.waitForTimeout(80);
  const r4 = await o2.page.evaluate(({ z, y }) => ({ zF: F.el(A, z).classList.contains('focus'), yF: F.el(A, y).classList.contains('focus') }), q2);
  check('悬停：页面打开后鼠标从没动过，focusWorks 之后第一次真实移动到卡上 → 悬停生效', r4.zF && !r4.yF, r4);
  check('悬停（光标位置未知）：没有报错', o2.errs.length === 0, o2.errs.slice(0, 5));
  await o2.ctx.close();
}

// ================= onFocusTakeover：用户接管程序聚焦时引擎告诉宿主 =================
async function takeoverTests(browser) {
  const { page, errs, ctx } = await open(browser, paneURL());
  await readyPane(page);
  await page.evaluate(async () => { A.setView('canvas'); await F.drawn(A, 'canvas'); await F.home(A); await F.drawn(B, 'hasse'); });
  const tl = () => page.evaluate(() => { const l = window.tlog.slice(); window.tlog.length = 0; return l; });
  const ids = await page.evaluate(() => {
    const vis = F.visible(A, 40).filter(id => F.el(A, id).getBoundingClientRect().width > 60);
    const q = F.el(A, vis[1]).getBoundingClientRect(), bq = F.board(B).closest('.board-wrap').getBoundingClientRect(), aq = F.board(A).closest('.board-wrap').getBoundingClientRect();
    return { x: vis[0], y: vis[1], yx: q.left + 20, yy: q.top + q.height / 2, bx: bq.left + 8, by: bq.top + 8, ax: aq.left + 30, ay: aq.top + 30, bid: F.visible(B, 0)[0] };
  });
  const resetPin = async () => { await page.mouse.move(ids.ax, ids.ay); await page.keyboard.press('Escape'); await page.waitForTimeout(50); await page.evaluate(() => { A.clearFocus(); B.clearFocus(); }); await page.mouse.move(3, 3); await tl(); };
  // 1) 点击作品卡固定 → 'pin'（回调时引擎已经固定好了）
  await page.evaluate(({ x }) => A.focusWorks([x], { mode: 'stay', reveal: false }), ids);
  await page.mouse.move(ids.yx, ids.yy); await page.mouse.click(ids.yx, ids.yy); await page.waitForTimeout(50);
  let l = await tl();
  check("onFocusTakeover：有程序聚焦时点击作品卡固定 → 只回调一次 'pin'，回调时已经固定好", l.join() === 'a:pin:pinned', l);
  await resetPin();
  // 2) 本实例按 Esc → 'esc'
  await page.evaluate(({ x }) => A.focusWorks([x], { mode: 'stay', reveal: false }), ids);
  await page.mouse.move(ids.ax, ids.ay); await page.keyboard.press('Escape'); await page.waitForTimeout(50);
  l = await tl();
  const aGone = await page.evaluate(() => !F.board(A).classList.contains('hovering'));
  check("onFocusTakeover：鼠标在本实例上按 Esc 清掉程序聚焦 → 回调 'esc'", l.join() === 'a:esc:-' && aGone, { l, aGone });
  await resetPin();
  // 3) 没有程序聚焦时点击固定 / Esc 取消固定：都不回调
  await page.mouse.click(ids.yx, ids.yy); await page.waitForTimeout(50);
  await page.mouse.move(ids.ax, ids.ay); await page.keyboard.press('Escape'); await page.waitForTimeout(50);
  l = await tl();
  check('onFocusTakeover：当时没有程序聚焦的点击固定、Esc 取消固定 → 不回调', l.length === 0, l);
  await resetPin();
  // 4) 误判场景一：焦点在 A 里、鼠标在 B 上按 Esc → 引擎只清 B，只有 B 回调，A 不回调、程序聚焦还在
  await page.evaluate(({ x, bid }) => { A.focusWorks([x], { mode: 'stay', reveal: false }); B.focusWorks([bid], { mode: 'stay', reveal: false }); A.shadow.querySelector('.tab').focus(); }, ids);
  await page.mouse.move(ids.bx, ids.by); await page.waitForTimeout(50);
  await page.keyboard.press('Escape'); await page.waitForTimeout(50);
  l = await tl();
  const st4 = await page.evaluate(({ x }) => ({ aFocus: F.el(A, x).classList.contains('focus'), bHov: F.board(B).classList.contains('hovering'), active: !!A.shadow.activeElement }), ids);
  check("onFocusTakeover：焦点在 A、鼠标在 B 时按 Esc → 只有 B 回调 'esc'；A 不回调、程序聚焦还在", l.join() === 'b:esc:-' && st4.aFocus && !st4.bHov && st4.active, { l, st4 });
  await resetPin();
  // 5) 误判场景二：空格抓手模式下点侧栏标签 → 点击被吞掉，不固定、不回调，程序聚焦还在
  const tag = await page.evaluate(async ({ x }) => {
    A.setPrefs({ drawer: true }); await F.wait(300);
    A.focusWorks([x], { mode: 'stay', reveal: false });
    const t = [...A.shadow.querySelectorAll('.drawer [data-tag]')].find(e => e.getBoundingClientRect().width > 0);
    const q = t.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 };
  }, ids);
  await page.mouse.move(ids.ax + 40, ids.ay + 40); await page.waitForTimeout(30);
  await page.keyboard.down('Space'); await page.waitForTimeout(30);
  const grab = await page.evaluate(() => A.shadow.querySelector('.root').classList.contains('grab'));
  await page.mouse.move(tag.x, tag.y); await page.mouse.click(tag.x, tag.y); await page.waitForTimeout(50);
  await page.keyboard.up('Space'); await page.waitForTimeout(50);
  await page.mouse.move(3, 3); await page.waitForTimeout(50);         // 移开（悬停不再盖着），看程序聚焦还在不在
  l = await tl();
  const st5 = await page.evaluate(({ x }) => ({ pinned: !!A.pinned, aFocus: F.el(A, x).classList.contains('focus') }), ids);
  check('onFocusTakeover：空格抓手模式下点侧栏标签 → 点击被吞掉：不固定、不回调、程序聚焦还在', grab && l.length === 0 && !st5.pinned && st5.aFocus, { grab, l, st5 });
  // 对照：不按空格点同一个侧栏标签 → 固定 + 'pin'
  await page.mouse.move(tag.x + 1, tag.y); await page.mouse.click(tag.x + 1, tag.y); await page.waitForTimeout(50);
  l = await tl();
  check("onFocusTakeover：（对照）不按空格点侧栏标签 → 固定、回调 'pin'", l.join() === 'a:pin:pinned', l);
  await resetPin();
  // 6) flash 自然结束、宿主 clearFocus、新的 focusWorks：都不回调
  await page.evaluate(async ({ x, y }) => {
    A.focusWorks([x], { mode: 'flash', reveal: false }); await F.wait(2000);
    A.focusWorks([x], { mode: 'stay', reveal: false }); A.focusWorks([y], { mode: 'stay', reveal: false }); A.clearFocus();
  }, ids);
  l = await tl();
  check('onFocusTakeover：flash 自然结束、新的 focusWorks、宿主 clearFocus → 都不回调', l.length === 0, l);
  check('takeover：没有报错', errs.length === 0, errs.slice(0, 5));
  await ctx.close();
}

// ================= onViewportChange 的 info.by =================
async function byTests(browser) {
  const { page, errs, ctx } = await open(browser, paneURL());
  await readyPane(page);
  const last = () => page.evaluate(() => { const l = vlog.filter(x => x.id === 'a'); vlog.length = 0; return l.map(x => x.by); });
  await page.evaluate(async () => { A.setView('canvas'); await F.drawn(A, 'canvas'); await F.home(A); });
  // host：setViewport
  await page.evaluate(() => A.setViewport({ zoom: 0.8, cx: 300, cy: 300 })); await page.waitForTimeout(400);
  check("info.by：宿主 setViewport → 'host'", (await last()).join() === 'host');
  // user：真鼠标滚轮滚动图区
  const c = await page.evaluate(() => { const q = F.wrap(A).getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; });
  await page.mouse.move(c.x, c.y); await page.mouse.wheel(0, 200); await page.waitForTimeout(500);
  check("info.by：用户滚轮滚动 → 'user'", (await last()).join() === 'user');
  // user：空格 + 滚轮缩放
  await page.keyboard.down('Space'); await page.mouse.wheel(0, -200); await page.keyboard.up('Space'); await page.waitForTimeout(500);
  check("info.by：空格 + 滚轮缩放 → 'user'", (await last()).join() === 'user');
  // user：Shift+0、Shift+1
  await page.keyboard.press('Shift+Digit1'); await page.waitForTimeout(400);
  check("info.by：Shift+1 显示全图 → 'user'", (await last()).join() === 'user');
  await page.keyboard.press('Shift+Digit0'); await page.waitForTimeout(400);
  check("info.by：Shift+0 回到初始 → 'user'", (await last()).join() === 'user');
  // user：点右下角百分比标签
  await page.evaluate(() => A.setViewport({ zoom: 0.7 })); await page.waitForTimeout(400); await last();
  const bd = await page.evaluate(() => { const q = A.shadow.querySelector('.view:not([hidden]) .zoom-badge').getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; });
  await page.mouse.click(bd.x, bd.y); await page.waitForTimeout(400);
  check("info.by：点百分比标签 → 'user'", (await last()).join() === 'user');
  await page.mouse.move(3, 3);
  // user：用户（键盘等）滚了，滚动事件到达前宿主就调了 getViewport → 仍报 'user'
  await page.evaluate(async () => { const s = F.wrap(A); s.scrollTop += 50; s.scrollLeft += 30; A.getViewport(); await F.wait(400); });
  check("info.by：用户滚动后、滚动事件前宿主读了 getViewport → 仍报 'user'", (await last()).join() === 'user');
  // focus 和 user 在同一个防抖窗口里 → 'user'
  await page.evaluate(async () => { await F.home(A); });
  const far = await page.evaluate(() => F.farthest(A));
  await page.mouse.move(c.x, c.y); await page.waitForTimeout(50);
  await page.evaluate(id => A.focusWorks([id], { mode: 'stay' }), far);
  await page.mouse.wheel(0, 120); await page.waitForTimeout(700);
  const merged = await last();
  check("info.by：reveal 和用户滚动在同一个防抖窗口里 → 只报一次 'user'", merged.join() === 'user', merged);
  await page.mouse.move(3, 3);
  // host：格子变大小后重摆
  await page.evaluate(async () => { A.clearFocus(); A.setViewport({ zoom: 0.6, cx: 500, cy: 400 }); await F.wait(400); vlog.length = 0; document.getElementById('cellA').style.flex = '0 0 700px'; await F.wait(600); });
  const rs = await last();
  await page.evaluate(async () => { document.getElementById('cellA').style.flex = ''; await F.wait(500); vlog.length = 0; });
  check("info.by：格子变大小后重摆 → 'host'（或没有回调）", rs.every(b => b === 'host'), rs);
  check('by：没有报错', errs.length === 0, errs.slice(0, 5));
  await ctx.close();
}

// ================= prefers-reduced-motion =================
async function motionTests(browser) {
  const { page, errs, ctx } = await open(browser, paneURL(), null, { reducedMotion: 'reduce' });
  await readyPane(page);
  const r = await page.evaluate(async () => {
    A.setView('canvas'); await F.drawn(A, 'canvas'); await F.home(A);
    const id = F.farthest(A), before = F.out(A, [id], 24);
    A.focusWorks([id], { mode: 'flash' });
    const now = F.out(A, [id], 24);                  // 同一个任务里：已经到位（瞬间完成）
    await F.frames();
    const cs = getComputedStyle(F.frame(F.el(A, id)));
    const anim = { name: cs.animationName, n: cs.animationIterationCount, dur: cs.animationDuration };
    await F.wait(1800);
    return { before, now, anim, gone: F.board(A).querySelectorAll('.focus, .fl').length === 0 };
  });
  check('减少动效：reveal 瞬间完成；flash 改成一次淡入淡出（1.5s × 1），之后高亮消失', r.before > 0 && r.now <= 1 && r.anim.name === 'tn-flash' && r.anim.n === '1' && r.anim.dur === '1.5s' && r.gone, r);
  check('motion：没有报错', errs.length === 0, errs.slice(0, 5));
  await ctx.close();
}

// ================= 'page' 布局 =================
async function pageTests(browser) {
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const { page, errs, ctx } = await open(browser, pathToFileURL(MULTI_HTML).href, { width: 1400, height: 1000 });
  await page.evaluate(HELPERS);
  const r = await page.evaluate(async data => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.getElementById('p1').style.width = '520px';
    const a = TagNote.mount(document.getElementById('a'), data, { view: 'canvas' });
    await wait(400);
    const out = {};
    // 找一个图区横向放不下、右边藏着作品的视图
    let v = null, id = null;
    for (const k of ['canvas', 'score', 'kmap', 'hasse', 'terr', 'line']) {
      a.setView(k);
      for (let n = 0; n < 100 && !(a.drawnWorkIds() && a.drawnWorkIds().length); n++) await wait(50);
      await wait(50);
      const s = F.wrap(a), V = F.vis(a);
      if (s.scrollWidth <= s.clientWidth + 40) continue;
      id = F.ids(a).find(x => { const q = F.frame(F.el(a, x)).getBoundingClientRect(); return q.left > V.r + 50 && q.width < V.r - V.l - 60; });
      if (id) { v = k; break; }
    }
    out.view = v; out.id = id;
    const pane = document.getElementById('p1'), y0 = pane.scrollTop, wy0 = window.scrollY;
    if (v) {
      const s = F.wrap(a);
      {
        out.res = a.focusWorks([id], { mode: 'stay' });
        out.vpMid = a.getViewport();
        await wait(600);
        out.outX = F.out(a, [id], 24, 'x'); out.sl = s.scrollLeft; out.vpEnd = a.getViewport();
        out.focus = F.el(a, id).classList.contains('focus');
      }
    }
    out.yStill = pane.scrollTop === y0 && window.scrollY === wy0;
    a.clearFocus(); out.cleared = !F.board(a).classList.contains('hovering');
    a.destroy();
    return out;
  }, data);
  check("'page'：focusWorks 能用；reveal 只做横向滚动（作品横向完整可见），纵向不动页面；缓动中 getViewport 返回终点", r.view && r.id && r.res.found[0] === r.id && r.outX <= 1 && r.sl > 0 && r.focus && r.yStill && r.cleared && Math.abs(r.vpMid.cx - r.vpEnd.cx) < 1, r);
  // 两个 'page' 实例都有程序聚焦：Esc 只清鼠标所在的那个；固定高亮：Esc 各自取消各自的固定
  const pt = await page.evaluate(async data => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.getElementById('p1').style.width = '';
    window.A = TagNote.mount(document.getElementById('a'), data, { view: 'canvas' });
    window.B = TagNote.mount(document.getElementById('b'), data, { view: 'canvas' });
    for (let n = 0; n < 100 && !(A.drawnWorkIds() && A.drawnWorkIds().length && B.drawnWorkIds() && B.drawnWorkIds().length); n++) await wait(50);
    await wait(100);
    const ia = F.visible(A, 0)[0], ib = F.visible(B, 0)[0];
    A.focusWorks([ia], { mode: 'stay', reveal: false }); B.focusWorks([ib], { mode: 'stay', reveal: false });
    const q = A.host.getBoundingClientRect();
    return { ia, ib, x: q.left + 60, y: q.top + 60 };
  }, data);
  await page.mouse.move(pt.x, pt.y); await page.waitForTimeout(50);
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  const pe = await page.evaluate(({ ia, ib }) => ({ a: F.board(A).classList.contains('hovering') || F.el(A, ia).classList.contains('focus'), b: F.board(B).classList.contains('hovering') && F.el(B, ib).classList.contains('focus') }), pt);
  check("'page'：两个实例都有程序聚焦，鼠标在 A 上按 Esc → 只清 A 的，B 的保持", !pe.a && pe.b, pe);
  const pp = await page.evaluate(({ ia, ib }) => {
    B.clearFocus();
    F.el(A, ia).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    F.el(B, ib).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    return { a: !!A.pinned, b: !!B.pinned };
  }, pt);
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  const pu = await page.evaluate(() => { const o = { a: !!A.pinned, b: !!B.pinned }; A.destroy(); B.destroy(); return o; });
  check("'page'：没用程序聚焦时——两个实例都固定了高亮，Esc 两个都取消固定", pp.a && pp.b && !pu.a && !pu.b, { pp, pu });
  check('page：没有报错', errs.length === 0, errs.slice(0, 5));
  await ctx.close();
}

(async () => {
  let browser;
  try { browser = await chromium.launch(); }
  catch (e) { console.error('启动 Playwright 无头浏览器失败：' + e.message); process.exit(2); }
  try {
    for (const [name, fn] of [['views', viewTests], ['reveal', revealTests], ['flash', flashTests], ['queue', queueTests], ['user', userTests], ['hold', holdTests], ['takeover', takeoverTests], ['by', byTests], ['motion', motionTests], ['page', pageTests]]) {
      if (ONLY.length && !ONLY.includes(name)) continue;
      try { await fn(browser); } catch (e) { check(`[${name}] 脚本执行`, false, e.stack.split('\n').slice(0, 4).join(' | ')); }
    }
  } finally { await browser.close(); }
  const bad = results.filter(r => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} 通过` + (bad.length ? '；失败：\n  ' + bad.map(r => r.name).join('\n  ') : ''));
  process.exitCode = bad.length ? 1 : 0;
})();
