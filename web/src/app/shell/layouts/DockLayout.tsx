import type { ReactNode } from 'react'
import { ThemeSlot } from '@/themes/ThemeSlot'
import { CommandButton, ModeToggle, NavItem, useNavGroups } from '../parts'
import { CurrentPickChip } from '../CurrentPick'
import { useShellNav } from '../nav'
import { MainArea } from './MainArea'

/**
 * 底部胶囊布局：极简外框，导航是底部悬浮的一颗胶囊。
 * 顶上那排（Logo、当前题目、命令面板、明暗开关）是浮在内容上面的，高 15 个间距单位（py-3 + h-9 + py-3）：
 * 用 --shell-sticky-top 告诉页面里的吸顶元素（候选池工具条、工作台右栏）停在它下面，而不是钻到它底下把按钮挡住。
 * 其余布局不设这个变量（= 0）。
 */
export function DockLayout({ children }: { children: ReactNode }) {
  const nav = useShellNav()
  const { main, system } = useNavGroups()

  return (
    <div className="relative h-full min-h-0 [--shell-sticky-top:calc(var(--space-unit)*15)]" data-layout="dock">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-2 px-4 py-3">
        <div className="pointer-events-auto">
          <ThemeSlot name="Logo" collapsed />
        </div>
        <div className="pointer-events-auto flex min-w-0 items-center gap-2">
          <CurrentPickChip />
          {!nav.embedded && <CommandButton compact />}
          {!nav.embedded && <ModeToggle />}
        </div>
      </div>
      <MainArea className="h-full" innerClassName="pt-12 pb-32">
        {children}
      </MainArea>
      <nav
        aria-label="主导航"
        className="glass absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border p-1.5 shadow-3"
      >
        {main.map((d) => (
          <NavItem key={d.id} def={d} shell="dock" />
        ))}
        <span aria-hidden className="mx-1 h-6 w-px bg-border" />
        {system.map((d) => (
          <NavItem key={d.id} def={d} shell="dock" />
        ))}
      </nav>
    </div>
  )
}
