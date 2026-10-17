import type { ComponentType } from 'react'
import type { UiEmojiKind } from '@/lib/emoji-names'

/** 路由 id（Backdrop / slots 用它判断当前在哪一页） */
export type RouteId =
  | 'workbench'
  /** 经典工作台（按顺序组块，/classic） */
  | 'classic'
  /** 问数据（/ask） */
  | 'ask'
  /** 清单（/lists） */
  | 'lists'
  /** 候选池（/pool，工作台方案圈到的全部角色；经典工作台的候选池是 candidates） */
  | 'pool'
  | 'candidates'
  | 'plans'
  | 'clicker'
  /** 单人猜猜呗（/solo）：在出题器里直接练，不经过网页点击 */
  | 'solo'
  | 'canvas'
  | 'data'
  | 'settings'
  | 'themes'
  | 'compare'
  | 'not-found'

export type ThemeMode = 'light' | 'dark'
export type ShellKind = 'sidebar' | 'topbar' | 'dock' | 'split'
export type Density = 'compact' | 'comfortable' | 'spacious'

/** 主题包的身份证（themes/<id>/manifest.ts 的 default export） */
export interface ThemeManifest {
  /** 必须和文件夹名一致，只用小写字母、数字、短横线 */
  id: string
  /** 中文名，例：「月夜·萤火」 */
  name: string
  /** 英文名，例：「Moonlit」 */
  nameEn: string
  /** 一句话标语（画廊卡片上显示） */
  tagline: string
  /** 两三句设计说明（画廊卡片展开后显示） */
  description: string
  /** 用到的壁纸 slug（见 assets/wallpapers/palette.json），可以为空数组 */
  wallpapers: string[]
  /** 画廊卡片上展示的那张壁纸 slug；不填就用 wallpapers[0]；都没有就显示纯色块 */
  previewWallpaper?: string
  /** 支持的明暗模式，至少一个 */
  modes: ThemeMode[]
  /** 默认明暗，必须在 modes 里 */
  defaultMode: ThemeMode
  /**
   * 可选：明暗设成「自动」时，按当前时间等条件算出该用哪种（例：6:00–18:00 浅色、其余深色）。
   * 不写 = 「自动」就是 defaultMode。ThemeProvider 每 5 分钟、以及页面重新可见时重算一次，
   * 所以开着页面跨过切换点也会自动换。返回值不在 modes 里会被夹回去。
   */
  autoMode?: () => ThemeMode
  /** 布局：侧栏 / 顶栏 / 底部胶囊 / 分栏（左导航 + 右上下文面板） */
  shell: ShellKind
  /** 密度：紧凑 / 舒适 / 宽松（决定 --space-unit 和控件高度的默认值） */
  density: Density
  /** 字体家族的人类可读说明（真正生效的是 tokens.css 里的 --font-*） */
  fonts: { display: string; body: string; mono: string }
  author: string
  /** ISO 日期，例：2026-01-01 */
  createdAt: string
  /**
   * 可选：true = 不在主题画廊、命令面板的切主题列表、分屏对比的下拉里列出。
   * 但它是正常注册的主题，可以用 `?theme=<id>` 直接打开——用于主题契约的演示主题（preview）和自动化测试，
   * 不是给日常使用挑的主题。默认 false（正常显示）。
   */
  hidden?: boolean
}

// ---------------------------------------------------------------------------
// Slots：主题可以替换的「装饰性」组件。取不到就用 base 的。
// ---------------------------------------------------------------------------

export interface BackdropProps {
  /** 当前页面 */
  route: RouteId
  /** 当前明暗 */
  mode: ThemeMode
  /**
   * true = 渲染在分屏对比 / 画廊缩略这种「小窗口」里。
   * 这时请省着点：不要跑动画、不要加载多张大图。
   */
  compact?: boolean
}

export interface LogoProps {
  /** 侧栏收起时只显示图形，不显示文字 */
  collapsed?: boolean
}

export type EmptyKind = UiEmojiKind

export interface EmptyIllustrationProps {
  kind: EmptyKind
  /** 像素，默认 72 */
  size?: number
}

export interface CardOrnamentProps {
  /** featured = 抽题结果卡、当前题目卡这类「主角卡」；default = 普通卡片（大多数主题这里什么都不画） */
  variant: 'default' | 'featured'
  tone?: 'neutral' | 'primary' | 'include' | 'exclude'
}

export interface LoadingIndicatorProps {
  size?: 'sm' | 'md' | 'lg'
  /** 读屏文字，也可以显示出来 */
  label?: string
}

export interface PageHeaderDecorProps {
  route: RouteId
  title: string
}

export interface NavItemDecorProps {
  route: RouteId
  active: boolean
  /** 当前布局，方便决定指示条画在哪一边 */
  shell: ShellKind
}

export interface ThemeSlots {
  Logo?: ComponentType<LogoProps>
  EmptyIllustration?: ComponentType<EmptyIllustrationProps>
  CardOrnament?: ComponentType<CardOrnamentProps>
  LoadingIndicator?: ComponentType<LoadingIndicatorProps>
  PageHeaderDecor?: ComponentType<PageHeaderDecorProps>
  NavItemDecor?: ComponentType<NavItemDecorProps>
}

export type SlotName = keyof ThemeSlots

/** registry 注册后的完整主题（manifest + 可选的组件 + token 覆盖率） */
export interface RegisteredTheme {
  manifest: ThemeManifest
  slots: ThemeSlots
  Backdrop?: ComponentType<BackdropProps>
  /** tokens.css 里声明了哪些 token（用于覆盖率统计） */
  declaredTokens: Set<string>
  /** 必填 token 里缺了哪些 */
  missingRequired: string[]
  /** 0–1 */
  coverage: number
  /** manifest 自检发现的问题（中文） */
  problems: string[]
}

/**
 * 加载失败的主题（registry 逐个主题隔离加载：某个主题的文件缺了 / 语法错 / 模块顶层抛错，只有它被跳过）。
 * 画廊里显示成「加载失败」卡片；选中过它的用户自动退回 base。
 */
export interface ThemeLoadFailure {
  /** 文件夹名（= 这个主题本该有的 id） */
  id: string
  /** manifest 读到了就是它的中文名，否则是文件夹名 */
  name: string
  /** 每条一句：哪个文件、出了什么错 */
  errors: string[]
}
