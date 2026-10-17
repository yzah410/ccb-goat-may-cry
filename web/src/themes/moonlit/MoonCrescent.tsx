/**
 * 主题页 / 404 没有壁纸时的背景：一片有大有小、有明有暗的星空，加一弯很小的月牙，带地照和柔光，
 * 两三缕薄云从它前面横过。只用 CSS 渐变和内联 SVG，不用图片。
 *
 * - 月牙的位置写在 extras.css 的 .moonlit-crescent-spot：按外壳宽度换地方，避开页头文字、按钮和卡片网格
 * - 尺寸跟着月牙直径 --d 走（也在那条规则里，按外壳宽度定）
 * - compact（分屏对比格子）：不加动画类名、不用模糊和 SVG 滤镜
 * - 动画只动 transform / opacity；「减少动效」时由全局规则停掉，停下时就是元素本来的样子（静态构图本身是完整的）
 */
import { useId, type CSSProperties } from 'react'

// ---------------------------------------------------------------- 小工具

/** mulberry32：小而稳定的伪随机数（星星位置每次都一样） */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function smoothstep(e0: number, e1: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** SVG 的 id 在同一页可能出现多份（分屏对比），用 useId 保证唯一 */
function useSvgId(prefix: string): string {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
}

const r2 = (v: number) => Math.round(v * 100) / 100

// ---------------------------------------------------------------- 星空

interface Star {
  x: number
  y: number
  r: number
  a: number
  c: string
  glow: boolean
  /** 会闪的星：[时长 s, 延迟 s, 最暗系数] */
  tw?: [number, number, number]
}

interface StarOpts {
  seed: number
  count: number
  /** 光源（百分比坐标）：离它越近星越暗（被月光洗掉），r = 影响半径（横向百分比） */
  light: { x: number; y: number; r: number }
  /** 挑几颗亮星慢慢闪 */
  twinkle: number
}

// 大多是月光下的暖白，少数冷白，个别带一点金和粉
const STAR_COLORS = ['#f6efdf', '#f6efdf', '#f6efdf', '#f6efdf', '#e1e6ff', '#e1e6ff', '#f2dca6', '#f1d6d0']

function makeStars(o: StarOpts): Star[] {
  const r = rng(o.seed)
  const fade = (x: number, y: number) => 0.04 + 0.96 * smoothstep(0.3, 1, Math.hypot(x - o.light.x, (y - o.light.y) * 0.6) / o.light.r)
  const out: Star[] = []
  for (let i = 0; i < o.count; i++) {
    const x = r() * 100
    const y = Math.pow(r(), 1.3) * 100 // 上面多、下面少
    const big = r()
    const rad = 0.35 + Math.pow(big, 3.4) * 1.2
    const a = (0.2 + Math.pow(big, 1.5) * 0.62 + r() * 0.14) * fade(x, y) * (1 - 0.45 * (y / 100))
    out.push({ x: r2(x), y: r2(y), r: r2(rad), a: r2(a), c: STAR_COLORS[Math.floor(r() * STAR_COLORS.length)], glow: rad > 1.0 })
  }
  const bright = out
    .map((s, i) => [s.a * s.r, i] as const)
    .sort((p, q) => q[0] - p[0])
    .slice(0, o.twinkle)
  for (const [, i] of bright) out[i].tw = [r2(3.2 + r() * 4.5), r2(-r() * 6), r2(0.35 + r() * 0.25)]
  return out
}

function StarField({ stars, still }: { stars: Star[]; still?: boolean }) {
  const glow = useSvgId('msg')
  return (
    <svg className="absolute inset-0 h-full w-full" aria-hidden>
      <defs>
        <radialGradient id={glow}>
          <stop offset="0" stopColor="#fff4d8" stopOpacity="0.55" />
          <stop offset="0.4" stopColor="#fff4d8" stopOpacity="0.14" />
          <stop offset="1" stopColor="#fff4d8" stopOpacity="0" />
        </radialGradient>
      </defs>
      {stars.map((s, i) => {
        const tw = s.tw && !still
        return (
          <g key={i}>
            {s.glow && <circle cx={`${s.x}%`} cy={`${s.y}%`} r={s.r * 5} fill={`url(#${glow})`} opacity={s.a} />}
            <circle
              cx={`${s.x}%`}
              cy={`${s.y}%`}
              r={s.r}
              fill={s.c}
              opacity={s.a}
              className={tw ? 'moonlit-twinkle' : undefined}
              style={
                tw && s.tw
                  ? ({ '--tw-dur': `${s.tw[0]}s`, '--tw-delay': `${s.tw[1]}s`, '--tw-lo': r2(s.a * s.tw[2]), '--tw-hi': s.a } as CSSProperties)
                  : undefined
              }
            />
          </g>
        )
      })}
    </svg>
  )
}

// 月牙附近的星被月光洗淡
const STARS = makeStars({ seed: 0xc3c3, count: 80, light: { x: 74, y: 10, r: 22 }, twinkle: 6 })

// ---------------------------------------------------------------- 月牙

/** 一弯月牙（亮面朝左下，两个尖朝右上，和 Logo 同一个朝向）+ 地照 + 柔光 */
function Crescent({ compact }: { compact?: boolean }) {
  const id = useSvgId('mc')
  return (
    <>
      {/* 柔光：贴近的一小圈 + 很大很淡的一圈；圆心偏向亮面那一侧 */}
      <span
        className="absolute rounded-full"
        style={{
          left: '50%',
          top: '50%',
          width: 'calc(var(--d) * 9)',
          height: 'calc(var(--d) * 9)',
          transform: 'translate(-53%, -47%)',
          background:
            'radial-gradient(circle, rgb(246 222 160 / 0.2) 0%, rgb(246 222 160 / 0.085) 14%, rgb(242 213 133 / 0.03) 34%, transparent 66%)',
        }}
      />
      <svg viewBox="-50 -50 100 100" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
        <defs>
          <radialGradient id={`${id}g`} gradientUnits="userSpaceOnUse" cx="-26" cy="22" r="70">
            <stop offset="0" stopColor="#fffaea" />
            <stop offset="0.45" stopColor="#f8e6ae" />
            <stop offset="1" stopColor="#e6c16c" />
          </radialGradient>
          {!compact && (
            <filter id={`${id}b`} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="1.6" />
            </filter>
          )}
          <mask id={`${id}m`} maskUnits="userSpaceOnUse" x="-60" y="-60" width="120" height="120">
            <rect x="-60" y="-60" width="120" height="120" fill="#fff" />
            {/* 阴影圆：往右上偏 → 只剩左下一道细弧；边缘模糊一点 = 柔和的明暗交界线 */}
            <circle cx="12" cy="-10" r="45.5" fill="#000" filter={compact ? undefined : `url(#${id}b)`} />
          </mask>
        </defs>
        {/* 地照：暗面也隐约看得见 */}
        <circle r="46" fill="rgb(150 160 220 / 0.09)" />
        <circle r="46" fill={`url(#${id}g)`} mask={`url(#${id}m)`} />
        {/* 亮弧外沿一点光 */}
        <circle r="46" fill="none" stroke="rgb(255 240 200 / 0.18)" strokeWidth="3" mask={`url(#${id}m)`} />
      </svg>
    </>
  )
}

// ---------------------------------------------------------------- 薄云

/**
 * 两缕横着的云（一缕从月牙下半部前面横过，被月光照到的那段带一点暖色），一缕更淡更高的。
 * 坐标：viewBox 0 0 700 200（以月牙直径 50 为准），月牙中心在 (450, 80)；整块跟着 --d 缩放。
 * 正常尺寸用 feTurbulence 做出一丝一丝的云；compact 不用滤镜，只剩几块软椭圆。
 */
const WISPS: { cx: number; cy: number; rx: number; ry: number; a: number }[] = [
  { cx: 410, cy: 98, rx: 270, ry: 17, a: 1 },
  { cx: 540, cy: 142, rx: 200, ry: 11, a: 0.7 },
  { cx: 250, cy: 46, rx: 160, ry: 7, a: 0.5 },
]

function Clouds({ compact }: { compact?: boolean }) {
  const id = useSvgId('mcl')
  return (
    <svg
      viewBox="0 0 700 200"
      className="absolute"
      style={{ left: 'calc(var(--d) * -8.5)', top: 'calc(var(--d) * -1.1)', width: 'calc(var(--d) * 14)', height: 'calc(var(--d) * 4)' }}
      aria-hidden
    >
      <defs>
        {WISPS.map((w, i) => (
          <radialGradient
            key={i}
            id={`${id}w${i}`}
            gradientUnits="userSpaceOnUse"
            cx={w.cx}
            cy={w.cy}
            r={w.rx}
            gradientTransform={`translate(${w.cx} ${w.cy}) scale(1 ${r2(w.ry / w.rx)}) translate(${-w.cx} ${-w.cy})`}
          >
            <stop offset="0" stopColor="#fff" stopOpacity={w.a} />
            <stop offset="0.5" stopColor="#fff" stopOpacity={w.a * 0.55} />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        ))}
        {/* 月光照到的范围（云在这里偏暖、更亮） */}
        <radialGradient id={`${id}lit`} gradientUnits="userSpaceOnUse" cx="440" cy="88" r="150">
          <stop offset="0" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id={`${id}m`} maskUnits="userSpaceOnUse" x="0" y="0" width="700" height="200">
          {WISPS.map((_w, i) => (
            <rect key={i} width="700" height="200" fill={`url(#${id}w${i})`} />
          ))}
        </mask>
        <mask id={`${id}ml`} maskUnits="userSpaceOnUse" x="0" y="0" width="700" height="200">
          <rect width="700" height="200" fill={`url(#${id}lit)`} />
        </mask>
        {!compact && (
          <>
            {/* 横向拉长的噪声 = 一丝一丝的云 */}
            <filter id={`${id}f`} filterUnits="userSpaceOnUse" x="0" y="0" width="700" height="200" colorInterpolationFilters="sRGB">
              <feTurbulence type="fractalNoise" baseFrequency="0.0065 0.06" numOctaves="4" seed="5" />
              <feColorMatrix type="matrix" values="0 0 0 0 0.74  0 0 0 0 0.75  0 0 0 0 0.88  2.2 0 0 0 -0.78" />
            </filter>
            <filter id={`${id}fw`} filterUnits="userSpaceOnUse" x="0" y="0" width="700" height="200" colorInterpolationFilters="sRGB">
              <feTurbulence type="fractalNoise" baseFrequency="0.0065 0.06" numOctaves="4" seed="5" />
              <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 0.9  0 0 0 0 0.66  2.2 0 0 0 -0.78" />
            </filter>
          </>
        )}
      </defs>
      <g mask={`url(#${id}m)`}>
        {compact ? (
          <rect width="700" height="200" fill="rgb(176 180 222)" opacity="0.1" />
        ) : (
          <>
            <rect width="700" height="200" filter={`url(#${id}f)`} opacity="0.2" />
            <g mask={`url(#${id}ml)`}>
              <rect width="700" height="200" filter={`url(#${id}fw)`} opacity="0.3" />
            </g>
          </>
        )}
      </g>
    </svg>
  )
}

// ---------------------------------------------------------------- 整体

interface MoonCrescentProps {
  /** true = 主题页；false = 404 */
  gallery: boolean
  compact?: boolean
}

export function MoonCrescent({ gallery, compact }: MoonCrescentProps) {
  return (
    <div className="absolute inset-0" aria-hidden>
      <StarField stars={STARS} still={compact} />
      {/* 右上角只留一点很淡的天光（月牙才是光源） */}
      <div
        className="absolute inset-0"
        style={{ background: 'radial-gradient(40cqw 30cqw at 96% -6%, rgb(242 213 133 / 0.06), transparent 70%)' }}
      />
      <div className="moonlit-crescent-spot" data-gallery={gallery || undefined}>
        <Crescent compact={compact} />
        <div className={compact ? 'absolute inset-0' : 'moonlit-drift absolute inset-0'} style={{ '--dx': '16px', '--drift-dur': '58s' } as CSSProperties}>
          <Clouds compact={compact} />
        </div>
      </div>
    </div>
  )
}
