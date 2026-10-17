import { Suspense, useEffect } from 'react'
import { Outlet, useLocation, useRouteError, isRouteErrorResponse, Link } from 'react-router'
import { Loading, EmptyState } from '@/components/data-display/Misc'
import { Button } from '@/components/ui/Button'
import { ClassicGate } from '@/features/classic/ClassicGate'
import { PlanDialogs } from '@/features/plans/components/PlanDialogs'
import { PlanDialogsV2 } from '@/features/workbench2/components/PlanDialogsV2'
import { TiersGate } from '@/features/tiers/TiersGate'
import { ThemeRouteContext } from '@/themes/context'
import { AppShell } from './shell/AppShell'
import { CommandPalette } from './shell/CommandPalette'
import { RouterShellNav } from './shell/nav'
import { ThemeUrlSync } from './themeActions'
import { ROUTE_BY_ID, routeIdFromPath } from './routes'
import { PAGES } from './pages'
import { backToBaseTheme, isCustomLook } from './recovery'
import type { RouteId } from '@/themes/types'

/** 所有普通页面的外层：外壳 + 命令面板 + 全局方案对话框 */
export function RootLayout() {
  const loc = useLocation()
  const route = routeIdFromPath(loc.pathname)

  // 主内容区自己滚动，换页时回到顶部；顺便改标题
  useEffect(() => {
    document.getElementById('main')?.scrollTo({ top: 0 })
    const label = ROUTE_BY_ID.get(route)?.label
    document.title = label ? `${label} · 山羊五月哭` : '山羊五月哭'
  }, [route])

  return (
    // 当前页面也给外壳外面的命令面板、方案对话框（主题的空态插画等 slot 可以用 useThemeRoute() 读）
    <ThemeRouteContext.Provider value={route}>
      <RouterShellNav>
        <ThemeUrlSync />
        <div className="h-dvh">
          <AppShell route={route}>
            <Suspense fallback={<Loading label="正在打开页面…" className="py-24" />}>
              <Outlet />
            </Suspense>
          </AppShell>
        </div>
        <CommandPalette />
        <PlanDialogs />
        <PlanDialogsV2 />
        <TiersGate />
      </RouterShellNav>
    </ThemeRouteContext.Provider>
  )
}

/** 按 id 渲染懒加载页面；经典工作台的页面要等后端确认装了经典工作台数据 */
export function PageById({ id }: { id: Exclude<RouteId, 'compare'> }) {
  const Page = PAGES[id]
  if (ROUTE_BY_ID.get(id)?.needsClassicData) {
    return (
      <ClassicGate>
        <Page />
      </ClassicGate>
    )
  }
  return <Page />
}

/** 路由出错（组件崩了）时的兜底页 */
export function RouteError() {
  const err = useRouteError()
  const msg = isRouteErrorResponse(err) ? `${err.status} ${err.statusText}` : err instanceof Error ? err.message : String(err)
  return (
    <div className="grid min-h-dvh place-items-center bg-bg p-6">
      <EmptyState
        kind="error"
        size="lg"
        title="这个页面出错了"
        description={<span className="font-mono text-xs">{msg}</span>}
        action={
          <>
            <Button variant="primary" onClick={() => window.location.reload()}>
              刷新一下
            </Button>
            <Button variant="secondary" asChild>
              <Link to="/">回工作台</Link>
            </Button>
            {/* 每一页都坏多半是主题的外壳装饰出错：换回基础主题（布局、密度改回跟随主题）再重新加载 */}
            {isCustomLook() && (
              <Button variant="ghost" onClick={backToBaseTheme}>
                回到基础主题
              </Button>
            )}
          </>
        }
      />
    </div>
  )
}
