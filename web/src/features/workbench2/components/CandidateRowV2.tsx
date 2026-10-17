/**
 * 候选池「列表」视图的折叠行：名字 / 评分 / 年份 / 代表作 + 设为当前 + 展开，数据来自出题器接口。
 * 展开 = 换成完整的角色卡片（CharacterCardV2，带「收起」）。
 */
import { cn } from '@/lib/cn'
import { fmtScore, fmtYearSpan } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { GenderBadge } from '@/components/data-display/Misc'
import { IconChevronDown, IconStar, IconTarget } from '@/lib/icons'
import type { CandidateV2 } from '@/features/v2/types'
import { cardNumbers, representativeWork } from '../card'

export function CandidateRowV2({
  item,
  rank,
  isCurrent,
  onSetCurrent,
  onExpand,
}: {
  item: CandidateV2
  rank: number
  isCurrent: boolean
  onSetCurrent: () => void
  onExpand: () => void
}) {
  const c = item.character
  const n = cardNumbers(item)
  const w = representativeWork(item)
  const appear = w.name ? (w.more > 0 ? `${w.name} +${w.more} 部` : w.name) : '—'
  return (
    <div
      data-slot="candidate-row"
      data-char-id={c.id}
      data-current={isCurrent || undefined}
      className={cn(
        'grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border px-3 py-2 shadow-1 transition-colors',
        isCurrent ? 'border-primary-400 bg-selected' : 'border-border bg-surface-1 hover:border-border-strong',
      )}
    >
      <span className="tabular text-right text-xs text-fg-3">#{rank}</span>
      <button type="button" onClick={onExpand} className="flex min-w-0 items-center gap-3 text-left" aria-label={`展开 ${c.name}`}>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-fg-1">{c.name}</span>
          <GenderBadge gender={c.gender} className="size-5" />
          {isCurrent && (
            <Badge tone="accent" size="sm">
              <IconStar />
              当前
            </Badge>
          )}
        </span>
        <span className="hidden shrink-0 items-center gap-3 text-sm text-fg-2 @2xl/main:flex">
          <span className="tabular">评分 {n.rating != null ? fmtScore(n.rating) : '—'}</span>
          <span className="tabular">{fmtYearSpan(n.earliest, n.latest)}</span>
        </span>
        <span className="hidden min-w-0 truncate text-sm text-fg-3 @4xl/main:block" title={appear}>
          {appear}
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-1">
        {!isCurrent && (
          <Button size="sm" variant="ghost" icon={<IconTarget />} onClick={onSetCurrent}>
            设为当前
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<IconChevronDown />} onClick={onExpand} aria-label="展开">
          展开
        </Button>
      </span>
    </div>
  )
}
