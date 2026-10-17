import type { CSSProperties } from 'react'
import { cn } from '@/lib/cn'

export interface VeilProps {
  /**
   * 渐变方向（CSS linear-gradient 的角度或关键字），例如 'to right'、'180deg'。
   * 起点那一端「保留画面」，终点那一端过渡到 color。
   */
  direction?: string
  /** 过渡目标色，默认 var(--bg)（可读背景） */
  color?: string
  /** 从哪里开始变不透明（0–100，百分比） */
  from?: number
  /** 到哪里完全不透明（0–100） */
  to?: number
  /** 起点端的最低不透明度（0–1），默认 0 = 完全透出画面 */
  minOpacity?: number
  /** 渐进式模糊：终点端的模糊半径（px）；0 = 不模糊 */
  blur?: number
  className?: string
  style?: CSSProperties
}

/**
 * 壁纸遮罩：线性渐变（一端保留画面，一端过渡到可读背景）+ 可选渐进式模糊。
 * 壁纸上放文字不要整块遮罩，用这个。
 *
 * 例：<Veil direction="to right" from={20} to={65} blur={12} />
 *     → 左边 20% 以内完全透出壁纸，到 65% 处变成纯背景色，模糊也同步从 0 加到 12px。
 */
export function Veil({
  direction = 'to right',
  color = 'var(--bg)',
  from = 25,
  to = 70,
  minOpacity = 0,
  blur = 0,
  className,
  style,
}: VeilProps) {
  const start = `color-mix(in oklab, ${color} ${Math.round(minOpacity * 100)}%, transparent)`
  const gradient = `linear-gradient(${direction}, ${start} ${from}%, ${color} ${to}%)`
  const mask = `linear-gradient(${direction}, transparent ${from}%, black ${to}%)`
  return (
    <div className={cn('absolute inset-0', className)} style={style} aria-hidden>
      {blur > 0 && (
        <div
          className="absolute inset-0"
          style={{
            backdropFilter: `blur(${blur}px)`,
            WebkitBackdropFilter: `blur(${blur}px)`,
            maskImage: mask,
            WebkitMaskImage: mask,
          }}
        />
      )}
      <div className="absolute inset-0" style={{ background: gradient }} />
    </div>
  )
}
