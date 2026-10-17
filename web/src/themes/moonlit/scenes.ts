/**
 * 每个页面认准一张夜景（按页面分层，不随机）。slug 对应 assets/wallpapers/ 里的壁纸（可选，见该目录的 README.md）；
 * 没有对应壁纸时，Backdrop 只画纯 CSS 的夜空、月晕和萤火。
 *
 * 字段：
 * - pos：object-position（画面里哪一块放进可视区）
 * - zoom：放大倍数（图片上下有黑边时，放大把黑边推出可视区）
 * - origin：放大的中心
 * - strength：工作页里透出强度的系数（再乘 --backdrop-opacity）。偏亮的图给小一点，保证页头文字对比度
 */
import type { RouteId } from '../types'

export interface Scene {
  slug: string
  pos: string
  zoom?: number
  origin?: string
  strength: number
  /** 一句话说明这张图为什么给这一页（只是说明，界面上不显示） */
  why: string
}

export const SCENES: Record<RouteId, Scene> = {
  workbench: {
    slug: 'night-1',
    pos: '92% 42%',
    zoom: 1.22,
    origin: '70% 45%',
    strength: 1,
    why: '最常用的一页',
  },
  // 经典工作台和工作台用同一张图，问数据和数据页用同一张图，清单和方案库用同一张图
  classic: {
    slug: 'night-1',
    pos: '92% 42%',
    zoom: 1.22,
    origin: '70% 45%',
    strength: 1,
    why: '经典工作台：和工作台同一张',
  },
  ask: {
    slug: 'night-2',
    pos: '72% 40%',
    zoom: 1.24,
    origin: '60% 45%',
    strength: 0.9,
    why: '问数据：和数据页同一张',
  },
  lists: {
    slug: 'night-3',
    pos: '66% 34%',
    zoom: 1.24,
    origin: '60% 45%',
    strength: 0.8,
    why: '清单：和方案库同一张',
  },
  pool: {
    slug: 'night-4',
    pos: '78% 22%',
    strength: 0.6,
    why: '候选池（透出强度调小，给页头文字留对比度）',
  },
  // 经典候选池和候选池同一张
  candidates: {
    slug: 'night-4',
    pos: '78% 22%',
    strength: 0.6,
    why: '经典候选池：和候选池同一张',
  },
  plans: {
    slug: 'night-3',
    pos: '66% 34%',
    zoom: 1.24,
    origin: '60% 45%',
    strength: 0.8,
    why: '方案库',
  },
  clicker: {
    slug: 'night-5',
    pos: '96% 30%',
    strength: 0.55,
    why: '自动点击',
  },
  // 单人猜猜呗：和自动点击同一张（都是「猜猜呗」）
  solo: {
    slug: 'night-5',
    pos: '96% 30%',
    strength: 0.55,
    why: '单人猜猜呗：和自动点击同一张',
  },
  canvas: {
    slug: 'night-6',
    pos: '0% 0%',
    zoom: 1.5,
    origin: '0% 0%',
    strength: 0.5,
    why: '导图（背景只取左上一角）',
  },
  data: {
    slug: 'night-2',
    pos: '72% 40%',
    zoom: 1.24,
    origin: '60% 45%',
    strength: 0.9,
    why: '数据页很安静',
  },
  settings: {
    slug: 'night-7',
    pos: '66% 34%',
    zoom: 1.22,
    origin: '60% 40%',
    strength: 0.9,
    why: '设置页',
  },
  themes: {
    slug: 'night-8',
    pos: '50% 22%',
    strength: 1,
    why: '主题画廊：主角图，整张打开',
  },
  compare: {
    slug: 'night-1',
    pos: '92% 42%',
    zoom: 1.22,
    origin: '70% 45%',
    strength: 0.8,
    why: '分屏对比页本身：和工作台一样',
  },
  'not-found': {
    slug: 'night-5',
    pos: '100% 40%',
    strength: 1,
    why: '走丢了：整张打开',
  },
}

/** 这些页面「大方露出画面」（只在画廊 / 404 / 空态这类地方完整露出） */
export const SHOWCASE: ReadonlySet<RouteId> = new Set<RouteId>(['themes', 'not-found'])

export function sceneFor(route: RouteId): Scene {
  return SCENES[route] ?? SCENES.workbench
}
