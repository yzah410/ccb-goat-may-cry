import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { PageHeader } from '@/app/shell/PageHeader'
import { useShellNav } from '@/app/shell/nav'
import { Button } from '@/components/ui/Button'
import { SegmentedControl, Switch } from '@/components/ui/Controls'
import { NumberField } from '@/components/ui/NumberField'
import { CharacterCard } from '@/components/data-display/CharacterCard'
import { CardSkeleton, EmptyState, ErrorState } from '@/components/data-display/Misc'
import { IconArrowLeft, IconGrid, IconRefresh, IconRows, IconUsers } from '@/lib/icons'
import { fmtInt } from '@/lib/format'
import { cn } from '@/lib/cn'
import { useDraft } from '@/features/blocks/store'
import { MODE_LABEL } from '@/features/blocks/schema'
import { useSendToGuessr } from '@/features/clicker/hooks'
import { useCandidateStats, useCandidates, useConfigPayload, useSetPick } from '@/features/candidates/hooks'
import { useCandidateView, usePick } from '@/features/candidates/store'
import { pageSpan, totalPagesOf } from '@/features/candidates/pagination'
import { Pagination } from '@/features/candidates/components/Pagination'
import { CandidateRow } from '@/features/candidates/components/CandidateRow'
import { StatsRow, TopTagsCard, YearChartCard } from '@/features/candidates/components/StatsPanels'

function PlanLine() {
  const planName = useDraft((s) => s.planName)
  const blocks = useDraft((s) => s.blocks)
  const mode = useDraft((s) => s.mode)
  const red = blocks.filter((b) => b.enabled && b.color === 'red').length
  const blue = blocks.filter((b) => b.enabled && b.color === 'blue').length
  return (
    <p className="mt-2 text-sm text-fg-3">
      方案 <span className="font-medium text-fg-1">{planName ?? '未命名'}</span> · {blocks.length} 个组块（启用的：纳入 {red} / 排除 {blue}）·{' '}
      {MODE_LABEL[mode]}
    </p>
  )
}

export default function CandidatesPage() {
  const nav = useShellNav()
  const qc = useQueryClient()
  const { fp } = useConfigPayload()
  const view = useCandidateView()
  const pick = usePick((s) => s.pick)
  const setPick = useSetPick()
  const { send, isPending: sending } = useSendToGuessr()

  // 页码：方案一改就回到第 1 页
  const [pg, setPg] = useState({ fp, page: 1, nonce: 0 })
  const page = pg.fp === fp ? pg.page : 1
  const nonce = pg.fp === fp ? pg.nonce : 0
  const setPage = (p: number) => setPg({ fp, page: p, nonce })

  // 行模式的展开状态：翻页 / 刷新 / 方案变了都重置成全部收起
  const expKey = `${fp}|${page}|${view.pageSize}|${nonce}`
  const [exp, setExp] = useState<{ key: string; open: Record<number, boolean> }>({ key: expKey, open: {} })
  const open = exp.key === expKey ? exp.open : {}
  const setOpen = (id: number, v: boolean) => setExp({ key: expKey, open: { ...open, [id]: v } })

  const q = useCandidates(page)
  const stats = useCandidateStats()
  const total = q.data?.total ?? null
  const totalPages = totalPagesOf(total ?? 0, view.pageSize)
  const [from, to] = pageSpan(page, view.pageSize, total ?? 0)

  const refresh = () => {
    setPg({ fp, page: 1, nonce: nonce + 1 })
    void qc.invalidateQueries({ queryKey: ['candidates', fp] })
    void qc.invalidateQueries({ queryKey: ['stats', fp] })
  }

  const items = q.data?.items ?? []
  const loadingFirst = q.isPending

  return (
    <>
      <PageHeader
        route="candidates"
        title="经典候选池"
        icon={<IconUsers />}
        description="经典工作台的方案圈到的全部角色，按「最早登场年 → 权重 → 评分 → 作品名 → 角色名」排好。看中谁就「设为当前」。（工作台的候选在「候选池」页）"
        actions={
          <>
            <Button variant="ghost" icon={<IconArrowLeft />} onClick={() => nav.go('classic')}>
              回经典工作台改组块
            </Button>
            <Button variant="secondary" icon={<IconRefresh />} loading={q.isFetching && !loadingFirst} onClick={refresh}>
              刷新
            </Button>
          </>
        }
      >
        <PlanLine />
      </PageHeader>

      <div className="flex flex-col gap-4">
        <StatsRow total={total} stats={stats.data} loading={stats.isPending || loadingFirst} />
        <div className="grid items-start gap-4 @5xl/main:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <YearChartCard stats={stats.data} loading={stats.isPending} fetching={stats.isFetching} />
          <TopTagsCard stats={stats.data} loading={stats.isPending} />
        </div>

        {/* 工具条：吸顶 */}
        <div className="glass sticky top-[var(--shell-sticky-top,0px)] z-20 -mx-2 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border px-3 py-2 shadow-1">
          <SegmentedControl
            size="sm"
            value={view.displayMode}
            onChange={view.setDisplayMode}
            aria-label="展示方式"
            options={[
              { value: 'card', label: '卡片', icon: <IconGrid /> },
              { value: 'row', label: '列表', icon: <IconRows /> },
            ]}
          />
          <label className="flex items-center gap-2 text-sm text-fg-2">
            每页
            <NumberField
              value={view.pageSize}
              onCommit={(v) => v !== null && view.setPageSize(Math.min(20, Math.max(1, v)))}
              integer
              fallback={view.pageSize}
              size="sm"
              className="w-16"
              aria-label="每页显示几个（1–20）"
            />
            个
          </label>
          <span className="text-sm text-fg-3">按年份 ↑、权重 ↓、评分 ↓、作品名、角色名排序</span>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-fg-2">
            <Switch size="sm" checked={view.showCharTags} onChange={view.setShowCharTags} aria-label="显示角色标签" />
            显示角色标签
          </label>
          <span className="ml-auto text-sm text-fg-3">
            {total == null ? '…' : total === 0 ? '0 个' : `第 ${fmtInt(from)}–${fmtInt(to)} 个，共 ${fmtInt(total)} 个`}
          </span>
        </div>

        <Pagination page={page} totalPages={totalPages} onPage={setPage} disabled={q.isFetching} />

        {loadingFirst ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg-3">正在让后端算候选…</p>
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </div>
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : total === 0 ? (
          <EmptyState
            kind="no-candidates"
            size="lg"
            title="这个方案一个人都没圈到"
            description="检查一下：有没有启用的「纳入」组块？排除块是不是把人全去掉了？"
            action={
              <Button variant="primary" icon={<IconArrowLeft />} onClick={() => nav.go('classic')}>
                回经典工作台调整
              </Button>
            }
          />
        ) : (
          <div
            className={cn(
              'grid gap-3 transition-opacity',
              view.displayMode === 'card' && '@5xl/main:grid-cols-2',
              q.isPlaceholderData && 'pointer-events-none opacity-50',
            )}
            aria-busy={q.isFetching}
          >
            {items.map((it, i) => {
              const rank = (page - 1) * view.pageSize + i + 1
              const isCurrent = pick?.item.char_id === it.char_id
              if (view.displayMode === 'row' && !open[it.char_id])
                return (
                  <CandidateRow
                    key={it.char_id}
                    item={it}
                    rank={rank}
                    isCurrent={isCurrent}
                    onSetCurrent={() => setPick(it, 'candidates')}
                    onExpand={() => setOpen(it.char_id, true)}
                  />
                )
              return (
                <CharacterCard
                  key={it.char_id}
                  item={it}
                  rank={rank}
                  showCharTags={view.showCharTags}
                  isCurrent={isCurrent}
                  onSetCurrent={() => setPick(it, 'candidates')}
                  onSend={isCurrent ? () => send(it) : undefined}
                  sending={sending}
                  sendVariant="soft"
                  onCollapse={view.displayMode === 'row' ? () => setOpen(it.char_id, false) : undefined}
                />
              )
            })}
          </div>
        )}

        {!loadingFirst && total !== 0 && <Pagination page={page} totalPages={totalPages} onPage={setPage} disabled={q.isFetching} />}
      </div>
    </>
  )
}
