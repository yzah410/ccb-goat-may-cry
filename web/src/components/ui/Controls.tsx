/**
 * 表单控件：Select / SegmentedControl / Switch / Checkbox / Slider / Tabs。
 * 全部基于 Radix（键盘可达、读屏友好），样式只用 token。
 */
import type { ReactNode } from 'react'
import { Checkbox as CB, Select as S, Slider as SL, Switch as SW, Tabs as TB, ToggleGroup as TG } from 'radix-ui'
import { cn } from '@/lib/cn'
import { usePortalContainer } from '@/themes/context'
import { IconCheck, IconChevronDown } from '@/lib/icons'

// ---------------------------------------------------------------- Select
export interface SelectOption<V extends string = string> {
  value: V
  label: ReactNode
  hint?: ReactNode
  disabled?: boolean
}

export function Select<V extends string = string>({
  value,
  onChange,
  options,
  placeholder,
  size = 'md',
  id,
  className,
  disabled,
  'aria-label': ariaLabel,
}: {
  value: V | undefined
  onChange: (v: V) => void
  options: SelectOption<V>[]
  placeholder?: string
  size?: 'sm' | 'md'
  id?: string
  className?: string
  disabled?: boolean
  'aria-label'?: string
}) {
  const container = usePortalContainer()
  return (
    <S.Root value={value} onValueChange={(v) => onChange(v as V)} disabled={disabled}>
      <S.Trigger
        id={id}
        aria-label={ariaLabel}
        data-slot="select"
        className={cn(
          'inline-flex w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border-strong bg-surface-1 text-left text-fg-1',
          'transition-[border-color,box-shadow] hover:border-fg-3',
          'focus-visible:outline-none focus-visible:border-primary-500 focus-visible:ring-3 focus-visible:ring-primary-200',
          'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-3',
          'data-[placeholder]:text-fg-3',
          size === 'sm' ? 'h-[var(--control-h-sm)] px-2 text-sm' : 'h-[var(--control-h-md)] px-3 text-base',
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          <S.Value placeholder={placeholder} />
        </span>
        <S.Icon className="shrink-0 text-fg-3">
          <IconChevronDown className="size-4" />
        </S.Icon>
      </S.Trigger>
      <S.Portal container={container}>
        <S.Content
          position="popper"
          sideOffset={6}
          className={cn(
            'z-50 max-h-[min(var(--radix-select-content-available-height),360px)] min-w-[var(--radix-select-trigger-width)]',
            'overflow-hidden rounded-lg border border-border bg-surface-1 text-fg-1 shadow-3',
            'data-[state=open]:animate-[pop-in_var(--motion-duration)_var(--motion-ease)]',
          )}
        >
          <S.Viewport className="p-1">
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className={cn(
                  'relative flex min-h-[var(--control-h-sm)] cursor-pointer select-none items-center gap-2 rounded-sm py-1.5 pl-7 pr-2 text-sm outline-none',
                  'data-[highlighted]:bg-surface-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
                )}
              >
                <S.ItemIndicator className="absolute left-2 inline-flex text-primary">
                  <IconCheck className="size-4" />
                </S.ItemIndicator>
                <div className="min-w-0 flex-1">
                  <S.ItemText>{o.label}</S.ItemText>
                  {o.hint && <div className="text-xs text-fg-3">{o.hint}</div>}
                </div>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  )
}

// ---------------------------------------------------------------- SegmentedControl
export interface SegmentOption<V extends string = string> {
  value: V
  label: ReactNode
  icon?: ReactNode
  disabled?: boolean
  /** 鼠标悬停提示（原生 title） */
  title?: string
}

/** 二选一 / 多选一的分段控件（不用 select 表示布尔） */
export function SegmentedControl<V extends string = string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
  'aria-label': ariaLabel,
  tone,
  fullWidth,
}: {
  value: V
  onChange: (v: V) => void
  options: SegmentOption<V>[]
  size?: 'sm' | 'md'
  className?: string
  'aria-label'?: string
  /** 让选中项用业务色（纳入/排除） */
  tone?: (v: V) => 'include' | 'exclude' | undefined
  fullWidth?: boolean
}) {
  return (
    <TG.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as V)}
      aria-label={ariaLabel}
      data-slot="segmented"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5 ring-1 ring-inset ring-border',
        fullWidth ? 'flex w-full' : 'w-fit max-w-full flex-wrap',
        className,
      )}
    >
      {options.map((o) => {
        const t = tone?.(o.value)
        return (
          <TG.Item
            key={o.value}
            value={o.value}
            disabled={o.disabled}
            title={o.title}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[calc(var(--radius-md)-2px)] font-medium text-fg-2',
              'transition-[background-color,color,box-shadow] hover:text-fg-1',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
              'disabled:pointer-events-none disabled:opacity-45',
              // 选中项加一圈 border-strong：深色模式里 surface-1 和轨道 surface-2 很接近，只靠底色看不出选中了哪个
              'data-[state=on]:bg-surface-1 data-[state=on]:text-fg-1 data-[state=on]:shadow-1 data-[state=on]:ring-1 data-[state=on]:ring-border-strong',
              t === 'include' && 'data-[state=on]:text-[color-mix(in_oklab,var(--include)_85%,var(--text-1))]',
              t === 'exclude' && 'data-[state=on]:text-[color-mix(in_oklab,var(--exclude)_85%,var(--text-1))]',
              size === 'sm' ? 'h-[calc(var(--control-h-sm)-4px)] px-2 text-xs' : 'h-[calc(var(--control-h-md)-4px)] px-3 text-sm',
              fullWidth && 'flex-1',
              '[&_svg]:size-4 [&_svg]:shrink-0',
            )}
          >
            {o.icon}
            {o.label}
          </TG.Item>
        )
      })}
    </TG.Root>
  )
}

// ---------------------------------------------------------------- Switch
export function Switch({
  checked,
  onChange,
  id,
  disabled,
  size = 'md',
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  id?: string
  disabled?: boolean
  size?: 'sm' | 'md'
  'aria-label'?: string
  'aria-describedby'?: string
}) {
  return (
    <SW.Root
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      data-slot="switch"
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full bg-surface-3 ring-1 ring-inset ring-border-strong',
        'transition-colors data-[state=checked]:bg-primary data-[state=checked]:ring-primary',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:cursor-not-allowed disabled:opacity-45',
        size === 'sm' ? 'h-4 w-7' : 'h-5 w-9',
      )}
    >
      <SW.Thumb
        className={cn(
          'block rounded-full bg-surface-1 shadow-1 transition-transform',
          size === 'sm'
            ? 'size-3 translate-x-0.5 data-[state=checked]:translate-x-3.5'
            : 'size-4 translate-x-0.5 data-[state=checked]:translate-x-[18px]',
        )}
      />
    </SW.Root>
  )
}

/** 带文字的开关行：整行可点 */
export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode
  description?: ReactNode
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start justify-between gap-4 rounded-md py-1',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span className="min-w-0">
        <span className="block text-base text-fg-1">{label}</span>
        {description && <span className="mt-0.5 block text-sm text-fg-3">{description}</span>}
      </span>
      <span className="pt-0.5">
        <Switch checked={checked} onChange={onChange} disabled={disabled} />
      </span>
    </label>
  )
}

// ---------------------------------------------------------------- Checkbox
export function Checkbox({
  checked,
  onChange,
  id,
  disabled,
  'aria-label': ariaLabel,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  id?: string
  disabled?: boolean
  'aria-label'?: string
}) {
  return (
    <CB.Root
      id={id}
      checked={checked}
      onCheckedChange={(v) => onChange(v === true)}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-[4px] border border-border-strong bg-surface-1',
        'transition-colors data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-on-primary',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-45',
      )}
    >
      <CB.Indicator>
        <IconCheck className="size-3" />
      </CB.Indicator>
    </CB.Root>
  )
}

// ---------------------------------------------------------------- Slider（单值或区间）
export function RangeSlider({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  'aria-label': ariaLabel,
  className,
}: {
  value: number[]
  onChange: (v: number[]) => void
  min: number
  max: number
  step?: number
  disabled?: boolean
  'aria-label'?: string
  className?: string
}) {
  return (
    <SL.Root
      value={value}
      onValueChange={onChange}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      minStepsBetweenThumbs={0}
      className={cn('relative flex h-5 w-full touch-none select-none items-center data-[disabled]:opacity-45', className)}
      aria-label={ariaLabel}
    >
      <SL.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-surface-3">
        <SL.Range className="absolute h-full rounded-full bg-primary" />
      </SL.Track>
      {value.map((_, i) => (
        <SL.Thumb
          key={i}
          aria-label={value.length > 1 ? (i === 0 ? '下限' : '上限') : ariaLabel}
          className={cn(
            'block size-4 rounded-full border-2 border-primary bg-surface-1 shadow-1 transition-[box-shadow]',
            'hover:ring-4 hover:ring-primary-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary-200',
          )}
        />
      ))}
    </SL.Root>
  )
}

// ---------------------------------------------------------------- Tabs
export const Tabs = TB.Root
export const TabsContent = TB.Content

export function TabsList({ items, className }: { items: { value: string; label: ReactNode; icon?: ReactNode }[]; className?: string }) {
  return (
    <TB.List className={cn('inline-flex items-center gap-1 border-b border-border', className)}>
      {items.map((it) => (
        <TB.Trigger
          key={it.value}
          value={it.value}
          className={cn(
            'relative -mb-px inline-flex h-[var(--control-h-md)] items-center gap-1.5 border-b-2 border-transparent px-3 text-sm font-medium text-fg-2',
            'transition-colors hover:text-fg-1 data-[state=active]:border-primary data-[state=active]:text-fg-1',
            'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
            '[&_svg]:size-4',
          )}
        >
          {it.icon}
          {it.label}
        </TB.Trigger>
      ))}
    </TB.List>
  )
}
