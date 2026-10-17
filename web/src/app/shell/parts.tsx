import { create } from 'zustand'
import { Link } from 'react-router'
import { cn } from '@/lib/cn'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useThemeScope } from '@/themes/context'
import { ThemeSlot } from '@/themes/ThemeSlot'
import type { RouteId, ShellKind } from '@/themes/types'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip } from '@/components/ui/Overlay'
import { Kbd } from '@/components/ui/Input'
import { IconChevronDown, IconCommand, IconLayers, IconMoon, IconSearch, IconSun } from '@/lib/icons'
import { useBackendStatus } from '@/features/status/api'
import { useClassicAvailable } from '@/features/classic/api'
import { visibleRoutes, type RouteDef } from '../routes'
import { useThemeActions } from '../themeActions'
import { useShellNav } from './nav'

// ---------------------------------------------------------------- 命令面板开关
export const useCommandPalette = create<{ open: boolean; setOpen: (v: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

// ---------------------------------------------------------------- 导航项
/** 导航项的样子（NavItem 和顶栏的「经典 ▾」下拉共用，保证一模一样） */
export function navItemClass(active: boolean, shell: ShellKind, collapsed?: boolean, className?: string): string {
  return cn(
    'group relative flex items-center gap-3 rounded-md text-sm font-medium outline-none transition-colors',
    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
    active ? 'bg-surface-3 text-fg-1' : 'text-fg-2 hover:bg-surface-2 hover:text-fg-1',
    // 顶栏：图标和字之间 gap-1.5、左右 px-2（1280 宽时导航要整个放得下，见 TopbarLayout 注释）
    shell === 'topbar' && 'h-9 gap-1.5 px-2',
    (shell === 'sidebar' || shell === 'split') && (collapsed ? 'size-10 justify-center' : 'h-9 px-3'),
    shell === 'dock' && 'size-11 justify-center rounded-full',
    shell === 'dock' && active && 'bg-primary text-on-primary hover:bg-primary-hover hover:text-on-primary',
    className,
  )
}

/**
 * 「经典」这一组在下拉里的样子：经典工作台的页面一小节（装了经典工作台数据才有），自动点击另起一节。
 * 顶栏的「经典 ▾」和窄屏的「菜单」共用。markCurrent：给当前页加底色（「菜单」里的其他项不加，这里也跟着不加）。
 */
export function ClusterMenuItems({ items, markCurrent }: { items: RouteDef[]; markCurrent?: boolean }) {
  const nav = useShellNav()
  const pages = items.filter((d) => d.needsClassicData)
  const rest = items.filter((d) => !d.needsClassicData)
  const item = (d: RouteDef) => (
    <DropdownMenuItem key={d.id} icon={<d.icon />} onSelect={() => nav.go(d.id)} className={markCurrent && d.id === nav.current ? 'bg-surface-2' : undefined}>
      {d.label}
    </DropdownMenuItem>
  )
  return (
    <>
      {pages.length > 0 && <DropdownMenuLabel>经典工作台的页面</DropdownMenuLabel>}
      {pages.map(item)}
      {pages.length > 0 && rest.length > 0 && <DropdownMenuSeparator />}
      {rest.map(item)}
    </>
  )
}

/**
 * 顶栏里的「经典 ▾」：把 RouteDef.cluster = 'classic' 的页面（经典工作台 / 经典候选池 / 自动点击）收成一个下拉。
 * 当前页在这一组里时，按钮显示成选中（文字固定写「经典」：宽度不变，顶栏不会因为换页被挤；具体是哪一页看页头）。
 * 按钮不许被压窄（shrink-0 + 不换行）：顶栏挤的时候「经典」两个字会被压成竖排。
 */
export function NavClusterMenu({ items, shell }: { items: RouteDef[]; shell: ShellKind }) {
  const nav = useShellNav()
  const cur = items.find((d) => d.id === nav.current)
  const active = !!cur
  const Icon = IconLayers
  const names = items.map((d) => d.label).join('、')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={navItemClass(active, shell, false, 'shrink-0')}
          aria-current={active ? 'page' : undefined}
          aria-label={cur ? `${names}，现在在「${cur.label}」` : names}
          data-nav="classic-group"
        >
          <ThemeSlot name="NavItemDecor" route={cur?.id ?? 'classic'} active={active} shell={shell} />
          <Icon className="relative size-[18px] shrink-0" aria-hidden />
          <span className="relative whitespace-nowrap">经典</span>
          <IconChevronDown className="relative size-3.5 shrink-0 opacity-70" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <ClusterMenuItems items={items} markCurrent />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function NavItem({
  def,
  collapsed,
  shell,
  className,
}: {
  def: RouteDef
  collapsed?: boolean
  shell: ShellKind
  className?: string
}) {
  const nav = useShellNav()
  const active = nav.current === def.id
  const Icon = def.icon
  const cls = navItemClass(active, shell, collapsed, className)
  const inner = (
    <>
      <ThemeSlot name="NavItemDecor" route={def.id} active={active} shell={shell} />
      <Icon className="relative size-[18px] shrink-0" aria-hidden />
      {!collapsed && shell !== 'dock' && <span className="relative truncate">{def.label}</span>}
    </>
  )
  const node = nav.href ? (
    <Link
      to={nav.href(def.id)}
      className={cls}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed || shell === 'dock' ? def.label : undefined}
      data-nav={def.id}
    >
      {inner}
    </Link>
  ) : (
    <button
      type="button"
      className={cls}
      onClick={() => nav.go(def.id)}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed || shell === 'dock' ? def.label : undefined}
      data-nav={def.id}
    >
      {inner}
    </button>
  )
  return collapsed || shell === 'dock' ? (
    <Tooltip content={def.label} side={shell === 'dock' ? 'top' : 'right'}>
      {node}
    </Tooltip>
  ) : (
    node
  )
}

/** 导航里的两组页面；经典工作台、经典候选池只在后端装了经典工作台数据时才有 */
export function useNavGroups(): { main: RouteDef[]; system: RouteDef[] } {
  const routes = visibleRoutes(useClassicAvailable())
  return {
    main: routes.filter((r) => r.group === 'main'),
    system: routes.filter((r) => r.group === 'system'),
  }
}

// ---------------------------------------------------------------- 明暗开关
export function ModeToggle({ className }: { className?: string }) {
  const { theme, mode } = useThemeScope()
  const { toggleMode } = useThemeActions()
  const locked = theme.manifest.modes.length < 2
  const label = locked ? `「${theme.manifest.name}」只有${mode === 'dark' ? '深色' : '浅色'}` : mode === 'dark' ? '换成浅色' : '换成深色'
  return (
    <Tooltip content={label}>
      <button
        type="button"
        onClick={toggleMode}
        aria-label={label}
        aria-disabled={locked || undefined}
        data-slot="mode-toggle"
        className={cn(
          'grid size-9 place-items-center rounded-md text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg-1',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
          locked && 'cursor-not-allowed opacity-45 hover:bg-transparent',
          className,
        )}
      >
        {mode === 'dark' ? <IconMoon className="size-[18px]" /> : <IconSun className="size-[18px]" />}
      </button>
    </Tooltip>
  )
}

// ---------------------------------------------------------------- 命令面板按钮
export function CommandButton({ compact, className }: { compact?: boolean; className?: string }) {
  const setOpen = useCommandPalette((s) => s.setOpen)
  if (compact)
    return (
      <Tooltip content="搜索 / 跳转（Ctrl K）">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="打开命令面板"
          className={cn(
            'grid size-9 place-items-center rounded-md text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg-1',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
            className,
          )}
        >
          <IconCommand className="size-[18px]" />
        </button>
      </Tooltip>
    )
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className={cn(
        'flex h-9 w-60 items-center gap-2 whitespace-nowrap rounded-md border border-border bg-surface-1 px-3 text-sm text-fg-3 shadow-1 transition-colors',
        'hover:border-border-strong hover:text-fg-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        className,
      )}
    >
      <IconSearch className="size-4" />
      <span className="min-w-0 flex-1 truncate text-left">搜索、跳转、切主题…</span>
      <Kbd>Ctrl</Kbd>
      <Kbd>K</Kbd>
    </button>
  )
}

// ---------------------------------------------------------------- 后端状态小点
export function BackendDot({ withText }: { withText?: boolean }) {
  const q = useBackendStatus()
  const ok = q.isSuccess
  const label = q.isPending
    ? '正在连后端…'
    : ok
      ? q.data.phase === 'no_db'
        ? '后端在线，但没找到出题器数据库 outsetter_v2.sqlite（见「数据」页）'
        : '后端在线'
      : '连不上后端'
  return (
    <Tooltip content={label}>
      <span className="inline-flex items-center gap-2 text-xs text-fg-3" role="status" aria-label={label}>
        <span
          className={cn(
            'size-2 rounded-full',
            q.isPending ? 'animate-pulse-soft bg-fg-3' : ok ? 'bg-success' : 'bg-danger',
          )}
        />
        {withText && <span className="truncate">{ok ? '后端在线' : q.isPending ? '连接中' : '后端离线'}</span>}
      </span>
    </Tooltip>
  )
}

// ---------------------------------------------------------------- 壁纸层
/**
 * 把当前作用域主题的 Backdrop 放到 shell 最底层。
 * 外壳 [data-slot=backdrop] = absolute inset-0 z-0 overflow-hidden pointer-events-none（tailwind.css 里定义），
 * 主题的 Backdrop 只要铺满这个外壳就行，永远不要用 position: fixed。
 * Backdrop 渲染时抛错 → 这一层留空（纯 --bg 底色），页面其余部分照常。
 */
export function BackdropHost({ route }: { route: RouteId }) {
  const { theme, mode, nested } = useThemeScope()
  const Backdrop = theme.Backdrop
  if (!Backdrop) return null
  return (
    <div data-slot="backdrop" aria-hidden>
      <ErrorBoundary
        resetKey={Backdrop}
        fallback={null}
        onError={(e) => console.warn(`[theme:${theme.manifest.id}] Backdrop 渲染时出错，背景层先留空（页面其余部分不受影响）：${e.message}`)}
      >
        <Backdrop route={route} mode={mode} compact={nested} />
      </ErrorBoundary>
    </div>
  )
}
