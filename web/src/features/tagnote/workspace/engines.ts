/**
 * 工作区里挂着的引擎实例的句柄（按标签 id），给工作区以外的功能用（做题联动的「跟随」：切视图、聚焦高亮、记 / 还原视区）。
 * 句柄由 PaneEngine 在实例挂载时登记、卸载时注销；视区变化（含 info.by）、引擎报的用户接管（onFocusTakeover）也从这里广播出去。
 * 不持久化、不碰 React。
 */
import type { FocusOptions, FocusResult, ViewKey, Viewport, ViewportChangeInfo } from '@/vendor/tagnote/tagnote.esm.js'
import type { FocusTakeoverReason } from '../binding'

export interface EngineHandle {
  tabId: string
  /** 这个实例画的是哪张图（标签换了图、新实例还没挂上时，旧实例的 mapId 和标签对不上） */
  mapId: string
  readonly view: string | null
  setView(view: ViewKey): void
  getViewport(view?: ViewKey): Viewport | null
  setViewport(vp: Partial<Viewport>, view?: ViewKey): void
  focusWorks(ids: string[], opts: FocusOptions): FocusResult
  clearFocus(): void
  drawnWorkIds(): string[] | null
  /** 图区（画板的滚动区域）在页面上的位置；拿不到 = null */
  boardRect(): DOMRect | null
}

export interface ViewportEvent {
  tabId: string
  view: ViewKey
  vp: Viewport
  by: ViewportChangeInfo['by']
}

const handles = new Map<string, EngineHandle>()
const changed = new Set<() => void>()
const mountListeners = new Set<(h: EngineHandle) => void>()
const vpListeners = new Set<(e: ViewportEvent) => void>()

export function registerEngine(h: EngineHandle): () => void {
  handles.set(h.tabId, h)
  for (const fn of [...changed]) fn()
  for (const fn of [...mountListeners]) {
    try {
      fn(h)
    } catch (err) {
      console.warn('[workspace] 实例挂载回调出错', err)
    }
  }
  return () => {
    if (handles.get(h.tabId) === h) handles.delete(h.tabId)
  }
}

/** 有实例挂上了（包括同一个标签的实例被换掉：开发时 StrictMode 挂两次、保活淘汰后重挂） */
export function onEngineMount(fn: (h: EngineHandle) => void): () => void {
  mountListeners.add(fn)
  return () => {
    mountListeners.delete(fn)
  }
}

/** 这个标签现在挂着的实例；给了 mapId 就只认画这张图的 */
export function engineOf(tabId: string, mapId?: string): EngineHandle | null {
  const h = handles.get(tabId)
  return h && (mapId === undefined || h.mapId === mapId) ? h : null
}

/**
 * 跟着重新挂载走的句柄：每次调用都找这个标签现在挂着的、画这张图的实例。
 * 实例会被换掉（开发时 StrictMode 挂两次、保活淘汰后重挂），等到手的那个可能已经销毁；找不到时才用原来那个。
 */
function liveHandle(first: EngineHandle): EngineHandle {
  const { tabId, mapId } = first
  const cur = () => engineOf(tabId, mapId) ?? first
  return {
    tabId,
    mapId,
    get view() {
      return cur().view
    },
    setView: (v) => cur().setView(v),
    getViewport: (v) => cur().getViewport(v),
    setViewport: (vp, v) => cur().setViewport(vp, v),
    focusWorks: (ids, opts) => cur().focusWorks(ids, opts),
    clearFocus: () => cur().clearFocus(),
    drawnWorkIds: () => cur().drawnWorkIds(),
    boardRect: () => cur().boardRect(),
  }
}

/** 等这个标签的实例挂上（最多 timeoutMs）；等不到 = null。给的句柄跟着重新挂载走 */
export function waitEngine(tabId: string, mapId: string, timeoutMs: number): Promise<EngineHandle | null> {
  const now = engineOf(tabId, mapId)
  if (now) return Promise.resolve(liveHandle(now))
  return new Promise((resolve) => {
    const check = () => {
      const h = engineOf(tabId, mapId)
      if (!h) return
      done(liveHandle(h))
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    function done(h: EngineHandle | null) {
      clearTimeout(timer)
      changed.delete(check)
      resolve(h)
    }
    changed.add(check)
  })
}

// ---------------------------------------------------------------- 用户接管：程序聚焦被用户操作清掉了
// 只认引擎的 onFocusTakeover：用户点击固定了高亮（'pin'，作品卡或侧栏标签）、在本实例按 Esc（'esc'），
// 并且当时确实有程序聚焦、确实被这次操作清掉了，引擎才回调；被吞掉的点击（空格抓手、拖动后的 click）、flash 结束、
// 宿主 clearFocus、新的 focusWorks 都不报。宿主不在 DOM 上猜。
// PaneEngine 挂引擎时传 focusTakeoverFor(...)，带上标签 id 转发到这里；跟随据此不再在重挂的实例上恢复聚焦。
const userFocusListeners = new Set<(tabId: string, reason: FocusTakeoverReason) => void>()

export function onUserFocus(fn: (tabId: string, reason: FocusTakeoverReason) => void): () => void {
  userFocusListeners.add(fn)
  return () => {
    userFocusListeners.delete(fn)
  }
}

export function emitUserFocus(tabId: string, reason: FocusTakeoverReason) {
  for (const fn of [...userFocusListeners]) {
    try {
      fn(tabId, reason)
    } catch (err) {
      console.warn('[workspace] 用户接管回调出错', err)
    }
  }
}

/**
 * 给引擎 onFocusTakeover 的回调：转发到 onUserFocus（带标签 id）。
 * mine() 为假（标签已经换成别的图、新实例还没挂上时旧实例报的）不转发：旧图上的聚焦和这个标签现在的图无关。
 */
export function focusTakeoverFor(tabId: string, mine: () => boolean): (reason: FocusTakeoverReason) => void {
  return (reason) => {
    if (mine()) emitUserFocus(tabId, reason)
  }
}

export function onViewportEvent(fn: (e: ViewportEvent) => void): () => void {
  vpListeners.add(fn)
  return () => {
    vpListeners.delete(fn)
  }
}

export function emitViewportEvent(e: ViewportEvent) {
  for (const fn of [...vpListeners]) {
    try {
      fn(e)
    } catch (err) {
      console.warn('[workspace] 视区回调出错', err)
    }
  }
}
