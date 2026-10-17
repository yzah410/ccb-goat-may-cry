import type { CSSProperties } from 'react'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/components/ui/Overlay'
import { IconPin } from '@/lib/icons'
import { WorkBadge } from './Misc'

const SCALE_MIN = 1960
const SCALE_MAX = new Date().getFullYear()
/** 两个图钉离得比这个近（百分比）就合并成一个「2007–2013」标签，免得文字叠在一起 */
const MERGE_GAP = 16

export interface AppearanceTimelineProps {
  earliest?: number | null
  latest?: number | null
  /** 代表作品（appear_best.name 或 appearances[0]） */
  bestName?: string | null
  /** 代表作品的年份（数据里有才显示） */
  bestYear?: number | null
  /** 登场作品总数 */
  count?: number | null
  /** 作品名列表（有就显示） */
  appearances?: string[] | null
  className?: string
}

/** 标签别跑出框：靠左边的左对齐、靠右边的右对齐、中间的居中 */
function labelStyle(pos: number): CSSProperties {
  const tx = pos < 8 ? '0' : pos > 92 ? '-100%' : '-50%'
  return { left: `${pos}%`, transform: `translateX(${tx})` }
}

/**
 * 登场时间线：年份轴上「图钉 + 虚线」标出最早到最晚登场（用图形代替「从…到…」）。
 * 三行：上面是年份标签，中间是轴线 + 图钉，下面是轴两端的年份。
 * 下面一行是代表作品 + 还有几部；鼠标放上去列出作品名。
 */
export function AppearanceTimeline({ earliest, latest, bestName, bestYear, count, appearances, className }: AppearanceTimelineProps) {
  const lo = earliest ?? latest ?? null
  const hi = latest ?? earliest ?? null
  const min = Math.min(SCALE_MIN, lo ?? SCALE_MIN)
  const max = Math.max(SCALE_MAX, hi ?? SCALE_MAX)
  const pos = (y: number) => ((y - min) / Math.max(1, max - min)) * 100
  const more = count != null && count > 1 ? count - 1 : appearances && appearances.length > 1 ? appearances.length - 1 : 0
  const list = (appearances ?? []).slice(0, 14)

  const pins = lo != null && hi != null ? (hi > lo ? [lo, hi] : [lo]) : []
  const merged = pins.length === 2 && pos(pins[1]!) - pos(pins[0]!) < MERGE_GAP
  const labels =
    lo == null || hi == null
      ? []
      : merged
        ? [{ text: `${lo}–${hi}`, at: (pos(lo) + pos(hi)) / 2 }]
        : pins.map((y) => ({ text: String(y), at: pos(y) }))

  return (
    <div className={cn('flex flex-col gap-2', className)} data-slot="appearance-timeline">
      {lo != null && hi != null ? (
        <div className="relative h-[46px]" aria-label={lo === hi ? `${lo} 年登场` : `${lo} 年到 ${hi} 年登场`} role="img">
          {/* 第 1 行：图钉年份 */}
          {labels.map((l) => (
            <span
              key={l.text}
              className="tabular absolute top-0 whitespace-nowrap text-xs font-medium leading-none text-fg-1"
              style={labelStyle(l.at)}
            >
              {l.text}
            </span>
          ))}
          {/* 第 2 行：轴线 + 登场跨度（虚线）+ 图钉 */}
          <div className="absolute inset-x-0 top-[29px] h-px bg-border" />
          {pins.length === 2 && (
            <div
              className="absolute top-[28px] h-0 border-t-2 border-dashed border-primary-500"
              style={{ left: `${pos(pins[0]!)}%`, width: `${pos(pins[1]!) - pos(pins[0]!)}%` }}
            />
          )}
          {pins.map((y) => (
            <IconPin
              key={y}
              aria-hidden
              className="absolute top-[14px] size-4 -translate-x-1/2 text-primary"
              style={{ left: `${pos(y)}%` }}
            />
          ))}
          {/* 第 3 行：轴两端（和图钉年份重复时不画） */}
          {min !== lo && <span className="tabular absolute bottom-0 left-0 text-[11px] leading-none text-fg-3">{min}</span>}
          {max !== hi && <span className="tabular absolute bottom-0 right-0 text-[11px] leading-none text-fg-3">{max}</span>}
        </div>
      ) : (
        <p className="text-sm text-fg-3">登场年份未知</p>
      )}
      {bestName && (
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-xs text-fg-3">代表作</span>
          {list.length > 1 ? (
            <Tooltip
              content={
                <span className="block">
                  {list.map((n) => (
                    <span key={n} className="block truncate">
                      {n}
                    </span>
                  ))}
                  {(appearances?.length ?? 0) > list.length && <span className="block">…还有 {(appearances?.length ?? 0) - list.length} 部</span>}
                </span>
              }
            >
              <span className="min-w-0" tabIndex={0}>
                <WorkBadge name={bestName} year={bestYear} extra={more > 0 ? `+${more} 部` : undefined} />
              </span>
            </Tooltip>
          ) : (
            <WorkBadge name={bestName} year={bestYear} extra={more > 0 ? `+${more} 部` : undefined} />
          )}
        </div>
      )}
    </div>
  )
}
