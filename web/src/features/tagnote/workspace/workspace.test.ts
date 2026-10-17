/**
 * 导图工作区：树操作（开 / 换 / 关 / 移 / 分屏 / 调大小）、几何、落点、存储校验、列表点击语义、
 * 运行时（切走前快照视区、保活顺序）、标签色点。vitest 跑在 node 环境，界面交互在浏览器里用 playwright 查。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TagNoteData, TagNoteInstance } from '@/vendor/tagnote/tagnote.esm.js'
import { DEFAULT_PREFS, TagNoteBinding, type EngineLike } from '../binding'
import { TAGNOTE_STORE_KEY, useTagNoteLocal } from '../store'
import type { MapSummary } from '../types'
import { captureNow, prefsFromEngine, registerLive, useWsRuntime, viewportsOf, wsActions } from './actions'
import { groupDotClass, mapLabels } from './labels'
import {
  EDGE_ZONE,
  GHOST_H,
  GHOST_MAX_W,
  GHOST_MIN_W,
  MIN_PANE_H,
  MIN_PANE_W,
  activeTabOf,
  afterMapDeleted,
  aliveTabs,
  applyDrop,
  cleanViewport,
  clickIntent,
  closeOthers,
  closeTab,
  computeLayout,
  dragSizes,
  dropZone,
  emptyWorkspace,
  ghostRect,
  isNoopDrop,
  minExtent,
  moveTab,
  normSizes,
  normalizeWorkspace,
  openMap,
  panesOf,
  pruneMaps,
  setSplitSizes,
  setTabViewport,
  splitTab,
  touchMru,
  zoneRect,
} from './tree'
import { VIEW_KEYS, type LayoutNode, type PaneNode, type SplitNode, type ViewKey, type Viewport, type Workspace } from './types'

// ---------------------------------------------------------------- 工具
/** 依次新开这些图（都在当前格） */
const opened = (...maps: string[]) => maps.reduce((w, m) => openMap(w, m, { newTab: true }), emptyWorkspace())
/** 树的简写：格子 = "p1[t2*,t3]"（* = 当前标签），分屏 = "row(…|…)" */
function shape(n: LayoutNode): string {
  if (n.type === 'pane') return `${n.id}[${n.tabs.map((t) => (t === n.active ? `${t}*` : t)).join(',')}]`
  return `${n.dir}(${n.children.map(shape).join('|')})`
}
const maps = (ws: Workspace) => Object.fromEntries(Object.values(ws.tabs).map((t) => [t.id, t.mapId]))
const split = (n: LayoutNode) => n as SplitNode
const pane = (ws: Workspace, id: string) => panesOf(ws.root).find((p) => p.id === id) as PaneNode

// ---------------------------------------------------------------- 打开 / 列表点击
describe('列表点击语义：单击换图、Ctrl / 中键新开、已开着的直接切过去', () => {
  it('clickIntent：左键 = 换图，Ctrl / ⌘ + 左键、中键 = 新开，右键不处理', () => {
    expect(clickIntent({ button: 0, ctrlKey: false, metaKey: false })).toBe('replace')
    expect(clickIntent({ button: 0, ctrlKey: true, metaKey: false })).toBe('newTab')
    expect(clickIntent({ button: 0, ctrlKey: false, metaKey: true })).toBe('newTab')
    expect(clickIntent({ button: 1, ctrlKey: false, metaKey: false })).toBe('newTab')
    expect(clickIntent({ button: 2, ctrlKey: false, metaKey: false })).toBeNull()
  })

  it('没有标签时单击也是新开；opened 变成 true', () => {
    const ws = openMap(emptyWorkspace(), 'A')
    expect(shape(ws.root)).toBe('p1[t2*]')
    expect(ws.tabs.t2).toEqual({ id: 't2', mapId: 'A', view: null, viewports: {} })
    expect(ws.opened).toBe(true)
  })

  it('单击 = 当前标签换图：标签 id 和视图不变，视区清空', () => {
    let ws = opened('A')
    ws = { ...ws, tabs: { t2: { ...ws.tabs.t2, view: 'kmap', viewports: { kmap: { zoom: 2, cx: 1, cy: 1 } } } } }
    const next = openMap(ws, 'B')
    expect(shape(next.root)).toBe('p1[t2*]')
    expect(next.tabs.t2).toEqual({ id: 't2', mapId: 'B', view: 'kmap', viewports: {} })
  })

  it('新开：插在当前标签右边、成为当前标签，视图用传进来的「上次视图」', () => {
    let ws = opened('A', 'B') // p1[t2,t3*]
    ws = openMap(ws, 'B') // 已开着 → 不变
    ws = { ...ws, root: { ...pane(ws, 'p1'), active: 't2' } }
    ws = openMap(ws, 'C', { newTab: true, view: 'score' })
    expect(shape(ws.root)).toBe('p1[t2,t4*,t3]')
    expect(ws.tabs.t4.view).toBe('score')
  })

  it('这一格已经有标签在看这张图 → 切过去，不重复开；什么都没变时原样返回', () => {
    const ws = opened('A', 'B')
    const back = openMap(ws, 'A', { newTab: true })
    expect(shape(back.root)).toBe('p1[t2*,t3]')
    expect(Object.keys(back.tabs)).toHaveLength(2)
    expect(openMap(back, 'A')).toBe(back)
  })

  it('pane 参数：在指定的格子开，并让它成为当前格；别的格子开着同一张图不算', () => {
    let ws = splitTab(opened('A', 'B'), 't3', 'p1', 'right') // row(p1[t2*]|p4[t3*])，当前格 p4
    expect(ws.activePane).toBe('p4')
    ws = openMap(ws, 'B', { newTab: true, pane: 'p1' })
    expect(shape(ws.root)).toBe('row(p1[t2,t6*]|p4[t3*])')
    expect(ws.activePane).toBe('p1')
    expect(activeTabOf(ws)?.mapId).toBe('B')
  })
})

// ---------------------------------------------------------------- 关闭
describe('关闭：当前标签让给右边；一格关光就收起；整个工作区关光留一格空的', () => {
  it('关当前标签 → 右边那个；没有右边 → 左边那个', () => {
    let ws = opened('A', 'B', 'C') // p1[t2,t3,t4*]
    ws = { ...ws, root: { ...pane(ws, 'p1'), active: 't3' } }
    ws = closeTab(ws, 't3')
    expect(shape(ws.root)).toBe('p1[t2,t4*]')
    ws = closeTab(ws, 't4')
    expect(shape(ws.root)).toBe('p1[t2*]')
  })

  it('一格里最后一个标签关掉 → 这一格收起，兄弟补位；同方向的分屏拍平', () => {
    let ws = opened('A', 'B', 'C') // p1[t2,t3,t4*]
    ws = splitTab(ws, 't4', 'p1', 'right') // row(p1|p5)
    ws = splitTab(ws, 't3', 'p5', 'bottom') // row(p1|col(p5|p7))
    expect(shape(ws.root)).toBe('row(p1[t2*]|col(p5[t4*]|p7[t3*]))')
    expect(ws.activePane).toBe('p7')
    // 关不是当前格的 p5 → col 只剩 p7，由它顶替；当前格不变
    let w = closeTab(ws, 't4')
    expect(shape(w.root)).toBe('row(p1[t2*]|p7[t3*])')
    expect(split(w.root).sizes).toEqual([0.5, 0.5])
    expect(w.activePane).toBe('p7')
    // 关当前格 p7 的最后一个标签 → 当前格交给挨着的 p5
    w = closeTab(ws, 't3')
    expect(shape(w.root)).toBe('row(p1[t2*]|p5[t4*])')
    expect(w.activePane).toBe('p5')
  })

  it('三格并排关掉中间那格：比例按剩下的重新归一', () => {
    let ws = opened('A', 'B', 'C')
    ws = splitTab(ws, 't4', 'p1', 'right')
    ws = splitTab(ws, 't3', 'p5', 'right') // row(p1|p5|p7)，同方向插成兄弟
    expect(shape(ws.root)).toBe('row(p1[t2*]|p5[t4*]|p7[t3*])')
    expect(split(ws.root).sizes).toEqual([0.5, 0.25, 0.25])
    ws = closeTab(ws, 't4')
    expect(shape(ws.root)).toBe('row(p1[t2*]|p7[t3*])')
    expect(split(ws.root).sizes).toEqual([0.6667, 0.3333])
  })

  it('整个工作区关光：留一格空的，opened 仍是 true（不会自动再开图）', () => {
    let ws = splitTab(opened('A', 'B'), 't3', 'p1', 'right')
    ws = closeTab(closeTab(ws, 't2'), 't3')
    expect(shape(ws.root)).toBe('p4[]')
    expect(ws.activePane).toBe('p4')
    expect(ws.tabs).toEqual({})
    expect(ws.opened).toBe(true)
    expect(activeTabOf(ws)).toBeNull()
  })

  it('关闭其他：只关同一格的；只有一个标签时只是激活它', () => {
    let ws = opened('A', 'B', 'C')
    ws = splitTab(ws, 't2', 'p1', 'bottom') // col(p1[t3,t4*]|p5[t2*])
    ws = closeOthers(ws, 't3')
    expect(shape(ws.root)).toBe('col(p1[t3*]|p5[t2*])')
    expect(Object.keys(ws.tabs).sort()).toEqual(['t2', 't3'])
    expect(ws.activePane).toBe('p1')
    expect(closeOthers(ws, 't3')).toBe(ws)
  })

  it('关不存在的标签：原样返回', () => {
    const ws = opened('A')
    expect(closeTab(ws, 'nope')).toBe(ws)
  })
})

// ---------------------------------------------------------------- 移动 / 分屏 / 落点
describe('移动和分屏', () => {
  it('同一格里换顺序；位置没变时原样返回', () => {
    const ws = opened('A', 'B', 'C') // p1[t2,t3,t4*]
    expect(shape(moveTab(ws, 't2', 'p1', 2).root)).toBe('p1[t3,t4,t2*]')
    expect(shape(moveTab(ws, 't4', 'p1', 0).root)).toBe('p1[t4*,t2,t3]')
    expect(moveTab(ws, 't4', 'p1', 2)).toBe(ws)
  })

  it('移到别的格子：插到指定位置、成为那一格的当前标签；原来那格空了就收起', () => {
    let ws = splitTab(opened('A', 'B', 'C'), 't4', 'p1', 'right') // row(p1[t2,t3*]|p5[t4*])
    ws = moveTab(ws, 't2', 'p5', 0)
    expect(shape(ws.root)).toBe('row(p1[t3*]|p5[t2*,t4])')
    expect(ws.activePane).toBe('p5')
    ws = moveTab(ws, 't3', 'p5', Infinity)
    expect(shape(ws.root)).toBe('p5[t2,t4,t3*]')
  })

  it('拖到边缘 = 移过去分出一格；某格唯一的标签拖到自己边缘 = 什么都不做', () => {
    const ws = opened('A', 'B')
    const left = splitTab(ws, 't3', 'p1', 'left')
    expect(shape(left.root)).toBe('row(p4[t3*]|p1[t2*])')
    expect(left.activePane).toBe('p4')
    const top = splitTab(ws, 't2', 'p1', 'top')
    expect(shape(top.root)).toBe('col(p4[t2*]|p1[t3*])')
    const one = opened('A')
    expect(splitTab(one, 't2', 'p1', 'right')).toBe(one)
  })

  it('另一个方向 = 嵌套；同方向 = 插成兄弟、平分目标那一格', () => {
    let ws = splitTab(opened('A', 'B', 'C'), 't4', 'p1', 'right') // row(p1|p5)
    const nested = splitTab(ws, 't3', 'p5', 'bottom')
    expect(shape(nested.root)).toBe('row(p1[t2*]|col(p5[t4*]|p7[t3*]))')
    expect(split(nested.root).sizes).toEqual([0.5, 0.5])
    ws = setSplitSizes(ws, split(ws.root).id, [0.6, 0.4])
    const sib = splitTab(ws, 't3', 'p5', 'left')
    expect(shape(sib.root)).toBe('row(p1[t2*]|p7[t3*]|p5[t4*])')
    expect(split(sib.root).sizes).toEqual([0.6, 0.2, 0.2])
  })

  it('右键分屏 = 复制：新标签看同一张图、同一视图和视区（各自一份），原标签不动', () => {
    let ws = opened('A')
    ws = setTabViewport({ ...ws, tabs: { t2: { ...ws.tabs.t2, view: 'kmap' } } }, 't2', 'kmap', { zoom: 2, cx: 5, cy: 6 })
    const c = splitTab(ws, 't2', 'p1', 'right', true)
    expect(shape(c.root)).toBe('row(p1[t2*]|p4[t3*])')
    expect(c.tabs.t3).toEqual({ id: 't3', mapId: 'A', view: 'kmap', viewports: { kmap: { zoom: 2, cx: 5, cy: 6 } } })
    expect(c.tabs.t3.viewports).not.toBe(c.tabs.t2.viewports)
    // 唯一的标签也能复制到自己旁边
    expect(shape(splitTab(c, 't3', 'p4', 'bottom', true).root)).toBe('row(p1[t2*]|col(p4[t3*]|p7[t6*]))')
  })

  it('isNoopDrop / applyDrop：放回原处不变（只激活它）', () => {
    const ws = splitTab(opened('A', 'B', 'C'), 't4', 'p1', 'right') // row(p1[t2,t3*]|p5[t4*])
    expect(isNoopDrop(ws, 't3', { kind: 'center', pane: 'p1' })).toBe(true)
    expect(isNoopDrop(ws, 't3', { kind: 'tabs', pane: 'p1', index: 1 })).toBe(true)
    expect(isNoopDrop(ws, 't3', { kind: 'tabs', pane: 'p1', index: 0 })).toBe(false)
    expect(isNoopDrop(ws, 't4', { kind: 'edge', pane: 'p5', edge: 'left' })).toBe(true)
    expect(isNoopDrop(ws, 't3', { kind: 'edge', pane: 'p1', edge: 'left' })).toBe(false)
    expect(isNoopDrop(ws, 't3', { kind: 'center', pane: 'p5' })).toBe(false)
    const a = applyDrop(ws, 't2', { kind: 'center', pane: 'p1' })
    expect(shape(a.root)).toBe('row(p1[t2*,t3]|p5[t4*])')
    expect(a.activePane).toBe('p1')
    expect(shape(applyDrop(ws, 't2', { kind: 'center', pane: 'p5' }).root)).toBe('row(p1[t3*]|p5[t4,t2*])')
    expect(shape(applyDrop(ws, 't2', { kind: 'edge', pane: 'p5', edge: 'bottom' }).root)).toBe('row(p1[t3*]|col(p5[t4*]|p7[t2*]))')
  })
})

// ---------------------------------------------------------------- 大小 / 几何 / 落点
describe('大小和几何', () => {
  it('normSizes：加起来是 1；坏值、长度不对就平分', () => {
    expect(normSizes([2, 2])).toEqual([0.5, 0.5])
    expect(normSizes([1, 1, 1])).toEqual([0.3333, 0.3333, 0.3334])
    expect(normSizes([1, Number.NaN])).toEqual([0.5, 0.5])
    expect(normSizes([1], 2)).toEqual([0.5, 0.5])
    expect(normSizes([0, 0])).toEqual([0.5, 0.5])
  })

  it('setSplitSizes：归一后写进去；长度不对、没变化都原样返回', () => {
    const ws = splitTab(opened('A', 'B'), 't3', 'p1', 'right')
    const id = split(ws.root).id
    const w = setSplitSizes(ws, id, [3, 1])
    expect(split(w.root).sizes).toEqual([0.75, 0.25])
    expect(setSplitSizes(w, id, [0.75, 0.25])).toBe(w)
    expect(setSplitSizes(w, id, [1, 1, 1])).toBe(w)
    expect(setSplitSizes(w, 'nope', [1, 1])).toBe(w)
  })

  it('dragSizes：两边加起来不变、各自不小于最小比例；最小值加起来放不下时按比例分', () => {
    const r4 = (xs: number[]) => xs.map((x) => Math.round(x * 1e4) / 1e4)
    expect(r4(dragSizes([0.5, 0.5], 0, 0.1, 0.2, 0.2))).toEqual([0.6, 0.4])
    expect(r4(dragSizes([0.5, 0.5], 0, 0.9, 0.2, 0.2))).toEqual([0.8, 0.2])
    expect(r4(dragSizes([0.5, 0.5], 0, -0.9, 0.2, 0.3))).toEqual([0.2, 0.8])
    const [a, b] = dragSizes([0.5, 0.5], 0, 0.3, 0.6, 0.6)
    expect(a).toBeCloseTo(0.5)
    expect(b).toBeCloseTo(0.5)
    // 三个孩子：只动第 1、2 个
    const three = dragSizes([0.4, 0.3, 0.3], 1, 0.1, 0.1, 0.1)
    expect(three[0]).toBe(0.4)
    expect(three[1]).toBeCloseTo(0.4)
    expect(three[2]).toBeCloseTo(0.2)
  })

  it('minExtent：同方向相加（含分隔线），另一个方向取最大', () => {
    const ws = splitTab(splitTab(opened('A', 'B', 'C'), 't4', 'p1', 'right'), 't3', 'p5', 'bottom') // row(p1|col(p5|p7))
    expect(minExtent(ws.root, 'row')).toBe(MIN_PANE_W * 2 + 1)
    expect(minExtent(ws.root, 'col')).toBe(MIN_PANE_H * 2 + 1)
    expect(minExtent(split(ws.root).children[1], 'row')).toBe(MIN_PANE_W)
  })

  it('computeLayout：按比例切、分隔线 1px、最后一格吃掉取整的零头；拖动中的临时比例优先', () => {
    const ws = splitTab(splitTab(opened('A', 'B', 'C'), 't4', 'p1', 'right'), 't3', 'p5', 'bottom')
    const g = computeLayout(ws.root, 1001, 601)
    expect(g.panes.p1).toEqual({ x: 0, y: 0, w: 500, h: 601 })
    expect(g.panes.p5).toEqual({ x: 501, y: 0, w: 500, h: 300 })
    expect(g.panes.p7).toEqual({ x: 501, y: 301, w: 500, h: 300 })
    const [v, h] = g.splitters
    expect(v).toMatchObject({ splitId: split(ws.root).id, index: 0, dir: 'row', line: { x: 500, y: 0, w: 1, h: 601 }, avail: 1000 })
    expect(v.minA).toBeCloseTo(MIN_PANE_W / 1000)
    expect(h).toMatchObject({ dir: 'col', line: { x: 501, y: 300, w: 500, h: 1 }, avail: 600 })
    const live = computeLayout(ws.root, 1001, 601, { [split(ws.root).id]: [0.3, 0.7] })
    expect(live.panes.p1.w).toBe(300)
    expect(live.panes.p5.x).toBe(301)
  })

  it('dropZone / zoneRect：离边缘不到 1/4 = 那条边，其余 = 中间；提示是那一半或整块', () => {
    const body = { x: 100, y: 50, w: 400, h: 300 }
    expect(EDGE_ZONE).toBe(0.25)
    expect(dropZone(body, 490, 200)).toBe('right')
    expect(dropZone(body, 110, 200)).toBe('left')
    expect(dropZone(body, 300, 60)).toBe('top')
    expect(dropZone(body, 300, 340)).toBe('bottom')
    expect(dropZone(body, 300, 200)).toBe('center')
    expect(dropZone({ x: 0, y: 0, w: 0, h: 0 }, 0, 0)).toBe('center')
    expect(zoneRect(body, 'right')).toEqual({ x: 300, y: 50, w: 200, h: 300 })
    expect(zoneRect(body, 'bottom')).toEqual({ x: 100, y: 200, w: 400, h: 150 })
    expect(zoneRect(body, 'center')).toEqual(body)
  })

  it('ghostRect：影子比标签大一圈、在鼠标右下方不挡落点；放不下翻到左边 / 上边，始终在容器里', () => {
    // 窄标签也至少 GHOST_MIN_W 宽，宽标签最多 GHOST_MAX_W
    expect(ghostRect(100, 10, 72, 1200, 800)).toEqual({ x: 114, y: 26, w: GHOST_MIN_W })
    expect(ghostRect(100, 10, 400, 1200, 800).w).toBe(GHOST_MAX_W)
    expect(ghostRect(100, 10, 200, 1200, 800).w).toBe(200)
    // 鼠标所在的点不被影子盖住（标签栏里的插入竖线就在鼠标下面）
    const g = ghostRect(600, 15, 200, 1200, 800)
    expect(600 < g.x || 600 > g.x + g.w || 15 < g.y || 15 > g.y + GHOST_H).toBe(true)
    // 靠右边：翻到鼠标左边；靠下边：翻到鼠标上边
    expect(ghostRect(1150, 10, 200, 1200, 800).x).toBe(1150 - 14 - 200)
    expect(ghostRect(100, 790, 200, 1200, 800).y).toBe(790 - 16 - GHOST_H)
    // 容器比影子还窄：贴着左边，不出界
    const tiny = ghostRect(50, 10, 200, 150, 800)
    expect(tiny.x).toBe(4)
    expect(tiny.x + tiny.w).toBeLessThanOrEqual(150 - 4)
  })
})

// ---------------------------------------------------------------- 删除 / 清理 / 保活
describe('图被删、保活顺序', () => {
  it('afterMapDeleted：当前标签正看着它 → 换成下一张；别的看着它的标签关掉', () => {
    let ws = opened('A', 'B') // p1[t2,t3*]
    ws = splitTab(ws, 't3', 'p1', 'right', true) // row(p1[t2,t3*]|p5[t4*])，t4 也看 B，当前格 p5
    const w = afterMapDeleted(ws, 'B', 'C')
    expect(shape(w.root)).toBe('row(p1[t2*]|p5[t4*])')
    expect(maps(w)).toEqual({ t2: 'A', t4: 'C' })
    // 删的不是当前看的：只关掉看它的标签
    const w2 = afterMapDeleted(ws, 'A', 'C')
    expect(maps(w2)).toEqual({ t3: 'B', t4: 'B' })
  })

  it('pruneMaps：方案库里没有了的图安静关掉；一个都不用关就原样返回', () => {
    const ws = opened('A', 'B', 'C')
    expect(pruneMaps(ws, () => true)).toBe(ws)
    const w = pruneMaps(ws, (id) => id !== 'B')
    expect(shape(w.root)).toBe('p1[t2,t4*]')
  })

  it('aliveTabs：每格的当前标签一定保留（超过上限也留），其余按最近用过的补', () => {
    let ws = opened('A', 'B', 'C', 'D') // p1[t2,t3,t4,t5*]
    ws = splitTab(ws, 't5', 'p1', 'right') // row(p1[t2,t3,t4*]|p6[t5*])
    expect([...aliveTabs(ws, ['t2', 't3'], 1)].sort()).toEqual(['t4', 't5'])
    expect([...aliveTabs(ws, ['t2', 'gone', 't3'], 3)].sort()).toEqual(['t2', 't4', 't5'])
  })

  it('touchMru：当前格的当前标签排第一，关掉的去掉；没变原样返回', () => {
    let ws = splitTab(opened('A', 'B', 'C'), 't4', 'p1', 'right') // row(p1[t2,t3*]|p5[t4*])，当前格 p5
    const m1 = touchMru(ws, ['t2', 't9'])
    expect(m1).toEqual(['t4', 't3', 't2'])
    expect(touchMru(ws, m1)).toBe(m1)
    ws = closeTab(ws, 't2')
    expect(touchMru(ws, m1)).toEqual(['t4', 't3'])
  })
})

// ---------------------------------------------------------------- 存储校验
describe('normalizeWorkspace：修好存坏了的工作区，绝不抛错', () => {
  it('重复、悬空的标签去掉；坏视图、坏视区丢掉；重复的格子 id 换新；空格子收起；比例对上孩子数', () => {
    const raw = {
      tabs: {
        t2: { id: 't2', mapId: 'A', view: 'kmap', viewports: { kmap: { zoom: 9, cx: 1.234, cy: 2 }, nope: { zoom: 1, cx: 0, cy: 0 }, canvas: { zoom: 'x' } } },
        t3: { id: 't3', mapId: 'B', view: 'weird', viewports: {} },
        t9: { id: 't9', mapId: '', view: null, viewports: {} },
      },
      root: {
        type: 'split',
        id: 's4',
        dir: 'row',
        sizes: [1],
        children: [
          { type: 'pane', id: 'p1', tabs: ['t2', 'ghost', 't2'], active: 'ghost' },
          { type: 'pane', id: 'p1', tabs: ['t3', 't2', 't9'], active: 't3' },
          { type: 'pane', id: 'p7', tabs: [], active: null },
        ],
      },
      activePane: 'p99',
      seq: 0,
      opened: false,
    } as unknown as Workspace
    const ws = normalizeWorkspace(raw)
    expect(shape(ws.root)).toBe('row(p1[t2*]|p10[t3*])')
    expect(split(ws.root).sizes).toEqual([0.5, 0.5])
    expect(ws.tabs).toEqual({
      t2: { id: 't2', mapId: 'A', view: 'kmap', viewports: { kmap: { zoom: 3, cx: 1.2, cy: 2 } } },
      t3: { id: 't3', mapId: 'B', view: null, viewports: {} },
    })
    expect(ws.activePane).toBe('p1')
    expect(ws.seq).toBe(10)
    expect(ws.opened).toBe(true)
    // 再整理一遍不变；新开的标签 id 不会和旧的撞
    expect(normalizeWorkspace(ws)).toEqual(ws)
    expect(Object.keys(openMap(ws, 'C', { newTab: true }).tabs)).toContain('t11')
  })

  it('全空：一格空的', () => {
    expect(normalizeWorkspace(emptyWorkspace())).toEqual(emptyWorkspace())
  })

  it('setTabViewport：缩放夹在 25%–300%、坐标留 1 位小数；一样的不写；坏值不写', () => {
    const ws = opened('A')
    const w = setTabViewport(ws, 't2', 'canvas', { zoom: 0.1, cx: 10.06, cy: -3.04 })
    expect(w.tabs.t2.viewports.canvas).toEqual({ zoom: 0.25, cx: 10.1, cy: -3 })
    expect(setTabViewport(w, 't2', 'canvas', { zoom: 0.2, cx: 10.1, cy: -3 })).toBe(w)
    expect(setTabViewport(w, 't2', 'canvas', { zoom: Number.NaN, cx: 0, cy: 0 })).toBe(w)
    expect(setTabViewport(w, 'nope', 'canvas', { zoom: 1, cx: 0, cy: 0 })).toBe(w)
  })

  it('setTabViewport：可选的 home 只留 true；只有 home 变了也写；home 不是 true、多余的 x0/y0 都去掉、不连累整个视区', () => {
    const w = setTabViewport(opened('A'), 't2', 'canvas', { zoom: 1, cx: 400, cy: 300, home: true })
    expect(w.tabs.t2.viewports.canvas).toEqual({ zoom: 1, cx: 400, cy: 300, home: true })
    expect(setTabViewport(w, 't2', 'canvas', { zoom: 1, cx: 400, cy: 300, home: true })).toBe(w)
    // 平移离开初始位置：引擎报上来的视区不带 home → 要写（哪怕 zoom/cx/cy 碰巧一样）
    const moved = setTabViewport(w, 't2', 'canvas', { zoom: 1, cx: 400, cy: 300 })
    expect(moved).not.toBe(w)
    expect(moved.tabs.t2.viewports.canvas).toEqual({ zoom: 1, cx: 400, cy: 300 })
    expect(setTabViewport(moved, 't2', 'canvas', { zoom: 1, cx: 400, cy: 300, home: true }).tabs.t2.viewports.canvas?.home).toBe(true)
    const bad = setTabViewport(opened('A'), 't2', 'canvas', { zoom: 1, cx: 1, cy: 2, home: false, x0: -22, y0: 5 } as unknown as Viewport)
    expect(bad.tabs.t2.viewports.canvas).toEqual({ zoom: 1, cx: 1, cy: 2 })
    expect(Object.keys(bad.tabs.t2.viewports.canvas ?? {})).toEqual(['zoom', 'cx', 'cy'])
    expect(cleanViewport({ zoom: 1, cx: 1, cy: 2, home: 'yes' })).toEqual({ zoom: 1, cx: 1, cy: 2 })
    expect(cleanViewport({ zoom: 1, cx: 1, cy: 2, home: 1 })).toEqual({ zoom: 1, cx: 1, cy: 2 })
  })
})

// ---------------------------------------------------------------- 持久化（store + actions）
describe('工作区持久化', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    localStorage.clear()
    useTagNoteLocal.setState({ workspace: emptyWorkspace(), prefs: { ...DEFAULT_PREFS } })
    useWsRuntime.setState({ mru: [] })
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

  const stored = () => JSON.parse(localStorage.getItem(TAGNOTE_STORE_KEY) ?? '{}')

  it('操作写进 localStorage，刷新（rehydrate）后原样还原；新开的标签用全局「上次视图」', async () => {
    useTagNoteLocal.getState().setPrefs({ ...DEFAULT_PREFS, view: 'hasse' })
    wsActions.open('A')
    wsActions.open('B', { newTab: true })
    wsActions.split('t3', 'bottom')
    const raw = stored()
    expect(raw.version).toBe(1)
    expect(shape(raw.state.workspace.root)).toBe('col(p1[t2,t3*]|p5[t4*])')
    expect(raw.state.workspace.tabs.t3.view).toBe('hasse')
    const before = useTagNoteLocal.getState().workspace
    useTagNoteLocal.setState({ workspace: emptyWorkspace() }) // 这一下也会写存储，再放回去
    localStorage.setItem(TAGNOTE_STORE_KEY, JSON.stringify(raw))
    await useTagNoteLocal.persist.rehydrate()
    expect(useTagNoteLocal.getState().workspace).toEqual(before)
    expect(warn).not.toHaveBeenCalled()
  })

  it('带 home 的视区能存进去、刷新（rehydrate）后读回来不丢；分屏复制的新标签也带着', async () => {
    wsActions.open('A')
    wsActions.setViewport('t2', 'canvas', { zoom: 1, cx: 287.3, cy: 200, home: true })
    const vp = { zoom: 1, cx: 287.3, cy: 200, home: true }
    expect(stored().state.workspace.tabs.t2.viewports.canvas).toEqual(vp)
    const raw = stored()
    useTagNoteLocal.setState({ workspace: emptyWorkspace() })
    localStorage.setItem(TAGNOTE_STORE_KEY, JSON.stringify(raw))
    await useTagNoteLocal.persist.rehydrate()
    expect(useTagNoteLocal.getState().workspace.tabs.t2.viewports.canvas).toEqual(vp)
    wsActions.split('t2', 'right')
    const ws = useTagNoteLocal.getState().workspace
    const copy = Object.values(ws.tabs).find((t) => t.id !== 't2')
    expect(copy?.viewports.canvas).toEqual(vp)
    expect(warn).not.toHaveBeenCalled()
  })

  it('形状不对的工作区 → 用默认（空的），只告警不抛错；形状对、意思不对的 → 修好', async () => {
    localStorage.setItem(TAGNOTE_STORE_KEY, JSON.stringify({ version: 1, state: { ...stored().state, workspace: { tabs: 'x' } } }))
    await useTagNoteLocal.persist.rehydrate()
    expect(useTagNoteLocal.getState().workspace).toEqual(emptyWorkspace())
    expect(warn).toHaveBeenCalled()

    const bad: Workspace = {
      tabs: { t2: { id: 't2', mapId: 'A', view: null, viewports: {} } },
      root: { type: 'pane', id: 'p1', tabs: ['t2', 't2', 't8'], active: 't8' },
      activePane: 'p5',
      seq: 1,
      opened: true,
    }
    localStorage.setItem(TAGNOTE_STORE_KEY, JSON.stringify({ version: 1, state: { ...stored().state, workspace: bad } }))
    await useTagNoteLocal.persist.rehydrate()
    const ws = useTagNoteLocal.getState().workspace
    expect(shape(ws.root)).toBe('p1[t2*]')
    expect(ws.activePane).toBe('p1')
    expect(ws.seq).toBe(2) // 悬空的 t8 已经丢掉，不会撞
  })

  it('列表点击走 wsActions.open：单击换当前格的当前标签，newTab 新开，作用于当前格', () => {
    wsActions.open('A')
    wsActions.split('t2', 'right') // row(p1[t2*]|p4[t3*])，当前格 p4
    wsActions.open('B')
    let ws = useTagNoteLocal.getState().workspace
    expect(maps(ws)).toEqual({ t2: 'A', t3: 'B' })
    wsActions.activatePane('p1')
    wsActions.open('C', { newTab: true })
    ws = useTagNoteLocal.getState().workspace
    expect(shape(ws.root)).toBe('row(p1[t2,t6*]|p4[t3*])')
  })

  it('改工作区之前先快照正在显示的视区（切走的标签 display:none 后再问就晚了）', () => {
    wsActions.open('A')
    wsActions.open('B', { newTab: true }) // p1[t2,t3*]
    let vp = { zoom: 2, cx: 10, cy: 20 }
    const off = registerLive({ tabId: 't3', capture: () => ({ canvas: vp }) })
    wsActions.activate('t2')
    expect(useTagNoteLocal.getState().workspace.tabs.t3.viewports.canvas).toEqual({ zoom: 2, cx: 10, cy: 20 })
    // 只改大小不快照
    vp = { zoom: 1, cx: 0, cy: 0 }
    wsActions.activatePane('p1')
    expect(useTagNoteLocal.getState().workspace.tabs.t3.viewports.canvas).toEqual({ zoom: 2, cx: 10, cy: 20 })
    // 离开页面前
    captureNow()
    expect(useTagNoteLocal.getState().workspace.tabs.t3.viewports.canvas).toEqual({ zoom: 1, cx: 0, cy: 0 })
    off()
    vp = { zoom: 3, cx: 1, cy: 1 }
    captureNow()
    expect(useTagNoteLocal.getState().workspace.tabs.t3.viewports.canvas).toEqual({ zoom: 1, cx: 0, cy: 0 })
  })

  it('快照所有画过的视图，不只当前视图：缩放完、防抖没到就切视图再切标签，那个视图的视区也存下（假引擎）', () => {
    wsActions.open('A')
    wsActions.open('B', { newTab: true }) // p1[t2,t3*]，t3 在显示
    // 引擎里：分支画布刚缩放到 1.9（防抖中的回调永远不会到），现在在标签谱；卡诺图等没画过 → null
    const engineVps: Partial<Record<ViewKey, Viewport>> = { canvas: { zoom: 1.9, cx: 120, cy: 80 }, score: { zoom: 1, cx: 300, cy: 40 } }
    const asked: (ViewKey | undefined)[] = []
    const fakeInst = {
      view: 'score',
      getViewport: (v?: ViewKey) => {
        asked.push(v)
        const vp = engineVps[v ?? 'score']
        return vp ? { ...vp } : null
      },
      getPrefs: () => ({ ...DEFAULT_PREFS }),
      setPrefs: () => {},
      destroy: () => {},
    } as unknown as TagNoteInstance
    const engine: EngineLike = { mount: () => fakeInst }
    const binding = new TagNoteBinding(engine, {} as HTMLElement, { data: {} as TagNoteData, theme: 'dark', layout: 'pane', fullscreen: 'host' })
    const off = registerLive({ tabId: 't3', capture: () => viewportsOf(binding) })
    expect(viewportsOf(binding)).toEqual(engineVps)
    expect(new Set(asked)).toEqual(new Set(VIEW_KEYS)) // 六个视图逐个问

    wsActions.activate('t2') // 切到别的标签：t3 藏起来之前快照
    expect(useTagNoteLocal.getState().workspace.tabs.t3.viewports).toEqual(engineVps)
    // 存储里也是 1.9（刷新后从这里还原）
    expect(JSON.parse(localStorage.getItem(TAGNOTE_STORE_KEY) ?? '{}').state.workspace.tabs.t3.viewports.canvas.zoom).toBe(1.9)
    off()

    // 卸载前（关标签、保活淘汰、离开方案库）：PaneEngine 用 setViewports 存一遍；没变就不写 store
    const before = useTagNoteLocal.getState().workspace
    wsActions.setViewports('t3', viewportsOf(binding))
    expect(useTagNoteLocal.getState().workspace).toBe(before)
    engineVps.kmap = { zoom: 0.5, cx: 1, cy: 2 }
    wsActions.setViewports('t3', viewportsOf(binding))
    expect(useTagNoteLocal.getState().workspace.tabs.t3.viewports).toEqual(engineVps)
    // 标签已经关掉：什么都不做
    wsActions.close('t3')
    const closed = useTagNoteLocal.getState().workspace
    wsActions.setViewports('t3', viewportsOf(binding))
    expect(useTagNoteLocal.getState().workspace).toBe(closed)
  })

  it('引擎报上来的偏好：视图记在这个标签上并当作「上次视图」；封面、配色、侧栏是全局的', () => {
    wsActions.open('A')
    wsActions.open('B', { newTab: true })
    prefsFromEngine('t3', { cover: false, scale: 1, color: true, drawer: true, view: 'score' })
    const st = useTagNoteLocal.getState()
    expect(st.workspace.tabs.t3.view).toBe('score')
    expect(st.workspace.tabs.t2.view).toBeNull()
    expect(st.prefs).toMatchObject({ cover: false, drawer: true, view: 'score' })
    // 没变化不写
    const before = useTagNoteLocal.getState()
    prefsFromEngine('t3', { cover: false, scale: 1, color: true, drawer: true, view: 'score' })
    expect(useTagNoteLocal.getState().prefs).toBe(before.prefs)
    expect(useTagNoteLocal.getState().workspace).toBe(before.workspace)
  })

  it('运行时的「最近用过」跟着操作更新', () => {
    wsActions.open('A')
    wsActions.open('B', { newTab: true })
    wsActions.activate('t2')
    expect(useWsRuntime.getState().mru).toEqual(['t2', 't3'])
    wsActions.close('t3')
    expect(useWsRuntime.getState().mru).toEqual(['t2'])
  })
})

// ---------------------------------------------------------------- 标签上的组色点
describe('标签：组色点和组名', () => {
  it('同一组同一个颜色，相邻年份不同；新建的用主色，没有年份用弱文字色', () => {
    expect(groupDotClass('new')).toBe('bg-primary')
    expect(groupDotClass('none')).toBe('bg-fg-3')
    expect(groupDotClass('y2024')).toBe(groupDotClass('y2024'))
    expect(groupDotClass('y2024')).not.toBe(groupDotClass('y2025'))
    expect(groupDotClass('d1990-1999')).toMatch(/^bg-chart-[1-8]$/)
    expect(groupDotClass('d1990-1999')).not.toBe(groupDotClass('d2000-2009'))
  })

  it('mapLabels：每张图的标题、组名、色点、作品数', () => {
    const item = (id: string, group: string | null, source = 'manual'): MapSummary => ({
      id,
      title: `图${id}`,
      source,
      group,
      origin: null,
      n_works: 4,
      common_tags: [],
      tags_from: 'map',
      generated_at: '2026-10-10',
      updated_at: '2026-10-10T00:00:00Z',
    })
    const labels = mapLabels([item('a', '2024'), item('b', null), item('c', null, 'outsetter')])
    expect(labels.get('a')).toMatchObject({ title: '图a', nWorks: 4 })
    expect(labels.get('b')).toMatchObject({ group: '没有年份', dot: 'bg-fg-3' })
    expect(labels.get('c')).toMatchObject({ dot: 'bg-primary' })
  })
})
