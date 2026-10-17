/**
 * 导航适配层：布局组件只认这个 context，不直接碰 React Router。
 * - 正常 App：当前页来自 URL，点击 = 真的跳转（渲染成 <Link>，中键新标签页也能用）
 * - 分屏对比的格子里：当前页是格子自己的状态，点击只切换格子里的页面
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import type { RouteId } from '@/themes/types'
import { pathOf, routeIdFromPath } from '../routes'

export interface ShellNav {
  current: RouteId
  go: (id: RouteId) => void
  /** 有 href 的时候导航项渲染成链接 */
  href?: (id: RouteId) => string
  /** 在分屏对比格子里 */
  embedded: boolean
}

const ShellNavContext = createContext<ShellNav | null>(null)

export function useShellNav(): ShellNav {
  const v = useContext(ShellNavContext)
  if (!v) throw new Error('useShellNav 必须在 RouterShellNav / LocalShellNav 里用')
  return v
}

/** 正常 App：用 React Router */
export function RouterShellNav({ children }: { children: ReactNode }) {
  const loc = useLocation()
  const navigate = useNavigate()
  const current = routeIdFromPath(loc.pathname)
  const value = useMemo<ShellNav>(
    () => ({ current, go: (id) => navigate(pathOf(id)), href: pathOf, embedded: false }),
    [current, navigate],
  )
  return <ShellNavContext.Provider value={value}>{children}</ShellNavContext.Provider>
}

/** 分屏对比格子：自己管当前页 */
export function LocalShellNav({ current, go, children }: { current: RouteId; go: (id: RouteId) => void; children: ReactNode }) {
  const value = useMemo<ShellNav>(() => ({ current, go, embedded: true }), [current, go])
  return <ShellNavContext.Provider value={value}>{children}</ShellNavContext.Provider>
}
