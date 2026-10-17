/**
 * 候选池的统计：统计块一行 + 年份分布柱状图 + 最常见的标签。
 * 数据来自 POST /v2/stats（经典候选池用 POST /stats）。
 *
 * 图表规则：单系列 → 只用 --chart-1、不放图例（标题就是图例）；柱子 ≤24px、顶部 4px 圆角、
 * 相邻柱 2px 空隙；网格线是实线细线；每根柱子都有悬停提示；有「表格」视图；重新请求时保留旧图并变淡。
 */
import { useState, type ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import type { TooltipContentProps } from 'recharts'
import { cn } from '@/lib/cn'
import { fmtInt, fmtScore } from '@/lib/format'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { SegmentedControl } from '@/components/ui/Controls'
import { StatTile } from '@/components/data-display/StatTile'
import { TagChip } from '@/components/data-display/TagChip'
import { Skeleton } from '@/components/data-display/Misc'
import { IconCalendar, IconChart, IconStar, IconTable, IconUsers } from '@/lib/icons'
import { classifyWorkTag } from '@/lib/tags'
import { usePrefs } from '@/features/settings/store'
import type { StatsResp } from '../types'

function GenderSplit({ by }: { by: Record<string, number> }) {
  const f = by['♀'] ?? 0
  const m = by['♂'] ?? 0
  const u = by['?'] ?? 0
  const total = Math.max(1, f + m + u)
  // 男 = 图表第 1 色（蓝），女 = 第 5 色（洋红）：和 GenderBadge 用同一对颜色；未知 = 中性灰
  const segs = [
    { key: '男', n: m, color: 'var(--chart-1)' },
    { key: '女', n: f, color: 'var(--chart-5)' },
    { key: '未知', n: u, color: 'var(--border-strong)' },
  ]
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface-1 px-4 py-3 shadow-1">
      <span className="text-sm text-fg-3">性别</span>
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`男 ${m}，女 ${f}，未知 ${u}`}>
        {segs.map((s) =>
          s.n > 0 ? <span key={s.key} style={{ width: `${(s.n / total) * 100}%`, background: s.color }} className="h-full first:rounded-l-full last:rounded-r-full" /> : null,
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-2">
        {segs.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: s.color }} />
            {s.key}
            <span className="tabular font-medium text-fg-1">{fmtInt(s.n)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

export function StatsRow({ total, stats, loading }: { total: number | null; stats: StatsResp | null | undefined; loading: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-3 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
      <StatTile icon={<IconUsers />} label="候选总数" value={total == null ? '—' : fmtInt(total)} loading={total == null && loading} hint="按当前方案圈到的角色" />
      {stats ? (
        <GenderSplit by={stats.by_gender} />
      ) : (
        <StatTile label="性别" value="—" loading={loading} />
      )}
      <StatTile
        icon={<IconCalendar />}
        label="最早登场年份"
        value={stats?.year_min != null ? `${stats.year_min}–${stats.year_max}` : '—'}
        loading={loading && !stats}
        hint={stats?.no_year ? `${fmtInt(stats.no_year)} 人没有年份` : '最早 – 最晚'}
      />
      <StatTile
        icon={<IconStar />}
        label="平均评分"
        value={stats?.avg_score != null ? fmtScore(stats.avg_score) : '—'}
        loading={loading && !stats}
        hint="角色最高评分的平均值"
      />
    </div>
  )
}

function YearTooltip({ active, payload }: TooltipContentProps<number, string>) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload as { year: number; count: number } | undefined
  if (!row) return null
  return (
    <div className="rounded-md border border-border bg-surface-1 px-3 py-2 shadow-2">
      <div className="flex items-center gap-2">
        <span className="h-0.5 w-3 rounded-full" style={{ background: 'var(--chart-1)' }} />
        <span className="tabular text-base font-semibold text-fg-1">{fmtInt(row.count)} 人</span>
      </div>
      <div className="mt-0.5 text-xs text-fg-2">{row.year} 年第一次登场</div>
    </div>
  )
}

export function YearChartCard({ stats, loading, fetching, className }: { stats: StatsResp | null | undefined; loading: boolean; fetching: boolean; className?: string }) {
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const motion = usePrefs((s) => s.motionPref)
  const data = stats?.by_year ?? []
  const peak = data.reduce<{ year: number; count: number } | null>((m, r) => (!m || r.count > m.count ? r : m), null)

  return (
    <Card className={className}>
      <CardHeader
        icon={<IconChart />}
        title="候选的最早登场年份分布"
        description={peak ? `最多的是 ${peak.year} 年（${fmtInt(peak.count)} 人）` : '每根柱子 = 这一年第一次登场的候选人数'}
        actions={
          <SegmentedControl
            size="sm"
            value={view}
            onChange={setView}
            aria-label="图还是表"
            options={[
              { value: 'chart', label: '图', icon: <IconChart /> },
              { value: 'table', label: '表', icon: <IconTable /> },
            ]}
          />
        }
      />
      <CardBody>
        {loading && !stats ? (
          <Skeleton className="h-[220px] w-full" />
        ) : !data.length ? (
          <p className="py-10 text-center text-sm text-fg-3">没有可画的数据</p>
        ) : view === 'chart' ? (
          <div className={cn('h-[220px] w-full transition-opacity', fetching && 'opacity-50')} aria-label="年份分布柱状图">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap={2}>
                <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                <XAxis
                  dataKey="year"
                  tickLine={false}
                  axisLine={{ stroke: 'var(--chart-grid)' }}
                  tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
                  minTickGap={16}
                  interval="preserveStartEnd"
                />
                <YAxis
                  width={44}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                  tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
                  tickFormatter={(v: number) => fmtInt(v)}
                />
                <RTooltip cursor={{ fill: 'var(--surface-2)' }} content={(p) => <YearTooltip {...(p as TooltipContentProps<number, string>)} />} />
                <Bar
                  dataKey="count"
                  fill="var(--chart-1)"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={24}
                  activeBar={{ fillOpacity: 0.78 }}
                  isAnimationActive={motion !== 'reduce'}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="max-h-[220px] overflow-y-auto rounded-md border border-border scroll-thin">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-bg-elevated text-left text-xs text-fg-3">
                <tr>
                  <th className="px-3 py-2 font-medium">最早登场年份</th>
                  <th className="px-3 py-2 text-right font-medium">人数</th>
                </tr>
              </thead>
              <tbody className="tabular">
                {data.map((r) => (
                  <tr key={r.year} className="border-t border-border">
                    <td className="px-3 py-1.5 text-fg-1">{r.year}</td>
                    <td className="px-3 py-1.5 text-right text-fg-1">{fmtInt(r.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

/** 最常见的标签：题材 / 来源 / 播放形式，各带人数 */
export function TopTagsCard({ stats, loading, className }: { stats: StatsResp | null | undefined; loading: boolean; className?: string }) {
  const count = (n: number) => <span className="tabular opacity-70">{fmtInt(n)}</span>
  const sorted = (o: Record<string, number> | undefined) =>
    Object.entries(o ?? {})
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
  return (
    <Card className={className}>
      <CardHeader title="最常见的标签" description="候选里出现次数最多的（一个角色算一次）" />
      <CardBody className="flex flex-col gap-4">
        {loading && !stats ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-4/5" />
            <Skeleton className="h-6 w-3/5" />
          </div>
        ) : stats && stats.total === 0 ? (
          <p className="py-6 text-center text-sm text-fg-3">没有候选，也就没有标签可统计</p>
        ) : stats ? (
          <>
            <TagRow title="来源">
              {sorted(stats.source).map(([t, n]) => (
                <TagChip key={t} kind="source" label={t} size="sm" suffix={count(n)} />
              ))}
            </TagRow>
            <TagRow title="播放形式">
              {sorted(stats.playback).map(([t, n]) => (
                <TagChip key={t} kind="playback" label={t} size="sm" suffix={count(n)} />
              ))}
            </TagRow>
            <TagRow title="作品标签">
              {stats.top_work_tags.slice(0, 16).map((x) => {
                const c = classifyWorkTag(x.tag)
                const kind = c === 'genre-primary' || c === 'genre-secondary' ? 'genre' : c === 'studio' ? 'studio' : 'work'
                return <TagChip key={x.tag} kind={kind} label={x.tag} size="sm" emphasis={c === 'genre-primary' ? 'strong' : 'soft'} suffix={count(x.count)} />
              })}
            </TagRow>
          </>
        ) : null}
      </CardBody>
    </Card>
  )
}

function TagRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-fg-3">{title}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}
