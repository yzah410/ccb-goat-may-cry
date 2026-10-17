/**
 * 小件展示组件：GenderBadge / WorkBadge / EmptyState / ErrorState / Skeleton / LogLineView / KeyValue / Loading
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { ThemeSlot } from '@/themes/ThemeSlot'
import type { EmptyKind } from '@/themes/types'
import { isApiError, errorText } from '@/lib/apiClient'
import { Button } from '@/components/ui/Button'
import { Tooltip } from '@/components/ui/Overlay'
import {
  IconAlert,
  IconCircleCheck,
  IconCircleX,
  IconFilm,
  IconHelp,
  IconInfo,
  IconMars,
  IconRefresh,
  IconVenus,
} from '@/lib/icons'
import type { LogLine } from '@/features/clicker/normalize'

// ---------------------------------------------------------------- GenderBadge
export function GenderBadge({ gender, className }: { gender: string | null | undefined; className?: string }) {
  const g = gender === '♂' ? 'male' : gender === '♀' ? 'female' : 'unknown'
  const label = g === 'male' ? '男' : g === 'female' ? '女' : '性别未知'
  return (
    <Tooltip content={label}>
      <span
        role="img"
        aria-label={label}
        className={cn(
          'inline-grid size-6 shrink-0 place-items-center rounded-full [&_svg]:size-3.5',
          g === 'male' && 'bg-[color-mix(in_oklab,var(--chart-1)_15%,transparent)] text-[color-mix(in_oklab,var(--chart-1)_82%,var(--text-1))]',
          g === 'female' && 'bg-[color-mix(in_oklab,var(--chart-5)_16%,transparent)] text-[color-mix(in_oklab,var(--chart-5)_82%,var(--text-1))]',
          g === 'unknown' && 'bg-surface-2 text-fg-3 ring-1 ring-inset ring-border',
          className,
        )}
      >
        {g === 'male' ? <IconMars /> : g === 'female' ? <IconVenus /> : <IconHelp />}
      </span>
    </Tooltip>
  )
}

// ---------------------------------------------------------------- WorkBadge
export function WorkBadge({
  name,
  year,
  extra,
  icon,
  className,
  title,
}: {
  name: string
  year?: number | null
  /** 例如「+3 部」 */
  extra?: ReactNode
  icon?: ReactNode
  className?: string
  title?: string
}) {
  return (
    <span
      data-slot="work-badge"
      title={title ?? name}
      className={cn(
        'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-sm text-fg-1 ring-1 ring-inset ring-border [&_svg]:size-3.5 [&_svg]:shrink-0',
        className,
      )}
    >
      <span className="text-fg-3">{icon ?? <IconFilm aria-hidden />}</span>
      <span className="min-w-0 truncate">{name}</span>
      {year != null && <span className="tabular shrink-0 text-xs text-fg-3">{year}</span>}
      {extra && <span className="shrink-0 text-xs font-medium text-fg-2">{extra}</span>}
    </span>
  )
}

// ---------------------------------------------------------------- EmptyState
export function EmptyState({
  kind = 'generic',
  title,
  description,
  action,
  size = 'md',
  className,
}: {
  kind?: EmptyKind
  title: ReactNode
  description?: ReactNode
  /** 下一步做什么（按钮） */
  action?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const px = size === 'sm' ? 36 : size === 'lg' ? 80 : 56
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        size === 'sm' ? 'gap-2 py-6' : size === 'lg' ? 'gap-4 py-16' : 'gap-3 py-10',
        className,
      )}
    >
      <ThemeSlot name="EmptyIllustration" kind={kind} size={px} />
      <div className="max-w-md">
        <p className={cn('font-medium text-fg-1', size === 'sm' ? 'text-base' : 'text-lg')}>{title}</p>
        {description && <p className="mt-1 text-sm text-fg-2">{description}</p>}
      </div>
      {action && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  )
}

/** 错误态：连不上后端 → 插头插画；其他 → 警告插画；都带「重试」 */
export function ErrorState({
  error,
  title,
  onRetry,
  size = 'md',
  className,
}: {
  error: unknown
  title?: ReactNode
  onRetry?: () => void
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const offline = isApiError(error) && (error.kind === 'network' || error.kind === 'timeout')
  return (
    <EmptyState
      kind={offline ? 'offline' : 'error'}
      size={size}
      className={className}
      title={title ?? (offline ? '连不上后端' : '出了点问题')}
      description={errorText(error)}
      action={
        onRetry && (
          <Button variant="secondary" icon={<IconRefresh />} onClick={onRetry}>
            再试一次
          </Button>
        )
      }
    />
  )
}

// ---------------------------------------------------------------- Loading / Skeleton
export function Loading({ label, size = 'md', className }: { label?: string; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center py-8', className)}>
      <ThemeSlot name="LoadingIndicator" size={size} label={label} />
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('skeleton rounded-md', className)} />
}

export function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3 rounded-lg border border-border bg-surface-1 p-5', className)} aria-busy>
      <div className="flex items-center gap-3">
        <Skeleton className="h-6 w-36" />
        <Skeleton className="size-6 rounded-full" />
      </div>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-4', i === lines - 1 ? 'w-1/2' : 'w-full')} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- LogLine
const LEVEL_STYLE: Record<LogLine['level'], string> = {
  debug: 'text-fg-3',
  info: 'text-fg-2',
  warn: 'text-warning-fg',
  error: 'text-danger-fg',
  success: 'text-success-fg',
}

const LEVEL_ICON: Record<LogLine['level'], ReactNode> = {
  debug: <span className="size-1.5 rounded-full bg-fg-3" />,
  info: <IconInfo className="size-3.5" />,
  warn: <IconAlert className="size-3.5" />,
  error: <IconCircleX className="size-3.5" />,
  success: <IconCircleCheck className="size-3.5" />,
}

const LEVEL_LABEL: Record<LogLine['level'], string> = { debug: '调试', info: '信息', warn: '注意', error: '错误', success: '成功' }

function hhmmss(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function LogLineView({ line, compact = false }: { line: LogLine; compact?: boolean }) {
  return (
    <div
      data-slot="log-line"
      data-level={line.level}
      className={cn(
        'grid grid-cols-[4.5rem_1rem_minmax(0,1fr)] items-start gap-2 rounded-sm px-2 py-0.5 text-xs leading-body',
        // compact：窄栏里用（分栏布局右侧面板），正文用普通字体、最多 2 行，完整内容悬停看
        !compact && 'font-mono',
        line.level === 'error' && 'bg-danger-bg',
        line.level === 'warn' && 'bg-warning-bg',
      )}
    >
      <span className="tabular font-mono text-fg-3">{line.ts ? hhmmss(line.ts) : '——'}</span>
      <span className={cn('grid h-[1.55em] place-items-center', LEVEL_STYLE[line.level])} title={LEVEL_LABEL[line.level]}>
        {LEVEL_ICON[line.level]}
      </span>
      <span
        className={cn(compact ? 'line-clamp-2 break-words' : 'whitespace-pre-wrap break-words', LEVEL_STYLE[line.level])}
        title={compact ? line.msg : undefined}
      >
        {line.msg}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------- KeyValue
export function KeyValue({
  items,
  className,
}: {
  items: { label: ReactNode; value: ReactNode; hint?: ReactNode }[]
  className?: string
}) {
  return (
    <dl className={cn('grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm', className)}>
      {items.map((it, i) => (
        <div key={i} className="contents">
          <dt className="text-fg-3">{it.label}</dt>
          <dd className="min-w-0 break-words text-fg-1">
            {it.value}
            {it.hint && <span className="ml-2 text-xs text-fg-3">{it.hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}

