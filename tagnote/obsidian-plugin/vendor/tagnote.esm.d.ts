// TagNote 引擎的类型声明（手写，随 src/tagnote.core.js 一起维护）。
// build.py 会把它复制成 engine/tagnote.esm.d.ts，以及各宿主 vendor 目录里的同名文件。

export type ViewKey = 'canvas' | 'score' | 'kmap' | 'hasse' | 'terr' | 'line';
export type ThemeMode = 'auto' | 'light' | 'dark';

export interface TagNoteWork {
  id: string;
  title: string;
  /** 用户手写备注，显示为作品名后的（备注） */
  note?: string;
  years?: string;
  score?: number | null;
  subject_id?: number;
  cover?: string | null;
  /** Obsidian 作品笔记的链接目标，形如 "<subject_id> - 作品名" */
  link?: string | null;
  char_id?: number | null;
  tags: string[];
  [extra: string]: unknown;
}

export interface TagNoteCollection {
  title: string;
  /**
   * 导图的来源标记：
   * manual = 手工整理的导图；batch = 批量生成的导图；outsetter = 在出题器里新建的导图。
   */
  source?: 'manual' | 'batch' | 'outsetter' | string;
  /** 导图的来源路径或标识（可选）。出题器导入时用它认出同一张导图，导图库里显示为「来自 …」；引擎本身不读 */
  origin?: string;
  generated_at?: string;
  [extra: string]: unknown;
}

export interface TerrCache { sig: string; cols: number; rows: number; pos: Record<string, [number, number]>; [k: string]: unknown }
export interface LayoutCache { terr?: TerrCache; [kind: string]: unknown }

export interface TagNoteData {
  schema?: 'tagnote/1' | string;
  collection?: TagNoteCollection;
  tag_groups?: Record<string, string[]>;
  works: TagNoteWork[];
  layout_cache?: LayoutCache;
  [extra: string]: unknown;
}

export interface TagNotePrefs {
  cover: boolean;
  /** 字号倍率。顶栏不提供字号按钮，宿主一般固定为 1；可以通过 prefs / setPrefs 传入 */
  scale: number;
  color: boolean;
  drawer: boolean;
  view: ViewKey | string | null;
}

export interface CustomView { key: string; name: string; no?: string; render(el: HTMLElement, inst: TagNoteInstance): void }

/** 一个视图的视区。zoom 0.25–3；cx/cy = 可见区域中心点对应的图上坐标（未缩放的 board 像素），
 *  范围是整张图（画板四周留了半个图区的空白，中心能到图上任意一点，出不了图）。
 *  用中心点而不是 scrollLeft/Top：格子大小变了（拖分隔线、进出全屏）还原时仍然对准同一块。
 *  home: true = 还在初始位置（100%，没平移也没缩放过）。带 home 的视区还原、格子变大小时都重新按初始规则摆：
 *  图比图区内容区大就从左上角开始，小就居中；cx/cy 这时只是参考。平移或缩放离开初始位置后，getViewport 返回的视区不带 home。
 *  没有 home 的视区（平移或缩放过的图）按 cx/cy 还原。
 *  setViewport 传 { home: true } = 回到初始（同 Shift+0），忽略同时传的 zoom/cx/cy；传了 zoom/cx/cy 而没传 home，就不是 home。 */
export interface Viewport { zoom: number; cx: number; cy: number; home?: true }

export interface MountOptions {
  view?: ViewKey | string;
  views?: ViewKey[] | null;
  customViews?: CustomView[];
  theme?: ThemeMode;
  prefs?: Partial<TagNotePrefs> | null;
  config?: Record<string, unknown> | null;
  coverOf?: ((work: TagNoteWork) => string | null | undefined) | null;
  toolbar?: boolean;
  heads?: boolean;
  notes?: boolean;
  extraCSS?: string;
  layoutCache?: LayoutCache | null;
  onLayoutCache?: ((kind: string, value: unknown) => void) | null;
  onPrefsChange?: ((prefs: TagNotePrefs) => void) | null;
  onViewChange?: ((view: string) => void) | null;
  /** 双击或 Ctrl/⌘ + 单击作品名；拿到的是原始作品对象 */
  onWorkOpen?: ((work: TagNoteWork, event: MouseEvent) => void) | null;

  /** 'page'（默认，Obsidian 插件用它）
   *  'pane'：根元素占满宿主的高度；顶栏在上；图区自己在两个方向上滚动；
   *          「标签与近邻」侧栏是独立的一列、自己滚动；不依赖页面滚动；
   *          分支画布「一屏放得下」、变高重排都按图区自己的高度算。
   *          移动缩放（空格 + 拖动 / 空格 + 滚轮）只在 'pane' 下启用；
   *          快捷键 Shift+1 显示全图（最大 100%）、Shift+0 回到初始，作用于鼠标所在（没有就是焦点所在）的实例，
   *          焦点在输入框里或带 Ctrl / Alt / ⌘ 时不拦。不在初始位置时右下角显示缩放百分比，点它 = Shift+0。 */
  layout?: 'page' | 'pane';

  /** 'engine'（默认）：引擎自己处理全屏
   *  'host'：全屏按钮只调用 onFullRequest()，引擎自己不调 requestFullscreen、不进 overlay；
   *          按钮的「全屏 / 退出全屏」状态由宿主用 setHostFull(on) 告诉引擎。 */
  fullscreen?: 'engine' | 'host';
  onFullRequest?: (() => void) | null;

  /** 初始视区（按视图）。视图首次画完后才应用；没画的视图先记着。 */
  viewports?: Partial<Record<ViewKey, Viewport>> | null;
  /** 拖动 / 缩放 / 滚动停下后（防抖约 200ms）回调，宿主拿去存。info.by 见 ViewportChangeInfo。 */
  onViewportChange?: ((view: ViewKey, vp: Viewport, info: ViewportChangeInfo) => void) | null;
  /** 程序聚焦（focusWorks）因为用户操作被引擎清掉时回调：'pin' = 用户点击固定了高亮（作品卡或侧栏标签），'esc' = 用户在本实例按 Esc。
   *  只在当时确实有程序聚焦、并且确实被这次用户操作清掉时回调（引擎状态改完后同步调用）；
   *  flash 自然结束、宿主 clearFocus、新的 focusWorks、被吞掉的点击（空格抓手模式、拖动后的 click）都不回调。 */
  onFocusTakeover?: ((reason: 'pin' | 'esc') => void) | null;
}

/** 视区是谁动的：
 *  'user'：用户平移 / 缩放 / 滚动 / Shift+1 / Shift+0 / 点右下角百分比标签；
 *  'focus'：focusWorks 的 reveal；
 *  'host'：setViewport、格子变大小后重摆等宿主或排版引起的。
 *  防抖合并时窗口内只要有过 'user' 就报 'user'。 */
export interface ViewportChangeInfo { by: 'user' | 'focus' | 'host' }

/** focusWorks 的选项 */
export interface FocusOptions {
  /** 'stay'：一直保持，直到 clearFocus()、下一次 focusWorks()，或用户点击固定了别的高亮（视为接管）。
   *          期间鼠标悬停照常临时覆盖它，移出作品卡后回到这个高亮；重画、切视图后仍保持（作品在新视图里画出来了就继续高亮）。
   *          调用之后、鼠标真正移动（离原位置 ≥ 2px）之前，浏览器补发的悬停（切标签 / 切视图后光标下面换了作品卡）不算悬停，不盖住它。
   *  'flash'：同样的高亮，作品框闪 3 下（约 1.5 秒）后高亮自动消失；视区停在原地，不回弹。
   *           prefers-reduced-motion 时改成一次淡入淡出。 */
  mode: 'stay' | 'flash';
  /** 先保证作品完整显示在图区可见矩形里（默认 true；留 24px 边距）：本来就完整可见 → 不动（home 保留）；
   *  不完整 → 用最小的平移移进来；当前缩放下装不下 → 缩小到刚好装下（不低于 0.25），绝不放大。
   *  ids 有多个时以外接矩形为准，0.25 下也装不下 → 只保证 ids[0]。约 250ms 缓动（prefers-reduced-motion 时瞬间完成），
   *  缓动中用户平移 / 滚轮 / 拖滚动条立刻停下、以用户为准；缓动中 getViewport 返回终点。
   *  动了视区就和用户平移一样去掉 home，结束后 onViewportChange(…, { by: 'focus' })。'page' 布局只做横向滚动。 */
  reveal?: boolean;
  /** 次要作品（猜错的作品）：虚线框，比主高亮淡；不参与 reveal，不带近邻；和 ids 重复的忽略。跟主高亮同生同灭。 */
  secondary?: string[];
}

export interface FocusResult {
  /** ids 里当前视图实际画出来、被高亮了的（排队时按数据判断） */
  found: string[];
  /** secondary 里当前视图实际画出来的（排队时按数据判断） */
  secondaryFound: string[];
  /** 实例还没画完 / 宿主宽度为 0 而排队了：显示并画完后自动执行（含 reveal；和 setViewport 都排队时先 setViewport） */
  queued: boolean;
}

export interface TagNoteInstance {
  readonly host: HTMLElement;
  readonly view: string | null;
  readonly M: unknown;
  setView(key: ViewKey | string): void;
  setData(data: TagNoteData): void;
  setPrefs(prefs: Partial<TagNotePrefs>): void;
  setTheme(theme: ThemeMode): void;
  rerender(): void;
  /** 宿主改了侧栏的高度上限（如 --tn-drawer-max 依赖的面板高度）以后调用：重新给读数区封顶。很便宜，可以每次尺寸变化都调（侧栏宽度也变了时，较慢的重新测量会延后到停止变化 150ms 后）。 */
  fit(): void;
  /** 是否在全屏（浏览器全屏，或浏览器不让全屏时铺满窗口） */
  isFull(): boolean;
  /** 进入 / 退出全屏；和顶栏的「全屏」按钮、Esc 效果一样 */
  setFull(on: boolean): void;
  getPrefs(): TagNotePrefs;
  getLayoutCache(): LayoutCache;
  /** 不传 view = 当前视图。该视图还没画过时返回 null。 */
  getViewport(view?: ViewKey): Viewport | null;
  /** 不传 view = 当前视图。视图还没画完时先排队，画完再应用。缺的字段保持原值（home 见 Viewport）。 */
  setViewport(vp: Partial<Viewport>, view?: ViewKey): void;
  /** 当前视图缩放回 1，保持中心点不变（回到初始位置用 setViewport({ home: true })）。 */
  resetZoom(): void;
  /** fullscreen:'host' 时宿主报告全屏状态，按钮文字 / 图标跟着变。
   *  不影响 Esc 归属：全屏容器里有几个实例时，Esc 照常归鼠标所在 / 焦点所在 / 最后交互的那个看得见的实例。 */
  setHostFull(on: boolean): void;
  /** 程序触发的聚焦高亮（效果同鼠标悬停作品卡：作品框、标签近邻、其他作品变淡）。
   *  ids = 作品 id（DOM 上的 data-wid，works[].id）；ids 为空 = clearFocus()。
   *  最后一次操作说了算：调用时用户已固定的高亮被取消；之后用户点击固定了高亮 = 接管，程序聚焦清掉；Esc 也清（只作用于当前实例）。 */
  focusWorks(ids: string[], opts: FocusOptions): FocusResult;
  /** 清掉程序聚焦（含排队的） */
  clearFocus(): void;
  /** 当前视图里画出来的作品 id；没画完返回 null */
  drawnWorkIds(): string[] | null;
  destroy(): void;
}

export interface ViewInfo { key: ViewKey; no: string; name: string; [k: string]: unknown }

declare const TagNote: {
  mount(element: HTMLElement, data: TagNoteData, options?: MountOptions): TagNoteInstance;
  buildModel(data: TagNoteData, config?: Record<string, unknown> | null, coverOf?: MountOptions['coverOf']): unknown;
  diffOf(M: unknown, from: unknown, to: unknown): { plus: string[]; minus: string[] };
  computeLayoutCache(data: TagNoteData, config?: Record<string, unknown> | null): LayoutCache;
  VIEWS: ViewInfo[];
  DEFAULT_CONFIG: Record<string, unknown>;
  VERSION: string;
};
export default TagNote;
