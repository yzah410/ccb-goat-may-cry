/**
 * TagNote 引擎的 React 包装：挂载一次；数据变了 setData；明暗变了 setTheme；卸载时 destroy。
 *
 * 结构：外框（--tnv-*：出题器的主题 token 在这里解析）→ 挂载元素（--tn-*: var(--tnv-*)，引擎在它的 Shadow DOM 里画）。
 * 两层变量映射见 ../tokens.ts。外框和挂载元素都不设 overflow，使「标签与近邻」侧栏能相对页面滚动区域吸顶。
 */
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react'
import TagNote from '@/vendor/tagnote/tagnote.esm.js'
import { cn } from '@/lib/cn'
import { useThemeScope } from '@/themes/context'
import { TagNoteBinding, scrollParent, spaceBelow, type EngineLike } from '../binding'
import { useTagNoteLocal } from '../store'
import { FRAME_VARS, HOST_VARS, SCROLL_H_VAR, SPACE_BELOW_VAR } from '../tokens'
import type { LayoutCache, TagNoteData } from '../types'

export interface TagNoteViewHandle {
  /** 引擎当前的布局缓存（存进方案库、下载笔记时带上） */
  getLayoutCache: () => LayoutCache
}

export interface TagNoteViewProps {
  data: TagNoteData
  /** 数据的身份：变了才 setData（同一张图只是缓存里多了布局，不重画） */
  dataKey: string
  /** 领地图算出新布局；full = 引擎当前完整的布局缓存 */
  onLayoutCache?: (kind: string, value: unknown, full: LayoutCache) => void
  className?: string
  'aria-label'?: string
  ref?: Ref<TagNoteViewHandle>
  /** 测试时换成假引擎 */
  engine?: EngineLike
}

export function TagNoteView({ data, dataKey, onLayoutCache, className, 'aria-label': ariaLabel, ref, engine = TagNote }: TagNoteViewProps) {
  const { theme, mode } = useThemeScope()
  const frameRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const bindingRef = useRef<TagNoteBinding | null>(null)
  // 只挂载一次：挂载时和回调里读的是这里的最新值
  const latest = useRef({ data, dataKey, mode, onLayoutCache })
  useLayoutEffect(() => {
    latest.current = { data, dataKey, mode, onLayoutCache }
  })

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const init = latest.current
    const binding = new TagNoteBinding(
      engine,
      host,
      {
        data: init.data,
        theme: init.mode,
        prefs: useTagNoteLocal.getState().prefs,
        onPrefsChange: (prefs) => useTagNoteLocal.getState().setPrefs(prefs),
        onLayoutCache: (kind, value, full) => latest.current.onLayoutCache?.(kind, value, full),
      },
      init.dataKey,
    )
    bindingRef.current = binding
    return () => {
      bindingRef.current = null
      binding.destroy()
    }
  }, [engine])

  useLayoutEffect(() => {
    bindingRef.current?.setData(data, dataKey)
  }, [data, dataKey])

  useLayoutEffect(() => {
    bindingRef.current?.setTheme(mode)
  }, [mode])

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

  // 侧栏最大高度按真正的滚动区域算（出题器的 <main> 比窗口矮）；
  // 再量出引擎下方的空白（页面的下内边距），滚到底时侧栏伸进去，不被推到顶栏下面
  useEffect(() => {
    const frame = frameRef.current
    const sc = scrollParent(frame)
    if (!frame || !sc || typeof ResizeObserver === 'undefined') return
    const apply = () => {
      frame.style.setProperty(SCROLL_H_VAR, `${sc.clientHeight}px`)
      frame.style.setProperty(SPACE_BELOW_VAR, `${spaceBelow(frame, sc)}px`)
      bindingRef.current?.fit()
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(sc)
    return () => ro.disconnect()
  }, [])

  useImperativeHandle(ref, () => ({ getLayoutCache: () => bindingRef.current?.getLayoutCache() ?? {} }), [])

  return (
    <div
      ref={frameRef}
      // 底部胶囊布局：胶囊（离底 5 个间距单位、高约 14 个）浮在内容上，侧栏下沿让开 20 个间距单位
      className={cn('tagnote-frame min-w-0 in-data-[layout=dock]:[--tnv-sticky-bottom:calc(var(--space-unit)*20)]', className)}
      style={FRAME_VARS}
      data-tagnote-frame=""
    >
      <div ref={hostRef} className="tagnote-host" style={HOST_VARS} role="region" aria-label={ariaLabel ?? '标签笔记'} />
    </div>
  )
}
