/**
 * 出题器的编辑器里反复用到的几个小控件：
 * - ValuesField：一组值（标签 / 声优名）= 可删的芯片 + 带补全的输入框
 * - ToggleChips：多选的胶囊按钮（作品类型、性别、身份……）
 * - ListPicker：选一个清单（角色 / 作品 / 标签）；没有清单时给「去建一个」
 * - MinMax：两个数字框（留空 = 不限）
 */
import { useState, type ReactNode } from 'react'
import { ToggleGroup as TG } from 'radix-ui'
import { cn } from '@/lib/cn'
import { useShellNav } from '@/app/shell/nav'
import { Select } from '@/components/ui/Controls'
import { NumberField } from '@/components/ui/NumberField'
import { TagChip, type TagChipKind } from '@/components/data-display/TagChip'
import { IconArrowRight } from '@/lib/icons'
import { useListsOfKind } from '../hooks'
import { LIST_KIND_LABEL } from '../labels'
import type { ListKind, ModeId, SuggestKind } from '../types'
import { SuggestCombo } from './SuggestCombo'

// ---------------------------------------------------------------- ValuesField
const CHIP_KIND: Record<SuggestKind, TagChipKind> = {
  game_tag: 'genre',
  work_tag: 'work',
  meta_tag: 'work',
  char_tag: 'char',
  va: 'va',
  work: 'work',
  character: 'other',
}

export function ValuesField({
  kind,
  mode,
  n,
  values,
  onChange,
  placeholder,
  ariaLabel,
  autoFocus,
  inline = true,
}: {
  kind: SuggestKind
  mode?: ModeId
  /** 作品标签数（game_tag 的补全数字按它算） */
  n?: number
  values: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  ariaLabel?: string
  autoFocus?: boolean
  /** 补全列表放在文档流里（默认：这个控件多半在弹层里） */
  inline?: boolean
}) {
  // 按原样打进去（补全里没有）的值：芯片上标一下，提醒「库里可能没有」
  const [free, setFree] = useState<ReadonlySet<string>>(() => new Set())
  return (
    <div className="flex flex-col gap-2">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((v) => (
            <TagChip
              key={v}
              kind={CHIP_KIND[kind]}
              label={v}
              size="sm"
              emoji={null}
              emphasis="strong"
              title={free.has(v) ? '补全里没有这个名字，按原样筛（可能一个人都筛不到）' : undefined}
              className={free.has(v) ? 'ring-1 ring-warning' : undefined}
              onRemove={() => onChange(values.filter((x) => x !== v))}
            />
          ))}
        </div>
      )}
      <SuggestCombo
        kind={kind}
        mode={mode}
        n={n}
        exclude={values}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        autoFocus={autoFocus}
        inline={inline}
        onPick={(p) => {
          if (p.free) setFree((s) => new Set(s).add(p.value))
          onChange([...values, p.value])
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------- ToggleChips
export interface ToggleOption<V extends string> {
  value: V
  label: ReactNode
  title?: string
}

/** 多选胶囊（Radix ToggleGroup multiple：键盘左右移动、空格切换） */
export function ToggleChips<V extends string>({
  options,
  values,
  onChange,
  ariaLabel,
  size = 'sm',
  /** 至少要留一个（最后一个点不掉） */
  atLeastOne,
}: {
  options: ToggleOption<V>[]
  values: readonly V[]
  onChange: (v: V[]) => void
  ariaLabel: string
  size?: 'sm' | 'md'
  atLeastOne?: boolean
}) {
  return (
    <TG.Root
      type="multiple"
      value={[...values]}
      onValueChange={(v) => {
        if (atLeastOne && v.length === 0) return
        // 保持选项本身的顺序（不是点击顺序）
        onChange(options.map((o) => o.value).filter((x) => v.includes(x)))
      }}
      aria-label={ariaLabel}
      className="flex flex-wrap items-center gap-1.5"
    >
      {options.map((o) => (
        <TG.Item
          key={o.value}
          value={o.value}
          title={o.title}
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2.5 font-medium text-fg-2 ring-1 ring-inset ring-border-strong transition-colors',
            'hover:bg-surface-2 hover:text-fg-1',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
            'data-[state=on]:bg-primary-100 data-[state=on]:text-primary-800 data-[state=on]:ring-primary-300',
            size === 'sm' ? 'h-7 text-xs' : 'h-8 text-sm',
          )}
        >
          {o.label}
        </TG.Item>
      ))}
    </TG.Root>
  )
}

// ---------------------------------------------------------------- ListPicker

export function ListPicker({
  kind,
  value,
  onChange,
  placeholder,
  size = 'sm',
  allowNone,
  className,
}: {
  kind: ListKind
  value: string | null | undefined
  onChange: (id: string | null) => void
  placeholder?: string
  size?: 'sm' | 'md'
  /** 有「不用清单」这一项 */
  allowNone?: boolean
  className?: string
}) {
  const nav = useShellNav()
  const { lists, isPending, isError } = useListsOfKind(kind)
  const missing = !!value && !isPending && !lists.some((l) => l.id === value)
  if (!isPending && !isError && lists.length === 0)
    return (
      <div className={cn('flex flex-wrap items-center gap-2 text-sm text-fg-3', className)}>
        还没有{LIST_KIND_LABEL[kind]}
        <button type="button" className="inline-flex items-center gap-1 text-link hover:underline" onClick={() => nav.go('lists')}>
          去「清单」页建一个 <IconArrowRight className="size-3.5" />
        </button>
      </div>
    )
  const NONE = '__none__'
  const options = [
    ...(allowNone ? [{ value: NONE, label: '不用清单' }] : []),
    ...lists.map((l) => ({ value: l.id, label: l.name, hint: `${l.items.length} 项${l.note ? ` · ${l.note}` : ''}` })),
    ...(missing ? [{ value: value!, label: '（这个清单已经删了）', disabled: true }] : []),
  ]
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <Select
        size={size}
        value={value ?? (allowNone ? NONE : undefined)}
        onChange={(v) => onChange(v === NONE ? null : v)}
        options={options}
        placeholder={isPending ? '正在读清单…' : (placeholder ?? `选一个${LIST_KIND_LABEL[kind]}`)}
        aria-label={`选${LIST_KIND_LABEL[kind]}`}
      />
      {missing && <p className="text-xs text-danger-fg">用到的清单已经被删了，换一个吧</p>}
      {isError && <p className="text-xs text-danger-fg">清单读不出来（后端连不上？）</p>}
    </div>
  )
}

// ---------------------------------------------------------------- 两个数字框
export function MinMax({
  min,
  max,
  onChange,
  integer = true,
  step,
  unit,
  labels = ['最少', '最多'],
  lo,
  hi,
  width = 'w-24',
}: {
  min: number | null | undefined
  max: number | null | undefined
  onChange: (min: number | null, max: number | null) => void
  integer?: boolean
  step?: number
  unit?: string
  labels?: [string, string]
  lo?: number
  hi?: number
  width?: string
}) {
  const swapped = min != null && max != null && min > max
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <NumberField
          value={min ?? null}
          onCommit={(v) => onChange(v, max ?? null)}
          allowEmpty
          integer={integer}
          step={step}
          min={lo}
          max={hi}
          size="sm"
          className={width}
          placeholder="不限"
          aria-label={labels[0]}
          suffix={unit && <span className="text-xs">{unit}</span>}
        />
        <span className="text-fg-3">–</span>
        <NumberField
          value={max ?? null}
          onCommit={(v) => onChange(min ?? null, v)}
          allowEmpty
          integer={integer}
          step={step}
          min={lo}
          max={hi}
          size="sm"
          className={width}
          placeholder="不限"
          aria-label={labels[1]}
          suffix={unit && <span className="text-xs">{unit}</span>}
        />
      </div>
      <p className={cn('text-xs', swapped ? 'text-warning-fg' : 'text-fg-3')}>
        {swapped ? '左边比右边大了，这样一个都筛不到' : '留空 = 不限'}
      </p>
    </div>
  )
}
