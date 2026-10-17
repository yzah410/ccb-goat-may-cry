import type { ReactNode } from 'react'
import { ThemeRouteContext, useThemeScope } from '@/themes/context'
import type { RouteId, ShellKind } from '@/themes/types'
import { BackdropHost } from './parts'
import { SidebarLayout } from './layouts/SidebarLayout'
import { TopbarLayout } from './layouts/TopbarLayout'
import { DockLayout } from './layouts/DockLayout'
import { SplitLayout } from './layouts/SplitLayout'

function Layout({ shell, children }: { shell: ShellKind; children: ReactNode }) {
  switch (shell) {
    case 'topbar':
      return <TopbarLayout>{children}</TopbarLayout>
    case 'dock':
      return <DockLayout>{children}</DockLayout>
    case 'split':
      return <SplitLayout>{children}</SplitLayout>
    default:
      return <SidebarLayout>{children}</SidebarLayout>
  }
}

/**
 * 外壳：铺满父元素（根 App 里是整屏，分屏对比里是半边格子）。
 * - 最底层：当前主题的 Backdrop（壁纸层）
 * - 上面：按主题 manifest.shell（或设置里的覆盖）选四种布局之一
 * - 它是容器查询容器 @container/shell：布局按「格子宽度」而不是窗口宽度响应
 * - 它提供「当前页面」给主题的 slot（useThemeRoute()）；分屏对比里每一格各是各的页面
 */
export function AppShell({ route, children }: { route: RouteId; children: ReactNode }) {
  const { shell } = useThemeScope()
  return (
    <ThemeRouteContext.Provider value={route}>
      <div data-shell-root="" data-shell={shell} className="@container/shell relative isolate h-full w-full overflow-hidden text-fg-1">
        <BackdropHost route={route} />
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-surface-1 px-3 py-2 text-sm text-fg-1 shadow-3 focus:not-sr-only focus:absolute focus:left-3 focus:top-3"
        >
          跳到主要内容
        </a>
        <div className="relative z-10 h-full">
          <Layout shell={shell}>{children}</Layout>
        </div>
      </div>
    </ThemeRouteContext.Provider>
  )
}
