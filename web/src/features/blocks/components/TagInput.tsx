import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/cn'
import { fmtCompact } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { toast } from '@/components/ui/Toast'
import { SegmentedControl, Select } from '@/components/ui/Controls'
import { IconMinus, IconPlus } from '@/lib/icons'
import { useTagSuggestions } from '@/features/tags/api'
import { TAG_KIND_LABEL, type BlockColor, type TagItem, type TagKind } from '../schema'

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return v
}

const KIND_OPTIONS = (Object.keys(TAG_KIND_LABEL) as TagKind[]).map((k) => ({ value: k, label: TAG_KIND_LABEL[k] }))

/**
 * 加一个标签：选类型（只在「角色范围」里能选）→ 选纳入/排除 → 输入名字（有自动补全）→ 回车。
 * 类型和颜色都从固定选项里选，不用手打。
 */
export function TagInput({
  mode,
  onAdd,
  existing,
}: {
  /** work-only = 作品范围（只认作品标签）；mixed = 角色范围（四种都行） */
  mode: 'work-only' | 'mixed'
  onAdd: (item: TagItem) => void
  existing: TagItem[]
}) {
  const [kind, setKind] = useState<TagKind>('work')
  const [color, setColor] = useState<BlockColor>('red')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(-1)
  const listId = useId()
  const dq = useDebounced(q.trim(), 180)
  const effKind = mode === 'work-only' ? 'work' : kind
  const sug = useTagSuggestions(effKind, dq, open && (dq.length > 0 || effKind === 'source'))
  const items = sug.data?.items ?? []

  const add = (name: string) => {
    const n = name.trim()
    if (!n) return
    const dup = existing.find((t) => t.name === n && t.kind === effKind)
    if (dup) {
      toast.info(`「${n}」已经在这一组里了`, {
        description: dup.color === color ? '同一组里不用重复加' : '同一组里同一个标签不能既纳入又排除；要反过来先删掉已有的',
      })
      setQ('')
      return
    }
    onAdd({ name: n, kind: effKind, color })
    setQ('')
    setHi(-1)
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
      add(hi >= 0 && items[hi] ? items[hi]!.name : q)
    } else if (e.key === 'Escape') {
      if (open) {
        e.stopPropagation()
        setOpen(false)
      }
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {mode === 'mixed' && (
          <div className="w-32">
            <Select size="sm" value={kind} onChange={setKind} options={KIND_OPTIONS} aria-label="标签类型" />
          </div>
        )}
        <SegmentedControl
          size="sm"
          value={color}
          onChange={setColor}
          aria-label="纳入还是排除"
          tone={(v) => (v === 'red' ? 'include' : 'exclude')}
          options={[
            { value: 'red', label: '纳入（必须有）', icon: <IconPlus />, title: '必须有这个标签' },
            { value: 'blue', label: '排除（不能有）', icon: <IconMinus />, title: '不能有这个标签' },
          ]}
        />
      </div>
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <input
            role="combobox"
            aria-expanded={open && items.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={hi >= 0 ? `${listId}-${hi}` : undefined}
            aria-label="标签名"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setOpen(true)
              setHi(-1)
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 120)}
            onKeyDown={onKey}
            placeholder={effKind === 'source' ? '原创 / 漫画改 / 小说改 / 游戏改' : `输入${TAG_KIND_LABEL[effKind]}，回车添加`}
            className={cn(
              'h-[var(--control-h-sm)] w-full rounded-md border border-border-strong bg-surface-1 px-2 text-sm text-fg-1',
              'hover:border-fg-3 focus-visible:border-primary-500 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-primary-200',
            )}
          />
          {open && items.length > 0 && (
            <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-border bg-surface-1 shadow-3">
              <ul id={listId} role="listbox" className="max-h-60 overflow-y-auto p-1 scroll-thin">
                {items.map((s, i) => (
                  <li
                    key={s.name}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === hi}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      add(s.name)
                    }}
                    onMouseEnter={() => setHi(i)}
                    className={cn(
                      'flex cursor-pointer items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-sm',
                      i === hi ? 'bg-primary-100 text-primary-900' : 'text-fg-1',
                    )}
                  >
                    <span className="truncate">{s.name}</span>
                    <span className="tabular shrink-0 text-xs text-fg-3">{fmtCompact(s.count)}</span>
                  </li>
                ))}
              </ul>
              <p className="border-t border-border bg-bg-elevated px-2 py-1.5 text-xs text-fg-3">
                ↑↓ 选，回车添加{hi < 0 && q.trim() ? `「${q.trim()}」（原样）` : '选中的'}；数字是有多少部作品/角色带这个标签
              </p>
            </div>
          )}
        </div>
        <Button size="sm" variant="secondary" icon={<IconPlus />} disabled={!q.trim()} onClick={() => add(q)}>
          添加
        </Button>
      </div>
      {q.trim() && dq === q.trim() && sug.isSuccess && !sug.isFetching && items.length === 0 && (
        <p className="text-xs text-warning-fg">数据里没有叫「{q.trim()}」的标签；也可以添加，但名字要和数据里一模一样才筛得到。</p>
      )}
    </div>
  )
}
