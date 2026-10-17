// 两个实例同页、在可滚动容器里（模拟 Obsidian 面板）；检查隔离、onWorkOpen、布局缓存、destroy（Playwright 无头 Chromium）。
//
// 用法（先 python build.py，生成 engine/tagnote.js）：
//   node test/multi.js --pw <装了 playwright 的目录> [--shots <截图目录>]
//   也可以用环境变量 PLAYWRIGHT_DIR / TN_SHOTS。不给 --shots 时不截图。
// 只开 Playwright 自己的无头浏览器；启动失败直接退出（退出码 2），不重试；结束时 finally 里关浏览器。
// 退出码：0 页面没有报错；1 页面有报错。输出的数字没有自动判定，请人看一眼。
'use strict';
const path = require('path'), fs = require('fs');

const arg = (name, env) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : process.env[env]; };
const PW = arg('pw', 'PLAYWRIGHT_DIR'), SHOTS = arg('shots', 'TN_SHOTS');
let chromium;
try { ({ chromium } = PW ? require(require.resolve('playwright', { paths: [PW] })) : require('playwright')); }
catch (e) { console.error('找不到 playwright：用 --pw <目录> 或环境变量 PLAYWRIGHT_DIR 指向装了 playwright 的目录。' + e.message); process.exit(2); }

(async () => {
  let browser;
  try { browser = await chromium.launch(); }
  catch (e) { console.error('启动浏览器失败：' + e.message); process.exit(2); }
  let bad = false;
  try { bad = await run(browser); } finally { await browser.close(); }
  if (bad) process.exit(1);
})();

async function run(browser) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1400 } });
  const errs = []; page.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto('file://' + path.resolve(__dirname, 'multi.html'));
  const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/works_2018_yuri.json'), 'utf8'));
  const small = JSON.parse(JSON.stringify(data)); small.works = small.works.slice(0, 7); small.collection.title = '小集合';
  const r = await page.evaluate(async ([data, small]) => {
    const out = {};
    let cacheSaved = null; window.opened = [];
    const a = TagNote.mount(document.getElementById('a'), data, { view: 'terr', theme: 'dark', onLayoutCache: (k, v) => { cacheSaved = { [k]: v }; }, onWorkOpen: w => window.opened.push(w.title) });
    const b = TagNote.mount(document.getElementById('b'), small, { view: 'hasse', toolbar: false, heads: false });
    await new Promise(r => setTimeout(r, 3000));
    out.aTerrCards = a.shadow.querySelectorAll('[data-board="terr"] .work').length;
    out.bHasseCards = b.shadow.querySelectorAll('[data-board="hasse"] .hw').length;
    out.cache = cacheSaved && Object.keys(cacheSaved.terr.pos).length;
    // 新实例带缓存：应直接用缓存，不再回调
    let again = 0; a.destroy();
    const a2 = TagNote.mount(document.getElementById('a'), data, { view: 'terr', layoutCache: cacheSaved, onLayoutCache: () => again++ });
    await new Promise(r => setTimeout(r, 600));
    out.reusedCache = again === 0 && a2.shadow.querySelectorAll('[data-board="terr"] .work').length === 19;
    out.prefs = a2.getPrefs();
    window.a2 = a2; window.b = b;
    return out;
  }, [data, small]);
  console.log(JSON.stringify(r));
  // dblclick 打开作品；Ctrl+点击
  await page.evaluate(([data]) => { window.a2.destroy(); window.opened = []; window.a3 = TagNote.mount(document.getElementById('a'), data, { view: 'kmap', onWorkOpen: w => window.opened.push(w.title) }); }, [data]);
  await page.waitForTimeout(800);
  await page.locator('#a .work[data-wid="w05"] .wt').dblclick();
  await page.locator('#a .work[data-wid="w01"] .wt').click({ modifiers: ['Control'] });
  console.log('opened:', await page.evaluate(() => window.opened));
  await page.evaluate(() => { const e = TagNote.mount(document.createElement('div'), null, {}); e.destroy(); });
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'multi-instance.png') }); }
  if (errs.length) console.log('ERRORS\n' + errs.join('\n'));
  return errs.length > 0;
}
