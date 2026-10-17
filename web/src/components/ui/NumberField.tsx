import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Input } from './Input'
import { RangeSlider } from './Controls'
import { IconArrowUpDown } from '@/lib/icons'

export interface NumberFieldProps {
  value: number | null | undefined
  /** 合法数字（或允许留空时的 null）才会提交 */
  onCommit: (v: number | null) => void
  min?: number
  max?: number
  step?: number
  integer?: boolean
  /** 允许留空（提交 null） */
  allowEmpty?: boolean
  /** 失焦时如果内容非法，改成这个值（例如权重非法 → 0） */
  fallback?: number
  id?: string
  'aria-label'?: string
  'aria-describedby'?: string
  disabled?: boolean
  size?: 'sm' | 'md'
  className?: string
  placeholder?: string
  suffix?: ReactNode
}

function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return ''
  return String(v)
}

/**
 * 数字输入：打字时保留原样（不会一敲「-」就跳成 0），能解析成合法数字就立即提交；
 * 失焦时把非法内容纠正成 fallback（或上一次的合法值）。
 */
export function NumberField({
  value,
  onCommit,
  min,
  max,
  step,
  integer,
  allowEmpty,
  fallback,
  id,
  disabled,
  size = 'md',
  className,
  placeholder,
  suffix,
  ...aria
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? fmt(value)

  const parse = (s: string): { ok: boolean; v: number | null } => {
    const t = s.trim()
    if (t === '') return { ok: !!allowEmpty, v: null }
    const n = Number(t)
    if (!Number.isFinite(n)) return { ok: false, v: null }
    if (integer && !Number.isInteger(n)) return { ok: false, v: null }
    if (min !== undefined && n < min) return { ok: false, v: null }
    if (max !== undefined && n > max) return { ok: false, v: null }
    return { ok: true, v: n }
  }

  const invalid = draft !== null && !parse(draft).ok

  return (
    <Input
      id={id}
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      value={shown}
      placeholder={placeholder}
      disabled={disabled}
      size={size}
      invalid={invalid}
      aria-label={aria['aria-label']}
      aria-describedby={aria['aria-describedby']}
      className={cn('tabular', className)}
      trailing={suffix}
      onFocus={() => setDraft(fmt(value))}
      onChange={(e) => {
        setDraft(e.target.value)
        const r = parse(e.target.value)
        if (r.ok) onCommit(r.v)
      }}
      onBlur={() => {
        if (draft !== null && !parse(draft).ok && fallback !== undefined) onCommit(fallback)
        setDraft(null)
      }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
        e.preventDefault()
        const base = parse(shown).v ?? value ?? 0
        let n = base + (e.key === 'ArrowUp' ? 1 : -1) * (step ?? 1)
        if (min !== undefined) n = Math.max(min, n)
        if (max !== undefined) n = Math.min(max, n)
        n = Math.round(n * 1000) / 1000
        setDraft(String(n))
        onCommit(n)
      }}
    />
  )
}

/** 下限 – 上限；下限比上限大时提示「后端会自动对调」 */
export function RangePair({
  lo,
  hi,
  onChange,
  min,
  max,
  step,
  integer,
  unit,
  labelLo = '从',
  labelHi = '到',
  disabled,
}: {
  lo: number
  hi: number
  onChange: (lo: number, hi: number) => void
  min?: number
  max?: number
  step?: number
  integer?: boolean
  unit?: string
  labelLo?: string
  labelHi?: string
  disabled?: boolean
}) {
  const swapped = lo > hi
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <NumberField
          value={lo}
          onCommit={(v) => v !== null && onChange(v, hi)}
          min={min}
          max={max}
          step={step}
          integer={integer}
          aria-label={labelLo}
          disabled={disabled}
          className="w-24"
          suffix={unit && <span className="text-xs">{unit}</span>}
        />
        <span className="text-fg-3">–</span>
        <NumberField
          value={hi}
          onCommit={(v) => v !== null && onChange(lo, v)}
          min={min}
          max={max}
          step={step}
          integer={integer}
          aria-label={labelHi}
          disabled={disabled}
          className="w-24"
          suffix={unit && <span className="text-xs">{unit}</span>}
        />
        {swapped && (
          <button
            type="button"
            onClick={() => onChange(hi, lo)}
            className="inline-flex items-center gap-1 rounded-sm px-1.5 py-1 text-xs text-warning-fg hover:bg-warning-bg"
            title="点一下对调"
          >
            <IconArrowUpDown className="size-3.5" />
            对调
          </button>
        )}
      </div>
      {swapped && <p className="text-xs text-warning-fg">下限比上限大了——后端会自动对调，不会报错；也可以点「对调」。</p>}
    </div>
  )
}

const THIS_YEAR = new Date().getFullYear()

/** 年份区间：拖动条 + 两个输入框 */
export function YearRange({
  value,
  onChange,
  min = 1950,
  max = THIS_YEAR + 1,
  disabled,
}: {
  value: [number, number]
  onChange: (v: [number, number]) => void
  min?: number
  max?: number
  disabled?: boolean
}) {
  const [a, b] = value
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  return (
    <div className="flex flex-col gap-3">
      <RangeSlider
        value={[Math.max(min, Math.min(max, lo)), Math.max(min, Math.min(max, hi))]}
        min={Math.min(min, lo)}
        max={Math.max(max, hi)}
        onChange={(v) => onChange([v[0] ?? lo, v[1] ?? hi])}
        disabled={disabled}
        aria-label="年份范围"
      />
      <RangePair lo={a} hi={b} integer onChange={(x, y) => onChange([x, y])} unit="年" labelLo="起始年" labelHi="结束年" disabled={disabled} />
    </div>
  )
}
