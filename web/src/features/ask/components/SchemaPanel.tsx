/**
 * 表结构参考（GET /v2/sql/schema）：每张表、每一列一句中文说明；点列名 / 表名插进 SQL 编辑框。
 * 下面是后端给的注意事项和例子（点例子 = 把问题和 SQL 填进来，不自动跑）。
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/cn'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { ErrorState, Skeleton } from '@/components/data-display/Misc'
import { IconChevronDown, IconChevronRight, IconSearch, IconTable } from '@/lib/icons'
import { v2Api } from '@/features/v2/api'
import { V2_KEYS } from '@/features/v2/hooks'

const KIND_LABEL: Record<string, string> = { table: '表', view: '视图', temp: '清单表' }

export function SchemaPanel({ onInsert, onExample, className }: { onInsert: (text: string) => void; onExample: (q: string, sql: string) => void; className?: string }) {
  const q = useQuery({ queryKey: V2_KEYS.schema, queryFn: () => v2Api.sqlSchema(), staleTime: 30 * 60_000, retry: 1 })
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const tables = useMemo(() => {
    const k = filter.trim().toLowerCase()
    const all = q.data?.tables ?? []
    if (!k) return all
    return all.filter(
      (t) =>
        t.name.toLowerCase().includes(k) ||
        (t.note ?? '').toLowerCase().includes(k) ||
        t.columns.some((c) => c.name.toLowerCase().includes(k) || (c.note ?? '').toLowerCase().includes(k)),
    )
  }, [q.data, filter])
  const notes = q.data?.notes ? (Array.isArray(q.data.notes) ? q.data.notes : [q.data.notes]) : []

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-center gap-2">
        <IconTable className="size-4 text-fg-3" aria-hidden />
        <h2 className="text-base text-fg-1">表结构</h2>
        <span className="text-xs text-fg-3">点表名 / 列名插进 SQL</span>
      </div>
      <Input size="sm" leading={<IconSearch />} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="找表或列（例：标签、heat）" aria-label="找表或列" />
      {q.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-3/4" />
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} size="sm" onRetry={() => void q.refetch()} />
      ) : (
        <ul className="flex flex-col gap-1">
          {tables.map((t) => {
            const isOpen = !!filter.trim() || !!open[t.name]
            return (
              <li key={t.name} className="rounded-md border border-border bg-surface-1">
                <div className="flex items-start gap-1.5 px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => setOpen((o) => ({ ...o, [t.name]: !o[t.name] }))}
                    className="mt-0.5 text-fg-3 hover:text-fg-1"
                    aria-label={isOpen ? `收起 ${t.name}` : `展开 ${t.name}`}
                    aria-expanded={isOpen}
                  >
                    {isOpen ? <IconChevronDown className="size-4" /> : <IconChevronRight className="size-4" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button type="button" onClick={() => onInsert(t.name)} className="font-mono text-sm font-medium text-fg-1 hover:text-link hover:underline" title="插进 SQL">
                        {t.name}
                      </button>
                      {t.kind && (
                        <Badge size="sm" tone={t.kind === 'view' ? 'info' : t.kind === 'temp' ? 'accent' : 'neutral'}>
                          {KIND_LABEL[t.kind] ?? t.kind}
                        </Badge>
                      )}
                    </div>
                    {t.note && <p className="mt-0.5 text-xs leading-body text-fg-2">{t.note}</p>}
                  </div>
                </div>
                {isOpen && (
                  <ul className="border-t border-border px-2 py-1.5">
                    {t.columns.map((c) => (
                      <li key={c.name} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-2 py-0.5 text-xs">
                        <button type="button" onClick={() => onInsert(c.name)} className="truncate text-left font-mono text-fg-1 hover:text-link hover:underline" title={`插进 SQL：${c.name}${c.type ? `（${c.type}）` : ''}`}>
                          {c.name}
                        </button>
                        <span className="text-fg-3">{c.note || c.type || ''}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
          {tables.length === 0 && <li className="py-4 text-center text-sm text-fg-3">没有匹配的表或列</li>}
        </ul>
      )}
      {notes.length > 0 && (
        <div className="flex flex-col gap-1 rounded-md bg-surface-2 p-3">
          <span className="text-xs font-medium text-fg-2">注意</span>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-xs leading-body text-fg-2">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      {!!q.data?.examples?.length && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-fg-2">例子（点一下填进去，不会自动跑）</span>
          {q.data.examples.map((ex, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onExample(ex.q, ex.sql)}
              className="rounded-md border border-border bg-surface-1 px-2.5 py-1.5 text-left text-xs text-fg-1 transition-colors hover:border-border-strong hover:bg-surface-2"
            >
              {ex.q}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
