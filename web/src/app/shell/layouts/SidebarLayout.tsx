import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { ThemeSlot } from '@/themes/ThemeSlot'
import { usePrefs } from '@/features/settings/store'
import { Tooltip } from '@/components/ui/Overlay'
import { IconPanelLeftClose, IconPanelLeftOpen } from '@/lib/icons'
import { BackendDot, CommandButton, ModeToggle, NavItem, useNavGroups } from '../parts'
import { CurrentPickChip } from '../CurrentPick'
import { useShellNav } from '../nav'
import { MainArea } from './MainArea'

/** 侧栏布局：左侧可折叠导航 + 顶部一条工具栏 */
export function SidebarLayout({ children }: { children: ReactNode }) {
  const nav = useShellNav()
  const collapsedPref = usePrefs((s) => s.sidebarCollapsed)
  const setPrefs = usePrefs((s) => s.set)
  const collapsed = nav.embedded ? true : collapsedPref
  const { main, system } = useNavGroups()

  return (
    <div className="flex h-full min-h-0" data-layout="sidebar">
      <aside
        className={cn(
          'glass flex shrink-0 flex-col border-r border-border transition-[width]',
          collapsed ? 'w-16 items-center' : 'w-60',
        )}
        aria-label="主导航"
      >
        <div className={cn('flex h-16 items-center', collapsed ? 'justify-center' : 'px-4')}>
          <ThemeSlot name="Logo" collapsed={collapsed} />
        </div>
        <nav className={cn('flex flex-1 flex-col gap-1 overflow-y-auto scroll-thin', collapsed ? 'items-center px-2' : 'px-3')}>
          {main.map((d) => (
            <NavItem key={d.id} def={d} collapsed={collapsed} shell="sidebar" />
          ))}
          <div className={cn('my-3 h-px bg-border', collapsed ? 'w-8' : 'mx-2')} />
          {system.map((d) => (
            <NavItem key={d.id} def={d} collapsed={collapsed} shell="sidebar" />
          ))}
        </nav>
        <div className={cn('flex items-center gap-2 border-t border-border py-3', collapsed ? 'flex-col px-2' : 'px-4')}>
          <BackendDot withText={!collapsed} />
          {!nav.embedded && (
            <Tooltip content={collapsed ? '展开侧栏' : '收起侧栏'} side="right">
              <button
                type="button"
                onClick={() => setPrefs({ sidebarCollapsed: !collapsed })}
                aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
                className={cn(
                  'grid size-8 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg-1',
                  !collapsed && 'ml-auto',
                )}
              >
                {collapsed ? <IconPanelLeftOpen className="size-4" /> : <IconPanelLeftClose className="size-4" />}
              </button>
            </Tooltip>
          )}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-end gap-2 px-4 @3xl/shell:px-8">
          {!nav.embedded && <CommandButton className="mr-auto hidden @4xl/shell:flex" />}
          <CurrentPickChip />
          {!nav.embedded && <CommandButton compact className="@4xl/shell:hidden" />}
          {!nav.embedded && <ModeToggle />}
        </header>
        <MainArea>{children}</MainArea>
      </div>
    </div>
  )
}
