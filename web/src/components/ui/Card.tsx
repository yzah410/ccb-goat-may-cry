import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { ThemeSlot } from '@/themes/ThemeSlot'
import type { CardOrnamentProps } from '@/themes/types'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** 主题装饰：featured = 主角卡（抽题结果、当前题目），主题的 CardOrnament slot 会画点东西 */
  ornament?: CardOrnamentProps['variant']
  ornamentTone?: CardOrnamentProps['tone']
  /** 可交互的卡（整张可点）：加 hover 态 */
  interactive?: boolean
  /** 选中态（容器高亮） */
  selected?: boolean
  /** 玻璃面（叠在壁纸上时用） */
  glass?: boolean
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, ornament, ornamentTone, interactive, selected, glass, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="card"
      data-selected={selected || undefined}
      data-featured={ornament === 'featured' || undefined}
      className={cn(
        'relative overflow-hidden rounded-lg border border-border text-fg-1 shadow-1',
        glass ? 'glass' : 'bg-surface-1',
        interactive &&
          'cursor-pointer transition-[border-color,box-shadow,background-color] hover:border-border-strong hover:shadow-2',
        selected && 'border-primary-400 bg-selected ring-1 ring-primary-400',
        className,
      )}
      {...rest}
    >
      {ornament && <ThemeSlot name="CardOrnament" variant={ornament} tone={ornamentTone} />}
      {children}
    </div>
  )
})

export function CardHeader({
  title,
  description,
  icon,
  actions,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  icon?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-start gap-3 px-5 pt-4', className)} data-slot="card-header">
      {icon && <span className="mt-0.5 text-fg-2 [&_svg]:size-5">{icon}</span>}
      <div className="min-w-0 flex-1">
        <h3 className="text-lg text-fg-1">{title}</h3>
        {description && <p className="mt-1 text-sm text-fg-2">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} data-slot="card-body" {...rest} />
}

export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center justify-end gap-2 border-t border-border px-5 py-3', className)}
      data-slot="card-footer"
      {...rest}
    />
  )
}
