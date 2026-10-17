/**
 * 标签栏「+」弹出的搜索框：搜全部图（不看左边列表的来源筛选），按组列出；↑↓ 选、Enter 在这一格新开、Esc 关。
 * 画在工作区容器里（不走 portal），工作区全屏时也能用。
 * 做题联动的「+ 加图」也用它（换掉标题、「已打开」和页脚的文字）。
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/Input'
import { IconSearch } from '@/lib/icons'
import { cn } from '@/lib/cn'
import { buildGroups, flatOrder } from '../library'
import type { MapSummary } from '../types'
import { groupDotClass } from './labels'

export interface QuickOpenProps {
  items: MapSummary[]
  /** 这一格里已经开着的图（标一下「已打开」，选它 = 切过去） */
  openHere: Set<string>
  onPick: (mapId: string) => void
  onClose: () => void
  /** 对话框的名字（读屏用），默认「打开一张图」 */
  title?: string
  /** openHere 里的图后面标的字，默认「已打开」 */
  openLabel?: string
  /** 页脚的操作说明 */
  footer?: string
}

export function QuickOpen({
  items,
  openHere,
  onPick,
  onClose,
  title = '打开一张图',
  openLabel = '已打开',
  footer = '↑↓ 选择 · Enter 在这一格打开 · Esc 关闭',
}: QuickOpenProps) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const groups = useMemo(() => buildGroups(items, { query }), [items, query])
  const order = useMemo(() => flatOrder(groups), [groups])
  const at = Math.min(cursor, Math.max(0, order.length - 1))
  const current = order[at]

  // 键盘移动时，选中的那一行滚进可见区
  useEffect(() => {
    if (!current) return
    listRef.current?.querySelector<HTMLElement>(`[data-qo-id="${CSS.escape(current.id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!order.length) return
      setCursor((at + (e.key === 'ArrowDown' ? 1 : -1) + order.length) % order.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (current) onPick(current.id)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <div
      className="absolute inset-0 z-30"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      data-ws-quickopen=""
    >
      <div
        role="dialog"
        aria-label={title}
        className={cn(
          'absolute left-1/2 top-[min(12%,4rem)] flex max-h-[calc(100%_-_min(12%,4rem)_-_1rem)] w-[min(34rem,calc(100%-2rem))] -translate-x-1/2 flex-col',
          'rounded-lg border border-border bg-surface-1 text-fg-1 shadow-3',
          'animate-[pop-in_var(--motion-duration)_var(--motion-ease)]',
        )}
        onKeyDown={onKey}
      >
        <div className="border-b border-border p-2">
          <Input
            autoFocus
            size="sm"
            type="search"
            leading={<IconSearch />}
            placeholder="搜标题或共有标签"
            aria-label="搜标题或共有标签"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={current ? `${listId}-${current.id}` : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(0)
            }}
          />
        </div>
        <div ref={listRef} id={listId} role="listbox" aria-label="全部图" className="min-h-0 flex-1 overflow-y-auto p-1 scroll-thin">
          {groups.length === 0 && <p className="px-2 py-3 text-sm text-fg-3">没有标题或共有标签里含「{query.trim()}」的图。</p>}
          {groups.map((g) => (
            <div key={g.key} role="group" aria-label={g.label}>
              <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-xs font-medium text-fg-3">
                <span aria-hidden className={cn('size-1.5 rounded-full', groupDotClass(g.key))} />
                {g.label}
              </div>
              {g.items.map((it) => {
                const sel = current?.id === it.id
                return (
                  <div
                    key={it.id}
                    id={`${listId}-${it.id}`}
                    role="option"
                    aria-selected={sel}
                    data-qo-id={it.id}
                    onPointerMove={() => {
                      if (!sel) setCursor(order.indexOf(it))
                    }}
                    onClick={() => onPick(it.id)}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                      sel ? 'bg-selected text-fg-1' : 'text-fg-2',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{it.title}</span>
                    {openHere.has(it.id) && <span className="shrink-0 text-xs text-fg-3">{openLabel}</span>}
                    <span className="shrink-0 font-mono text-xs text-fg-3">{it.n_works} 部</span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        <p className="border-t border-border px-3 py-1.5 text-xs text-fg-3">{footer}</p>
      </div>
    </div>
  )
}
