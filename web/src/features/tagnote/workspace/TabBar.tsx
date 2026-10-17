/**
 * 一格上方的标签栏（36px）：组色点 + 图名；× 或中键关闭；按住拖动换顺序 / 拖到别的格子 / 拖到边缘分屏（拖放逻辑在 Workspace）；
 * 右键菜单；最右边「+」搜索全部图，在这一格新开。
 *
 * 样子：当前标签和格子（引擎顶栏）同一个底色、连成一体，非当前标签淡一些；关闭按钮悬停或当前标签才出现。
 * 当前格的当前标签顶上一道主色细线，别的格子没有。
 * 右边的 actions 区放做题联动的「跟随」按钮。跟随中的格子：标签栏底线淡淡染上主色；联动的图的标签带一个小链条。
 */
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { IconLink, IconPlus, IconX } from '@/lib/icons'
import { cn } from '@/lib/cn'
import type { MapLabel } from './labels'
import type { PaneNode, WsTab } from './types'

export interface TabBarProps {
  pane: PaneNode
  tabs: WsTab[]
  labels: Map<string, MapLabel>
  /** 这一格是当前格 */
  current: boolean
  /** 正在拖的标签（在原位淡掉） */
  dragging: string | null
  onTabPointerDown: (e: ReactPointerEvent<HTMLElement>, tabId: string) => void
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onMenu: (tabId: string, clientX: number, clientY: number) => void
  onAdd: () => void
  /** 标签栏右边的额外按钮 */
  actions?: ReactNode
  /** 这一格在跟随单人猜猜呗（做题联动） */
  following?: boolean
  /** 联动的图（这些图的标签带小链条；只在跟随格里给） */
  linked?: ReadonlySet<string>
}

export function TabBar({
  pane,
  tabs,
  labels,
  current,
  dragging,
  onTabPointerDown,
  onActivate,
  onClose,
  onMenu,
  onAdd,
  actions,
  following,
  linked,
}: TabBarProps) {
  const focusTab = (el: HTMLElement, tabId: string) => {
    onActivate(tabId)
    el.closest('[data-ws-tabbar]')?.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`)?.focus()
  }
  const onKey = (e: KeyboardEvent<HTMLElement>, i: number) => {
    const tab = tabs[i]
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
      if (next) focusTab(e.currentTarget, next.id)
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const next = e.key === 'Home' ? tabs[0] : tabs[tabs.length - 1]
      if (next) focusTab(e.currentTarget, next.id)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onActivate(tab.id)
    } else if (e.key === 'Delete') {
      e.preventDefault()
      onClose(tab.id)
    }
  }

  return (
    <div
      className={cn(
        // @container：格子窄时，右边按钮的文字收起（见 FollowButton）
        '@container flex h-full min-w-0 items-end',
        // 跟随中：底线换成淡主色（一眼看出是哪一格，但不抢眼）
        following ? 'shadow-[inset_0_-1px_0_color-mix(in_oklab,var(--primary)_55%,var(--border))]' : 'shadow-[inset_0_-1px_0_var(--border)]',
      )}
      data-ws-tabbar={pane.id}
      data-ws-following={following ? '' : undefined}
    >
      <div
        role="tablist"
        aria-label="打开的图"
        className="flex h-full min-w-0 flex-1 items-end gap-px overflow-x-auto overflow-y-hidden pl-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onWheel={(e) => {
          // 标签多了横着滚：竖着的滚轮也让它横着走
          if (e.deltaY && !e.deltaX) e.currentTarget.scrollLeft += e.deltaY
        }}
      >
        {tabs.map((tab, i) => {
          const active = pane.active === tab.id
          const label = labels.get(tab.mapId)
          const title = label?.title ?? '…'
          const isLinked = !!linked?.has(tab.mapId)
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              data-tab-id={tab.id}
              data-map-id={tab.mapId}
              data-active={active ? '' : undefined}
              data-linked={isLinked ? '' : undefined}
              title={label ? `${label.title}\n${label.group}${isLinked ? '\n跟随单人猜猜呗的图' : ''}` : undefined}
              onPointerDown={(e) => onTabPointerDown(e, tab.id)}
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault() // 中键：别进浏览器的自动滚动
              }}
              onAuxClick={(e) => {
                if (e.button !== 1) return
                e.preventDefault()
                onClose(tab.id)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                // 键盘（菜单键 / Shift+F10）打开时没有鼠标位置，放在标签下面
                const kb = e.clientX === 0 && e.clientY === 0
                onMenu(tab.id, kb ? r.left + 8 : e.clientX, kb ? r.bottom : e.clientY)
              }}
              onKeyDown={(e) => onKey(e, i)}
              className={cn(
                'group relative flex h-[calc(100%-4px)] min-w-[4.5rem] max-w-52 shrink cursor-default select-none items-center gap-1.5 rounded-t-md pl-2.5 pr-1 text-sm',
                'outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                // 当前标签和下面的格子同一个底色（引擎根元素透明，露出格子的 bg），盖住标签栏底线 = 连成一体
                active
                  ? 'z-[1] border-x border-t border-border bg-bg text-fg-1'
                  : 'border-x border-t border-transparent text-fg-2 hover:bg-surface-3 hover:text-fg-1',
                active && !current && 'text-fg-2',
                dragging === tab.id && 'opacity-40',
              )}
            >
              {/* 只有当前格的当前标签顶上有主色细线：分屏时一眼看出哪格是当前格 */}
              {active && current && <span aria-hidden className="absolute inset-x-1.5 -top-px h-0.5 rounded-full bg-primary" />}
              <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', label?.dot ?? 'bg-fg-3', !active && 'opacity-70')} />
              <span className="min-w-0 flex-1 truncate">{title}</span>
              {isLinked && (
                <IconLink
                  aria-label="跟随单人猜猜呗的图"
                  className={cn('size-3 shrink-0 text-primary', active ? 'opacity-80' : 'opacity-60')}
                  data-tab-linked=""
                />
              )}
              <button
                type="button"
                tabIndex={-1}
                aria-label={`关闭「${title}」`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(tab.id)
                }}
                className={cn(
                  'grid size-5 shrink-0 place-items-center rounded-sm text-fg-2 transition-opacity hover:bg-border-strong hover:text-fg-1',
                  active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
                )}
              >
                <IconX className="size-3.5" />
              </button>
            </div>
          )
        })}
      </div>
      <div className="flex h-full shrink-0 items-center gap-1 px-1.5" data-ws-actions="">
        {actions}
        <button
          type="button"
          aria-label="打开一张图（搜索全部图）"
          title="打开一张图（搜索全部图）"
          onClick={onAdd}
          className="grid size-7 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg-1 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
          data-ws-add=""
        >
          <IconPlus className="size-4" />
        </button>
      </div>
    </div>
  )
}
