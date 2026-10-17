import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

const fieldBase = [
  'w-full min-w-0 rounded-md border bg-surface-1 text-fg-1',
  'transition-[border-color,box-shadow,background-color]',
  'hover:border-fg-3',
  'focus-visible:outline-none focus-visible:border-primary-500 focus-visible:ring-3 focus-visible:ring-primary-200',
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-3 disabled:hover:border-border-strong',
  'aria-invalid:border-danger aria-invalid:focus-visible:ring-danger-bg',
]

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: 'sm' | 'md'
  invalid?: boolean
  /** 左侧小图标 */
  leading?: ReactNode
  /** 右侧附加（单位、按钮） */
  trailing?: ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, size = 'md', invalid, leading, trailing, ...rest },
  ref,
) {
  const wrapped = !!(leading || trailing)
  const input = (
    <input
      ref={ref}
      data-slot="input"
      aria-invalid={invalid || undefined}
      className={cn(
        fieldBase,
        'border-border-strong',
        size === 'sm' ? 'h-[var(--control-h-sm)] px-2 text-sm' : 'h-[var(--control-h-md)] px-3 text-base',
        leading && 'pl-9',
        trailing && 'pr-9',
        // 有前后缀时，宽度等布局类给外层包装（见下），输入框自己铺满
        !wrapped && className,
      )}
      {...rest}
    />
  )
  if (!wrapped) return input
  return (
    <div className={cn('relative w-full min-w-0', className)}>
      {leading && (
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-fg-3 [&_svg]:size-4">
          {leading}
        </span>
      )}
      {input}
      {trailing && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-fg-3">{trailing}</span>}
    </div>
  )
})

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      aria-invalid={invalid || undefined}
      className={cn(fieldBase, 'border-border-strong px-3 py-2 text-base leading-body scroll-thin', className)}
      {...rest}
    />
  )
})

export interface FieldProps {
  label: ReactNode
  /** 字段下方的说明（灰字） */
  hint?: ReactNode
  /** 出错时的说明（红字，同时让读屏知道） */
  error?: ReactNode
  /** 标签右边的小东西（例如「不限」开关、帮助图标） */
  aside?: ReactNode
  className?: string
  children: (ids: { id: string; describedBy?: string }) => ReactNode
}

/** 表单字段：标签 + 控件 + 说明/错误。children 是函数，拿到 id 绑到控件上。 */
export function Field({ label, hint, error, aside, className, children }: FieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const describedBy = error || hint ? hintId : undefined
  return (
    <div className={cn('flex flex-col gap-1.5', className)} data-slot="field">
      <div className="flex min-h-5 items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-fg-2">
          {label}
        </label>
        {aside}
      </div>
      {children({ id, describedBy })}
      {error ? (
        <p id={hintId} className="text-xs text-danger-fg" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-fg-3">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border-strong bg-surface-2 px-1 font-mono text-[11px] leading-none text-fg-2',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

export function Separator({ className, vertical }: { className?: string; vertical?: boolean }) {
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={cn(vertical ? 'mx-1 h-5 w-px self-center bg-border' : 'my-1 h-px w-full bg-border', className)}
    />
  )
}
