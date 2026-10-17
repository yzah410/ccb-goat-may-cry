import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Slot } from 'radix-ui'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/cn'
import { IconLoader } from '@/lib/icons'

/**
 * 按钮：四态（hover / 按下 / 键盘焦点 / 禁用）+ loading。
 * 内边距遵守「左右 = 上下 × 2」：sm 4/8、md 8/16、lg 12/24（高度来自密度 token）。
 * 每页只放一个 primary，其余用 secondary / ghost。
 */
export const buttonVariants = cva(
  [
    'relative inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap',
    'rounded-md font-medium leading-none',
    'transition-[background-color,color,border-color,box-shadow,transform,opacity]',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    'active:translate-y-px',
    'disabled:pointer-events-none disabled:opacity-45',
    'aria-busy:cursor-progress',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        // hover = --primary-hover（默认：主色往黑色混 14%）；按下 = 在 hover 色上再往黑混 14%（默认值约等于主色混 26% 黑）。
        // 不用 primary-700/800：深色模式里色阶是反的，那两档是亮色，白字会看不清。主题想「悬停变亮」就改 --primary-hover。
        primary:
          'bg-primary text-on-primary shadow-1 hover:bg-primary-hover active:bg-[color-mix(in_oklab,var(--primary-hover)_86%,black)] data-[state=open]:bg-primary-hover',
        secondary:
          'border border-border-strong bg-surface-1 text-fg-1 shadow-1 hover:bg-surface-2 active:bg-surface-3 data-[state=open]:bg-surface-2',
        soft: 'bg-primary-100 text-primary-800 hover:bg-primary-200 active:bg-primary-300',
        ghost: 'text-fg-2 hover:bg-surface-2 hover:text-fg-1 active:bg-surface-3 data-[state=open]:bg-surface-2',
        danger: 'bg-danger text-on-primary shadow-1 hover:brightness-95 active:brightness-90',
        'danger-ghost': 'text-danger-fg hover:bg-danger-bg active:brightness-95',
        link: 'h-auto px-0 text-link underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-[var(--control-h-sm)] px-2 text-sm [&_svg]:size-4',
        md: 'h-[var(--control-h-md)] px-4 text-base [&_svg]:size-4',
        lg: 'h-[var(--control-h-lg)] px-6 text-lg [&_svg]:size-5',
        'icon-sm': 'size-[var(--control-h-sm)] text-sm [&_svg]:size-4',
        icon: 'size-[var(--control-h-md)] [&_svg]:size-[18px]',
        'icon-lg': 'size-[var(--control-h-lg)] [&_svg]:size-5',
      },
    },
    compoundVariants: [{ variant: 'link', className: 'h-auto px-0' }],
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** 渲染成子元素（例如 <Link>）而不是 <button> */
  asChild?: boolean
  /** 加载中：显示转圈、禁用点击、读屏报「忙」 */
  loading?: boolean
  /** 左侧图标（loading 时被转圈替换） */
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild, loading, icon, children, disabled, type, ...rest },
  ref,
) {
  const lead = loading ? <IconLoader className="animate-spin" aria-hidden /> : icon
  const common = {
    className: cn(buttonVariants({ variant, size }), className),
    'aria-busy': loading || undefined,
    'data-slot': 'button',
    'data-variant': variant ?? 'secondary',
  }
  if (asChild)
    // asChild：渲染成子元素（例如 <Link>）；图标用 Slottable 插进子元素里面（不能包在 Fragment 里，Slot 找不到）
    return (
      <Slot.Root ref={ref} {...common} {...rest}>
        {lead}
        <Slot.Slottable>{children}</Slot.Slottable>
      </Slot.Root>
    )
  return (
    <button ref={ref} type={type ?? 'button'} disabled={disabled || loading} {...common} {...rest}>
      {lead}
      {children}
    </button>
  )
})
