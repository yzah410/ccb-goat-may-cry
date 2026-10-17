/** 查询结果表：表头吸顶、先显示 200 行（可以再显示更多）、数字等宽、空值灰色的「—」 */
import { useState } from 'react'
import { cn } from '@/lib/cn'
import { fmtInt, fmtMs } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import type { AskTable } from '../store'

const STEP = 200

function cell(v: unknown): { text: string; muted?: boolean; num?: boolean } {
  if (v === null || v === undefined) return { text: '—', muted: true }
  if (typeof v === 'number') return { text: Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000), num: true }
  if (typeof v === 'string') return { text: v }
  return { text: JSON.stringify(v) }
}

export function ResultTable({ table, stale, className }: { table: AskTable; stale?: boolean; className?: string }) {
  const [shown, setShown] = useState(STEP)
  const rows = table.rows.slice(0, shown)
  // 这一列是不是数字列（看前 50 行里第一个不是空的值）：数字列表头也靠右，和数字对齐
  const numeric = table.columns.map((_, j) => {
    const v = table.rows.slice(0, 50).find((r) => r[j] != null)?.[j]
    return typeof v === 'number'
  })
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className={cn('max-h-[520px] overflow-auto rounded-md border border-border scroll-thin transition-opacity', stale && 'opacity-60')}>
        <table className="w-full min-w-max border-collapse text-sm">
          <thead className="sticky top-0 z-[1] bg-bg-elevated text-left text-xs text-fg-3">
            <tr>
              <th className="w-12 border-b border-border px-3 py-2 text-right font-medium">#</th>
              {table.columns.map((c, i) => (
                <th key={`${c}-${i}`} className={cn('border-b border-border px-3 py-2 font-medium', numeric[i] && 'text-right')}>
                  <span className="font-mono">{c}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-border first:border-t-0 hover:bg-surface-2">
                <td className="tabular px-3 py-1.5 text-right text-xs text-fg-3">{i + 1}</td>
                {table.columns.map((_, j) => {
                  const c = cell(r[j])
                  return (
                    <td
                      key={j}
                      className={cn('max-w-[28rem] truncate px-3 py-1.5', c.muted ? 'text-fg-3' : 'text-fg-1', c.num && 'tabular text-right')}
                      title={c.text.length > 40 ? c.text : undefined}
                    >
                      {c.text}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {table.rows.length === 0 && <p className="px-3 py-8 text-center text-sm text-fg-3">查询跑通了，但是一行都没有</p>}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-3">
        <span className="tabular">
          共 {fmtInt(table.rows.length)} 行{table.truncated ? '（后端最多给 2,000 行，后面的没显示）' : ''}
        </span>
        <span>·</span>
        <span>用时 {fmtMs(table.elapsed_ms)}</span>
        <span>·</span>
        <span>{table.by === 'ai' ? 'AI 写的 SQL 跑出来的' : '你自己跑的'}</span>
        {table.rows.length > shown && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setShown((n) => n + STEP)}>
            再显示 {Math.min(STEP, table.rows.length - shown)} 行
          </Button>
        )}
      </div>
    </div>
  )
}
