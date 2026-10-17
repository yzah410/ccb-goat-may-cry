/**
 * preview 只覆盖两个 slot，用来证明「主题可以换装饰，没换的自动用 base」：
 * - PageHeaderDecor：标题旁边一排主题取色小圆点
 * - CardOrnament：主角卡右上角淡淡一角强调色光晕
 */
import type { CardOrnamentProps, PageHeaderDecorProps, ThemeSlots } from '../types'

const DOTS = ['--primary', '--accent', '--include', '--exclude', '--chart-2', '--chart-3']

function PageHeaderDecor(_props: PageHeaderDecorProps) {
  return (
    <span className="flex items-center gap-1" aria-hidden title="这套主题的几个主要颜色">
      {DOTS.map((v) => (
        <span key={v} className="size-2.5 rounded-full ring-1 ring-border-strong" style={{ background: `var(${v})` }} />
      ))}
    </span>
  )
}

function CardOrnament({ variant }: CardOrnamentProps) {
  if (variant !== 'featured') return null
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-0 top-0 h-28 w-44"
      style={{ background: 'radial-gradient(120% 120% at 100% 0%, color-mix(in oklab, var(--accent) 30%, transparent) 20%, transparent 70%)' }}
    />
  )
}

const slots: ThemeSlots = { PageHeaderDecor, CardOrnament }
export default slots
