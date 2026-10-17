/**
 * 弹层类原语：Tooltip / Popover / Dialog / DropdownMenu。
 * 都会把 Portal 挂到「当前主题作用域」的弹层容器里（分屏对比时弹窗拿得到自己那边的 token）。
 */
import { useContext, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { Dialog as D, DropdownMenu as DM, Popover as P, Tooltip as T } from 'radix-ui'
import { cn } from '@/lib/cn'
import { usePortalContainer } from '@/themes/context'
import { IconX } from '@/lib/icons'
import { OverlayZoomContext } from './overlayZoom'

// ---------------------------------------------------------------- Tooltip
export const TooltipProvider = T.Provider

export function Tooltip({
  content,
  children,
  side = 'top',
  delay,
}: {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  delay?: number
}) {
  const container = usePortalContainer()
  // 触发元素在 CSS zoom 放大过的区域里时（overlayZoom.ts），提示框也放大同样的倍数
  const zoom = useContext(OverlayZoomContext)
  if (!content) return <>{children}</>
  return (
    <T.Root delayDuration={delay}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal container={container}>
        <T.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          style={zoom !== 1 ? { zoom } : undefined}
          className={cn(
            'z-50 max-w-72 rounded-md bg-fg-1 px-2.5 py-1.5 text-xs leading-body text-bg shadow-2',
            'data-[state=delayed-open]:animate-[pop-in_var(--motion-duration)_var(--motion-ease)]',
          )}
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}

// ---------------------------------------------------------------- Popover
export const Popover = P.Root
export const PopoverTrigger = P.Trigger
export const PopoverClose = P.Close

export function PopoverContent({
  className,
  children,
  align = 'center',
  side = 'bottom',
  ...rest
}: ComponentPropsWithoutRef<typeof P.Content>) {
  const container = usePortalContainer()
  return (
    <P.Portal container={container}>
      <P.Content
        align={align}
        side={side}
        sideOffset={8}
        collisionPadding={12}
        className={cn(
          'z-50 w-80 rounded-lg border border-border bg-surface-1 p-4 text-fg-1 shadow-3 outline-none',
          'data-[state=open]:animate-[pop-in_var(--motion-duration)_var(--motion-ease)]',
          className,
        )}
        {...rest}
      >
        {children}
      </P.Content>
    </P.Portal>
  )
}

// ---------------------------------------------------------------- Dialog
export const Dialog = D.Root
export const DialogTrigger = D.Trigger
export const DialogClose = D.Close

export function DialogContent({
  title,
  description,
  children,
  footer,
  className,
  size = 'md',
  hideClose,
  ...rest
}: Omit<ComponentPropsWithoutRef<typeof D.Content>, 'title'> & {
  title: ReactNode
  description?: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  hideClose?: boolean
}) {
  const container = usePortalContainer()
  return (
    <D.Portal container={container}>
      <D.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-[fade-in_var(--motion-duration)_var(--motion-ease)]" />
      <D.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 flex max-h-[min(88%,720px)] w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 flex-col',
          'rounded-xl border border-border bg-surface-1 text-fg-1 shadow-3 outline-none',
          'data-[state=open]:animate-[dialog-in_var(--motion-duration)_var(--motion-ease)]',
          size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : 'max-w-xl',
          className,
        )}
        {...rest}
      >
        <div className="flex items-start gap-3 px-6 pt-5">
          <div className="min-w-0 flex-1">
            <D.Title className="text-lg text-fg-1">{title}</D.Title>
            {description ? (
              <D.Description className="mt-1 text-sm text-fg-2">{description}</D.Description>
            ) : (
              <D.Description className="sr-only">{typeof title === 'string' ? title : '对话框'}</D.Description>
            )}
          </div>
          {!hideClose && (
            <D.Close
              className="-mr-2 -mt-1 grid size-8 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg-1"
              aria-label="关闭"
            >
              <IconX className="size-4" />
            </D.Close>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 scroll-thin">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3">{footer}</div>}
      </D.Content>
    </D.Portal>
  )
}

// ---------------------------------------------------------------- DropdownMenu
export const DropdownMenu = DM.Root
export const DropdownMenuTrigger = DM.Trigger

export function DropdownMenuContent({
  className,
  children,
  align = 'end',
  ...rest
}: ComponentPropsWithoutRef<typeof DM.Content>) {
  const container = usePortalContainer()
  return (
    <DM.Portal container={container}>
      <DM.Content
        align={align}
        sideOffset={6}
        collisionPadding={8}
        className={cn(
          'z-50 min-w-48 rounded-lg border border-border bg-surface-1 p-1 text-fg-1 shadow-3',
          'data-[state=open]:animate-[pop-in_var(--motion-duration)_var(--motion-ease)]',
          className,
        )}
        {...rest}
      >
        {children}
      </DM.Content>
    </DM.Portal>
  )
}

export function DropdownMenuItem({
  className,
  icon,
  children,
  hint,
  tone,
  ...rest
}: ComponentPropsWithoutRef<typeof DM.Item> & { icon?: ReactNode; hint?: ReactNode; tone?: 'danger' }) {
  return (
    <DM.Item
      className={cn(
        'flex h-[var(--control-h-sm)] cursor-pointer select-none items-center gap-2 rounded-sm px-2 text-sm outline-none',
        'data-[highlighted]:bg-surface-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
        tone === 'danger' ? 'text-danger-fg data-[highlighted]:bg-danger-bg' : 'text-fg-1',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        className,
      )}
      {...rest}
    >
      {icon && <span className={cn(tone === 'danger' ? 'text-danger' : 'text-fg-3')}>{icon}</span>}
      <span className="flex-1">{children}</span>
      {hint && <span className="text-xs text-fg-3">{hint}</span>}
    </DM.Item>
  )
}

export function DropdownMenuLabel({ children }: { children: ReactNode }) {
  return <DM.Label className="px-2 pb-1 pt-2 text-xs font-medium text-fg-3">{children}</DM.Label>
}

export function DropdownMenuSeparator() {
  return <DM.Separator className="my-1 h-px bg-border" />
}
