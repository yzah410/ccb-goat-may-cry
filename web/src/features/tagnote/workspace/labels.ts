/**
 * 标签上显示的东西：图名、所属的组（年份组）、组的小色点。纯函数。
 *
 * 色点：同一组永远同一个颜色，相邻的年份颜色不同（按年份对 8 取余，用主题的 8 个图表色）；
 * 年代组按年代算；「在这里新建的」用主色；「没有年份」用弱文字色。都是主题 token，明暗两套自动跟着变。
 */
import { buildGroups } from '../library'
import type { MapSummary } from '../types'

const CHART_DOTS = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5', 'bg-chart-6', 'bg-chart-7', 'bg-chart-8'] as const

export function groupDotClass(groupKey: string): string {
  if (groupKey === 'new') return 'bg-primary'
  const y = Number(/\d{4}/.exec(groupKey)?.[0])
  if (!Number.isFinite(y)) return 'bg-fg-3'
  const n = groupKey.startsWith('d') ? Math.floor(y / 10) : y
  return CHART_DOTS[((n % 8) + 8) % 8]
}

export interface MapLabel {
  title: string
  /** 组名：「2024」「1990–1999」「在这里新建的」「没有年份」 */
  group: string
  dot: string
  nWorks: number
}

/** 每张图的标签信息（按全部图分组，不看搜索和来源筛选） */
export function mapLabels(items: MapSummary[]): Map<string, MapLabel> {
  const out = new Map<string, MapLabel>()
  for (const g of buildGroups(items)) {
    const dot = groupDotClass(g.key)
    for (const it of g.items) out.set(it.id, { title: it.title, group: g.label, dot, nWorks: it.n_works })
  }
  return out
}
