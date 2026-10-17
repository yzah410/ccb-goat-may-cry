/**
 * 工作区的操作：改 useTagNoteLocal.workspace（纯逻辑在 ./tree.ts），外加两样不持久化的运行时状态：
 *
 * 1. 正在显示的引擎实例（registerLive）：每次改工作区之前，先把它们所有画过的视图的视区快照进各自的标签。
 *    原因：切走的标签会 display:none，浏览器会把它的滚动位置清零，事后再问引擎就晚了；
 *    引擎的 onViewportChange 有约 200ms 防抖，标签藏起来以后到期的回调不收（见 PaneEngine），
 *    刚缩放完、马上切到别的视图再切标签，那个视图的最后一下只能靠这里的快照。
 * 2. 最近用过的标签（useWsRuntime.mru）：保活上限按它淘汰。
 */
import { create } from 'zustand'
import { useTagNoteLocal } from '../store'
import type { TagNotePrefs } from '../types'
import * as T from './tree'
import { VIEW_KEYS, type DropTarget, type Edge, type ViewKey, type Viewport, type Workspace } from './types'

/** 最多同时保留几个引擎实例（每格的当前标签总是保留，哪怕超过） */
export const KEEP_ALIVE = 10

export const useWsRuntime = create<{ mru: readonly string[] }>(() => ({ mru: [] }))

// ---------------------------------------------------------------- 正在显示的实例
/** 一个标签各视图的视区 */
export type ViewportMap = Partial<Record<ViewKey, Viewport>>

export interface LiveHandle {
  tabId: string
  /** 正在显示、而且还在看这个标签的图时，返回所有画过的视图的视区（viewportsOf）；否则 null */
  capture: () => ViewportMap | null
}

/**
 * 引擎实例里所有画过的视图的视区：六个内置视图逐个问，没画过的（null）不要。
 * 只问当前视图不够：在分支画布缩放完、防抖还没到就切到标签谱，分支画布的最后一下只在引擎里。
 */
export function viewportsOf(b: { getViewport(view: ViewKey): Viewport | null }): ViewportMap {
  const out: ViewportMap = {}
  for (const k of VIEW_KEYS) {
    const vp = b.getViewport(k)
    if (vp) out[k] = vp
  }
  return out
}

function withViewports(ws: Workspace, tabId: string, vps: ViewportMap): Workspace {
  let w = ws
  for (const k of VIEW_KEYS) {
    const vp = vps[k]
    if (vp) w = T.setTabViewport(w, tabId, k, vp)
  }
  return w
}

const live = new Set<LiveHandle>()

export function registerLive(h: LiveHandle): () => void {
  live.add(h)
  return () => {
    live.delete(h)
  }
}

function captureAll(ws: Workspace): Workspace {
  let w = ws
  for (const h of live) {
    const c = h.capture()
    if (c) w = withViewports(w, h.tabId, c)
  }
  return w
}

/** 立刻把正在显示的视区存下来（离开页面、关浏览器标签前） */
export function captureNow() {
  const st = useTagNoteLocal.getState()
  const next = captureAll(st.workspace)
  if (next !== st.workspace) useTagNoteLocal.setState({ workspace: next })
}

// ---------------------------------------------------------------- 改工作区
/**
 * capture：改之前先快照正在显示的视区（默认要；只改大小、视图、视区这类不会藏起实例的操作可以不要）。
 * 没变就不写 store。
 */
export function updateWorkspace(fn: (ws: Workspace) => Workspace, { capture = true } = {}) {
  const st = useTagNoteLocal.getState()
  const base = capture ? captureAll(st.workspace) : st.workspace
  const next = fn(base)
  if (next !== st.workspace) useTagNoteLocal.setState({ workspace: next })
  const rt = useWsRuntime.getState()
  const mru = T.touchMru(next, rt.mru)
  if (mru !== rt.mru) useWsRuntime.setState({ mru })
}

const lastView = (): ViewKey | null => {
  const v = useTagNoteLocal.getState().prefs.view
  return T.isViewKey(v) ? v : null
}

export const wsActions = {
  /** 打开一张图：newTab = 新开标签（Ctrl+点击、中键、「+」搜索）；否则换掉当前格的当前标签（左边列表单击） */
  open(mapId: string, opts: { newTab?: boolean; pane?: string } = {}) {
    updateWorkspace((w) => T.openMap(w, mapId, { ...opts, view: lastView() }))
  },
  activate(tabId: string) {
    updateWorkspace((w) => T.activateTab(w, tabId))
  },
  activatePane(paneId: string) {
    updateWorkspace((w) => T.setActivePane(w, paneId), { capture: false })
  },
  close(tabId: string) {
    updateWorkspace((w) => T.closeTab(w, tabId))
  },
  closeOthers(tabId: string) {
    updateWorkspace((w) => T.closeOthers(w, tabId))
  },
  /** 右键「向右 / 向下分屏」：复制这个标签到新的一格 */
  split(tabId: string, edge: Extract<Edge, 'right' | 'bottom'>) {
    updateWorkspace((w) => {
      const p = T.paneOfTab(w, tabId)
      return p ? T.splitTab(w, tabId, p.id, edge, true) : w
    })
  },
  drop(tabId: string, target: DropTarget) {
    updateWorkspace((w) => T.applyDrop(w, tabId, target))
  },
  resize(splitId: string, sizes: number[]) {
    updateWorkspace((w) => T.setSplitSizes(w, splitId, sizes), { capture: false })
  },
  setViewport(tabId: string, view: ViewKey, vp: Viewport) {
    updateWorkspace((w) => T.setTabViewport(w, tabId, view, vp), { capture: false })
  },
  /** 一次存几个视图的视区（实例卸载前）；都没变就不写 */
  setViewports(tabId: string, vps: ViewportMap) {
    updateWorkspace((w) => withViewports(w, tabId, vps), { capture: false })
  },
  /** 删掉了一张图：当前标签换成 neighbor，其他看着它的标签关掉 */
  afterDeleted(mapId: string, neighbor: string | null) {
    updateWorkspace((w) => T.afterMapDeleted(w, mapId, neighbor))
  },
  /** 方案库里没有了的图：对应标签安静地关掉 */
  prune(exists: (mapId: string) => boolean) {
    updateWorkspace((w) => T.pruneMaps(w, exists))
  },
}

/**
 * 引擎报上来新的偏好：
 * - 视图记在这个标签上（每个标签各自的视图），同时当作全局「上次用的视图」（新开的标签用它）
 * - 封面、配色、侧栏是全局的：写进全局偏好，其他已挂载的格子由 PaneEngine 的 effect 跟着同步
 */
export function prefsFromEngine(tabId: string, p: TagNotePrefs) {
  const st = useTagNoteLocal.getState()
  const tab = st.workspace.tabs[tabId]
  const view = T.isViewKey(p.view) && tab && p.view !== tab.view ? p.view : null
  if (view) updateWorkspace((w) => T.setTabView(w, tabId, view), { capture: false })
  const g = st.prefs
  const next = { ...g, cover: p.cover, color: p.color, drawer: p.drawer, view: view ?? g.view }
  if (next.cover !== g.cover || next.color !== g.color || next.drawer !== g.drawer || next.view !== g.view) st.setPrefs(next)
}
