/**
 * 自动补全输入框（GET /v2/suggest）：标签 / 声优 / 作品 / 角色。
 * - 打字 180ms 防抖后查；↑↓ 选，回车加选中的（没选中就按原样加，allowFree=false 时不行），Esc 关
 * - 标签类在输入框为空时也列出最常见的几个（点一下就加）
 * - 已经加过的显示「已加」，不能重复加
 */
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { fmtCompact } from '@/lib/format'
import { IconLoader, IconPlus, IconSearch } from '@/lib/icons'
import { useDebounced, useSuggest } from '../hooks'
import { SUGGEST_KIND_LABEL } from '../labels'
import type { ModeId, SuggestItem, SuggestKind } from '../types'


/** 数字是什么意思（补全列表底部的说明） */
const COUNT_MEANING: Record<SuggestKind, string> = {
  game_tag: '数字 = 有多少个角色的格子里有它',
  work_tag: '数字 = 有多少部作品带它',
  meta_tag: '数字 = 有多少部作品带这个公共标签',
  char_tag: '数字 = 有多少个角色带它',
  va: '数字 = 配过多少个角色',
  work: '数字 = 收藏人数',
  character: '数字 = 角色热度',
}

const TAG_KINDS: SuggestKind[] = ['game_tag', 'work_tag', 'meta_tag', 'char_tag']

export interface PickedValue {
  value: string
  item?: SuggestItem
  /** 没在补全里选，而是原样打进去的 */
  free: boolean
}

export function SuggestCombo({
  kind,
  mode,
  n,
  onPick,
  exclude = [],
  placeholder,
  allowFree = true,
  size = 'sm',
  ariaLabel,
  autoFocus,
  className,
  leading,
  inline,
}: {
  kind: SuggestKind
  mode?: ModeId
  /** 作品标签数（game_tag 的数字按它算） */
  n?: number
  onPick: (v: PickedValue) => void
  /** 已经选了的值（显示「已加」） */
  exclude?: readonly string[]
  placeholder?: string
  allowFree?: boolean
  size?: 'sm' | 'md'
  ariaLabel?: string
  autoFocus?: boolean
  className?: string
  leading?: ReactNode
  /** 补全列表放在正常文档流里（把下面的内容往下推），而不是浮在上面盖住别的控件；弹层里用 */
  inline?: boolean
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(-1)
  const listId = useId()
  const dq = useDebounced(q.trim(), 180)
  const isTag = TAG_KINDS.includes(kind)
  const sug = useSuggest(kind, dq, { mode, n, enabled: open && (dq.length > 0 || isTag), limit: dq ? 20 : 12 })
  const items = sug.data ?? []
  const taken = new Set(exclude)

  const pick = (v: PickedValue) => {
    if (!v.value.trim() || taken.has(v.value)) return
    onPick(v)
    setQ('')
    setHi(-1)
    // 加完就收起列表（接着打字会再打开），免得列表挡住下面的按钮
    setOpen(false)
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setHi((i) => Math.min(items.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHi((i) => Math.max(-1, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const it = hi >= 0 ? items[hi] : undefined
      if (it) pick({ value: it.value, item: it, free: false })
      else {
        const exact = items.find((x) => x.value === q.trim() || x.label === q.trim())
        if (exact) pick({ value: exact.value, item: exact, free: false })
        else if (allowFree && q.trim()) pick({ value: q.trim(), free: true })
      }
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation()
      setOpen(false)
    }
  }

  const showList = open && (items.length > 0 || (sug.isFetching && !items.length))
  const noMatch = open && !!dq && dq === q.trim() && sug.isSuccess && !sug.isFetching && items.length === 0

  return (
    <div className={cn('relative min-w-0', className)}>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-fg-3 [&_svg]:size-3.5">
          {sug.isFetching ? <IconLoader className="animate-spin" /> : (leading ?? <IconSearch />)}
        </span>
        <input
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={hi >= 0 ? `${listId}-${hi}` : undefined}
          aria-label={ariaLabel ?? `输入${SUGGEST_KIND_LABEL[kind]}`}
          value={q}
          autoFocus={autoFocus}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
            setHi(-1)
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 140)}
          onKeyDown={onKey}
          placeholder={placeholder ?? `输入${SUGGEST_KIND_LABEL[kind]}，回车添加`}
          className={cn(
            'w-full rounded-md border border-border-strong bg-surface-1 pl-7 pr-2 text-fg-1',
            'hover:border-fg-3 focus-visible:border-primary-500 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-primary-200',
            size === 'sm' ? 'h-[var(--control-h-sm)] text-sm' : 'h-[var(--control-h-md)] text-base',
          )}
        />
      </div>
      {showList && (
        <div
          className={cn(
            'overflow-hidden rounded-md border border-border bg-surface-1',
            inline ? 'mt-1 shadow-1' : 'absolute left-0 right-0 top-full z-40 mt-1 min-w-56 shadow-3',
          )}
        >
          <ul id={listId} role="listbox" className={cn('overflow-y-auto p-1 scroll-thin', inline ? 'max-h-48' : 'max-h-64')}>
            {items.map((s, i) => {
              const done = taken.has(s.value)
              return (
                <li
                  key={`${s.value}-${s.id ?? ''}`}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === hi}
                  aria-disabled={done || undefined}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    if (!done) pick({ value: s.value, item: s, free: false })
                  }}
                  onMouseEnter={() => setHi(i)}
                  className={cn(
                    'flex cursor-pointer items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-sm',
                    i === hi ? 'bg-primary-100 text-primary-900' : 'text-fg-1',
                    done && 'cursor-default opacity-50',
                  )}
                >
                  <span className="min-w-0 truncate">
                    {s.label || s.value}
                    {s.id != null && (kind === 'work' || kind === 'character') && <span className="ml-1.5 font-mono text-xs text-fg-3">#{s.id}</span>}
                  </span>
                  <span className="tabular shrink-0 text-xs text-fg-3">{done ? '已加' : fmtCompact(s.count)}</span>
                </li>
              )
            })}
            {!items.length && sug.isFetching && <li className="px-2 py-1.5 text-sm text-fg-3">正在找…</li>}
          </ul>
          <p className="border-t border-border bg-bg-elevated px-2 py-1.5 text-xs text-fg-3">
            {dq ? '↑↓ 选，回车添加' : '最常见的几个；打字可以搜'} · {COUNT_MEANING[kind]}
          </p>
        </div>
      )}
      {noMatch && (
        <p className="mt-1 flex items-center gap-1 text-xs text-warning-fg">
          {allowFree ? (
            <>
              <IconPlus className="size-3" />
              库里没有叫「{dq}」的{SUGGEST_KIND_LABEL[kind]}；回车会按原样加，但很可能一个人都筛不到
            </>
          ) : (
            <>库里没找到「{dq}」，换个写法试试（中文名、原名都行）</>
          )}
        </p>
      )}
      {sug.isError && open && <p className="mt-1 text-xs text-fg-3">自动补全暂时用不了，可以直接输入完整名字</p>}
    </div>
  )
}
