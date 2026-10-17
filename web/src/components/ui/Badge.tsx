import type { HTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/cn'

/**
 * 徽标：小块状态/分类信息。颜色一律用 token；
 * 业务色（纳入/排除）请配合 ＋/－ 图标和文字，不要只靠颜色。
 */
export const badgeVariants = cva(
  'inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-sm font-medium leading-none [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'bg-surface-2 text-fg-2 ring-1 ring-inset ring-border',
        primary: 'bg-primary-100 text-primary-800',
        success: 'bg-success-bg text-success-fg',
        warning: 'bg-warning-bg text-warning-fg',
        danger: 'bg-danger-bg text-danger-fg',
        info: 'bg-info-bg text-info-fg',
        include:
          'bg-[color-mix(in_oklab,var(--include)_14%,transparent)] text-[color-mix(in_oklab,var(--include)_78%,var(--text-1))]',
        exclude:
          'bg-[color-mix(in_oklab,var(--exclude)_14%,transparent)] text-[color-mix(in_oklab,var(--exclude)_78%,var(--text-1))]',
        accent: 'bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] text-[color-mix(in_oklab,var(--accent)_75%,var(--text-1))]',
        outline: 'text-fg-2 ring-1 ring-inset ring-border-strong',
      },
      size: {
        sm: 'h-5 px-1.5 text-xs',
        md: 'h-6 px-2 text-xs',
      },
    },
    defaultVariants: { tone: 'neutral', size: 'md' },
  },
)

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, size, ...rest }: BadgeProps) {
  // data-tone：主题的 extras.css 可以按语气挑徽标（例：[data-slot="badge"][data-tone="accent"] = 「当前题目」星标）
  return <span data-slot="badge" data-tone={tone ?? 'neutral'} className={cn(badgeVariants({ tone, size }), className)} {...rest} />
}
