/**
 * 引擎实例和出题器之间的胶水（不依赖 React，方便用假引擎测试）。
 *
 * - 挂载一次；数据变了 setData，明暗变了 setTheme，卸载时 destroy
 * - 偏好（封面、配色、侧栏、上次视图）：挂载时带进去，引擎改了就回调出去存本地。字号倍率固定为 1（引擎顶栏不提供字号调节）
 * - 领地图算出新布局：回调出去（方案库拿去防抖 PATCH）
 * - 双击 / Ctrl+单击作品名：新标签页打开 Bangumi 条目
 * - 'pane' 布局（方案库的工作区）：初始视区带进去，视区变了回调出去存；全屏交给宿主（fullscreen:'host'）
 */
import type {
  FocusOptions,
  FocusResult,
  LayoutCache,
  MountOptions,
  TagNoteData,
  TagNoteInstance,
  TagNotePrefs,
  TagNoteWork,
  ViewKey,
  Viewport,
  ViewportChangeInfo,
} from '@/vendor/tagnote/tagnote.esm.js'

export type ThemeModeLD = 'light' | 'dark'

export const DEFAULT_PREFS: TagNotePrefs = { cover: true, scale: 1, color: true, drawer: false, view: null }

const VIEW_KEYS = new Set(['canvas', 'score', 'kmap', 'hasse', 'terr', 'line'])

/** 把任意输入整理成合法偏好：字号一律为 1（存着别的值也读成 1），视图只认六个内置 key */
export function sanitizePrefs(raw: unknown): TagNotePrefs {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof TagNotePrefs, unknown>>
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  const view = typeof p.view === 'string' && VIEW_KEYS.has(p.view) ? p.view : null
  return {
    cover: bool(p.cover, DEFAULT_PREFS.cover),
    scale: 1,
    color: bool(p.color, DEFAULT_PREFS.color),
    drawer: bool(p.drawer, DEFAULT_PREFS.drawer),
    view,
  }
}

/**
 * Bangumi 条目地址：只认 subject_id（正整数，或纯数字字符串）；没有就返回 null，调用方什么都不做。
 * 没有作品链接的卡片（例如导入的手写卡片）没有 subject_id，也没有 link / cover / char_id。
 */
export function bgmSubjectUrl(work: Pick<TagNoteWork, 'subject_id'>): string | null {
  const raw: unknown = work.subject_id
  const sid = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw
  if (typeof sid === 'number' && Number.isInteger(sid) && sid > 0) return `https://bgm.tv/subject/${sid}`
  return null
}

/** 引擎里本组件用到的那部分（真引擎是 TagNote 默认导出） */
export interface EngineLike {
  mount(element: HTMLElement, data: TagNoteData, options?: MountOptions): TagNoteInstance
}

export interface BindingOptions {
  data: TagNoteData
  theme: ThemeModeLD
  prefs?: unknown
  /** 新标签页打开（测试时可替换） */
  openUrl?: (url: string) => void
  onPrefsChange?: (prefs: TagNotePrefs) => void
  /** kind = 'terr' 等；full = 引擎当前的完整布局缓存 */
  onLayoutCache?: (kind: string, value: unknown, full: LayoutCache) => void
  /** 'pane'：占满宿主的高度、图区自己滚、能移动缩放（方案库的工作区）；不传 = 'page'（新建标签笔记的预览） */
  layout?: 'page' | 'pane'
  /** 'host'：引擎的全屏按钮只回调 onFullRequest，由宿主自己全屏，再用 setHostFull 告诉引擎 */
  fullscreen?: 'engine' | 'host'
  onFullRequest?: () => void
  /** 每个视图的初始视区（视图第一次画完才应用） */
  viewports?: Partial<Record<ViewKey, Viewport>>
  /** 拖动 / 缩放 / 滚动停下后回调（引擎防抖约 200ms）。info.by：'user' 用户动的 / 'focus' 聚焦的 reveal / 'host' 宿主或重排 */
  onViewportChange?: (view: ViewKey, vp: Viewport, info: ViewportChangeInfo) => void
  /** 程序聚焦被用户操作清掉了（引擎回调）：'pin' 点击固定了高亮，'esc' 在这个实例按了 Esc。被吞掉的点击、flash 结束、宿主 clearFocus 都不报 */
  onFocusTakeover?: (reason: FocusTakeoverReason) => void
}

export type FocusTakeoverReason = Parameters<NonNullable<MountOptions['onFocusTakeover']>>[0]

const NO_FOCUS: FocusResult = { found: [], secondaryFound: [], queued: false }

const defaultOpen = (url: string) => {
  window.open(url, '_blank', 'noopener,noreferrer')
}

export class TagNoteBinding {
  private inst: TagNoteInstance | null
  private dataKey: string | null = null
  private theme: ThemeModeLD
  private opts: BindingOptions
  private hostFull = false

  constructor(engine: EngineLike, host: HTMLElement, opts: BindingOptions, dataKey: string | null = null) {
    this.opts = opts
    this.theme = opts.theme
    this.dataKey = dataKey
    this.inst = null
    // 这些选项只在用到时才传：'page' 布局只用基本挂载参数
    const pane: MountOptions = {}
    if (opts.layout) pane.layout = opts.layout
    if (opts.fullscreen) pane.fullscreen = opts.fullscreen
    if (opts.fullscreen === 'host') pane.onFullRequest = () => this.opts.onFullRequest?.()
    if (opts.viewports) pane.viewports = opts.viewports
    // 引擎没给第三个参数时当作宿主引起的（不会被误当成「用户自己动过了」）
    if (opts.layout === 'pane') pane.onViewportChange = (view, vp, info) => this.opts.onViewportChange?.(view, vp, info ?? { by: 'host' })
    if (opts.onFocusTakeover) pane.onFocusTakeover = (reason) => this.opts.onFocusTakeover?.(reason)
    this.inst = engine.mount(host, opts.data, {
      ...pane,
      toolbar: true,
      heads: true,
      notes: false,
      theme: opts.theme,
      prefs: sanitizePrefs(opts.prefs),
      onPrefsChange: (prefs) => {
        const clean = sanitizePrefs(prefs)
        // 引擎顶栏不提供字号调节，正常不会报上来别的字号；万一不是 1（比如别处调了 setPrefs）就改回 1
        if (this.inst && clean.scale !== prefs.scale) this.inst.setPrefs({ scale: clean.scale })
        this.opts.onPrefsChange?.(clean)
      },
      onLayoutCache: (kind, value) => {
        const full = this.inst ? this.inst.getLayoutCache() : ({ [kind]: value } as LayoutCache)
        this.opts.onLayoutCache?.(kind, value, full)
      },
      onWorkOpen: (work) => {
        const url = bgmSubjectUrl(work)
        if (url) (this.opts.openUrl ?? defaultOpen)(url)
      },
    })
  }

  /** 回调换成最新的（组件每次渲染都可能给新函数） */
  update(opts: Partial<Pick<BindingOptions, 'onPrefsChange' | 'onLayoutCache' | 'openUrl' | 'onFullRequest' | 'onViewportChange' | 'onFocusTakeover'>>) {
    this.opts = { ...this.opts, ...opts }
  }

  /** 同一个 key 不重复 setData（避免把引擎正在用的布局缓存、选中状态冲掉） */
  setData(data: TagNoteData, key: string | null) {
    if (!this.inst) return
    if (key !== null && key === this.dataKey) return
    this.dataKey = key
    this.inst.setData(data)
  }

  setTheme(theme: ThemeModeLD) {
    if (!this.inst || theme === this.theme) return
    this.theme = theme
    this.inst.setTheme(theme)
  }

  /** 字体、尺寸变了以后重新排版（换主题包时字体会变） */
  rerender() {
    this.inst?.rerender()
  }

  /** 滚动区域变高变矮（侧栏的高度上限跟着变）：让引擎重新给读数区封顶 */
  fit() {
    this.inst?.fit()
  }

  getLayoutCache(): LayoutCache {
    return this.inst ? this.inst.getLayoutCache() : {}
  }

  /** 引擎当前的视图 */
  get view(): string | null {
    return this.inst?.view ?? null
  }

  /** 某个视图（默认当前视图）的视区；没画过、或引擎不支持时为 null */
  getViewport(view?: ViewKey): Viewport | null {
    return this.inst?.getViewport?.(view) ?? null
  }

  setViewport(vp: Partial<Viewport>, view?: ViewKey) {
    this.inst?.setViewport?.(vp, view)
  }

  /** 切视图（和顶栏的视图按钮一样；引擎会回调 onPrefsChange） */
  setView(view: ViewKey) {
    this.inst?.setView(view)
  }

  /** 程序触发的聚焦高亮（做题联动）；引擎不支持时什么都不做，返回「没找到」 */
  focusWorks(ids: string[], opts: FocusOptions): FocusResult {
    return this.inst?.focusWorks?.(ids, opts) ?? NO_FOCUS
  }

  clearFocus() {
    this.inst?.clearFocus?.()
  }

  /** 当前视图里画出来的作品 id；没画完或引擎不支持 = null */
  drawnWorkIds(): string[] | null {
    return this.inst?.drawnWorkIds?.() ?? null
  }

  /** 宿主全屏状态（fullscreen:'host'）：变了才告诉引擎 */
  setHostFull(on: boolean) {
    if (!this.inst || on === this.hostFull) return
    this.hostFull = on
    this.inst.setHostFull?.(on)
  }

  /**
   * 别的格子改了共用偏好（封面、配色、侧栏）：只推和引擎当前不一样的那几项。
   * 引擎 setPrefs 总会回调 onPrefsChange，一样的也推就会在几个格子之间来回推。
   */
  syncPrefs(patch: Partial<Pick<TagNotePrefs, 'cover' | 'color' | 'drawer'>>) {
    if (!this.inst) return
    const cur = this.inst.getPrefs()
    const diff: Partial<TagNotePrefs> = {}
    for (const k of ['cover', 'color', 'drawer'] as const) if (patch[k] !== undefined && patch[k] !== cur[k]) diff[k] = patch[k]
    if (Object.keys(diff).length) this.inst.setPrefs(diff)
  }

  getPrefs(): TagNotePrefs | null {
    return this.inst ? sanitizePrefs(this.inst.getPrefs()) : null
  }

  get alive(): boolean {
    return !!this.inst
  }

  destroy() {
    const inst = this.inst
    this.inst = null
    inst?.destroy()
  }
}

/**
 * el 下方、滚动内容结束前一定空着的高度：沿「el 是最后一个子元素」这条链往上，累加下外边距、父元素的下内边距和下边框。
 * 链上某一层后面还排着别的元素（下面有内容），就停在这一层，只算已经累加的。到 stop（滚动容器）为止，含它的下内边距。
 * 用途：滚到底时引擎侧栏可以伸进这段空白，不会被推到顶栏下面（--tn-space-below）。
 */
export function spaceBelow(el: HTMLElement, stop: HTMLElement | null): number {
  let sum = 0
  for (let child: HTMLElement = el, parent = el.parentElement; parent; child = parent, parent = parent.parentElement) {
    for (let n = child.nextElementSibling; n; n = n.nextElementSibling) {
      const ns = getComputedStyle(n)
      if (ns.display !== 'none' && ns.position !== 'absolute' && ns.position !== 'fixed') return sum
    }
    const ps = getComputedStyle(parent)
    sum += (parseFloat(getComputedStyle(child).marginBottom) || 0) + (parseFloat(ps.paddingBottom) || 0)
    if (parent === stop) break
    sum += parseFloat(ps.borderBottomWidth) || 0
  }
  return Math.max(0, Math.floor(sum))
}

/** 最近的竖向滚动容器（出题器里是 <main>）；没有就返回 null（= 整个窗口滚动） */
export function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return p
  }
  return null
}
