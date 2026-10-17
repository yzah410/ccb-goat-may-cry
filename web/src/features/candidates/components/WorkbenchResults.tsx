/**
 * 经典工作台右栏：操作按钮 + 预览人数 + 抽题结果。
 * - 「随机抽一题」是这一页唯一的 primary（调 /draw）
 * - 「预览人数」：给总数，并展示后端返回的几个样本名字
 * - 「列出候选」：取按时间排序的第 1 页，跳到经典候选池页
 */
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { StatTile } from '@/components/data-display/StatTile'
import { CharacterCard } from '@/components/data-display/CharacterCard'
import { EmptyState } from '@/components/data-display/Misc'
import { IconArrowRight, IconDice, IconRefresh, IconUsers } from '@/lib/icons'
import { fmtInt, relativeTime } from '@/lib/format'
import { useShellNav } from '@/app/shell/nav'
import { useDraft } from '@/features/blocks/store'
import { useSendToGuessr } from '@/features/clicker/hooks'
import { useConfigPayload, useDrawAction, usePreviewAction, useSetPick } from '../hooks'
import { useCandidateView, usePick, useResults } from '../store'
import { isResolved } from '../types'

export function WorkbenchActions() {
  const preview = usePreviewAction()
  const draw = useDrawAction()
  const nav = useShellNav()
  return (
    <Card className="p-4">
      <div className="flex flex-col gap-2">
        <Button variant="primary" size="lg" icon={<IconDice />} loading={draw.isPending} onClick={draw.run}>
          随机抽一题
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" icon={<IconUsers />} loading={preview.isPending} onClick={preview.run}>
            预览人数
          </Button>
          <Button variant="secondary" icon={<IconArrowRight />} onClick={() => nav.go('candidates')}>
            列出候选
          </Button>
        </div>
      </div>
    </Card>
  )
}

export function PreviewPanel() {
  const pv = useResults((s) => s.preview)
  const { fp } = useConfigPayload()
  const preview = usePreviewAction()
  const stale = !!pv && pv.fp !== fp
  const sample = pv?.data.sample ?? []
  const total = pv?.data.total_candidates ?? 0

  return (
    <div className="flex flex-col gap-2">
      <StatTile
        icon={<IconUsers />}
        label="候选人数"
        value={pv ? fmtInt(total) : '—'}
        loading={preview.isPending && !pv}
        stale={stale}
        tone={pv && total === 0 ? 'danger' : 'default'}
        hint={
          !pv
            ? '点「预览人数」看看这套组块能圈到多少人'
            : stale
              ? '方案改过了，这是上一次的结果 → 再点一次「预览人数」'
              : `${relativeTime(pv.at)}预览的`
        }
      />
      {pv && sample.length > 0 && (
        <div className="rounded-lg border border-border bg-surface-1 p-3">
          <p className="mb-2 text-xs text-fg-3">
            其中几个（后端返回的前 {sample.length} 个，没排序）
          </p>
          <div className="flex flex-wrap gap-1.5">
            {sample.slice(0, 18).map((s) => (
              <span key={s.id} className="rounded-sm bg-surface-2 px-2 py-0.5 text-sm text-fg-1" title={`id ${s.id} · 权重 ${s.weight}`}>
                {s.name}
              </span>
            ))}
            {sample.length > 18 && <span className="px-1 text-sm text-fg-3">…</span>}
          </div>
        </div>
      )}
    </div>
  )
}

export function DrawPanel() {
  const dr = useResults((s) => s.draw)
  const { fp } = useConfigPayload()
  const draw = useDrawAction()
  const seed = useDraft((s) => s.seed)
  const pick = usePick((s) => s.pick)
  const setPick = useSetPick()
  const { send, isPending } = useSendToGuessr()
  const showCharTags = useCandidateView((s) => s.showCharTags)

  if (!dr)
    return (
      <Card>
        <EmptyState
          kind="no-result"
          size="sm"
          title="还没抽"
          description="点「随机抽一题」，按权重从候选池里随机抽一个角色"
        />
      </Card>
    )

  const item = dr.data
  if (!isResolved(item))
    return (
      <Card>
        <EmptyState
          kind="no-candidates"
          size="sm"
          title="一个都没抽到"
          description="候选池是空的：至少要有一个启用的纳入块，而且它真的圈到了人"
        />
      </Card>
    )

  const isCurrent = pick?.item.char_id === item.char_id
  return (
    <div className="flex flex-col gap-2">
      {dr.fp !== fp && (
        <p className="rounded-sm bg-warning-bg px-3 py-2 text-xs text-warning-fg">方案改过了，这是改之前抽到的。</p>
      )}
      <CharacterCard
        key={`${item.char_id}-${dr.at}`}
        item={item}
        featured
        showCharTags={showCharTags}
        isCurrent={isCurrent}
        onSetCurrent={() => setPick(item, 'draw')}
        onSend={() => send(item)}
        sending={isPending}
        sendVariant="soft"
        className="animate-[slide-up_var(--motion-duration)_var(--motion-ease)]"
        extraActions={
          <Button variant="ghost" size="sm" icon={<IconRefresh />} loading={draw.isPending} onClick={draw.run}>
            再抽一次
          </Button>
        }
      />
      {seed !== null && (
        <p className="text-xs text-fg-3">设了随机种子 {seed}，所以每次抽到的都是同一个人；想换人就把种子清空。</p>
      )}
    </div>
  )
}
