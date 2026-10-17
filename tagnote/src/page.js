'use strict';
/* 独立网页的外壳：页头、换数据、总览页。引擎本身在 TagNote（tagnote.js）里。 */
const RAW0 = JSON.parse(document.getElementById('data').textContent);
const COVERS = (() => { try { return JSON.parse(document.getElementById('covers').textContent); } catch (e) { return {}; } })();
const store = {
  get(k, d) { try { const v = localStorage.getItem('tagnote:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('tagnote:' + k, JSON.stringify(v)); } catch (e) { } },
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const OVERVIEW_CSS = `
.reco{ background: var(--tn-card); border: 1px solid var(--tn-line); border-radius: 16px; padding: 20px 24px 22px; max-width: 1100px }
.reco h2{ font-family: var(--tn-f-display); font-weight: 900; font-size: 26px; margin: 0 0 8px; letter-spacing: .03em }
.reco p{ margin: 6px 0 0; max-width: 80ch; color: var(--tn-ink-2) }
.reco ol{ margin: 10px 0 0; padding-left: 1.3em; max-width: 80ch; color: var(--tn-ink-2) }
.reco li{ margin: 4px 0 }
.reco b{ color: var(--tn-ink) }
.ov-grid{ display:grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 16px; margin-top: 18px }
.ov-card{ background: var(--tn-card); border: 1px solid var(--tn-line); border-radius: 14px; padding: 16px 18px 18px; display:flex; flex-direction: column; gap: 8px; min-width: 0 }
.ov-card h3{ margin: 0; font-family: var(--tn-f-display); font-weight: 900; font-size: 21px; letter-spacing: .03em }
.ov-card h3 .no{ font-family: var(--tn-f-mono); font-weight: 500; font-size: 14px; color: var(--tn-accent); margin-right: 8px }
.ov-card p{ margin: 0; color: var(--tn-ink-2) }
.meters{ display:grid; grid-template-columns: auto 1fr; gap: 3px 10px; font-size: 13.5px; color: var(--tn-ink-2); align-items: center; margin-top: 2px }
.meter{ display:flex; gap: 3px }
.meter i{ width: 18px; height: 6px; border-radius: 3px; background: var(--tn-line) }
.meter i.f{ background: var(--tn-accent) }
.go{ margin-top: auto; align-self: flex-start; border: 1px solid var(--tn-line-2) !important; border-radius: 999px; padding: 4px 14px !important; color: var(--tn-ink); font-size: 14px }
.go:hover{ border-color: var(--tn-accent) !important; color: var(--tn-accent) }
.facts{ margin-top: 22px; display:grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 12px 30px; max-width: 1100px }
.facts h3{ font-size: 13px; letter-spacing: .12em; color: var(--tn-ink-3); margin: 0 0 4px; font-weight: 500 }
.facts ul{ margin: 0; padding-left: 1.1em; color: var(--tn-ink-2) }
.facts b{ color: var(--tn-ink) }
.facts code{ font-family: var(--tn-f-mono); font-size: 13px; background: var(--tn-paper-2); padding: 0 4px; border-radius: 4px }
`;

const overview = {
  key: 'overview', name: '总览与推荐',
  render(el) {
    const meter = n => `<span class="meter">${[0, 1, 2].map(i => `<i class="${i < n ? 'f' : ''}"></i>`).join('')}</span>`;
    el.innerHTML = `<div class="reco"><h2>建议用法：一张主图，配一张“找不同”图</h2>
      <p>这些设计各管一件事，两张图配合比一张“全能图”更好记。建议这样用：</p><ol>
      <li><b>主图用「03 卡诺图」。</b>这份示例里，日常、搞笑、萌、治愈四个标签决定了大部分结构，4×4 的格子正好装下；位置就是答案，适合在游戏里看到标签时反查“是哪一格”。主标签超过 4 个的作品集，主图改用「05 领地图」。</li>
      <li><b>配一张「04 增减阶梯」专门找不同。</b>它把“谁比谁多一个标签”画成带字的线，正好补上卡诺图格子内部和跨格的比较。偏好纯文字时，用「06 谱系」代替。</li>
      <li><b>「02 标签谱」当查表。</b>不用来背，用来核对：一行就是一部作品的完整标签组，最可靠。</li>
      <li><b>「01 分支画布」</b>按标签逐层分支：方框只到第一层分支，往下用连线继续分。</li></ol></div>
      <div class="ov-grid">${TagNote.VIEWS.map(v => `<article class="ov-card"><h3><span class="no">${v.no}</span>${v.name}</h3><p>${v.idea}</p>
        <div class="meters"><span>记标签组</span>${meter(v.g1)}<span>辨异同</span>${meter(v.g2)}</div>
        <button class="go" data-goto="${v.key}">打开 ${v.name} →</button></article>`).join('')}</div>
      <div class="facts">
        <section><h3>所有视图共用的规则</h3><ul>
          <li>全体作品共有的标签（这里是「百合」）不进图，写在标题里。</li>
          <li>类型、题材等用荧光笔底色；形式、来源用细框；未定义的低频标签用虚线框，只在两部作品已定义标签相差不超过 2 个、又共有它时出现。</li>
          <li>“近邻”按已定义标签的差别个数计算，共有的可见低频标签每个再减 0.3。</li></ul></section>
        <section><h3>悬停（每个视图都有）</h3><ul>
          <li>悬停标签：含它的作品亮起；悬停“非X”（表头、空格子、反向领地、侧栏）：不含 X 的作品亮起。</li>
          <li>悬停作品：最接近的几部亮起，卡片角上写出差别，如 <b>+治愈 −搞笑</b>。点击固定，Esc 取消。</li>
          <li>右上角「标签与近邻」打开侧栏：所有标签可悬停，悬停时列出命中的作品或近邻和差别。</li></ul></section>
        <section><h3>换数据</h3><ul>
          <li>页面没有写死作品名或标签，所有布局由 JSON 现算；用页头“载入其它作品集 JSON”可换同格式数据。</li>
          <li>引擎是独立的 <code>TagNote.mount()</code>，配色在 <code>config.hue</code>（标签 → 色相）里改。</li></ul></section>
      </div>`;
  },
};

let inst = null;
function shell(raw) {
  const title = (raw.collection && raw.collection.title) || '作品集';
  const clean = title.replace(/（.*?）|\(.*?\)/g, '').trim();
  const m = /^(\d{4})\s*(.*)$/.exec(clean);
  document.getElementById('ttl').innerHTML = (m ? `<span class="yr">${esc(m[1])}</span>${esc(m[2])}` : esc(clean)) + '<span class="kind">标签笔记</span>';
  const M = inst.M;
  document.getElementById('sub').innerHTML = `<b>${M.n}</b> 部作品 · 全部共有：${M.common.length ? M.common.map(t => `<b>${esc(t)}</b>`).join(' ') : '无'} · 已定义标签 <b>${M.tags.filter(t => M.groupOf(t) !== 'G_else').length}</b> 个`;
  document.title = clean + ' 标签笔记';
}
const themeOf = () => { const t = document.documentElement.getAttribute('data-theme'); return t === 'dark' || t === 'light' ? t : 'auto'; };
const prefs = store.get('prefs', {});
const hashView = location.hash.slice(1);
if (hashView) prefs.view = hashView;
inst = TagNote.mount(document.getElementById('app'), RAW0, {
  customViews: [overview], notes: true, extraCSS: OVERVIEW_CSS, theme: themeOf(), prefs,
  coverOf: w => COVERS[w.subject_id] || null,
  onPrefsChange: p => store.set('prefs', p),
  onViewChange: k => { if (location.hash.slice(1) !== k) history.replaceState(null, '', '#' + k); },
});
shell(RAW0);
new MutationObserver(() => inst.setTheme(themeOf())).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
window.addEventListener('hashchange', () => { const k = location.hash.slice(1); if (k && k !== inst.view) inst.setView(k); });
document.getElementById('load-json').addEventListener('change', e => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    const err = document.getElementById('err'); err.textContent = '';
    try {
      const raw = JSON.parse(rd.result);
      if (!raw || !Array.isArray(raw.works) || !raw.works.length) throw new Error('文件里没有 works 数组');
      inst.setData(raw); shell(raw); document.getElementById('reset-data').hidden = false;
    } catch (ex) { err.textContent = '没能读入：' + ex.message + '。请选择与示例相同格式的 JSON。'; }
  };
  rd.readAsText(f, 'utf-8'); e.target.value = '';
});
document.getElementById('reset-data').addEventListener('click', () => { inst.setData(RAW0); shell(RAW0); document.getElementById('reset-data').hidden = true; });
