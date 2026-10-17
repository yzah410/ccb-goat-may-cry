/**
 * base 主题的 slots —— 也是所有主题的兜底实现。
 * 其他主题只需要实现自己想换的那几个，没实现的自动用这里的。
 */
import type {
  CardOrnamentProps,
  EmptyIllustrationProps,
  LoadingIndicatorProps,
  LogoProps,
  NavItemDecorProps,
  PageHeaderDecorProps,
  ThemeSlots,
} from '../types'
import { Emoji, emojiForUi } from '@/lib/emoji'
import { IconLoader } from '@/lib/icons'
import { cn } from '@/lib/cn'

function Logo({ collapsed }: LogoProps) {
  return (
    <span className="flex items-center gap-2.5">
      <span
        className="grid size-8 shrink-0 place-items-center rounded-md text-on-primary shadow-1"
        // 用 --primary 往黑色混，不用 primary-700：深色模式里色阶是反的，700 是亮色，白色图标会看不清
        style={{ background: 'linear-gradient(135deg, var(--primary), color-mix(in oklab, var(--primary) 72%, black))' }}
        aria-hidden
      >
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M9.2 9a2.9 2.9 0 1 1 4.1 2.6c-.8.4-1.3 1.1-1.3 2v.4" />
          <circle cx="12" cy="17.6" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      </span>
      {!collapsed && (
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-base font-semibold tracking-tight text-fg-1">山羊五月哭</span>
          <span className="truncate text-xs text-fg-3">猜猜呗出题器</span>
        </span>
      )}
    </span>
  )
}

function EmptyIllustration({ kind, size = 72 }: EmptyIllustrationProps) {
  return (
    <span
      className="grid place-items-center rounded-full bg-primary-50 ring-1 ring-primary-100"
      style={{ width: size + 32, height: size + 32 }}
      aria-hidden
    >
      <Emoji name={emojiForUi(kind)} size={size} />
    </span>
  )
}

function CardOrnament({ variant, tone = 'primary' }: CardOrnamentProps) {
  if (variant !== 'featured') return null
  const color =
    tone === 'include' ? 'var(--include)' : tone === 'exclude' ? 'var(--exclude)' : tone === 'neutral' ? 'var(--border-strong)' : 'var(--primary)'
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 h-[3px]"
      style={{ background: `linear-gradient(90deg, ${color}, color-mix(in oklab, ${color} 30%, transparent))` }}
    />
  )
}

function LoadingIndicator({ size = 'md', label }: LoadingIndicatorProps) {
  const px = size === 'sm' ? 'size-4' : size === 'lg' ? 'size-8' : 'size-6'
  return (
    <span className="inline-flex items-center gap-2 text-fg-2" role="status" aria-live="polite">
      <IconLoader className={cn(px, 'animate-spin text-primary')} aria-hidden />
      {label ? <span className="text-sm">{label}</span> : <span className="sr-only">加载中</span>}
    </span>
  )
}

function PageHeaderDecor(_props: PageHeaderDecorProps) {
  return null
}

function NavItemDecor({ active, shell }: NavItemDecorProps) {
  if (!active) return null
  if (shell === 'topbar')
    return <span aria-hidden className="pointer-events-none absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-primary" />
  if (shell === 'dock') return null
  return <span aria-hidden className="pointer-events-none absolute inset-y-2 left-0 w-[3px] rounded-full bg-primary" />
}

const slots: ThemeSlots = {
  Logo,
  EmptyIllustration,
  CardOrnament,
  LoadingIndicator,
  PageHeaderDecor,
  NavItemDecor,
}

export default slots
