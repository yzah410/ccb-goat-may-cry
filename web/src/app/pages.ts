/**
 * 页面组件登记（懒加载，按页面分包）。路由和分屏对比都从这里取组件。
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { RouteId } from '@/themes/types'

type PageId = Exclude<RouteId, 'compare'>

export const PAGES: Record<PageId, LazyExoticComponent<ComponentType>> = {
  // `/` 是工作台；经典工作台在 /classic
  workbench: lazy(() => import('@/pages/workbench2/Workbench2Page')),
  classic: lazy(() => import('@/pages/classic/ClassicWorkbenchPage')),
  pool: lazy(() => import('@/pages/pool/PoolPage')),
  ask: lazy(() => import('@/pages/ask/AskPage')),
  lists: lazy(() => import('@/pages/lists/ListsPage')),
  candidates: lazy(() => import('@/pages/candidates/CandidatesPage')),
  plans: lazy(() => import('@/pages/plans/PlansPage')),
  clicker: lazy(() => import('@/pages/clicker/ClickerPage')),
  solo: lazy(() => import('@/pages/solo/SoloPage')),
  canvas: lazy(() => import('@/pages/canvas/CanvasPage')),
  data: lazy(() => import('@/pages/data/DataPage')),
  settings: lazy(() => import('@/pages/settings/SettingsPage')),
  themes: lazy(() => import('@/pages/themes/ThemesPage')),
  'not-found': lazy(() => import('@/pages/NotFoundPage')),
}

export const ComparePage = lazy(() => import('@/pages/themes/ComparePage'))

/** 单人猜猜呗的独立页面（/solo/full，没有侧栏），不套在普通外壳里 */
export const SoloFullPage = lazy(() => import('@/pages/solo/SoloFullPage'))
