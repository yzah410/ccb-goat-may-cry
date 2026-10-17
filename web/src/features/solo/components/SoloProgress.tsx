/**
 * 左上角「本组记忆巩固程度」进度条。
 * 纯色进度条，配色跟随主题；没有装饰性动效。
 *
 * - 条长 = total；条里两段纯色：已稳定 = --primary，巩固中 = --primary-400。同一色相、明度不同，色弱也分得清；
 *   两段之间留 1px 缝（露出轨道色）。学习中只在旁边写人数，不画长度。
 * - 轨道照滑块的轨道（Controls.tsx 的 Slider）：全圆角、--surface-3 底、没有描边。
 * - 动效只有一个：数值变化时条宽过渡 300ms。系统或设置里「减少动效」时，全局规则（styles/tailwind.css）把过渡压成 0。
 * - 悬停看四类各多少人、各是什么意思；saturated 时下面多一行小字。
 * 数怎么算见 ../progressView.ts。页面只在一处用它（pages/solo/SoloPage.tsx）。
 */
import { cn } from '@/lib/cn'
import { Tooltip } from '@/components/ui/Overlay'
import type { Progress } from '../api'
import { progressBarView, progressLegend, type ProgressKind } from '../progressView'

export interface SoloProgressProps {
  progress: Progress | null
  className?: string
}

/** 两段的颜色（悬停说明里的小色块也用它）；学习中、未出现不画长度，色块画成空心 */
const KIND_CLASS: Record<ProgressKind, string> = {
  stable: 'bg-primary',
  consolidating: 'bg-primary-400',
  learning: 'ring-bg/60',
  unseen: 'ring-bg/60',
}

const SEGMENT = 'h-full transition-[width] duration-300 ease-[var(--motion-ease)]'

export function SoloProgress({ progress, className }: SoloProgressProps) {
  if (!progress) return <div className={cn('h-5 w-40', className)} aria-hidden />
  const v = progressBarView(progress)
  const legend = progressLegend(v)
  const c = v.counts
  const valueText = `${v.totalText}；已稳定 ${c.stable} 人，巩固中 ${c.consolidating} 人，学习中 ${c.learning} 人，未出现 ${c.unseen} 人`

  const tip = (
    <div className="flex flex-col gap-1">
      <p className="font-medium">
        本组记忆巩固 {v.totalText}
        {v.delta && `（${v.delta}）`}
      </p>
      <ul className="flex flex-col gap-0.5">
        {legend.map((l) => (
          <li key={l.kind} className="flex items-baseline gap-1.5">
            <span className={cn('inline-block size-2 shrink-0 rounded-sm ring-1 ring-inset ring-bg/30', KIND_CLASS[l.kind])} aria-hidden />
            <span>{l.text}</span>
          </li>
        ))}
      </ul>
      <p>条的长度 = 全组每人巩固度的平均：已稳定算满，巩固中按隔过的最长局数算一部分。</p>
    </div>
  )

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)} data-slot="solo-progress">
      <Tooltip content={tip}>
        <div className="flex cursor-help flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
          <div
            role="progressbar"
            aria-label="本组记忆巩固程度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={v.total}
            aria-valuetext={valueText}
            className="flex h-2 w-40 shrink-0 gap-px overflow-hidden rounded-full bg-surface-3"
          >
            <span className={cn(SEGMENT, KIND_CLASS.stable, v.stable > 0 && 'min-w-0.5')} style={{ width: `${v.stable}%` }} data-part="stable" />
            <span className={cn(SEGMENT, KIND_CLASS.consolidating, v.consolidating > 0 && 'min-w-0.5')} style={{ width: `${v.consolidating}%` }} data-part="consolidating" />
          </div>
          <span className="tabular text-sm text-fg-2">{v.totalText}</span>
          {v.delta && <span className="tabular">{v.delta}</span>}
          {c.learning > 0 && <span className="tabular">{`学习中 ${c.learning}`}</span>}
        </div>
      </Tooltip>
      {v.saturated && <p className="text-xs text-fg-3">本组暂时练到饱和，可以休息或换组</p>}
    </div>
  )
}
