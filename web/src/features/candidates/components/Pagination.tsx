import { useState } from 'react'
import { cn } from '@/lib/cn'
import { fmtInt } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { IconChevronLeft, IconChevronRight } from '@/lib/icons'
import { pageWindow } from '../pagination'

/** 上一页 / 页码（最多 10 个）/ 下一页 / 跳到第几页 */
export function Pagination({
  page,
  totalPages,
  onPage,
  disabled,
  className,
}: {
  page: number
  totalPages: number
  onPage: (p: number) => void
  disabled?: boolean
  className?: string
}) {
  const [jump, setJump] = useState('')
  if (totalPages <= 1) return null
  const pages = pageWindow(page, totalPages)
  const go = (p: number) => onPage(Math.min(totalPages, Math.max(1, p)))
  return (
    <nav aria-label="分页" className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <Button size="sm" variant="secondary" icon={<IconChevronLeft />} disabled={disabled || page <= 1} onClick={() => go(page - 1)}>
        上一页
      </Button>
      {pages[0]! > 1 && (
        <>
          <PageBtn n={1} active={false} onClick={() => go(1)} disabled={disabled} />
          {pages[0]! > 2 && <span className="px-1 text-fg-3">…</span>}
        </>
      )}
      {pages.map((n) => (
        <PageBtn key={n} n={n} active={n === page} onClick={() => go(n)} disabled={disabled} />
      ))}
      {pages[pages.length - 1]! < totalPages && (
        <>
          {pages[pages.length - 1]! < totalPages - 1 && <span className="px-1 text-fg-3">…</span>}
          <PageBtn n={totalPages} active={false} onClick={() => go(totalPages)} disabled={disabled} />
        </>
      )}
      <Button size="sm" variant="secondary" disabled={disabled || page >= totalPages} onClick={() => go(page + 1)}>
        下一页
        <IconChevronRight />
      </Button>
      <form
        className="ml-2 flex items-center gap-1.5 text-sm text-fg-3"
        onSubmit={(e) => {
          e.preventDefault()
          const n = parseInt(jump, 10)
          if (!Number.isNaN(n)) go(n)
          setJump('')
        }}
      >
        跳到
        <input
          value={jump}
          onChange={(e) => setJump(e.target.value.replace(/\D/g, ''))}
          inputMode="numeric"
          aria-label="跳到第几页"
          placeholder={String(page)}
          className="tabular h-[var(--control-h-sm)] w-14 rounded-md border border-border-strong bg-surface-1 px-2 text-center text-sm text-fg-1 focus-visible:border-primary-500 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-primary-200"
        />
        页 / 共 {fmtInt(totalPages)} 页
      </form>
    </nav>
  )
}

function PageBtn({ n, active, onClick, disabled }: { n: number; active: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'tabular h-[var(--control-h-sm)] min-w-[var(--control-h-sm)] rounded-md px-2 text-sm transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:opacity-45',
        active ? 'bg-primary text-on-primary font-semibold shadow-1' : 'text-fg-2 hover:bg-surface-2 hover:text-fg-1',
      )}
    >
      {n}
    </button>
  )
}
