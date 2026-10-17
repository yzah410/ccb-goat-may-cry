import type { ReactNode } from 'react'
import { ThemeSlot } from '@/themes/ThemeSlot'
import { BackendDot, CommandButton, ModeToggle, NavItem, useNavGroups } from '../parts'
import { CurrentPickChip } from '../CurrentPick'
import { ContextPanel } from '../ContextPanel'
import { useShellNav } from '../nav'
import { MainArea } from './MainArea'

/** 分栏布局：左侧窄图标导航 + 中间内容 + 右侧上下文面板（当前题目、人数、点击器状态） */
export function SplitLayout({ children }: { children: ReactNode }) {
  const nav = useShellNav()
  const { main, system } = useNavGroups()

  return (
    <div className="flex h-full min-h-0" data-layout="split">
      <aside className="glass flex w-16 shrink-0 flex-col items-center border-r border-border py-3" aria-label="主导航">
        <div className="mb-4">
          <ThemeSlot name="Logo" collapsed />
        </div>
        {/* 页面比较多：窗口矮的时候（例如 1280×640）图标一列放不下，让这一段自己滚动，底下的命令面板 / 明暗 / 后端状态始终看得见 */}
        <nav className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto scroll-thin">
          {main.map((d) => (
            <NavItem key={d.id} def={d} shell="split" collapsed />
          ))}
          <span aria-hidden className="my-2 h-px w-8 bg-border" />
          {system.map((d) => (
            <NavItem key={d.id} def={d} shell="split" collapsed />
          ))}
        </nav>
        <div className="flex flex-col items-center gap-1">
          {!nav.embedded && <CommandButton compact />}
          {!nav.embedded && <ModeToggle />}
          <div className="mt-2">
            <BackendDot />
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 右侧面板放不下时，当前题目回到顶部 */}
        <header className="flex h-14 shrink-0 items-center justify-end px-4 @5xl/shell:hidden">
          <CurrentPickChip />
        </header>
        <MainArea>{children}</MainArea>
      </div>
      <aside
        className="glass hidden w-80 shrink-0 flex-col overflow-y-auto border-l border-border scroll-thin @5xl/shell:flex"
        aria-label="上下文面板"
      >
        <ContextPanel />
      </aside>
    </div>
  )
}
