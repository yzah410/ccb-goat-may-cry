import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { ThemeSlot } from '@/themes/ThemeSlot'
import type { RouteId } from '@/themes/types'

/** 页头：标题 + 一句话说明 + 右侧操作。主题的 PageHeaderDecor slot 画在标题旁边。 */
export function PageHeader({
  route,
  title,
  description,
  icon,
  actions,
  children,
  className,
}: {
  route: RouteId
  title: string
  description?: ReactNode
  icon?: ReactNode
  /** 右侧操作按钮（每页只放一个 primary） */
  actions?: ReactNode
  /** 标题下面的额外信息（例如方案名、未保存提示） */
  children?: ReactNode
  className?: string
}) {
  return (
    <header
      data-slot="page-header"
      className={cn('flex flex-col gap-4 pb-6 pt-6 @3xl/main:flex-row @3xl/main:items-end @3xl/main:justify-between', className)}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-3">
          {icon && (
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-1 text-fg-2 shadow-1 ring-1 ring-inset ring-border [&_svg]:size-5">
              {icon}
            </span>
          )}
          <h1 className="truncate text-2xl text-fg-1">{title}</h1>
          <ThemeSlot name="PageHeaderDecor" route={route} title={title} />
        </div>
        {description && <p className="mt-2 max-w-2xl text-sm text-fg-2">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}
