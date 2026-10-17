/**
 * 月夜·萤火的 5 个装饰位。原则：只画「光」——月亮、萤火、暖红的一点，不画会挡字的东西。
 */
import { useId, type ReactElement } from 'react'
import type {
  CardOrnamentProps,
  EmptyIllustrationProps,
  EmptyKind,
  LoadingIndicatorProps,
  LogoProps,
  NavItemDecorProps,
  ThemeSlots,
} from '../types'
// 直接引入本主题的萤火组件
import { Fireflies } from './Fireflies'
// 空态插画：夜里的东西（unplugin-icons 静态引入，离线可用，不受 emoji-names 子集限制）
import EmojiCrescent from '~icons/fluent-emoji-flat/crescent-moon'
import EmojiGlowingStar from '~icons/fluent-emoji-flat/glowing-star'
import EmojiScroll from '~icons/fluent-emoji-flat/scroll'
import EmojiZzz from '~icons/fluent-emoji-flat/zzz'
import EmojiShootingStar from '~icons/fluent-emoji-flat/shooting-star'
import EmojiScarf from '~icons/fluent-emoji-flat/scarf'
import EmojiTelescope from '~icons/fluent-emoji-flat/telescope'
import EmojiStorm from '~icons/fluent-emoji-flat/cloud-with-lightning'
import EmojiNewMoon from '~icons/fluent-emoji-flat/new-moon'
import EmojiFullMoon from '~icons/fluent-emoji-flat/full-moon'
import EmojiWaxing from '~icons/fluent-emoji-flat/waxing-crescent-moon'
import EmojiMoonViewing from '~icons/fluent-emoji-flat/moon-viewing-ceremony'
import EmojiMilkyWay from '~icons/fluent-emoji-flat/milky-way'
import EmojiBarChart from '~icons/fluent-emoji-flat/bar-chart'
import EmojiPhone from '~icons/fluent-emoji-flat/mobile-phone'
import EmojiSparkles from '~icons/fluent-emoji-flat/sparkles'
import EmojiOwl from '~icons/fluent-emoji-flat/owl'

const GOLD = '#ecc86c'
const GOLD_LIGHT = '#f9e7a8'
const FIREFLY = '#fff3b8'

/** SVG 里的 id 在同一页会重复出现（顶栏 + 画廊卡片 + 分屏对比），用 useId 保证唯一，并去掉不适合放进 url() 的字符 */
function useSvgId(prefix: string): string {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
}

// ---------------------------------------------------------------- Logo：靛蓝圆里一弯金月 + 一只萤火
function MoonMark({ size = 32 }: { size?: number }) {
  const bg = useSvgId('mlbg')
  const gold = useSvgId('mlgold')
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden className="shrink-0">
      <defs>
        <radialGradient id={bg} cx="34%" cy="28%" r="85%">
          <stop offset="0" stopColor="#2f3160" />
          <stop offset="1" stopColor="#11132a" />
        </radialGradient>
        <linearGradient id={gold} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={GOLD_LIGHT} />
          <stop offset="1" stopColor="#e2b453" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="15.5" fill={`url(#${bg})`} stroke="rgb(245 217 138 / 0.38)" />
      <path d="M13.36 7.85A8.8 8.8 0 1 0 23.45 18.97A7.6 7.6 0 0 1 13.36 7.85Z" fill={`url(#${gold})`} />
      <circle cx="24.2" cy="22.6" r="3.4" fill="rgb(255 236 160 / 0.2)" />
      <circle cx="24.2" cy="22.6" r="1.35" fill={FIREFLY} />
      <circle cx="9.2" cy="8.6" r="0.75" fill="#f3ecdd" opacity="0.75" />
      <circle cx="22.4" cy="7.2" r="0.55" fill="#f3ecdd" opacity="0.55" />
    </svg>
  )
}

function Logo({ collapsed }: LogoProps) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-full" style={{ boxShadow: '0 0 18px -4px rgb(236 200 108 / 0.45)' }}>
        <MoonMark />
      </span>
      {!collapsed && (
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-lg font-semibold text-fg-1" style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.02em' }}>
            山羊五月哭
          </span>
          <span className="truncate text-xs text-fg-3" style={{ letterSpacing: '0.14em' }}>
            猜猜呗出题器 · 月夜
          </span>
        </span>
      )}
    </span>
  )
}

// ---------------------------------------------------------------- 空态：一扇夜空小圆窗 + 夜里的东西 + 围着飞的萤火
function nightArt(kind: EmptyKind, s: number): ReactElement {
  const p = { width: s, height: s }
  switch (kind) {
    case 'no-candidates':
      return <EmojiCrescent {...p} /> // 今晚这里没有人
    case 'no-blocks':
      return <EmojiGlowingStar {...p} /> // 先点亮第一颗星（加第一个组块）
    case 'no-plans':
      return <EmojiScroll {...p} /> // 还没有存下来的信笺
    case 'no-logs':
      return <EmojiZzz {...p} /> // 一切安静
    case 'no-result':
      return <EmojiShootingStar {...p} /> // 对着流星抽一题
    case 'no-pick':
      return <EmojiScarf {...p} /> // 围巾还没系上（没有当前题目）
    case 'search-empty':
      return <EmojiTelescope {...p} /> // 望远镜里没找到
    case 'error':
      return <EmojiStorm {...p} /> // 起风暴了
    case 'offline':
      return <EmojiNewMoon {...p} /> // 新月：没有光（连不上）
    case 'success':
      return <EmojiFullMoon {...p} /> // 满月：完成
    case 'loading':
      return <EmojiWaxing {...p} /> // 月亮在变圆
    case 'themes':
      return <EmojiMoonViewing {...p} /> // 赏月
    case 'canvas':
      return <EmojiMilkyWay {...p} /> // 星图 = 导图
    case 'data':
      return <EmojiBarChart {...p} />
    case 'clicker':
      return <EmojiPhone {...p} /> // 自动点击：把题目发到网页版猜猜呗
    case 'not-found':
      return <EmojiOwl {...p} /> // 夜里守路的猫头鹰
    default:
      return <EmojiSparkles {...p} />
  }
}

function EmptyIllustration({ kind, size = 72 }: EmptyIllustrationProps) {
  const box = size + 32
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: box, height: box }} aria-hidden>
      <span
        className="absolute inset-0 rounded-full"
        style={{
          background: [
            'radial-gradient(circle at 30% 24%, rgb(242 213 133 / 0.2), transparent 48%)',
            'radial-gradient(circle at 50% 60%, var(--surface-2), var(--surface-1) 72%)',
          ].join(', '),
          boxShadow: 'inset 0 1px 0 rgb(255 244 214 / 0.08), 0 0 0 1px var(--border), 0 0 44px -10px rgb(236 200 108 / 0.28)',
        }}
      />
      <Fireflies seed={`empty-${kind}`} count={5} area="ring" />
      <span className="relative" style={{ filter: 'drop-shadow(0 4px 14px rgb(236 200 108 / 0.22))' }}>
        {nightArt(kind, size)}
      </span>
    </span>
  )
}

// ---------------------------------------------------------------- 主角卡：右上角一圈月晕 + 顶沿一道被照亮的细线
function CardOrnament({ variant, tone = 'primary' }: CardOrnamentProps) {
  if (variant !== 'featured') return null
  const c =
    tone === 'include' ? 'var(--include)' : tone === 'exclude' ? 'var(--exclude)' : tone === 'neutral' ? 'var(--text-3)' : 'var(--primary)'
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden" style={{ borderRadius: 'inherit' }}>
      {/* 月晕的圆心在卡片右上角外面，卡片里只落到它最淡的外圈 → 不压字 */}
      <span
        className="absolute rounded-full"
        style={{
          right: -84,
          top: -96,
          width: 240,
          height: 240,
          background: `radial-gradient(circle, color-mix(in oklab, ${c} 26%, transparent) 0%, color-mix(in oklab, ${c} 9%, transparent) 44%, transparent 70%)`,
        }}
      />
      <span
        className="absolute inset-x-0 top-0 h-px"
        style={{ background: `linear-gradient(90deg, transparent 4%, color-mix(in oklab, ${c} 55%, transparent) 50%, ${c} 86%, transparent 100%)` }}
      />
      <span className="absolute right-0 top-0 h-24 w-40">
        <Fireflies seed={`card-${tone}`} count={3} area="page" />
      </span>
    </span>
  )
}

// ---------------------------------------------------------------- 加载：一弯金月，一只萤火绕着它转
function LoadingIndicator({ size = 'md', label }: LoadingIndicatorProps) {
  const px = size === 'sm' ? 16 : size === 'lg' ? 32 : 24
  const dot = Math.max(3, Math.round(px * 0.2))
  return (
    <span className="inline-flex items-center gap-2 text-fg-2" role="status" aria-live="polite">
      <span className="relative inline-block shrink-0" style={{ width: px, height: px }} aria-hidden>
        <svg viewBox="0 0 24 24" className="absolute inset-0 size-full">
          <path d="M9.36 4.06A8.6 8.6 0 1 0 19.3 14.76A7.4 7.4 0 0 1 9.36 4.06Z" fill={GOLD} />
        </svg>
        <span className="absolute inset-0 animate-spin" style={{ animationDuration: '1.6s' }}>
          <span
            className="absolute left-1/2 top-0 rounded-full"
            style={{ width: dot, height: dot, marginLeft: -dot / 2, background: FIREFLY, boxShadow: '0 0 6px 2px rgb(255 226 140 / 0.7)' }}
          />
        </span>
      </span>
      {label ? <span className="text-sm">{label}</span> : <span className="sr-only">加载中</span>}
    </span>
  )
}

// ---------------------------------------------------------------- 导航选中：一道被月光照亮的线（顶栏在下沿、侧栏在左沿），胶囊里是一圈月晕
function NavItemDecor({ active, shell }: NavItemDecorProps) {
  if (!active) return null
  const glow = '0 0 10px 1px rgb(242 213 133 / 0.55)'
  if (shell === 'topbar')
    return (
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-2 -bottom-px h-[2px] rounded-full"
        style={{ background: `linear-gradient(90deg, transparent, ${GOLD} 28%, ${GOLD} 72%, transparent)`, boxShadow: glow }}
      />
    )
  if (shell === 'dock')
    return (
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{ boxShadow: '0 0 0 3px rgb(242 213 133 / 0.16), 0 0 22px 2px rgb(242 213 133 / 0.42)' }}
      />
    )
  return (
    <span aria-hidden className="pointer-events-none absolute inset-y-2 left-0 w-[3px] rounded-full" style={{ background: GOLD, boxShadow: glow }} />
  )
}

const slots: ThemeSlots = {
  Logo,
  EmptyIllustration,
  CardOrnament,
  LoadingIndicator,
  NavItemDecor,
}

export default slots
