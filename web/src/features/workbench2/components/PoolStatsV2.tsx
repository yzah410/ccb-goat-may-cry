/**
 * 候选池页的「统计」标签页：统计块（总数 / 性别 / 最早登场年份 / 平均评分）、
 * 年份分布图（可切表格）、「最常见的标签」。
 * 「最常见的标签」按当前模式的分栏规则分节：第一栏的每个分组各一节（动画 = 来源 / 播放形式；游戏 = 平台 / 分级·性质……），
 * 其余合成「作品标签」一节、按分类配色。
 */
import type { ReactNode } from 'react'
import { fmtInt } from '@/lib/format'
import { statsTagSections, useTagRulesVersion } from '@/lib/tags'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { TagChip } from '@/components/data-display/TagChip'
import { ErrorState, Skeleton } from '@/components/data-display/Misc'
import { StatsRow, YearChartCard } from '@/features/candidates/components/StatsPanels'
import type { ModeId, StatsV2Resp } from '@/features/v2/types'
import { MODE_BY_ID } from '../spec'
import { chipForStyle } from '../card'

function TagRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-fg-3">{title}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

/** 最常见的标签（按模式分节） */
export function TopTagsCardV2({ stats, mode, loading, className }: { stats: StatsV2Resp | null | undefined; mode: ModeId; loading: boolean; className?: string }) {
  const count = (n: number) => <span className="tabular opacity-70">{fmtInt(n)}</span>
  useTagRulesVersion() // 分档改了 → 重画
  const r = statsTagSections(stats, mode)
  const modeLabel = MODE_BY_ID.get(mode)?.label ?? mode
  return (
    <Card className={className}>
      <CardHeader title="最常见的标签" description={`一个角色算一次 · 按${mode === 'all' ? '四个模式合起来的规则' : `${modeLabel}模式的规则`}分组`} />
      <CardBody className="flex flex-col gap-4">
        {loading && !stats ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-4/5" />
            <Skeleton className="h-6 w-3/5" />
          </div>
        ) : stats && stats.total === 0 ? (
          <p className="py-6 text-center text-sm text-fg-3">题库是空的，也就没有标签可统计</p>
        ) : stats ? (
          <>
            {r.sections.map((s) => (
              <TagRow key={s.label} title={s.label}>
                {s.items.map((x) => {
                  // 第一栏各节用普通强度（「来源」「播放形式」都不加粗）
                  const c = chipForStyle(x.style)
                  return <TagChip key={x.tag} kind={c.kind} label={x.tag} size="sm" suffix={count(x.count)} />
                })}
              </TagRow>
            ))}
            <TagRow title="作品标签">
              {r.workTags.length ? (
                r.workTags.map((x) => {
                  const c = chipForStyle(x.style)
                  return <TagChip key={x.tag} kind={c.kind} label={x.tag} size="sm" emphasis={c.emphasis} suffix={count(x.count)} />
                })
              ) : (
                <span className="text-sm text-fg-3">—</span>
              )}
            </TagRow>
          </>
        ) : null}
      </CardBody>
    </Card>
  )
}

/** 统计标签页的整体：统计块一行 + 年份分布 + 最常见的标签 */
export function PoolStatsView({
  total,
  stats,
  mode,
  loading,
  fetching,
  error,
  onRetry,
}: {
  total: number | null
  stats: StatsV2Resp | null | undefined
  mode: ModeId
  loading: boolean
  fetching: boolean
  error: unknown
  onRetry: () => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <StatsRow total={total} stats={stats} loading={loading} />
      {error && !stats ? (
        <ErrorState error={error} size="sm" onRetry={onRetry} />
      ) : (
        <div className="grid items-start gap-4 @5xl/main:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <YearChartCard stats={stats} loading={loading} fetching={fetching} />
          <TopTagsCardV2 stats={stats} mode={mode} loading={loading} />
        </div>
      )}
    </div>
  )
}
