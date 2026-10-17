# -*- coding: utf-8 -*-
"""注入页面执行的只读脚本（page.evaluate）。

原则：只读 DOM 和 React fiber，不改任何节点、不挂任何全局变量、不调游戏函数。
React 19 在 DOM 节点上挂 `__reactFiber$<随机后缀>`（这个命名从 React 17 起就是这样）。
"""

# 公共小工具：拿 fiber。
# 坑：DOM 节点上的 __reactFiber$ 指向「创建时的那个 fiber」，React 双缓冲后它可能属于过期的 alternate 树，
# 从它往上读到的 props / hooks 是旧的（例：玩家已取消准备，读到的仍是已准备）。
# 办法：顺着 return 走到 HostRoot，若它不是 FiberRoot.current，说明拿到的是旧树 → 改用 alternate。
_FIB = r"""
const __cur = (f) => { if (!f) return f; let r = f; let n = 0; while (r.return && n < 5000) { r = r.return; n++; }
  if (r.stateNode && r.stateNode.current && r.stateNode.current !== r && f.alternate) return f.alternate; return f; };
const __fib = (el) => { if (!el) return null; const k = Object.keys(el).find(k => k.startsWith('__reactFiber$')); return k ? __cur(el[k]) : null; };
"""

# ---------------------------------------------------------------------------
# 页面状态探针：我是谁 / 是不是房主 / 出题模式 / 游戏是否开始 / 弹窗 / 搜索框 / 遮罩
# ---------------------------------------------------------------------------
JS_PROBE = "() => {" + _FIB + r"""
  const out = { url: location.href, visible: document.visibilityState === 'visible', focus: document.hasFocus(),
                joined: !document.querySelector('.join-container'), hasPlayerList: false };
  // 1) PlayerList 的 props（Multiplayer 页才有）
  let f = __fib(document.querySelector('.players-list')); let hops = 0;
  while (f && hops < 12) {
    const p = f.memoizedProps;
    if (p && Array.isArray(p.players) && ('isManualMode' in p)) {
      out.hasPlayerList = true;
      out.myId = (p.socket && p.socket.id) || null;
      out.isHost = !!p.isHost; out.isManualMode = !!p.isManualMode; out.isGameStarted = !!p.isGameStarted;
      out.answerSetterId = p.answerSetterId || null;
      out.players = p.players.map(x => ({ id: x.id, username: x.username, isHost: !!x.isHost, ready: !!x.ready,
                                          disconnected: !!x.disconnected, team: (x.team ?? null), isAnswerSetter: !!x.isAnswerSetter }));
      break;
    }
    f = f.return; hops++;
  }
  // 2) 玩家表格行（key = socket id）
  out.rows = [...document.querySelectorAll('.score-table tbody > tr')].map((tr, i) => {
    const b = tr.querySelector('button.ready-button');
    return { i, key: (__fib(tr) || {}).key ?? null, btn: b ? b.textContent.trim() : null };
  });
  // 3) 「有人想出题？」按钮
  const mb = document.querySelector('.manual-mode-button');
  out.manualBtn = mb ? { active: mb.classList.contains('active'), disabled: !!mb.disabled, text: mb.textContent.trim() } : null;
  // 4) 出题弹窗：SetAnswerPopup 的第一个 hook 就是 selectedCharacter（通常 hops=2, hook=0）
  const pop = document.querySelector('.set-answer-popup');
  out.popup = null;
  if (pop) {
    const sub = pop.querySelector('.submit-button');
    let sel = null, g = __fib(pop), h2 = 0;
    while (g && h2 < 8) {
      if (typeof g.type === 'function') {
        let h = g.memoizedState, k = 0;
        while (h && k < 30) {
          const v = h.memoizedState;
          if (v && typeof v === 'object' && !Array.isArray(v) && ('id' in v) && ('name' in v)) { sel = { id: v.id, name: v.name, nameCn: v.nameCn ?? null }; break; }
          h = h.next; k++;
        }
        break;
      }
      g = g.return; h2++;
    }
    const simg = pop.querySelector('.selected-character img');
    out.popup = { confirmEnabled: sub ? !sub.disabled : false, confirmText: sub ? sub.textContent.trim() : null,
                  selected: sel, selectedImg: simg ? simg.getAttribute('src') : null,
                  selectedText: (pop.querySelector('.selected-character .character-info') || {}).textContent || null };
  }
  // 5) 局内猜测搜索框（不在出题弹窗 / 其他弹窗里的那个）：用来判断页面角色
  const secs = [...document.querySelectorAll('.search-section')];
  const gi = secs.findIndex(s => !s.closest('.set-answer-popup') && !s.closest('.popup-overlay'));
  out.gameSearch = null;
  if (gi >= 0) {
    const inp = secs[gi].querySelector('input.search-input');
    out.gameSearch = { disabled: inp ? !!inp.disabled : true };
  }
  out.answerSetterView = !!document.querySelector('.answer-setter-view');
  // 6) 挡住点击的遮罩（结算弹窗 / 欢迎 / Bangumi 被墙提示）；设置弹窗不算（用户可能在改设置）
  out.overlays = [...document.querySelectorAll('.popup-overlay')].map(o => ({
    closable: !!o.querySelector('.popup-close'),
    settings: !!o.querySelector('.settings-popup'),
    text: (o.textContent || '').trim().slice(0, 60) }));
  return out;
}"""

# ---------------------------------------------------------------------------
# 出题弹窗里的搜索框快照
# ---------------------------------------------------------------------------
JS_SEARCH_SNAPSHOT = "() => {" + _FIB + r"""
  const root = document.querySelector('.set-answer-popup');
  if (!root) return { present: false };
  const inp = root.querySelector('input.search-input');
  const charBtn = root.querySelector('.search-box > button.search-button');
  const subjBtn = root.querySelector('.subject-search-wrapper > button.search-button');
  const dd = root.querySelector('.search-dropdown');
  const items = dd ? [...dd.querySelectorAll('.search-result-item')].map((el, i) => {
    const img = el.querySelector('img.result-character-icon');
    const f = __fib(el);
    return { i, loadMore: el.classList.contains('load-more'), selected: el.classList.contains('selected'),
             key: f ? (f.key ?? null) : null, img: img ? img.getAttribute('src') : null, noImage: !!el.querySelector('.no-image'),
             name: (el.querySelector('.result-character-name') || {}).textContent ?? null,
             cn: (el.querySelector('.result-character-name-cn') || {}).textContent ?? null,
             subjectType: (el.querySelector('.result-subject-type') || {}).textContent ?? null,
             text: el.textContent.trim().slice(0, 40) };
  }) : [];
  const lm = items.find(x => x.loadMore);
  const ld = dd ? dd.querySelector('.search-loading') : null;
  const hd = dd ? dd.querySelector('.selected-subject-header span') : null;
  return {
    present: true,
    inputValue: inp ? inp.value : null, inputDisabled: inp ? !!inp.disabled : true,
    placeholder: inp ? inp.getAttribute('placeholder') : null,
    charBtn: charBtn ? { text: charBtn.textContent.trim(), disabled: !!charBtn.disabled, active: charBtn.classList.contains('active') } : null,
    subjBtn: subjBtn ? { text: subjBtn.textContent.trim(), disabled: !!subjBtn.disabled, active: subjBtn.classList.contains('active'),
                         disabledMode: subjBtn.classList.contains('disabled-mode') } : null,
    dropdown: !!dd, loading: !!ld, loadingText: ld ? ld.textContent.trim() : null,
    header: hd ? hd.textContent : null,
    loadMoreText: lm ? lm.text : null,
    items,
  };
}"""

# 点击前的最后核验：拿到将要点的那个元素，确认它的 key / 图片仍然是目标
JS_ITEM_IDENTITY = "(el) => {" + _FIB + r"""
  const img = el.querySelector('img.result-character-icon'); const f = __fib(el);
  return { key: f ? (f.key ?? null) : null, img: img ? img.getAttribute('src') : null,
           name: (el.querySelector('.result-character-name') || {}).textContent ?? null,
           cn: (el.querySelector('.result-character-name-cn') || {}).textContent ?? null,
           loadMore: el.classList.contains('load-more') };
}"""
