import type { ReactNode } from 'react'
import { ThemeSlot } from '@/themes/ThemeSlot'
import { Button } from '@/components/ui/Button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/Overlay'
import { IconMenu } from '@/lib/icons'
import { ClusterMenuItems, CommandButton, ModeToggle, NavClusterMenu, NavItem, useNavGroups } from '../parts'
import { CurrentPickChip } from '../CurrentPick'
import { useShellNav } from '../nav'
import { ROUTE_BY_ID } from '../../routes'
import { MainArea } from './MainArea'

/**
 * 顶栏布局：横向导航；窄的时候收进「菜单」。
 *
 * 导航宽度的取舍：
 * - 经典工作台、经典候选池、自动点击收进一个「经典 ▾」下拉；
 * - 带文字的横向导航从 1280px 宽起才显示，更窄的时候用「菜单」按钮；
 * - 导航不许被挤（shrink-0），挤的是右边的「当前题目」小卡：名字截断成「…」，最宽 12rem。
 *   量过 1280 宽：边距 48 + Logo 172 + 导航 802 + 间隔 16，右边一组还剩约 240（当前题目小卡最宽约 160，名字再长就截断）。
 *   导航被挤时，「经典」两个字会压成竖排、最右边的设置图标被裁掉。
 * - 顶栏导航项用 gap-1.5 / px-2（parts.tsx 的 navItemClass）。
 */
export function TopbarLayout({ children }: { children: ReactNode }) {
  const nav = useShellNav()
  const { main, system } = useNavGroups()
  const primary = main.filter((d) => !d.cluster)
  const classic = main.filter((d) => d.cluster === 'classic')
  const current = ROUTE_BY_ID.get(nav.current)

  return (
    <div className="flex h-full min-h-0 flex-col" data-layout="topbar">
      <header className="glass relative z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border px-4 @3xl/shell:px-6">
        <div className="mr-2 shrink-0">
          <ThemeSlot name="Logo" />
        </div>
        <nav className="hidden shrink-0 items-center gap-0.5 @7xl/shell:flex" aria-label="主导航">
          {primary.map((d) => (
            <NavItem key={d.id} def={d} shell="topbar" />
          ))}
          {classic.length > 0 && <NavClusterMenu items={classic} shell="topbar" />}
          <span aria-hidden className="mx-1.5 h-5 w-px shrink-0 bg-border" />
          {system.map((d) => (
            <NavItem key={d.id} def={d} shell="topbar" collapsed />
          ))}
        </nav>
        <div className="@7xl/shell:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" icon={<IconMenu />}>
                {current?.label ?? '菜单'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {primary.map((d) => (
                <DropdownMenuItem key={d.id} icon={<d.icon />} onSelect={() => nav.go(d.id)}>
                  {d.label}
                </DropdownMenuItem>
              ))}
              {classic.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <ClusterMenuItems items={classic} />
                </>
              )}
              <DropdownMenuSeparator />
              {system.map((d) => (
                <DropdownMenuItem key={d.id} icon={<d.icon />} onSelect={() => nav.go(d.id)}>
                  {d.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {/* min-w-0：顶栏挤的时候这一组让位，当前题目的名字截断；两个按钮不缩 */}
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <CurrentPickChip className="max-w-48" />
          {!nav.embedded && <CommandButton compact className="shrink-0" />}
          {!nav.embedded && <ModeToggle className="shrink-0" />}
        </div>
      </header>
      <MainArea>{children}</MainArea>
    </div>
  )
}
