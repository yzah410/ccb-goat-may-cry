/**
 * 导图工作区的纯逻辑：开 / 换 / 关 / 移标签，分屏，调整大小，校验存下来的数据，算每一格的位置。
 * 不碰 React、DOM 和 store，方便测试。所有函数都不改传进来的对象；什么都没变时原样返回（调用方据此不写 store）。
 *
 * 每次结构变化后由 finish() 整理，保证：
 * - 分屏至少 2 个孩子；只剩 1 个就由它顶替（兄弟格补位）；同方向的分屏套分屏拍平成一层
 * - 分屏里没有空格子（一格里最后一个标签关掉 = 这一格收起）；只有整个工作区只剩一格时，允许它是空的
 * - 每个标签只在一格里出现一次；每格的 active 是它自己的标签之一（没有标签时为 null）；activePane 一定存在
 */
import {
  VIEW_KEYS,
  type DropTarget,
  type Edge,
  type LayoutNode,
  type PaneNode,
  type Rect,
  type SplitDir,
  type SplitNode,
  type ViewKey,
  type Viewport,
  type Workspace,
  type WsTab,
} from './types'

/** 每一格上方标签栏的高度 */
export const TAB_BAR_H = 36
/** 格子的最小尺寸（含标签栏）：拖分隔线时两边都不小于它 */
export const MIN_PANE_W = 240
export const MIN_PANE_H = 160
/** 格子之间分隔线的粗细 */
export const SPLIT_GAP = 1
/** 拖到格子主体离边缘多近（占宽 / 高的比例）算「分屏」，再往里算「移进这一格」 */
export const EDGE_ZONE = 0.25
/** 视区缩放范围（和引擎一致） */
export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 3

export const isViewKey = (v: unknown): v is ViewKey => typeof v === 'string' && (VIEW_KEYS as readonly string[]).includes(v)

const newPane = (id: string, tabs: string[] = [], active: string | null = tabs[0] ?? null): PaneNode => ({ type: 'pane', id, tabs, active })

export function emptyWorkspace(): Workspace {
  return { tabs: {}, root: newPane('p1'), activePane: 'p1', seq: 1, opened: false }
}

// ---------------------------------------------------------------- 查找
export function panesOf(node: LayoutNode): PaneNode[] {
  return node.type === 'pane' ? [node] : node.children.flatMap(panesOf)
}

export function findPane(ws: Workspace, id: string): PaneNode | null {
  return panesOf(ws.root).find((p) => p.id === id) ?? null
}

export function paneOfTab(ws: Workspace, tabId: string): PaneNode | null {
  return panesOf(ws.root).find((p) => p.tabs.includes(tabId)) ?? null
}

/** 当前格的当前标签（图头、左边列表的高亮都看它） */
export function activeTabOf(ws: Workspace): WsTab | null {
  const p = findPane(ws, ws.activePane)
  return p?.active ? (ws.tabs[p.active] ?? null) : null
}

/** 每一格的当前标签（这些标签的引擎实例一直挂着） */
export function paneActives(ws: Workspace): string[] {
  const first = findPane(ws, ws.activePane)?.active
  const rest = panesOf(ws.root)
    .map((p) => p.active)
    .filter((t): t is string => !!t && t !== first)
  return first ? [first, ...rest] : rest
}

/**
 * 哪些标签保留引擎实例：每格的当前标签一定在；其余按最近用过的顺序补，总数不超过 limit。
 * 没在里面的标签不挂引擎，再切过去时按存的视图和视区重新挂。
 */
export function aliveTabs(ws: Workspace, mru: readonly string[], limit: number): Set<string> {
  const alive = new Set(paneActives(ws))
  for (const id of mru) {
    if (alive.size >= limit) break
    if (ws.tabs[id]) alive.add(id)
  }
  return alive
}

/** 最近用过的标签：每格的当前标签排到最前（当前格的在第一个），关掉的去掉；没变就原样返回 */
export function touchMru(ws: Workspace, mru: readonly string[], keep = 30): readonly string[] {
  const front = paneActives(ws)
  const next = [...front, ...mru.filter((id) => !front.includes(id) && ws.tabs[id])].slice(0, keep)
  return next.length === mru.length && next.every((id, i) => id === mru[i]) ? mru : next
}

// ---------------------------------------------------------------- 内部工具
function ids(ws: Workspace) {
  let seq = ws.seq
  return { next: (prefix: 't' | 'p' | 's') => `${prefix}${++seq}`, seq: () => seq }
}

function mapPanes(node: LayoutNode, fn: (p: PaneNode) => LayoutNode): LayoutNode {
  if (node.type === 'pane') return fn(node)
  let changed = false
  const children = node.children.map((c) => {
    const n = mapPanes(c, fn)
    if (n !== c) changed = true
    return n
  })
  return changed ? { ...node, children } : node
}

function mapSplits(node: LayoutNode, fn: (s: SplitNode) => SplitNode): LayoutNode {
  if (node.type === 'pane') return node
  let changed = false
  const children = node.children.map((c) => {
    const n = mapSplits(c, fn)
    if (n !== c) changed = true
    return n
  })
  const self = changed ? { ...node, children } : node
  return fn(self)
}

const withPane = (root: LayoutNode, paneId: string, fn: (p: PaneNode) => LayoutNode) => mapPanes(root, (p) => (p.id === paneId ? fn(p) : p))

/** 去掉一个标签；它是当前标签时，改成它右边那个（没有就左边那个） */
function without(p: PaneNode, tabId: string): PaneNode {
  const i = p.tabs.indexOf(tabId)
  if (i < 0) return p
  const tabs = p.tabs.filter((t) => t !== tabId)
  const active = p.active === tabId ? (tabs[i] ?? tabs[i - 1] ?? null) : p.active
  return { ...p, tabs, active }
}

function insertAt(p: PaneNode, tabId: string, index: number): PaneNode {
  const rest = p.tabs.filter((t) => t !== tabId)
  const i = Math.max(0, Math.min(Number.isFinite(index) ? Math.round(index) : rest.length, rest.length))
  return { ...p, tabs: [...rest.slice(0, i), tabId, ...rest.slice(i)], active: tabId }
}

/** 比例归一：加起来是 1；有坏值或全是 0 就平分。保留 4 位小数（存进 localStorage 的东西短一点） */
export function normSizes(sizes: readonly number[], n = sizes.length): number[] {
  if (n <= 0) return []
  const ok = sizes.length === n && sizes.every((s) => Number.isFinite(s) && s > 0)
  const raw = ok ? sizes : Array.from({ length: n }, () => 1)
  const sum = raw.reduce((a, b) => a + b, 0)
  const out = raw.map((s) => Math.round((s / sum) * 1e4) / 1e4)
  // 四舍五入的零头补给最后一个，保证加起来正好是 1
  out[n - 1] = Math.round((1 - out.slice(0, -1).reduce((a, b) => a + b, 0)) * 1e4) / 1e4
  return out
}

/** 收起空格子、单孩子的分屏由孩子顶替、同方向拍平、比例归一；整棵树空了返回 null */
function tidy(node: LayoutNode): LayoutNode | null {
  if (node.type === 'pane') return node.tabs.length ? node : null
  const kids: LayoutNode[] = []
  const sizes: number[] = []
  node.children.forEach((c, i) => {
    const t = tidy(c)
    if (!t) return
    const s = node.sizes[i] ?? 0
    if (t.type === 'split' && t.dir === node.dir) {
      t.children.forEach((g, j) => {
        kids.push(g)
        sizes.push(s * (t.sizes[j] ?? 0))
      })
    } else {
      kids.push(t)
      sizes.push(s)
    }
  })
  if (!kids.length) return null
  if (kids.length === 1) return kids[0]
  return { ...node, children: kids, sizes: normSizes(sizes) }
}

/** 一格收起后，焦点交给挨着它的那一格（前面的兄弟优先，取离分界线最近的那格） */
function nearPane(root: LayoutNode, paneId: string): string | null {
  const walk = (node: LayoutNode): string | null | undefined => {
    if (node.type === 'pane') return undefined
    const i = node.children.findIndex((c) => c.type === 'pane' && c.id === paneId)
    if (i >= 0) {
      const prev = node.children[i - 1]
      const next = node.children[i + 1]
      if (prev) return panesOf(prev).at(-1)?.id ?? null
      if (next) return panesOf(next)[0]?.id ?? null
      return null
    }
    for (const c of node.children) {
      const r = walk(c)
      if (r !== undefined) return r
    }
    return undefined
  }
  return walk(root) ?? null
}

function finish(ws: Workspace, root: LayoutNode, tabs: Record<string, WsTab>, activePane: string, seq = ws.seq): Workspace {
  const tidied = tidy(root) ?? newPane(panesOf(root)[0]?.id ?? 'p1')
  const ps = panesOf(tidied)
  const ap = ps.some((p) => p.id === activePane) ? activePane : ps[0].id
  return { ...ws, tabs, root: tidied, activePane: ap, seq }
}

// ---------------------------------------------------------------- 打开 / 切换 / 关闭
export interface OpenOptions {
  /** true = 新开一个标签；false = 换掉当前标签里的图（没有标签时也是新开） */
  newTab?: boolean
  /** 在哪一格开；默认当前格 */
  pane?: string
  /** 新开的标签用哪个视图（一般是全局「上次用的视图」） */
  view?: ViewKey | null
}

/**
 * 打开一张图：
 * - 这一格里已经有标签在看这张图 → 直接切过去（不重复开）
 * - newTab 或这一格没有标签 → 在当前标签右边新开一个
 * - 否则 → 当前标签换成这张图（保留视图，视区清空：换了图，旧的位置没意义）
 */
export function openMap(ws: Workspace, mapId: string, opts: OpenOptions = {}): Workspace {
  const p = findPane(ws, opts.pane ?? ws.activePane) ?? panesOf(ws.root)[0]
  const same = p.tabs.find((t) => ws.tabs[t]?.mapId === mapId)
  if (same) {
    if (p.active === same && ws.activePane === p.id && ws.opened) return ws
    return { ...ws, root: withPane(ws.root, p.id, (q) => ({ ...q, active: same })), activePane: p.id, opened: true }
  }
  const cur = p.active ? ws.tabs[p.active] : null
  if (!opts.newTab && cur) {
    return { ...ws, tabs: { ...ws.tabs, [cur.id]: { ...cur, mapId, viewports: {} } }, activePane: p.id, opened: true }
  }
  const g = ids(ws)
  const id = g.next('t')
  const at = p.active ? p.tabs.indexOf(p.active) + 1 : p.tabs.length
  const tab: WsTab = { id, mapId, view: opts.view ?? null, viewports: {} }
  return {
    ...ws,
    tabs: { ...ws.tabs, [id]: tab },
    root: withPane(ws.root, p.id, (q) => ({ ...q, tabs: [...q.tabs.slice(0, at), id, ...q.tabs.slice(at)], active: id })),
    activePane: p.id,
    seq: g.seq(),
    opened: true,
  }
}

/** 列表里点一张图：左键 = 换掉当前标签里的图；Ctrl / ⌘ + 左键、中键 = 新开标签；其他键（右键等）不处理 */
export function clickIntent(e: { button: number; ctrlKey: boolean; metaKey: boolean }): 'replace' | 'newTab' | null {
  if (e.button === 1) return 'newTab'
  if (e.button !== 0) return null
  return e.ctrlKey || e.metaKey ? 'newTab' : 'replace'
}

export function activateTab(ws: Workspace, tabId: string): Workspace {
  const p = paneOfTab(ws, tabId)
  if (!p || (p.active === tabId && ws.activePane === p.id)) return ws
  return { ...ws, root: withPane(ws.root, p.id, (q) => ({ ...q, active: tabId })), activePane: p.id }
}

// ---------------------------------------------------------------- 做题联动（跟随格）用：开 / 切标签但不抢当前格
/**
 * 在某一格里把这些图开成标签（已经开着的不重复开），排在最后；这一格的当前标签不变（原来没有标签就用第一个新开的）。
 * 不改当前格（activePane）：用户正在别的格子里看图时不打扰。都开着了就原样返回。
 */
export function ensureTabs(ws: Workspace, paneId: string, mapIds: readonly string[], view: ViewKey | null = null): Workspace {
  const p = findPane(ws, paneId)
  if (!p) return ws
  const have = new Set(p.tabs.map((t) => ws.tabs[t]?.mapId))
  const add = mapIds.filter((m, i) => !have.has(m) && mapIds.indexOf(m) === i)
  if (!add.length) return ws
  const g = ids(ws)
  const tabs = { ...ws.tabs }
  const newIds: string[] = []
  for (const mapId of add) {
    const id = g.next('t')
    tabs[id] = { id, mapId, view, viewports: {} }
    newIds.push(id)
  }
  const root = withPane(ws.root, p.id, (q) => ({ ...q, tabs: [...q.tabs, ...newIds], active: q.active ?? newIds[0] }))
  return { ...ws, tabs, root, seq: g.seq(), opened: true }
}

/**
 * 让某一格显示这张图：这一格里已经有标签在看它 → 切过去；没有 → 在最后新开一个再切过去。
 * 不改当前格。返回新的工作区和那个标签的 id（格子不存在 = 原样返回、tabId 为 null）。
 */
export function showMap(ws: Workspace, paneId: string, mapId: string, view: ViewKey | null = null): { ws: Workspace; tabId: string | null } {
  const p = findPane(ws, paneId)
  if (!p) return { ws, tabId: null }
  const same = p.tabs.find((t) => ws.tabs[t]?.mapId === mapId)
  if (same) return { ws: showTab(ws, same), tabId: same }
  const opened = ensureTabs(ws, paneId, [mapId], view)
  const tabId = findPane(opened, paneId)?.tabs.at(-1) ?? null
  return { ws: tabId ? showTab(opened, tabId) : opened, tabId }
}

/** 把标签设成它那一格的当前标签，不改当前格；已经是了就原样返回 */
export function showTab(ws: Workspace, tabId: string): Workspace {
  const p = paneOfTab(ws, tabId)
  if (!p || p.active === tabId) return ws
  return { ...ws, root: withPane(ws.root, p.id, (q) => ({ ...q, active: tabId })) }
}

export function setActivePane(ws: Workspace, paneId: string): Workspace {
  if (ws.activePane === paneId || !findPane(ws, paneId)) return ws
  return { ...ws, activePane: paneId }
}

/** 关一个标签；这一格没标签了就收起（兄弟格补位），当前格交给挨着的那一格 */
export function closeTab(ws: Workspace, tabId: string): Workspace {
  const p = paneOfTab(ws, tabId)
  if (!p) return ws
  const { [tabId]: _gone, ...tabs } = ws.tabs
  const np = without(p, tabId)
  const root = withPane(ws.root, p.id, () => np)
  const fallback = np.tabs.length ? p.id : (nearPane(ws.root, p.id) ?? p.id)
  return finish(ws, root, tabs, ws.activePane === p.id ? fallback : ws.activePane)
}

/** 关掉同一格里的其他标签 */
export function closeOthers(ws: Workspace, tabId: string): Workspace {
  const p = paneOfTab(ws, tabId)
  if (!p || p.tabs.length < 2) return activateTab(ws, tabId)
  const tabs = { ...ws.tabs }
  for (const t of p.tabs) if (t !== tabId) delete tabs[t]
  return { ...ws, tabs, root: withPane(ws.root, p.id, (q) => ({ ...q, tabs: [tabId], active: tabId })), activePane: p.id }
}

/** 关掉看着这些图以外的标签（图被删了）；一个都不用关就原样返回 */
export function pruneMaps(ws: Workspace, keep: (mapId: string) => boolean): Workspace {
  return Object.values(ws.tabs)
    .filter((t) => !keep(t.mapId))
    .reduce((w, t) => closeTab(w, t.id), ws)
}

/**
 * 删掉了一张图：当前格的当前标签正看着它 → 换成 neighbor（删完可以接着看下一张）；
 * 其他看着它的标签安静地关掉。
 */
export function afterMapDeleted(ws: Workspace, mapId: string, neighbor: string | null): Workspace {
  let w = ws
  const cur = activeTabOf(w)
  if (cur && cur.mapId === mapId && neighbor && neighbor !== mapId) w = openMap(w, neighbor)
  return pruneMaps(w, (id) => id !== mapId)
}

// ---------------------------------------------------------------- 移动 / 分屏
/** 把标签移到某一格的第 index 个位置（同一格里 = 换顺序）；移走后原来那格空了就收起 */
export function moveTab(ws: Workspace, tabId: string, toPane: string, index: number): Workspace {
  const from = paneOfTab(ws, tabId)
  const to = findPane(ws, toPane)
  if (!from || !to) return ws
  if (from.id === to.id) {
    const moved = insertAt(from, tabId, index)
    const same = moved.tabs.every((t, i) => t === from.tabs[i])
    if (same && from.active === tabId && ws.activePane === from.id) return ws
    return { ...ws, root: withPane(ws.root, from.id, () => moved), activePane: from.id }
  }
  const root = mapPanes(ws.root, (q) => (q.id === from.id ? without(q, tabId) : q.id === to.id ? insertAt(q, tabId, index) : q))
  return finish(ws, root, ws.tabs, to.id)
}

function insertBeside(node: LayoutNode, targetId: string, np: PaneNode, dir: SplitDir, before: boolean, splitId: () => string): LayoutNode {
  if (node.type === 'pane') {
    if (node.id !== targetId) return node
    return { type: 'split', id: splitId(), dir, children: before ? [np, node] : [node, np], sizes: [0.5, 0.5] }
  }
  const i = node.children.findIndex((c) => c.type === 'pane' && c.id === targetId)
  if (i >= 0 && node.dir === dir) {
    // 同方向：插成兄弟，平分目标那一格原来的大小
    const half = (node.sizes[i] ?? 0) / 2
    const at = before ? i : i + 1
    const children = [...node.children]
    const sizes = [...node.sizes]
    sizes[i] = half
    children.splice(at, 0, np)
    sizes.splice(at, 0, half)
    return { ...node, children, sizes }
  }
  let changed = false
  const children = node.children.map((c) => {
    const n = insertBeside(c, targetId, np, dir, before, splitId)
    if (n !== c) changed = true
    return n
  })
  return changed ? { ...node, children } : node
}

/**
 * 在 targetPane 的 edge 那一边分出一格，放这个标签。
 * copy = false（拖到边缘）：标签从原来的格子移过去；某格唯一的标签拖到它自己的边缘 = 什么都不做。
 * copy = true（右键「向右 / 向下分屏」）：复制一个看同一张图、同一视图和视区的新标签，原标签不动（Obsidian 的做法）。
 */
export function splitTab(ws: Workspace, tabId: string, targetPane: string, edge: Edge, copy = false): Workspace {
  const src = paneOfTab(ws, tabId)
  const target = findPane(ws, targetPane)
  const tab = ws.tabs[tabId]
  if (!src || !target || !tab) return ws
  if (!copy && src.id === target.id && src.tabs.length === 1) return ws
  const g = ids(ws)
  let tabs = ws.tabs
  let moving = tabId
  if (copy) {
    moving = g.next('t')
    tabs = { ...tabs, [moving]: { ...tab, id: moving, viewports: { ...tab.viewports } } }
  }
  const np = newPane(g.next('p'), [moving], moving)
  const dir: SplitDir = edge === 'left' || edge === 'right' ? 'row' : 'col'
  const before = edge === 'left' || edge === 'top'
  let root = copy ? ws.root : withPane(ws.root, src.id, (q) => without(q, tabId))
  root = insertBeside(root, target.id, np, dir, before, () => g.next('s'))
  return finish(ws, root, tabs, np.id, g.seq())
}

/** 这个落点松手会不会什么都不变（不变就不画落点提示） */
export function isNoopDrop(ws: Workspace, tabId: string, t: DropTarget): boolean {
  const src = paneOfTab(ws, tabId)
  if (!src) return true
  if (t.kind === 'center') return t.pane === src.id
  if (t.kind === 'edge') return t.pane === src.id && src.tabs.length === 1
  if (t.pane !== src.id) return false
  const rest = src.tabs.filter((x) => x !== tabId)
  return Math.max(0, Math.min(t.index, rest.length)) === src.tabs.indexOf(tabId)
}

export function applyDrop(ws: Workspace, tabId: string, t: DropTarget): Workspace {
  if (isNoopDrop(ws, tabId, t)) return activateTab(ws, tabId)
  if (t.kind === 'tabs') return moveTab(ws, tabId, t.pane, t.index)
  if (t.kind === 'center') return moveTab(ws, tabId, t.pane, Infinity)
  return splitTab(ws, tabId, t.pane, t.edge)
}

// ---------------------------------------------------------------- 大小
export function setSplitSizes(ws: Workspace, splitId: string, sizes: readonly number[]): Workspace {
  let changed = false
  const root = mapSplits(ws.root, (s) => {
    if (s.id !== splitId || sizes.length !== s.children.length) return s
    const next = normSizes(sizes)
    if (next.every((v, i) => v === s.sizes[i])) return s
    changed = true
    return { ...s, sizes: next }
  })
  return changed ? { ...ws, root } : ws
}

/**
 * 拖第 i 条分隔线（第 i 和第 i+1 个孩子之间）：两边加起来不变，各自不小于自己的最小比例。
 * 两边的最小值加起来都放不下时，按最小值的比例分。
 */
export function dragSizes(start: readonly number[], i: number, delta: number, minA: number, minB: number): number[] {
  const a = start[i] ?? 0
  const b = start[i + 1] ?? 0
  const total = a + b
  let na = a + delta
  if (minA + minB >= total) na = minA + minB > 0 ? (total * minA) / (minA + minB) : total / 2
  else na = Math.min(Math.max(na, minA), total - minB)
  const out = [...start]
  out[i] = na
  out[i + 1] = total - na
  return out
}

/** 一棵子树沿 dir 方向最少要多少像素（格子的最小尺寸 + 分隔线） */
export function minExtent(node: LayoutNode, dir: SplitDir): number {
  if (node.type === 'pane') return dir === 'row' ? MIN_PANE_W : MIN_PANE_H
  const ms = node.children.map((c) => minExtent(c, dir))
  return node.dir === dir ? ms.reduce((a, b) => a + b, 0) + SPLIT_GAP * (ms.length - 1) : Math.max(...ms)
}

// ---------------------------------------------------------------- 视图 / 视区
export function setTabView(ws: Workspace, tabId: string, view: ViewKey): Workspace {
  const t = ws.tabs[tabId]
  if (!t || t.view === view || !isViewKey(view)) return ws
  return { ...ws, tabs: { ...ws.tabs, [tabId]: { ...t, view } } }
}

/**
 * 整理一个视区：缩放夹在 25%–300%，坐标保留 1 位小数；zoom/cx/cy 不是有限数返回 null。
 * 可选的 home（还在初始位置、没平移也没缩放过；引擎还原时按初始规则重新摆）只在严格等于 true 时留下，否则去掉。
 * 别的字段（例如多余的 x0/y0）一律丢掉。
 */
export function cleanViewport(vp: unknown): Viewport | null {
  if (!vp || typeof vp !== 'object') return null
  const { zoom, cx, cy, home } = vp as Record<string, unknown>
  if (typeof zoom !== 'number' || typeof cx !== 'number' || typeof cy !== 'number') return null
  if (![zoom, cx, cy].every(Number.isFinite)) return null
  const out: Viewport = {
    zoom: Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) * 1000) / 1000,
    cx: Math.round(cx * 10) / 10,
    cy: Math.round(cy * 10) / 10,
  }
  if (home === true) out.home = true
  return out
}

export function setTabViewport(ws: Workspace, tabId: string, view: ViewKey, vp: Viewport): Workspace {
  const t = ws.tabs[tabId]
  const clean = cleanViewport(vp)
  if (!t || !clean || !isViewKey(view)) return ws
  const old = t.viewports[view]
  if (old && old.zoom === clean.zoom && old.cx === clean.cx && old.cy === clean.cy && old.home === clean.home) return ws
  return { ...ws, tabs: { ...ws.tabs, [tabId]: { ...t, viewports: { ...t.viewports, [view]: clean } } } }
}

// ---------------------------------------------------------------- 存下来的数据：语义校验
/**
 * zod 只查了形状，这里查意思：标签只出现一次、引用的标签都在、当前标签属于这一格、比例和孩子数对得上、
 * 格子 / 分屏 id 不重复、视图和视区合法、计数器不小于已用过的 id。修不好的部分丢掉，绝不抛错。
 */
export function normalizeWorkspace(raw: Workspace): Workspace {
  const tabs: Record<string, WsTab> = {}
  const usedNodes = new Set<string>()
  let seq = Number.isFinite(raw.seq) ? Math.max(1, Math.floor(raw.seq)) : 1
  const num = (id: string) => Number(/^[tps](\d+)$/.exec(id)?.[1] ?? 0)
  for (const k of Object.keys(raw.tabs)) seq = Math.max(seq, num(k))
  const visit = (n: LayoutNode) => {
    seq = Math.max(seq, num(n.id))
    if (n.type === 'split') n.children.forEach(visit)
  }
  visit(raw.root)
  const nodeId = (id: string, prefix: 'p' | 's') => {
    if (!usedNodes.has(id) && /^[ps]\d+$/.test(id)) {
      usedNodes.add(id)
      return id
    }
    const fresh = `${prefix}${++seq}`
    usedNodes.add(fresh)
    return fresh
  }
  const fixNode = (n: LayoutNode): LayoutNode => {
    if (n.type === 'pane') {
      const list: string[] = []
      for (const t of n.tabs) {
        const tab = raw.tabs[t]
        if (!tab || tabs[t] || typeof tab.mapId !== 'string' || !tab.mapId) continue
        const viewports: WsTab['viewports'] = {}
        for (const [k, v] of Object.entries(tab.viewports ?? {})) {
          const c = cleanViewport(v)
          if (isViewKey(k) && c) viewports[k] = c
        }
        tabs[t] = { id: t, mapId: tab.mapId, view: isViewKey(tab.view) ? tab.view : null, viewports }
        list.push(t)
      }
      return newPane(nodeId(n.id, 'p'), list, n.active && list.includes(n.active) ? n.active : (list[0] ?? null))
    }
    const children = n.children.map(fixNode)
    return { type: 'split', id: nodeId(n.id, 's'), dir: n.dir === 'col' ? 'col' : 'row', children, sizes: normSizes(n.sizes, children.length) }
  }
  const root = fixNode(raw.root)
  const ws: Workspace = { tabs, root, activePane: raw.activePane, seq, opened: !!raw.opened || Object.keys(tabs).length > 0 }
  return finish(ws, root, tabs, raw.activePane, seq)
}

// ---------------------------------------------------------------- 几何：每一格在哪、分隔线在哪
export interface SplitterGeom {
  splitId: string
  /** 第 index 条：第 index 和 index+1 个孩子之间 */
  index: number
  dir: SplitDir
  /** 分隔线本身（SPLIT_GAP 粗） */
  line: Rect
  /** 这个分屏沿分割方向可分配的总长度（去掉分隔线），拖动时像素 → 比例 */
  avail: number
  sizes: number[]
  /** 两边各自最少要占的比例 */
  minA: number
  minB: number
}

export interface LayoutGeom {
  panes: Record<string, Rect>
  splitters: SplitterGeom[]
}

/** 按容器大小算出每一格的矩形（像素，相对容器左上角）。overrides：拖分隔线时还没提交的比例 */
export function computeLayout(root: LayoutNode, width: number, height: number, overrides?: Record<string, number[]>): LayoutGeom {
  const panes: Record<string, Rect> = {}
  const splitters: SplitterGeom[] = []
  const walk = (node: LayoutNode, r: Rect) => {
    if (node.type === 'pane') {
      panes[node.id] = r
      return
    }
    const sizes = overrides?.[node.id] ?? node.sizes
    const row = node.dir === 'row'
    const n = node.children.length
    const avail = Math.max(0, (row ? r.w : r.h) - SPLIT_GAP * (n - 1))
    const origin = row ? r.x : r.y
    let acc = 0
    node.children.forEach((c, i) => {
      const from = Math.round(acc * avail)
      acc += sizes[i] ?? 0
      const to = i === n - 1 ? avail : Math.round(acc * avail)
      const s = origin + from + i * SPLIT_GAP
      const len = Math.max(0, to - from)
      walk(c, row ? { x: s, y: r.y, w: len, h: r.h } : { x: r.x, y: s, w: r.w, h: len })
      if (i < n - 1) {
        const next = node.children[i + 1]
        splitters.push({
          splitId: node.id,
          index: i,
          dir: node.dir,
          line: row ? { x: s + len, y: r.y, w: SPLIT_GAP, h: r.h } : { x: r.x, y: s + len, w: r.w, h: SPLIT_GAP },
          avail,
          sizes,
          minA: avail > 0 ? minExtent(c, node.dir) / avail : 0,
          minB: avail > 0 && next ? minExtent(next, node.dir) / avail : 0,
        })
      }
    })
  }
  walk(root, { x: 0, y: 0, w: Math.max(0, width), h: Math.max(0, height) })
  return { panes, splitters }
}

/** 拖到格子主体的哪儿：离某条边足够近 = 那条边（分屏），否则 = 中间（移进这一格） */
export function dropZone(body: Rect, x: number, y: number): Edge | 'center' {
  if (body.w <= 0 || body.h <= 0) return 'center'
  const rx = (x - body.x) / body.w
  const ry = (y - body.y) / body.h
  const d: Record<Edge, number> = { left: rx, right: 1 - rx, top: ry, bottom: 1 - ry }
  let best: Edge = 'left'
  for (const k of ['right', 'top', 'bottom'] as const) if (d[k] < d[best]) best = k
  return d[best] < EDGE_ZONE ? best : 'center'
}

/** 落点提示的矩形：边缘 = 那一半，中间 = 整个主体 */
export function zoneRect(body: Rect, zone: Edge | 'center'): Rect {
  const hw = Math.round(body.w / 2)
  const hh = Math.round(body.h / 2)
  switch (zone) {
    case 'left':
      return { ...body, w: hw }
    case 'right':
      return { ...body, x: body.x + body.w - hw, w: hw }
    case 'top':
      return { ...body, h: hh }
    case 'bottom':
      return { ...body, y: body.y + body.h - hh, h: hh }
    default:
      return body
  }
}

// ---------------------------------------------------------------- 拖标签时跟手的影子
/** 影子比标签大一圈（两行：图名 + 组名和作品数），宽度在这个范围里跟着标签宽 */
export const GHOST_MIN_W = 176
export const GHOST_MAX_W = 288
export const GHOST_H = 44
/** 影子放在鼠标右下方这么远，不挡住鼠标下面的落点提示（标签栏里那条插入竖线） */
const GHOST_GAP_X = 14
const GHOST_GAP_Y = 16

/**
 * 影子的位置和宽度（相对工作区容器）：放在鼠标右下方；右边、下边放不下就翻到鼠标左边、上边，始终留在容器里。
 * px / py = 鼠标相对容器的位置，tabW = 被拖标签的宽度，cw / ch = 容器的大小。
 */
export function ghostRect(px: number, py: number, tabW: number, cw: number, ch: number): { x: number; y: number; w: number } {
  const w = Math.min(GHOST_MAX_W, Math.max(GHOST_MIN_W, Math.round(tabW)), Math.max(0, cw - 8))
  let x = px + GHOST_GAP_X
  if (x + w > cw - 4) x = px - GHOST_GAP_X - w
  let y = py + GHOST_GAP_Y
  if (y + GHOST_H > ch - 4) y = py - GHOST_GAP_Y - GHOST_H
  return { x: Math.max(4, Math.min(x, cw - w - 4)), y: Math.max(4, Math.min(y, ch - GHOST_H - 4)), w }
}
