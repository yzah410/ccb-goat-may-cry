/**
 * 标签的右键菜单：向右分屏、向下分屏、关闭、关闭其他。
 * 画在工作区容器里（不走 portal），工作区全屏时也能用；位置夹在容器里面，不出界。
 * 键盘：打开时焦点在第一项，↑↓ 移动，Enter / 空格选，Esc 关。
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface TabMenuItem {
  key: string
  label: string
  icon?: ReactNode
  disabled?: boolean
  /** 在这一项前面画一条分隔线 */
  sep?: boolean
  run: () => void
}

export interface TabMenuProps {
  /** 相对工作区容器的位置（鼠标点的地方） */
  x: number
  y: number
  items: TabMenuItem[]
  onClose: () => void
}

export function TabMenu({ x, y, items, onClose }: TabMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  // 量出菜单大小以后夹进容器（直接改样式，不经过状态）；焦点放到第一项
  useLayoutEffect(() => {
    const el = ref.current
    const box = el?.offsetParent as HTMLElement | null
    if (!el || !box) return
    const left = Math.max(4, Math.min(x, box.clientWidth - el.offsetWidth - 4))
    const top = y + el.offsetHeight + 4 > box.clientHeight ? Math.max(4, y - el.offsetHeight) : y
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    el.querySelector<HTMLElement>('[role=menuitem]:not([aria-disabled=true])')?.focus()
  }, [x, y])

  const move = (from: HTMLElement, step: number) => {
    const list = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([aria-disabled=true])') ?? [])]
    if (!list.length) return
    const i = list.indexOf(from)
    list[(i + step + list.length) % list.length]?.focus()
  }

  return (
    <div
      className="absolute inset-0 z-30"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
      data-ws-menu=""
    >
      <div
        ref={ref}
        role="menu"
        aria-label="标签操作"
        className={cn(
          'absolute min-w-40 rounded-lg border border-border bg-surface-1 p-1 text-fg-1 shadow-3',
          'animate-[pop-in_var(--motion-duration)_var(--motion-ease)]',
        )}
        style={{ left: x, top: y }}
        onKeyDown={(e) => {
          const t = e.target as HTMLElement
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            move(t, e.key === 'ArrowDown' ? 1 : -1)
          } else if (e.key === 'Escape' || e.key === 'Tab') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
      >
        {items.map((it) => (
          <div key={it.key}>
            {it.sep && <div role="separator" className="my-1 h-px bg-border" />}
            <div
              role="menuitem"
              tabIndex={-1}
              aria-disabled={it.disabled || undefined}
              onClick={() => {
                if (it.disabled) return
                onClose()
                it.run()
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                if (it.disabled) return
                onClose()
                it.run()
              }}
              onPointerMove={(e) => {
                if (!it.disabled && document.activeElement !== e.currentTarget) e.currentTarget.focus()
              }}
              className={cn(
                'flex h-[var(--control-h-sm)] cursor-pointer select-none items-center gap-2 rounded-sm px-2 text-sm outline-none',
                'focus:bg-surface-2 [&_svg]:size-4 [&_svg]:shrink-0',
                it.disabled && 'pointer-events-none opacity-45',
              )}
              data-menu-key={it.key}
            >
              <span className="grid w-4 place-items-center text-fg-3">{it.icon}</span>
              <span className="flex-1">{it.label}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
