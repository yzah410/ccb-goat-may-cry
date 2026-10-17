/**
 * 路由表（导航、命令面板、分屏对比都读它）。
 * 加一个页面：在这里加一条 + 在 app/pages.ts 里登记组件 + 在 router.tsx 里加路由。
 */
import type { ComponentType, SVGProps } from 'react'
import type { RouteId } from '@/themes/types'
import {
  IconBrain,
  IconCanvas,
  IconClicker,
  IconDatabase,
  IconFolderOpen,
  IconLayers,
  IconListChecks,
  IconMessageQuestion,
  IconPalette,
  IconSettings,
  IconUserSearch,
  IconUsers,
  IconWorkbench,
} from '@/lib/icons'

export interface RouteDef {
  id: RouteId
  path: string
  label: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  /** main = 业务页；system = 系统页（导航里放下面一组） */
  group: 'main' | 'system'
  /** 一句话说明（命令面板、页头都用） */
  description: string
  /**
   * classic = 顶栏布局收进「经典 ▾」下拉的页面（经典工作台 / 经典候选池 / 自动点击），省出横向空间；
   * 侧栏 / 胶囊 / 分栏照常一项一项列出来。
   */
  cluster?: 'classic'
  /** 要后端装了经典工作台数据才有的页面（经典工作台 / 经典候选池） */
  needsClassicData?: boolean
}

// `/` 是工作台（路由 id 是 workbench），经典工作台在 /classic；
// 导图页同时支持工作台和经典工作台；经典候选池只读经典工作台的草稿。
export const ROUTE_DEFS: RouteDef[] = [
  { id: 'workbench', path: '/', label: '工作台', icon: IconWorkbench, group: 'main', description: '圈题库（范围 + 条件）、看人数、抽一题；可以一句话让 AI 填' },
  // 候选池：工作台当前方案圈到的全部角色
  { id: 'pool', path: '/pool', label: '候选池', icon: IconUserSearch, group: 'main', description: '工作台现在的方案圈到的全部角色：卡片 / 列表 / 统计，挑一个设为当前题目' },
  { id: 'canvas', path: '/canvas', label: '导图导出', icon: IconCanvas, group: 'main', description: '把工作台或经典工作台的筛选结果导出成 Obsidian 导图（.canvas）' },
  { id: 'plans', path: '/plans', label: '方案库', icon: IconFolderOpen, group: 'main', description: '工作台和经典工作台保存过的方案' },
  { id: 'lists', path: '/lists', label: '清单', icon: IconListChecks, group: 'main', description: '角色 / 作品 / 标签清单：例如排除已经记住的角色、只从某个系列出题' },
  { id: 'ask', path: '/ask', label: '问数据', icon: IconMessageQuestion, group: 'main', description: '一句话问数据，AI 写 SQL；结果能存成清单或条件' },
  // 单人猜猜呗：题目从方案里出，在这里直接猜；自动点击是把题目发到网页版猜猜呗
  { id: 'solo', path: '/solo', label: '单人猜猜呗', icon: IconBrain, group: 'main', description: '用工作台或已保存的方案出题，在这里直接猜；按记得牢不牢安排下一题' },
  { id: 'classic', path: '/classic', label: '经典工作台', icon: IconLayers, group: 'main', cluster: 'classic', needsClassicData: true, description: '按顺序组块（从上到下依次纳入 / 排除）圈题库；方案和工作台的方案分开存。需要经典工作台数据' },
  { id: 'candidates', path: '/candidates', label: '经典候选池', icon: IconUsers, group: 'main', cluster: 'classic', needsClassicData: true, description: '经典工作台方案的全部候选，挑一个设为当前题目' },
  { id: 'clicker', path: '/clicker', label: '自动点击', icon: IconClicker, group: 'main', cluster: 'classic', description: '把题目发到猜猜呗、开自动模式、看日志' },
  { id: 'data', path: '/data', label: '数据', icon: IconDatabase, group: 'system', description: '出题器数据库：数据量、dump 版本、构建时间、作品标签覆盖；经典工作台数据是否可用' },
  { id: 'themes', path: '/themes', label: '主题', icon: IconPalette, group: 'system', description: '切换主题、分屏对比两套主题' },
  { id: 'settings', path: '/settings', label: '设置', icon: IconSettings, group: 'system', description: '后端地址、AI、外观、缓存' },
]

export const ROUTE_BY_ID = new Map(ROUTE_DEFS.map((r) => [r.id, r]))

/** 导航、命令面板、分屏对比能选的页面；经典工作台那一组只在装了经典工作台数据时才有 */
export function visibleRoutes(classicAvailable: boolean): RouteDef[] {
  return ROUTE_DEFS.filter((r) => !r.needsClassicData || classicAvailable)
}

/**
 * 单人猜猜呗的独立页面（没有侧栏、占满窗口；/solo 页头「在新标签页打开」打开的就是它）。
 * 不进导航；routeIdFromPath 把它算作 solo（主题、壁纸按 solo 页画）。
 */
export const SOLO_FULL_PATH = '/solo/full'

export function routeIdFromPath(pathname: string): RouteId {
  const p = pathname.replace(/\/+$/, '') || '/'
  if (p === '/') return 'workbench'
  if (p.startsWith('/themes/compare')) return 'compare'
  const hit = ROUTE_DEFS.find((r) => r.path !== '/' && (p === r.path || p.startsWith(`${r.path}/`)))
  return hit?.id ?? 'not-found'
}

export function pathOf(id: RouteId): string {
  return ROUTE_BY_ID.get(id)?.path ?? '/'
}
