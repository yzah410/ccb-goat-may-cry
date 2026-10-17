/**
 * 工作区里一个标签的引擎实例：'pane' 布局（占满格子、图区自己在两个方向上滚、能移动缩放），全屏交给工作区（fullscreen:'host'）。
 *
 * - 一个标签一个实例，切到别的标签时 display:none 保活（悬停、固定高亮、视区都还在）。
 *   display:none 会让浏览器把滚动位置清零，所以切走前由 actions 快照视区（所有画过的视图，不只当前视图），切回来时这里按快照还原。
 *   卸载（关标签、保活淘汰、离开方案库）前也把所有视图的视区存一遍：引擎防抖中的回调会随实例一起丢掉。
 * - 同一个标签换成别的图 = 换一个新实例（按图 id 做 key）：旧图的视区、选中状态对新图没意义。
 *   新图数据到之前，旧图半透明留着，画面不闪白。
 * - 视图记在标签上（每个标签各自的视图）；封面、配色、侧栏是全局的，别的格子改了这里跟着同步。
 * - 领地图算出新布局：按这个实例自己的图 id 交给方案库的 saver（多个实例各存各的）。
 * - 实例的句柄登记到 ./engines.ts（做题联动的「跟随」用它切视图、聚焦高亮、记视区）；视区变化连同 info.by 一起广播；
 *   引擎报的用户接管（onFocusTakeover：点击固定了高亮、按 Esc，清掉了程序聚焦）原样转发过去。宿主不自己在 DOM 上猜。
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import TagNote from '@/vendor/tagnote/tagnote.esm.js'
import { ErrorState, Loading } from '@/components/data-display/Misc'
import { cn } from '@/lib/cn'
import { useThemeScope } from '@/themes/context'
import { TagNoteBinding, type EngineLike } from '../binding'
import { useMapDetail } from '../hooks'
import { useTagNoteLocal } from '../store'
import { FRAME_VARS, HOST_VARS, SCROLL_H_VAR, SPACE_BELOW_VAR } from '../tokens'
import type { LayoutCache, MapDetail } from '../types'
import { prefsFromEngine, registerLive, viewportsOf, wsActions } from './actions'
import { emitViewportEvent, focusTakeoverFor, registerEngine } from './engines'
import { isViewKey } from './tree'
import type { Rect } from './types'

export interface PaneEngineProps {
  tabId: string
  mapId: string
  /** 图区（格子去掉标签栏），像素，相对工作区 */
  rect: Rect
  /** 是这一格的当前标签（显示）；否则 display:none 保活 */
  shown: boolean
  /** 工作区在全屏：引擎的全屏按钮显示成「退出全屏」 */
  full: boolean
  onFullRequest: () => void
  onLayoutCache: (mapId: string, full: LayoutCache) => void
  /** 所在的格子：在图上按下鼠标 / 焦点进来时，这一格成为当前格 */
  paneId: string
  /** 测试时换成假引擎 */
  engine?: EngineLike
}

export function PaneEngine({ tabId, mapId, rect, shown, full, onFullRequest, onLayoutCache, paneId, engine = TagNote }: PaneEngineProps) {
  const detail = useMapDetail(mapId)
  const data = detail.data
  const failed = detail.isError && (!data || data.id !== mapId)
  // 格子的高度给侧栏当上限；'pane' 布局下顶栏不吸顶、下方没有页面空白
  const frame = {
    ...FRAME_VARS,
    '--tnv-sticky-top': '0px',
    [SCROLL_H_VAR]: `${rect.h}px`,
    [SPACE_BELOW_VAR]: '0px',
  } as typeof FRAME_VARS

  return (
    <div
      className="pointer-events-auto absolute min-w-0 overflow-hidden bg-bg"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, display: shown ? undefined : 'none' }}
      data-ws-engine={tabId}
      onPointerDownCapture={() => wsActions.activatePane(paneId)}
      onFocusCapture={() => wsActions.activatePane(paneId)}
    >
      {failed ? (
        <ErrorState error={detail.error} title="这张图没打开" onRetry={() => void detail.refetch()} />
      ) : data ? (
        // 'pane' 布局的引擎左右不留边（'page' 里由页面留）：这里左右各留一点，标题和画板的边框不贴着格子的边框、分隔线
        <div className="tagnote-frame relative h-full min-w-0 px-3" style={frame} data-tagnote-frame="">
          <EngineHost
            key={data.id}
            tabId={tabId}
            data={data}
            stale={detail.isPlaceholderData || data.id !== mapId}
            shown={shown}
            full={full}
            onFullRequest={onFullRequest}
            onLayoutCache={onLayoutCache}
            engine={engine}
          />
        </div>
      ) : (
        <Loading label="正在打开…" className="h-full" />
      )}
    </div>
  )
}

const dataKey = (d: MapDetail) => `${d.id}|${d.collection?.title ?? ''}`

function EngineHost({
  tabId,
  data,
  stale,
  shown,
  full,
  onFullRequest,
  onLayoutCache,
  engine,
}: {
  tabId: string
  data: MapDetail
  stale: boolean
  shown: boolean
  full: boolean
  onFullRequest: () => void
  onLayoutCache: (mapId: string, full: LayoutCache) => void
  engine: EngineLike
}) {
  const { theme, mode } = useThemeScope()
  const hostRef = useRef<HTMLDivElement>(null)
  const bindingRef = useRef<TagNoteBinding | null>(null)
  const shownRef = useRef(shown)
  const mapId = data.id
  // 只挂载一次：挂载时和回调里读的是这里的最新值
  const latest = useRef({ data, mode, onFullRequest, onLayoutCache })
  useLayoutEffect(() => {
    latest.current = { data, mode, onFullRequest, onLayoutCache }
  })

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const init = latest.current
    const st = useTagNoteLocal.getState()
    const tab = st.workspace.tabs[tabId]
    // 这个实例还在看这个标签的图吗（换图时新数据到之前，旧实例还留着；它报上来的东西不能记到新图头上）
    const mine = () => useTagNoteLocal.getState().workspace.tabs[tabId]?.mapId === mapId
    const own = tab?.mapId === mapId
    const binding = new TagNoteBinding(
      engine,
      host,
      {
        data: init.data,
        theme: init.mode,
        prefs: { ...st.prefs, view: (own && tab.view) || st.prefs.view },
        layout: 'pane',
        fullscreen: 'host',
        viewports: own ? tab.viewports : undefined,
        onFullRequest: () => latest.current.onFullRequest(),
        onPrefsChange: (p) => {
          if (mine()) prefsFromEngine(tabId, p)
        },
        onViewportChange: (view, vp, info) => {
          // 藏起来的时候尺寸是 0，报上来的不算（藏起来之前 actions 已把所有视图快照过）
          if (!shownRef.current || !mine()) return
          wsActions.setViewport(tabId, view, vp)
          emitViewportEvent({ tabId, view, vp, by: info.by })
        },
        onLayoutCache: (_kind, _value, cache) => latest.current.onLayoutCache(mapId, cache),
        onFocusTakeover: focusTakeoverFor(tabId, mine),
      },
      dataKey(init.data),
    )
    bindingRef.current = binding
    const off = registerLive({ tabId, capture: () => (shownRef.current && binding.alive && mine() ? viewportsOf(binding) : null) })
    const offEngine = registerEngine({
      tabId,
      mapId,
      get view() {
        return binding.view
      },
      setView: (v) => binding.setView(v),
      getViewport: (v) => binding.getViewport(v),
      setViewport: (vp, v) => binding.setViewport(vp, v),
      focusWorks: (ids, opts) => binding.focusWorks(ids, opts),
      clearFocus: () => binding.clearFocus(),
      drawnWorkIds: () => binding.drawnWorkIds(),
      boardRect: () => {
        // 引擎画在 shadow root 里；每个视图一个画板滚动区，取看得见的那个
        const wraps = host.shadowRoot?.querySelectorAll<HTMLElement>('.board-wrap') ?? []
        for (const el of wraps) {
          const r = el.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) return r
        }
        return null
      },
    })
    return () => {
      // 卸载（离开方案库、关标签、保活淘汰）前，所有画过的视图的视区记下来。
      // 藏着的实例也记：引擎只在显示时更新视区，藏着时问到的是藏起来那一刻的值，不是 0 尺寸量出来的。
      // 换了图（mine() 为假）的不记：旧图的视区对新图没意义；标签已经关掉的，setViewports 什么都不做。
      if (mine()) wsActions.setViewports(tabId, viewportsOf(binding))
      off()
      offEngine()
      bindingRef.current = null
      binding.destroy()
    }
  }, [engine, tabId, mapId])

  // 显示 / 隐藏：刚从 display:none 切回来时，滚动位置已被浏览器清零，按切走前记下的视区还原
  useLayoutEffect(() => {
    const was = shownRef.current
    shownRef.current = shown
    const b = bindingRef.current
    if (!b || !shown || was) return
    const view = b.view
    const vp = isViewKey(view) ? useTagNoteLocal.getState().workspace.tabs[tabId]?.viewports[view] : undefined
    if (vp && isViewKey(view)) b.setViewport(vp, view)
  }, [shown, tabId])

  useLayoutEffect(() => {
    bindingRef.current?.setData(data, dataKey(data))
  }, [data])

  useLayoutEffect(() => {
    bindingRef.current?.setTheme(mode)
  }, [mode])

  useLayoutEffect(() => {
    bindingRef.current?.setHostFull(full)
  }, [full])

  // 全局偏好（封面、配色、侧栏）：别的格子改了，这里跟着变
  const cover = useTagNoteLocal((s) => s.prefs.cover)
  const color = useTagNoteLocal((s) => s.prefs.color)
  const drawer = useTagNoteLocal((s) => s.prefs.drawer)
  useLayoutEffect(() => {
    bindingRef.current?.syncPrefs({ cover, color, drawer })
  }, [cover, color, drawer])

  // 换主题包（字体可能变了）：等字体就绪后重新排版
  const themeId = theme.manifest.id
  const lastThemeId = useRef(themeId)
  useEffect(() => {
    if (lastThemeId.current === themeId) return
    lastThemeId.current = themeId
    let cancelled = false
    const raf = requestAnimationFrame(() => {
      const ready = typeof document !== 'undefined' && document.fonts ? document.fonts.ready : Promise.resolve()
      void ready.then(() => {
        if (!cancelled) bindingRef.current?.rerender()
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [themeId])

  return (
    <>
      <div
        ref={hostRef}
        className={cn('tagnote-host h-full transition-opacity', stale && 'pointer-events-none opacity-50')}
        style={HOST_VARS}
        role="region"
        aria-label={data.collection?.title ?? '标签笔记'}
        aria-busy={stale || undefined}
      />
      {stale && (
        <p className="pointer-events-none absolute inset-x-0 top-12 text-center text-sm text-fg-3" role="status">
          正在打开…
        </p>
      )}
    </>
  )
}
