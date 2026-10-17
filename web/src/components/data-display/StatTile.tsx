import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface StatTileProps {
  label: ReactNode
  value: ReactNode
  /** 大数字下面的一行小字 */
  hint?: ReactNode
  icon?: ReactNode
  tone?: 'default' | 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'include' | 'exclude'
  loading?: boolean
  size?: 'sm' | 'md'
  className?: string
  /** 值过期了（配置改了还没重新请求）：变灰 + 提示 */
  stale?: boolean
}

const TONE: Record<NonNullable<StatTileProps['tone']>, string> = {
  default: 'text-fg-1',
  primary: 'text-primary-700',
  accent: 'text-[color-mix(in_oklab,var(--accent)_80%,var(--text-1))]',
  success: 'text-success-fg',
  warning: 'text-warning-fg',
  danger: 'text-danger-fg',
  include: 'text-[color-mix(in_oklab,var(--include)_85%,var(--text-1))]',
  exclude: 'text-[color-mix(in_oklab,var(--exclude)_85%,var(--text-1))]',
}

/** 统计块：大数字 + 小标签（数字型信息不要塞进句子里） */
export function StatTile({ label, value, hint, icon, tone = 'default', loading, size = 'md', className, stale }: StatTileProps) {
  return (
    <div
      data-slot="stat-tile"
      data-tone={tone}
      className={cn(
        'flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-surface-1 shadow-1',
        size === 'sm' ? 'px-3 py-2' : 'px-4 py-3',
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-sm text-fg-3 [&_svg]:size-4">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      {loading ? (
        <div className={cn('skeleton rounded-sm', size === 'sm' ? 'h-6 w-16' : 'h-8 w-24')} />
      ) : (
        <div
          className={cn(
            'truncate font-semibold leading-tight tracking-tight',
            size === 'sm' ? 'text-xl' : 'text-2xl',
            TONE[tone],
            stale && 'opacity-45',
          )}
          title={stale ? '配置改过了，这是旧结果' : undefined}
        >
          {value}
        </div>
      )}
      {hint && <div className="truncate text-xs text-fg-3">{hint}</div>}
    </div>
  )
}

/** 卡片里的小统计：一排「小标签 + 数字」，用细分隔线隔开 */
export function MiniStats({ items, className }: { items: { label: string; value: ReactNode; title?: string }[]; className?: string }) {
  return (
    <dl className={cn('flex flex-wrap items-stretch gap-x-4 gap-y-2', className)}>
      {items.map((it, i) => (
        <div key={it.label} className={cn('flex flex-col', i > 0 && 'border-l border-border pl-4')} title={it.title}>
          <dt className="text-xs text-fg-3">{it.label}</dt>
          <dd className="text-lg font-semibold leading-tight text-fg-1">{it.value}</dd>
        </div>
      ))}
    </dl>
  )
}
