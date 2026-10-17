/**
 * 导图工作区（标签页 + 分屏）的数据类型。
 *
 * 树：叶子是「格子」（pane：一排标签 + 当前标签），中间节点是「分屏」（split：row = 左右排，col = 上下排，
 * n 个孩子按 sizes 分，sizes 加起来是 1）。标签本身单独放在 tabs 里，格子只记标签 id 的顺序。
 * 整个工作区存在 useTagNoteLocal.workspace（浏览器 localStorage），刷新后原样还原。
 */
import type { ViewKey, Viewport } from '@/vendor/tagnote/tagnote.esm.js'

export type { ViewKey, Viewport }

export const VIEW_KEYS: readonly ViewKey[] = ['canvas', 'score', 'kmap', 'hasse', 'terr', 'line']

export interface WsTab {
  id: string
  mapId: string
  /** 这个标签正在看的视图；null = 还没定（挂载时用全局「上次用的视图」） */
  view: ViewKey | null
  /** 每个视图各自的视区（引擎 onViewportChange 报上来的；切走前再快照一次） */
  viewports: Partial<Record<ViewKey, Viewport>>
}

export interface PaneNode {
  type: 'pane'
  id: string
  /** 标签 id，按标签栏上的顺序 */
  tabs: string[]
  /** 这一格的当前标签；没有标签时为 null */
  active: string | null
}

/** row = 孩子左右排（竖分隔线）；col = 孩子上下排（横分隔线） */
export type SplitDir = 'row' | 'col'

export interface SplitNode {
  type: 'split'
  id: string
  dir: SplitDir
  children: LayoutNode[]
  /** 每个孩子占的比例，加起来是 1 */
  sizes: number[]
}

export type LayoutNode = PaneNode | SplitNode

export interface Workspace {
  tabs: Record<string, WsTab>
  root: LayoutNode
  /** 当前格：最后点过的那一格；图头（改名、删除、下载）和左边列表的点击都作用于它的当前标签 */
  activePane: string
  /** 生成 id 用的计数器（t3、p4、s5……） */
  seq: number
  /** 打开过图没有：全新的工作区第一次进方案库时自动打开列表第一张；用户自己关光了就留空 */
  opened: boolean
}

export type Edge = 'left' | 'right' | 'top' | 'bottom'

/** 拖标签松手的落点 */
export type DropTarget =
  /** 某一格的标签栏，插到第 index 个位置（不算正在拖的那个） */
  | { kind: 'tabs'; pane: string; index: number }
  /** 某一格的中间：移进那一格（排在最后） */
  | { kind: 'center'; pane: string }
  /** 某一格的边缘：在那一边分出一格 */
  | { kind: 'edge'; pane: string; edge: Edge }

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
