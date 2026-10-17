import { describe, expect, it } from 'vitest'
import type { WrongGuess } from '@/features/solo/api'
import {
  DEFAULT_FOLLOW_SETTINGS,
  FLASH_MS,
  NOTICE_MAX_W,
  PANEL_MIN_H,
  ZOOM_BADGE_RESERVE_H,
  ZOOM_BADGE_RESERVE_W,
  PANEL_MIDDLE_MIN_H,
  acceptFrom,
  allMissingOf,
  boardInRoot,
  captionText,
  clampReturnSec,
  clipTo,
  coverageOf,
  findTarget,
  groupForPlan,
  initialGroup,
  isPlanSwitch,
  matchWorks,
  needsCatchUp,
  notInGroupText,
  noticeBox,
  panelBox,
  panelCompact,
  pickSecondary,
  planNameOfKey,
  planReturn,
  planSwitchText,
  restoreFocus,
  returnReady,
  returnWait,
  sameGroup,
  shouldJump,
  takenOver,
  uncoveredOf,
  visibleArea,
  type FocusRecord,
  type LastEnd,
  type ReturnOrigin,
  type WorkLite,
} from './follow'
import type { LinkMsg } from './protocol'

const w = (id: string, subject_id?: number | string | null, char_id?: number | null): WorkLite => ({ id, subject_id, char_id })

describe('matchWorks：图里属于答案的作品卡', () => {
  const works = [w('a', 300, 7), w('b', 101, 1), w('c', 102, 5), w('d', 103), w('e', null, null), w('f', '101', null)]

  it('char_id 是答案，或 subject_id 在答案作品里', () => {
    expect(matchWorks(works, 1, [101, 103])).toEqual(['b', 'f', 'd'])
  })

  it('排序：答案角色自己的卡 → 绑定作品的卡 → 其他登场作品；同档按图里的顺序', () => {
    // 答案 5：卡 c 是他本人；绑定作品 103（d）；登场 101（b、f）
    expect(matchWorks(works, 5, [103, 101])).toEqual(['c', 'd', 'b', 'f'])
  })

  it('手写卡（没有 subject_id / char_id）和不像数字的字段不匹配', () => {
    expect(matchWorks([w('x', 'abc', null), w('y', undefined, undefined), w('z', 0, 0)], 0, [0])).toEqual([])
  })

  it('都没有 → 空', () => {
    expect(matchWorks(works, 99, [999])).toEqual([])
  })
})

describe('findTarget：跳到哪张图', () => {
  const data: Record<string, WorkLite[]> = {
    m1: [w('1a', 900, 90)],
    m2: [w('2a', 101, 1), w('2b', 102, 2)],
    m3: [w('3a', 101, 1)],
  }
  const of = (id: string) => data[id]

  it('优先当前格正在显示的那张（在组里、有答案）', () => {
    expect(findTarget(['m1', 'm2', 'm3'], of, 'm3', 1, [101])).toEqual({ mapId: 'm3', ids: ['3a'] })
  })

  it('显示的那张没有答案 → 组里排在最前面、有答案的', () => {
    expect(findTarget(['m1', 'm3', 'm2'], of, 'm1', 1, [101])).toEqual({ mapId: 'm3', ids: ['3a'] })
  })

  it('显示的图不在组里 → 不优先它', () => {
    expect(findTarget(['m2', 'm3'], (id) => (id === 'mx' ? [w('xa', 101, 1)] : data[id]), 'mx', 1, [101])).toEqual({ mapId: 'm2', ids: ['2a'] })
  })

  it('组里都没有 → null；数据没拿到的图当作没有', () => {
    expect(findTarget(['m1', 'm2'], of, null, 77, [777])).toBeNull()
    expect(findTarget(['m2', 'm3'], (id) => (id === 'm2' ? null : data[id]), null, 1, [101])).toEqual({ mapId: 'm3', ids: ['3a'] })
  })
})

describe('pickSecondary：猜错的作品', () => {
  const works = [w('a', 101, 1), w('b', 102, 2), w('c', 103, null), w('d', 104, 4), w('e', 103, null)]
  const g = (char_id: number, work_ids: number[]): WrongGuess => ({ char_id, name: `c${char_id}`, work_ids })

  it('先按 char_id，找不到再按作品列表的顺序；每人最多 1 张', () => {
    expect(pickSecondary(works, [g(2, [101]), g(9, [104, 103])], [])).toEqual(['b', 'd'])
  })

  it('排除答案卡，同一张卡不用两次', () => {
    expect(pickSecondary(works, [g(1, [103]), g(8, [103]), g(7, [103])], ['a'])).toEqual(['c', 'e'])
  })

  it('图里没有 → 不标', () => {
    expect(pickSecondary(works, [g(50, [500])], [])).toEqual([])
  })
})

describe('只在 Hard / Again 跳', () => {
  const hardOnly = { hardOnly: true }
  it('关着：都跳；开着：只有 hard / again', () => {
    expect(shouldJump('easy', DEFAULT_FOLLOW_SETTINGS)).toBe(true)
    expect(shouldJump('good', hardOnly)).toBe(false)
    expect(shouldJump('hard', hardOnly)).toBe(true)
    expect(shouldJump('again', hardOnly)).toBe(true)
  })

  it('补跳：同一局、当时没跳、下一题没开始、改成了 hard / again', () => {
    const last: LastEnd = { roundId: 'r1', grade: 'good', handled: false, nextStarted: false }
    expect(needsCatchUp(last, 'r1', 'hard', hardOnly)).toBe(true)
    expect(needsCatchUp(last, 'r1', 'easy', hardOnly)).toBe(false)
    expect(needsCatchUp(last, 'r0', 'again', hardOnly)).toBe(false)
    expect(needsCatchUp({ ...last, nextStarted: true }, 'r1', 'again', hardOnly)).toBe(false)
    expect(needsCatchUp({ ...last, handled: true }, 'r1', 'again', hardOnly)).toBe(false)
    expect(needsCatchUp(null, 'r1', 'again', hardOnly)).toBe(false)
  })
})

describe('「返回」', () => {
  const origin: ReturnOrigin = { tabId: 't1', view: 'score', vp: { zoom: 1, cx: 10, cy: 20, home: true } }

  it('下一题没开始 → 不回；开始了 → 亮够 N 秒才回', () => {
    const p = planReturn(null, origin, 't2', 1000)
    expect(returnWait(p, 9000, 4)).toBeNull()
    const started = { ...p, nextStarted: true }
    expect(returnWait(started, 2000, 4)).toBe(3000)
    expect(returnReady(started, 4999, 4)).toBe(false)
    expect(returnReady(started, 5000, 4)).toBe(true)
    expect(returnWait(started, 60_000, 4)).toBe(0)
  })

  it('秒数夹在 2–15', () => {
    expect(clampReturnSec(1)).toBe(2)
    expect(clampReturnSec(30)).toBe(15)
    expect(clampReturnSec(6.4)).toBe(6)
    expect(clampReturnSec('x')).toBe(4)
    const p = { ...planReturn(null, origin, 't2', 0), nextStarted: true }
    expect(returnWait(p, 0, 99)).toBe(15_000)
  })

  it('上一次还没回去又聚焦了 → 沿用最早的原处，时间从这次算', () => {
    const first = planReturn(null, origin, 't2', 1000)
    const second = planReturn(first, { tabId: 't2', view: 'canvas', vp: { zoom: 0.5, cx: 1, cy: 1 } }, 't3', 5000)
    expect(second.origin).toBe(origin)
    expect(second.targetTab).toBe('t3')
    expect(second.focusedAt).toBe(5000)
    expect(second.nextStarted).toBe(false)
  })

  it('接管：切了标签或视图', () => {
    const e = { tabId: 't2', view: 'canvas' }
    expect(takenOver(e, { activeTab: 't2', view: 'canvas' })).toBe(false)
    expect(takenOver(e, { activeTab: 't1', view: 'canvas' })).toBe(true)
    expect(takenOver(e, { activeTab: 't2', view: 'kmap' })).toBe(true)
    // 视图还没定 / 读不到：不算接管
    expect(takenOver({ tabId: 't2', view: null }, { activeTab: 't2', view: 'kmap' })).toBe(false)
    expect(takenOver(e, { activeTab: 't2', view: null })).toBe(false)
  })
})

describe('覆盖率', () => {
  const maps = [
    { id: 'a', covers: [1, 2, 3] },
    { id: 'b', covers: [3, 4] },
    { id: 'c', covers: [5] },
  ]
  it('勾选的图合起来覆盖多少人（去重）', () => {
    const c = coverageOf(maps, ['a', 'b'], 6)
    expect([c.covered, c.total, c.ratio]).toEqual([4, 6, 4 / 6])
    expect(coverageOf(maps, [], 6).covered).toBe(0)
    expect(coverageOf(maps, ['zzz', 'c'], 6).covered).toBe(1)
    expect(coverageOf(maps, ['a'], 0).ratio).toBe(0)
  })

  it('没覆盖的人：用整个题库算，保持热度顺序；标出所有图里都没有的', () => {
    const pool = [6, 5, 4, 3, 2, 1].map((c) => ({ char_id: c, name: `c${c}`, bound_work_id: null, bound_work_name: null }))
    const u = uncoveredOf(pool, coverageOf(maps, ['a'], 6), [6])
    expect(u.list.map((x) => [x.char_id, x.noMap])).toEqual([
      [6, true],
      [5, false],
      [4, false],
    ])
  })
})

describe('换方案', () => {
  it('记住过就用记住的，没有用预选结果（先不保存）', () => {
    expect(groupForPlan({ map_ids: ['x', 'y'] }, ['a'])).toEqual({ mapIds: ['x', 'y'], remembered: true })
    expect(groupForPlan(null, ['a', 'b'])).toEqual({ mapIds: ['a', 'b'], remembered: false })
  })

  it('方案变了才换；没在跟随、撤销过的方案不换', () => {
    expect(isPlanSwitch('plan:A', 'plan:B', null)).toBe(true)
    expect(isPlanSwitch('plan:A', 'plan:A', null)).toBe(false)
    expect(isPlanSwitch(null, 'plan:B', null)).toBe(false)
    expect(isPlanSwitch('plan:A', 'plan:B', 'plan:B')).toBe(false)
    expect(isPlanSwitch('plan:A', 'workbench', 'plan:B')).toBe(true)
  })
})

describe('多个单人标签页：只认最近的那个', () => {
  const m = (type: string, src: string) => ({ type, src, at: 1 }) as unknown as LinkMsg
  it('state / round-* 改认它；grade / bye 只收认定的；ping 谁问都回；map:* 不管', () => {
    expect(acceptFrom(null, m('solo:state', 'A'))).toEqual({ accept: true, src: 'A' })
    expect(acceptFrom('A', m('solo:round-end', 'B'))).toEqual({ accept: true, src: 'B' })
    expect(acceptFrom('B', m('solo:grade', 'A'))).toEqual({ accept: false, src: 'B' })
    expect(acceptFrom('B', m('solo:bye', 'B'))).toEqual({ accept: true, src: 'B' })
    expect(acceptFrom(null, m('solo:bye', 'B'))).toEqual({ accept: false, src: null })
    expect(acceptFrom('B', m('solo:ping', 'A'))).toEqual({ accept: true, src: 'B' })
    expect(acceptFrom('B', m('map:presence', 'C'))).toEqual({ accept: false, src: 'B' })
  })
})

describe('文案', () => {
  const end = { answer_name: '牧濑红莉栖', bound_work: { id: 1, name: '命运石之门' } }
  it('字幕和提示', () => {
    expect(captionText(end, 'hard')).toBe('上一题：牧濑红莉栖《命运石之门》· Hard')
    expect(captionText({ ...end, bound_work: null }, 'easy')).toBe('上一题：牧濑红莉栖 · Easy')
    expect(notInGroupText(end)).toBe('《命运石之门》不在联动的图里')
    expect(notInGroupText({ ...end, bound_work: null })).toBe('「牧濑红莉栖」不在联动的图里')
    expect(planSwitchText('秋季')).toBe('单人猜猜呗换了方案『秋季』，已换用它的图组')
    expect(planSwitchText(null)).toBe('单人猜猜呗换了方案『工作台方案』，已换用它的图组')
  })

  it('换方案的提示：新方案没有图组默认说「还没有联动图组」，只有预选说明谁都不在图里才用「哪张图里都没有」这句提示', () => {
    expect(planSwitchText('秋季', 2)).toBe('单人猜猜呗换了方案『秋季』，已换用它的图组')
    expect(planSwitchText('秋季', 0)).toBe('单人猜猜呗换了方案：方案『秋季』还没有联动图组')
    expect(planSwitchText(null, 0)).toBe('单人猜猜呗换了方案：方案『工作台方案』还没有联动图组')
    expect(planSwitchText('秋季', 0, true)).toBe('单人猜猜呗换了方案『秋季』；它题库里的人哪张图里都没有，图组先空着')
    // 有图组时 allMissing 不影响
    expect(planSwitchText('秋季', 1, true)).toBe('单人猜猜呗换了方案『秋季』，已换用它的图组')
  })

  it('allMissingOf：题库不空、而且每个人都不在任何图里', () => {
    expect(allMissingOf({ pool_total: 5, no_map: 5 })).toBe(true)
    expect(allMissingOf({ pool_total: 5, no_map: 4 })).toBe(false)
    // 预选失败 / 题库空：不能说「谁都不在图里」
    expect(allMissingOf({ pool_total: 0, no_map: 0 })).toBe(false)
  })
})

describe('字幕和提示放在哪：图区在工作区容器里的位置', () => {
  const body = { x: 300, y: 30, w: 500, h: 400 }
  it('量得到图区：换成容器坐标', () => {
    expect(boardInRoot({ left: 100, top: 50 }, { left: 410, top: 130, width: 480, height: 320 }, body)).toEqual({ x: 310, y: 80, w: 480, h: 320 })
  })
  it('量不到（没挂上 / 宽高为 0）：格子主体让出引擎顶栏', () => {
    expect(boardInRoot({ left: 0, top: 0 }, null, body)).toEqual({ x: 300, y: 70, w: 500, h: 360 })
    expect(boardInRoot({ left: 0, top: 0 }, { left: 0, top: 0, width: 0, height: 0 }, body)).toEqual({ x: 300, y: 70, w: 500, h: 360 })
    expect(boardInRoot({ left: 0, top: 0 }, null, { x: 0, y: 0, w: 100, h: 20 })).toEqual({ x: 0, y: 20, w: 100, h: 0 })
  })
  it('跟随格不在 → null', () => {
    expect(boardInRoot({ left: 0, top: 0 }, { left: 1, top: 1, width: 10, height: 10 }, null)).toBeNull()
  })

  it('noticeBox：放左下，右边不超过缩放百分比标签的左边', () => {
    const board = { x: 100, y: 50, w: 600, h: 400 }
    expect(noticeBox(board)).toEqual({ left: 108, bottom: 442, maxWidth: NOTICE_MAX_W })
    expect(noticeBox({ ...board, w: 2000 }).maxWidth).toBe(NOTICE_MAX_W)
  })

  it('noticeBox：左右分屏的格子 → 提示最宽到标签左边，不盖住标签', () => {
    // 例：右半格图区约 383 宽，标签在右下 10px、约 39 宽（x 683–723）；提示不能延伸到 x=716 盖住标签
    const board = { x: 341, y: 60, w: 383, h: 500 }
    const nb = noticeBox(board)
    const badgeLeft = board.x + board.w - 10 - 45
    expect(nb.left + nb.maxWidth).toBeLessThanOrEqual(badgeLeft)
    expect(nb.left + nb.maxWidth).toBe(board.x + board.w - ZOOM_BADGE_RESERVE_W)
    expect(nb.bottom).toBe(board.y + board.h - 8)
  })

  it('noticeBox：格子太窄（标签左边放不下 160）→ 放到标签上面、占满一行', () => {
    const board = { x: 0, y: 0, w: 200, h: 300 }
    const nb = noticeBox(board)
    expect(nb).toEqual({ left: 8, bottom: 300 - ZOOM_BADGE_RESERVE_H, maxWidth: 184 })
    // 标签上沿：离底 10 + 高约 22 = 32；提示下边在它上面
    expect(nb.bottom).toBeLessThanOrEqual(board.y + board.h - 32)
  })
})

describe('设置面板', () => {
  const WIN = { left: 0, top: 0, right: 760, bottom: 400 }
  it('panelBox：右边对齐按钮、在按钮下面；夹进容器；装不下就限高', () => {
    expect(panelBox({ right: 900, bottom: 30 }, { w: 1000, h: 700 })).toEqual({ left: 560, top: 34, width: 340, maxHeight: 658 })
    // 按钮靠左：不出左边
    expect(panelBox({ right: 200, bottom: 30 }, { w: 1000, h: 700 }).left).toBe(4)
    // 按钮在最右：不出右边
    expect(panelBox({ right: 1200, bottom: 30 }, { w: 1000, h: 700 }).left).toBe(656)
    // 容器很窄：面板变窄；按钮下面放不下 PANEL_MIN_H → 往上挪到顶，高度用满
    expect(panelBox({ right: 300, bottom: 30 }, { w: 300, h: 200 })).toEqual({ left: 4, top: 4, width: 292, maxHeight: 188 })
    // 容器很矮：不出下边
    const low = panelBox({ right: 300, bottom: 30 }, { w: 1000, h: 100 })
    expect(low.top + low.maxHeight).toBeLessThanOrEqual(100)
    expect(low).toEqual({ left: 4, top: 4, width: 340, maxHeight: 88 })
  })

  it('panelBox：按钮下面够 PANEL_MIN_H 就不挪；不够只挪到刚好够', () => {
    expect(panelBox({ right: 900, bottom: 30 }, { w: 1000, h: 400 }).top).toBe(34)
    // 按钮在 300：下面只剩 92，往上挪到 hi - PANEL_MIN_H
    expect(panelBox({ right: 900, bottom: 300 }, { w: 1000, h: 400 })).toEqual({ left: 560, top: 392 - PANEL_MIN_H, width: 340, maxHeight: PANEL_MIN_H })
  })

  it('panelBox：只放在容器看得见的那块里（矮窗口 760×400）', () => {
    // 容器从窗口 y=40 开始、高 700（下面 340 在窗口外）；按钮在容器 y=250
    const area = visibleArea({ left: 0, top: 40 }, { w: 760, h: 700 }, WIN)
    expect(area).toEqual({ x0: 0, y0: 0, x1: 760, y1: 360 })
    const b = panelBox({ right: 740, bottom: 250 }, { w: 760, h: 700 }, area)
    // 换回窗口坐标：上沿 ≥ 0，下沿 ≤ 400
    expect(b.top + 40).toBeGreaterThanOrEqual(0)
    expect(b.top + b.maxHeight + 40).toBeLessThanOrEqual(400)
    expect(b).toEqual({ left: 400, top: 352 - PANEL_MIN_H, width: 340, maxHeight: PANEL_MIN_H })
  })

  it('panelBox：矮窗口——容器从 y=265 开始，只露出 135px：面板整个在窗口里', () => {
    const area = visibleArea({ left: 17, top: 266 }, { w: 726, h: 354 }, WIN)
    expect(area).toEqual({ x0: 0, y0: 0, x1: 726, y1: 134 })
    const b = panelBox({ right: 697, bottom: 27 }, { w: 726, h: 354 }, area)
    expect(b.top + 266).toBeGreaterThanOrEqual(0)
    expect(b.top + b.maxHeight + 266).toBeLessThanOrEqual(400)
    // 头 125 + 尾 45 都放不下：整个面板一起滚
    expect(panelCompact(b.maxHeight, 125, 45)).toBe(true)
  })

  it('panelCompact：头、尾固定后中间还能露出 PANEL_MIDDLE_MIN_H 才分开滚', () => {
    expect(panelCompact(125 + 45 + PANEL_MIDDLE_MIN_H, 125, 45)).toBe(false)
    expect(panelCompact(125 + 45 + PANEL_MIDDLE_MIN_H - 1, 125, 45)).toBe(true)
    expect(panelCompact(658, 125, 45)).toBe(false)
  })

  it('visibleArea：容器和裁剪范围的交集（容器坐标）', () => {
    // 页面往下滚了，容器上面 100 在窗口外
    expect(visibleArea({ left: 0, top: -100 }, { w: 800, h: 600 }, { left: 0, top: 0, right: 800, bottom: 400 })).toEqual({ x0: 0, y0: 100, x1: 800, y1: 500 })
    // 整个在窗口里
    expect(visibleArea({ left: 10, top: 10 }, { w: 300, h: 200 }, { left: 0, top: 0, right: 800, bottom: 400 })).toEqual({ x0: 0, y0: 0, x1: 300, y1: 200 })
    // 外层滚动区（窗口坐标 y 60–300）把容器上下都裁掉一截
    expect(visibleArea({ left: 0, top: 20 }, { w: 300, h: 400 }, { left: 0, top: 60, right: 800, bottom: 300 })).toEqual({ x0: 0, y0: 40, x1: 300, y1: 280 })
    // 完全在外面：空区域，不倒过来
    const off = visibleArea({ left: 0, top: 500 }, { w: 300, h: 200 }, { left: 0, top: 0, right: 800, bottom: 400 })
    expect(off.y1).toBe(off.y0)
  })

  it('clipTo：两块矩形的交集；不相交时宽高为 0', () => {
    expect(clipTo({ left: 0, top: 0, right: 800, bottom: 400 }, { left: 100, top: 50, right: 900, bottom: 300 })).toEqual({ left: 100, top: 50, right: 800, bottom: 300 })
    const none = clipTo({ left: 0, top: 0, right: 100, bottom: 100 }, { left: 200, top: 200, right: 300, bottom: 300 })
    expect(none.right - none.left).toBe(0)
    expect(none.bottom - none.top).toBe(0)
  })

  it('planNameOfKey', () => {
    expect(planNameOfKey('plan:秋季')).toBe('秋季')
    expect(planNameOfKey('workbench')).toBeNull()
    expect(planNameOfKey('plan:')).toBeNull()
  })

  it('initialGroup：跟随中同方案 → 正在用的；否则记住的；都没有 → 预选', () => {
    const base = { followIds: ['a', 'b', 'a'], picked: ['p1', 'p2'], remembered: { map_ids: ['r1'] } }
    expect(initialGroup({ ...base, followingHere: true, followPlanKey: 'plan:A', planKey: 'plan:A' })).toEqual(['a', 'b'])
    expect(initialGroup({ ...base, followingHere: true, followPlanKey: 'plan:A', planKey: 'plan:B' })).toEqual(['r1'])
    expect(initialGroup({ ...base, followingHere: false, followPlanKey: 'plan:A', planKey: 'plan:A' })).toEqual(['r1'])
    expect(initialGroup({ ...base, remembered: null, followingHere: false, followPlanKey: null, planKey: 'workbench' })).toEqual(['p1', 'p2'])
  })

  it('sameGroup：顺序也算', () => {
    expect(sameGroup(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameGroup(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameGroup(['a'], ['a', 'b'])).toBe(false)
  })
})

describe('实例重挂后恢复聚焦：restoreFocus', () => {
  const stay: FocusRecord = { mode: 'stay', revealed: true, flashEnd: null }
  it('停留：恢复高亮；reveal 做过了不移动视区；多久以后重挂都恢复', () => {
    expect(restoreFocus(stay, 10_000, false)).toEqual({ mode: 'stay', reveal: false, clearAfter: null })
    expect(restoreFocus(stay, 10_000_000, false)).toEqual({ mode: 'stay', reveal: false, clearAfter: null })
  })
  it('停留、reveal 还排着：重挂时再 reveal；题目进行中不移动视区', () => {
    const pending: FocusRecord = { mode: 'stay', revealed: false, flashEnd: null }
    expect(restoreFocus(pending, 0, false)).toEqual({ mode: 'stay', reveal: true, clearAfter: null })
    expect(restoreFocus(pending, 0, true)).toEqual({ mode: 'stay', reveal: false, clearAfter: null })
  })
  it('闪烁：正在闪 → 按剩下的时间亮着（不从头重闪）；闪完了 → 不恢复', () => {
    const t0 = 1_000_000
    const flash: FocusRecord = { mode: 'flash', revealed: true, flashEnd: t0 + FLASH_MS }
    expect(restoreFocus(flash, t0 + 500, false)).toEqual({ mode: 'stay', reveal: false, clearAfter: FLASH_MS - 500 })
    // 闪烁结束后 1.7–3 秒重挂，不会从头闪
    expect(restoreFocus(flash, t0 + 1700, false)).toBeNull()
    expect(restoreFocus(flash, t0 + 3000, false)).toBeNull()
    expect(restoreFocus(flash, t0 + FLASH_MS, false)).toBeNull()
  })
  it('闪烁还排着、没开始：原样再来一次（进行中不移动视区）', () => {
    const queued: FocusRecord = { mode: 'flash', revealed: false, flashEnd: null }
    expect(restoreFocus(queued, 0, false)).toEqual({ mode: 'flash', reveal: true, clearAfter: null })
    expect(restoreFocus(queued, 0, true)).toEqual({ mode: 'flash', reveal: false, clearAfter: null })
  })
})
