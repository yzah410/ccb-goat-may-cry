/**
 * 方案库右边的导图工作区：标签页 + 分屏（像 Obsidian）。
 *
 * 都画在一个 relative 容器里，绝对定位：
 * - 格子层：每一格 = 上方 36px 的标签栏（没有标签时下面是空态）
 * - 引擎层：每个保活的标签一个引擎实例，放在它那一格标签栏的下面；不是当前标签的 display:none。
 *   引擎层和格子层分开、实例按标签 id 排好：标签移到别的格子、分屏、拖分隔线时，实例只是换个位置，不重新挂载。
 * - 分隔线；拖标签时的落点提示和跟手的影子；右键菜单；「+」搜索框（都不走 portal，全屏时也看得见）
 *
 * 拖标签：按住超过 4px 才算拖。落在标签栏 = 插到那个位置（同一格 = 换顺序）；落在格子中间 = 移进那一格；
 * 落在格子边缘 = 在那一边分出一格。松手不会改变任何东西的落点不画提示。Esc 取消。
 *
 * 全屏：整个工作区容器（左边列表不进去）。浏览器不让全屏时退而铺满窗口，Esc 退出。
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/Button'
import { IconColumns, IconRows2, IconSearch, IconX } from '@/lib/icons'
import { cn } from '@/lib/cn'
import { boardInRoot } from '@/features/maplink/follow'
import { FollowButton } from '@/features/maplink/FollowButton'
import { FollowController } from '@/features/maplink/followController'
import { FollowOverlay } from '@/features/maplink/FollowOverlay'
import { FollowPanel } from '@/features/maplink/FollowPanel'
import { useFollow, useFollowRuntime } from '@/features/maplink/followStore'
import { useTagNoteLocal } from '../store'
import type { LayoutCache, MapSummary } from '../types'
import { KEEP_ALIVE, captureNow, useWsRuntime, wsActions } from './actions'
import { engineOf } from './engines'
import { mapLabels, type MapLabel } from './labels'
import { PaneEngine } from './PaneEngine'
import { QuickOpen } from './QuickOpen'
import { Splitter } from './Splitter'
import { TabBar } from './TabBar'
import { TabMenu, type TabMenuItem } from './TabMenu'
import * as T from './tree'
import type { DropTarget, PaneNode, Rect } from './types'

export interface WorkspaceProps {
  /** 方案库里的全部图（标签上的名字和色点、「+」搜索） */
  items: MapSummary[]
  /** 领地图算出新布局：按图 id 存 */
  onLayoutCache: (mapId: string, full: LayoutCache) => void
  className?: string
}

/** 拖标签时画在屏幕上的东西 */
interface DragView {
  tabId: string
  /** 跟手影子的左上角（相对容器）和宽度：在鼠标右下方，见 T.ghostRect */
  x: number
  y: number
  w: number
  /** 落点提示（相对容器）：标签栏里是一条竖线，格子主体里是半透明的一块；null = 这里松手什么都不变 */
  hint: Rect | null
  line: boolean
}

interface DragTrack {
  tabId: string
  pointerId: number
  sx: number
  sy: number
  /** 被拖标签的宽度（影子跟着它宽） */
  w: number
  started: boolean
  target: DropTarget | null
  stop: () => void
}

/** 'api' = 浏览器全屏；'window' = 浏览器不让全屏时铺满窗口 */
type FullMode = 'api' | 'window' | null

const DRAG_START = 4
const tabNum = (id: string) => Number(id.slice(1)) || 0

export function Workspace({ items, onLayoutCache, className }: WorkspaceProps) {
  const ws = useTagNoteLocal((s) => s.workspace)
  const mru = useWsRuntime((s) => s.mru)
  const rootRef = useRef<HTMLDivElement | null>(null)
  // 容器元素也放一份在状态里：「跟随」面板的下拉菜单挂在它里面（全屏时也看得见），渲染时要用
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null)
  const setRoot = useCallback((el: HTMLDivElement | null) => {
    rootRef.current = el
    setRootEl(el)
  }, [])
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [sizing, setSizing] = useState<{ splitId: string; sizes: number[] } | null>(null)
  const [drag, setDrag] = useState<DragView | null>(null)
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const [quick, setQuick] = useState<string | null>(null)
  const [full, setFull] = useState<FullMode>(null)
  /** 「跟随」设置面板：哪一格的按钮、按钮的右边和下边（相对容器） */
  const [followPanel, setFollowPanel] = useState<{ paneId: string; right: number; bottom: number } | null>(null)
  const dragRef = useRef<DragTrack | null>(null)

  const labels = useMemo(() => mapLabels(items), [items])

  // ---------------------------------------------------------------- 做题联动：跟随单人猜猜呗
  const queryClient = useQueryClient()
  const [follower] = useState(() => new FollowController({ queryClient, mapExists: () => true }))
  useEffect(() => {
    follower.start()
    return () => follower.dispose()
  }, [follower])
  useEffect(() => {
    // 方案库还没载入时都当作在（不然刷新后还原跟随时组里的图开不出来）
    follower.updateDeps({ mapExists: (id) => !items.length || labels.has(id) })
  }, [follower, items.length, labels])
  const followPane = useFollow((s) => s.pane)
  const followIds = useFollow((s) => s.mapIds)
  const linkStatus = useFollowRuntime((s) => s.link)
  const linkedMaps = useMemo(() => new Set(followIds), [followIds])
  const panes = useMemo(() => T.panesOf(ws.root), [ws.root])
  const geom = useMemo(
    () => T.computeLayout(ws.root, size.w, size.h, sizing ? { [sizing.splitId]: sizing.sizes } : undefined),
    [ws.root, size, sizing],
  )
  // 每一格的图区（去掉标签栏）；按格子缓存，拖标签时引擎的 props 不变、不重渲染
  const bodies = useMemo(() => {
    const out: Record<string, Rect> = {}
    for (const [id, r] of Object.entries(geom.panes)) out[id] = { x: r.x, y: r.y + T.TAB_BAR_H, w: r.w, h: Math.max(0, r.h - T.TAB_BAR_H) }
    return out
  }, [geom])
  const alive = useMemo(() => T.aliveTabs(ws, mru, KEEP_ALIVE), [ws, mru])
  const engines = useMemo(() => {
    const out: { tabId: string; mapId: string; pane: PaneNode }[] = []
    for (const id of [...alive].sort((a, b) => tabNum(a) - tabNum(b))) {
      const tab = ws.tabs[id]
      const pane = panes.find((p) => p.tabs.includes(id))
      if (tab && pane) out.push({ tabId: id, mapId: tab.mapId, pane })
    }
    return out
  }, [alive, ws.tabs, panes])

  // 事件处理里读最新的工作区和几何
  const latest = useRef({ ws, geom, panes })
  useLayoutEffect(() => {
    latest.current = { ws, geom, panes }
  })

  // 容器大小
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      const h = el.clientHeight
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 离开页面、切到别的浏览器标签前，把正在显示的视区存下来（引擎的视区回调有防抖，最后一下可能还没报）
  useEffect(() => {
    const vis = () => {
      if (document.visibilityState === 'hidden') captureNow()
    }
    window.addEventListener('pagehide', captureNow)
    document.addEventListener('visibilitychange', vis)
    return () => {
      window.removeEventListener('pagehide', captureNow)
      document.removeEventListener('visibilitychange', vis)
      dragRef.current?.stop()
    }
  }, [])

  // ---------------------------------------------------------------- 全屏
  const toggleFull = useCallback(() => {
    const el = rootRef.current
    if (!el) return
    if (document.fullscreenElement === el) {
      document.exitFullscreen().catch(() => setFull(null))
      return
    }
    if (full === 'window') {
      setFull(null)
      return
    }
    if (typeof el.requestFullscreen === 'function' && document.fullscreenEnabled !== false) {
      el.requestFullscreen().catch(() => setFull('window'))
    } else setFull('window')
  }, [full])

  useEffect(() => {
    const el = rootRef.current
    const on = () => setFull((f) => (el && document.fullscreenElement === el ? 'api' : f === 'api' ? null : f))
    document.addEventListener('fullscreenchange', on)
    return () => {
      document.removeEventListener('fullscreenchange', on)
      if (el && document.fullscreenElement === el) document.exitFullscreen().catch(() => {})
    }
  }, [])

  // 铺满窗口时 Esc 退出（引擎用这次 Esc 取消了固定高亮时会 preventDefault，那就不退）
  useEffect(() => {
    if (full !== 'window') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) setFull(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])

  // ---------------------------------------------------------------- 拖标签
  /** 鼠标下面是哪个落点 */
  const hitTest = (clientX: number, clientY: number, tabId: string): { target: DropTarget | null; hint: Rect | null; line: boolean } => {
    const none = { target: null, hint: null, line: false }
    const root = rootRef.current
    if (!root) return none
    const { ws: w, geom: g, panes: ps } = latest.current
    const rr = root.getBoundingClientRect()
    const ox = rr.left + root.clientLeft
    const oy = rr.top + root.clientTop
    const x = clientX - ox
    const y = clientY - oy
    for (const p of ps) {
      const r = g.panes[p.id]
      if (!r || x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) continue
      let target: DropTarget
      let hint: Rect
      let line = false
      if (y < r.y + T.TAB_BAR_H) {
        // 标签栏：插到鼠标左边最近的那个缝里（不算正在拖的那个）
        const els = [...root.querySelectorAll<HTMLElement>(`[data-ws-tabbar="${p.id}"] [data-tab-id]`)].filter((el) => el.dataset.tabId !== tabId)
        let index = els.findIndex((el) => {
          const b = el.getBoundingClientRect()
          return clientX < b.left + b.width / 2
        })
        if (index < 0) index = els.length
        const at = els[index]?.getBoundingClientRect()
        const prev = els[index - 1]?.getBoundingClientRect()
        const lx = (at ? at.left : prev ? prev.right : r.x + ox + 4) - ox
        target = { kind: 'tabs', pane: p.id, index }
        hint = { x: Math.max(r.x, Math.min(lx - 1, r.x + r.w - 2)), y: r.y + 5, w: 2, h: T.TAB_BAR_H - 8 }
        line = true
      } else {
        const body = { x: r.x, y: r.y + T.TAB_BAR_H, w: r.w, h: r.h - T.TAB_BAR_H }
        const zone = T.dropZone(body, x, y)
        target = zone === 'center' ? { kind: 'center', pane: p.id } : { kind: 'edge', pane: p.id, edge: zone }
        hint = T.zoneRect(body, zone)
      }
      return T.isNoopDrop(w, tabId, target) ? none : { target, hint, line }
    }
    return none
  }

  const onTabPointerDown = (e: ReactPointerEvent<HTMLElement>, tabId: string) => {
    if (e.button !== 0 || dragRef.current) return
    wsActions.activate(tabId)
    const r = e.currentTarget.getBoundingClientRect()
    const finish = (commit: boolean) => {
      const d = dragRef.current
      if (!d) return
      d.stop()
      dragRef.current = null
      setDrag(null)
      if (commit && d.started && d.target) wsActions.drop(d.tabId, d.target)
    }
    const move = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d || ev.pointerId !== d.pointerId) return
      if (!d.started) {
        if (Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < DRAG_START) return
        d.started = true
        setMenu(null)
        setQuick(null)
        setFollowPanel(null)
      }
      const root = rootRef.current
      if (!root) return
      const rr = root.getBoundingClientRect()
      const hit = hitTest(ev.clientX, ev.clientY, d.tabId)
      d.target = hit.target
      const g = T.ghostRect(ev.clientX - rr.left - root.clientLeft, ev.clientY - rr.top - root.clientTop, d.w, root.clientWidth, root.clientHeight)
      setDrag({ tabId: d.tabId, ...g, hint: hit.hint, line: hit.line })
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId === dragRef.current?.pointerId) finish(true)
    }
    const cancel = () => finish(false)
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !dragRef.current?.started) return
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', key, true)
    dragRef.current = {
      tabId,
      pointerId: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      w: r.width,
      started: false,
      target: null,
      stop: () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', cancel)
        window.removeEventListener('blur', cancel)
        window.removeEventListener('keydown', key, true)
      },
    }
  }

  // ---------------------------------------------------------------- 右键菜单、「+」搜索
  const openMenu = (tabId: string, clientX: number, clientY: number) => {
    const root = rootRef.current
    if (!root) return
    const rr = root.getBoundingClientRect()
    wsActions.activate(tabId)
    setQuick(null)
    setFollowPanel(null)
    setMenu({ tabId, x: clientX - rr.left - root.clientLeft, y: clientY - rr.top - root.clientTop })
  }
  const closeMenu = () => {
    const id = menu?.tabId
    setMenu(null)
    // 焦点回到那个标签（键盘打开菜单的人接着用键盘）
    if (id) rootRef.current?.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)?.focus()
  }
  const menuItems = (tabId: string): TabMenuItem[] => {
    const pane = panes.find((p) => p.tabs.includes(tabId))
    return [
      { key: 'right', label: '向右分屏', icon: <IconColumns />, run: () => wsActions.split(tabId, 'right') },
      { key: 'down', label: '向下分屏', icon: <IconRows2 />, run: () => wsActions.split(tabId, 'bottom') },
      { key: 'close', label: '关闭', icon: <IconX />, sep: true, run: () => wsActions.close(tabId) },
      { key: 'others', label: '关闭其他', disabled: (pane?.tabs.length ?? 0) < 2, run: () => wsActions.closeOthers(tabId) },
    ]
  }
  const openQuick = (paneId: string) => {
    wsActions.activatePane(paneId)
    setMenu(null)
    setFollowPanel(null)
    setQuick(paneId)
  }
  const quickPane = quick ? panes.find((p) => p.id === quick) : null

  // 「跟随」按钮：没在跟随 / 就是这一格 → 开面板（再点一下关）；别的格子在跟随 → 跟随移过来
  const onFollowClick = (paneId: string, anchor: DOMRect) => {
    const f = useFollow.getState()
    if (f.pane && f.pane !== paneId) {
      f.moveTo(paneId)
      return
    }
    if (followPanel?.paneId === paneId) {
      setFollowPanel(null)
      return
    }
    showFollowPanel(paneId, anchor)
  }
  const showFollowPanel = (paneId: string, anchor: DOMRect) => {
    const root = rootRef.current
    if (!root) return
    setMenu(null)
    setQuick(null)
    setFollowPanel({ paneId, ...anchorIn(root, anchor) })
  }
  // 面板开着时窗口、容器、格子的大小变了：按钮跟着挪了，面板按按钮现在的位置重新摆
  const followPanelId = followPanel?.paneId ?? null
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!followPanelId || !root) return
    const bar = root.querySelector<HTMLElement>(`[data-ws-tabbar="${followPanelId}"]`)
    const measure = () => {
      const btn = bar?.querySelector<HTMLElement>('[data-follow-btn]')
      if (!btn || !bar?.isConnected) return
      const at = anchorIn(root, btn.getBoundingClientRect())
      setFollowPanel((cur) => (cur?.paneId === followPanelId && (cur.right !== at.right || cur.bottom !== at.bottom) ? { ...cur, ...at } : cur))
    }
    measure()
    window.addEventListener('resize', measure)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(root)
    if (bar) ro?.observe(bar)
    return () => {
      window.removeEventListener('resize', measure)
      ro?.disconnect()
    }
  }, [followPanelId, geom])
  // 角落提示里的「选图组」：打开这一格的面板（已经开着就不动）
  const openFollowPanel = (paneId: string) => {
    const btn = rootRef.current?.querySelector<HTMLElement>(`[data-ws-tabbar="${paneId}"] [data-follow-btn]`)
    if (btn && followPanel?.paneId !== paneId) showFollowPanel(paneId, btn.getBoundingClientRect())
  }
  const closeFollowPanel = () => {
    const id = followPanel?.paneId
    setFollowPanel(null)
    if (id) rootRef.current?.querySelector<HTMLElement>(`[data-ws-tabbar="${id}"] [data-follow-btn]`)?.focus()
  }
  const followPanelPane = followPanel ? panes.find((p) => p.id === followPanel.paneId) : null

  // 跟随格的图区在容器里的位置（字幕和提示放在它的角上）；格子变了、标签切了就重新量
  const followShownTab = followPane ? (panes.find((p) => p.id === followPane)?.active ?? null) : null
  const [followBoard, setFollowBoard] = useState<Rect | null>(null)
  useLayoutEffect(() => {
    const root = rootRef.current
    const body = followPane ? (bodies[followPane] ?? null) : null
    const measure = () => {
      if (!root || !body) {
        setFollowBoard(null)
        return
      }
      const rr = root.getBoundingClientRect()
      const b = followShownTab ? (engineOf(followShownTab)?.boardRect() ?? null) : null
      const next = boardInRoot({ left: rr.left + root.clientLeft, top: rr.top + root.clientTop }, b, body)
      setFollowBoard((cur) => (cur && next && cur.x === next.x && cur.y === next.y && cur.w === next.w && cur.h === next.h ? cur : next))
    }
    measure()
    // 引擎实例刚挂上时图区还没排好：过一会儿再量一次
    const t = setTimeout(measure, 300)
    return () => clearTimeout(t)
  }, [followPane, followShownTab, bodies])

  const onEngineLayout = useCallback((mapId: string, cache: LayoutCache) => onLayoutCache(mapId, cache), [onLayoutCache])

  return (
    <div
      ref={setRoot}
      className={cn(
        'relative h-full min-h-0 overflow-hidden bg-bg',
        full ? 'rounded-none' : 'rounded-lg border border-border',
        full === 'window' && 'fixed inset-0 z-50',
        className,
      )}
      data-tagnote-workspace=""
      data-ws-full={full ?? undefined}
      data-ws-dragging={drag ? '' : undefined}
    >
      {size.w > 0 && (
        <>
          {/* 格子层：标签栏 + 空态 */}
          {panes.map((p) => {
            const r = geom.panes[p.id]
            if (!r) return null
            const current = p.id === ws.activePane
            return (
              <div
                key={p.id}
                className="absolute flex flex-col"
                style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                data-ws-pane={p.id}
                data-current={current && panes.length > 1 ? '' : undefined}
                onPointerDownCapture={() => wsActions.activatePane(p.id)}
              >
                <div className="shrink-0 bg-bg" style={{ height: T.TAB_BAR_H }}>
                  <TabBar
                    pane={p}
                    tabs={p.tabs.map((id) => ws.tabs[id]).filter((t) => !!t)}
                    labels={labels}
                    current={current || panes.length === 1}
                    dragging={drag?.tabId ?? null}
                    onTabPointerDown={onTabPointerDown}
                    onActivate={(id) => wsActions.activate(id)}
                    onClose={(id) => wsActions.close(id)}
                    onMenu={openMenu}
                    onAdd={() => openQuick(p.id)}
                    following={followPane === p.id}
                    linked={followPane === p.id ? linkedMaps : undefined}
                    actions={
                      <FollowButton
                        following={followPane === p.id}
                        elsewhere={!!followPane && followPane !== p.id}
                        link={linkStatus}
                        open={followPanel?.paneId === p.id}
                        disabled={!follower.available}
                        onClick={(r) => onFollowClick(p.id, r)}
                      />
                    }
                  />
                </div>
                {!p.tabs.length && <EmptyPane onSearch={() => openQuick(p.id)} />}
              </div>
            )
          })}

          {/* 引擎层 */}
          <div className="pointer-events-none absolute inset-0">
            {engines.map(({ tabId, mapId, pane }) => {
              const body = bodies[pane.id]
              if (!body) return null
              return (
                <MemoPaneEngine
                  key={tabId}
                  tabId={tabId}
                  mapId={mapId}
                  paneId={pane.id}
                  rect={body}
                  shown={pane.active === tabId}
                  full={!!full}
                  onFullRequest={toggleFull}
                  onLayoutCache={onEngineLayout}
                />
              )
            })}
          </div>

          {/* 外层的分隔线后画（压在上面）：丁字路口处抓到的是贯穿的那条 */}
          {[...geom.splitters].reverse().map((sp) => (
            <Splitter
              key={`${sp.splitId}:${sp.index}`}
              geom={sp}
              onLive={(sizes) => setSizing(sizes ? { splitId: sp.splitId, sizes } : null)}
              onCommit={(sizes) => wsActions.resize(sp.splitId, sizes)}
            />
          ))}

          {drag && (
            <>
              {/* 拖动中盖住引擎（不触发图上的悬停），光标变成抓手 */}
              <div className="absolute inset-0 z-20 cursor-grabbing" />
              {drag.hint && (
                <div
                  aria-hidden
                  className={cn(
                    'pointer-events-none absolute z-20 transition-[left,top,width,height] duration-100',
                    drag.line ? 'rounded-full bg-primary' : 'rounded-md border border-primary/70 bg-primary/15',
                  )}
                  style={{ left: drag.hint.x, top: drag.hint.y, width: drag.hint.w, height: drag.hint.h }}
                  data-ws-drop-hint=""
                />
              )}
              <DragGhost label={labels.get(ws.tabs[drag.tabId]?.mapId ?? '')} x={drag.x} y={drag.y} w={drag.w} />
            </>
          )}

          <FollowOverlay
            board={followPane ? followBoard : null}
            onUndo={() => follower.undoSwitch()}
            onDismiss={() => follower.dismissNotice()}
            onPanel={() => {
              follower.dismissNotice()
              if (followPane) openFollowPanel(followPane)
            }}
          />

          {menu && <TabMenu x={menu.x} y={menu.y} items={menuItems(menu.tabId)} onClose={closeMenu} />}

          {quickPane && (
            <QuickOpen
              items={items}
              openHere={new Set(quickPane.tabs.map((id) => ws.tabs[id]?.mapId).filter((m): m is string => !!m))}
              onPick={(mapId) => {
                setQuick(null)
                wsActions.open(mapId, { newTab: true, pane: quickPane.id })
              }}
              onClose={() => setQuick(null)}
            />
          )}

          {followPanel && followPanelPane && (
            <FollowPanel
              controller={follower}
              paneId={followPanel.paneId}
              anchor={followPanel}
              root={size}
              portalContainer={rootEl}
              items={items}
              labels={labels}
              onClose={closeFollowPanel}
            />
          )}
        </>
      )}
    </div>
  )
}

const MemoPaneEngine = memo(PaneEngine)

/** 按钮（页面坐标的矩形）的右边、下边在工作区容器里的位置（扣掉容器边框）：「跟随」面板按它摆 */
function anchorIn(root: HTMLElement, r: DOMRect): { right: number; bottom: number } {
  const rr = root.getBoundingClientRect()
  return { right: r.right - rr.left - root.clientLeft, bottom: r.bottom - rr.top - root.clientTop }
}

function EmptyPane({ onSearch }: { onSearch: () => void }) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-6 text-center shadow-[inset_0_1px_0_var(--border)]" data-ws-empty="">
      <div className="flex max-w-xs flex-col items-center gap-2">
        <p className="text-sm text-fg-2">没有打开的图</p>
        <p className="text-xs leading-body text-fg-3">点列表里的一张图在这里打开；Ctrl+点击或中键点击会新开一个标签。</p>
        <Button variant="secondary" size="sm" className="mt-1" icon={<IconSearch />} onClick={onSearch}>
          搜索全部图
        </Button>
      </div>
    </div>
  )
}

function DragGhost({ label, x, y, w }: { label: MapLabel | undefined; x: number; y: number; w: number }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-30 flex flex-col justify-center gap-0.5 rounded-lg border border-primary/60 bg-bg-elevated px-3 shadow-3"
      style={{ left: x, top: y, width: w, height: T.GHOST_H }}
      data-ws-ghost=""
    >
      <span className="flex min-w-0 items-center gap-2 text-sm font-medium leading-tight text-fg-1">
        <span className={cn('size-2 shrink-0 rounded-full', label?.dot ?? 'bg-fg-3')} />
        <span className="min-w-0 truncate">{label?.title ?? '…'}</span>
      </span>
      {label && (
        <span className="min-w-0 truncate pl-4 text-xs leading-tight text-fg-3">
          {label.group} · {label.nWorks} 部作品
        </span>
      )}
    </div>
  )
}
