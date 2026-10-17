/**
 * 单人猜猜呗的独立页面（/solo/full）：只有单人猜猜呗本身，没有左侧栏和顶部工具栏，占满整个窗口。
 * 用途：在新标签页单独玩，例如一个屏幕玩猜猜呗、另一个屏幕看导图。
 * 入口：/solo 页头的「在新标签页打开」。主题、设置和普通 /solo 一样（同一个浏览器的 localStorage）；主题的壁纸层照常画。
 * 页面本身就是 SoloPage（standalone：页头不放「在新标签页打开」）；界面大小同样生效。
 */
import { useEffect } from 'react'
import { ThemeRouteContext, useThemeScope } from '@/themes/context'
import { RouterShellNav } from '@/app/shell/nav'
import { BackdropHost } from '@/app/shell/parts'
import { MainArea } from '@/app/shell/layouts/MainArea'
import { ThemeUrlSync } from '@/app/themeActions'
import SoloPage from './SoloPage'

export default function SoloFullPage() {
  const { shell } = useThemeScope()
  useEffect(() => {
    document.title = '单人猜猜呗'
  }, [])
  return (
    <ThemeRouteContext.Provider value="solo">
      <RouterShellNav>
        <ThemeUrlSync />
        <div
          data-shell-root=""
          data-shell={shell}
          data-solo-full=""
          className="@container/shell relative isolate h-dvh w-full overflow-hidden text-fg-1"
        >
          <BackdropHost route="solo" />
          <div className="relative z-10 flex h-full min-h-0 flex-col">
            <MainArea>
              <SoloPage standalone />
            </MainArea>
          </div>
        </div>
      </RouterShellNav>
    </ThemeRouteContext.Provider>
  )
}
