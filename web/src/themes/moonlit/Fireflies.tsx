import type { CSSProperties } from 'react'

/**
 * 萤火：一组会慢慢飘、慢慢闪的小光点。
 * - 位置由 seed（例如路由 id）确定性生成：同一页每次都一样，换一页换一种排布
 * - 六成落在「边缘」（左右 8% 以内、或顶部 22% 以内），四成随机——主要在内容外侧发光，不在正文底下闪
 * - 动画是纯 CSS（keyframes 在 extras.css），「减少动效」时全局规则会把它停掉，停下时仍保留一个中等亮度
 * - still = true：不动（分屏对比、画廊缩略图）
 */
export function Fireflies({
  seed,
  count,
  still,
  area = 'page',
}: {
  seed: string
  count: number
  still?: boolean
  /** page = 整屏（背景层）；ring = 围着一个圆（空态插画） */
  area?: 'page' | 'ring'
}) {
  const flies = makeFlies(seed, count, area)
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {flies.map((f, i) => (
        <span
          key={i}
          className="moonlit-firefly"
          data-still={still || undefined}
          style={
            {
              left: `${f.x}%`,
              top: `${f.y}%`,
              width: f.size,
              height: f.size,
              '--mf-dx': `${f.dx}px`,
              '--mf-dy': `${f.dy}px`,
              '--mf-lo': f.lo,
              '--mf-hi': f.hi,
              animationDuration: `${f.drift}s, ${f.blink}s`,
              animationDelay: `${-f.phase}s, ${-f.phase * 0.7}s`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  )
}

interface Fly {
  x: number
  y: number
  size: number
  dx: number
  dy: number
  lo: number
  hi: number
  drift: number
  blink: number
  phase: number
}

function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32：小而稳定的伪随机数 */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeFlies(seed: string, count: number, area: 'page' | 'ring'): Fly[] {
  const r = rng(hash(`${seed}|${count}|${area}`))
  const out: Fly[] = []
  for (let i = 0; i < count; i++) {
    let x: number
    let y: number
    if (area === 'ring') {
      // 围着圆的外沿（半径 44%–54%），角度均匀撒开再抖一点
      const ang = (i / count) * Math.PI * 2 + r() * 0.9
      const rad = 44 + r() * 10
      x = 50 + Math.cos(ang) * rad
      y = 50 + Math.sin(ang) * rad
    } else if (r() < 0.6) {
      // 边缘：左右两条 或 顶部一条
      const band = r()
      if (band < 0.34) {
        x = r() * 7
        y = 8 + r() * 88
      } else if (band < 0.68) {
        x = 93 + r() * 6.5
        y = 8 + r() * 88
      } else {
        x = 4 + r() * 92
        y = 2 + r() * 20
      }
    } else {
      x = 3 + r() * 94
      y = 6 + r() * 90
    }
    out.push({
      x: +x.toFixed(2),
      y: +y.toFixed(2),
      size: area === 'ring' ? 3 + Math.round(r() * 2) : 2 + Math.round(r() * 2.4),
      dx: Math.round((r() - 0.5) * 36),
      dy: Math.round(-8 - r() * 22),
      lo: +(0.12 + r() * 0.18).toFixed(2),
      hi: +(0.62 + r() * 0.36).toFixed(2),
      drift: +(9 + r() * 9).toFixed(1),
      blink: +(2.8 + r() * 4.2).toFixed(1),
      phase: +(r() * 12).toFixed(1),
    })
  }
  return out
}
