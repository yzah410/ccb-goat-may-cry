/**
 * 组块的人话摘要（组块卡片用）。
 * 目标：不看编辑器也能知道这个组块圈了什么。
 */
import { countLines } from '@/lib/format'
import type { Block, TagGroups, TagItem } from './schema'

function range(lo: number, hi: number, unit: string, kind: 'rank' | 'percent'): string {
  const [a, b] = lo <= hi ? [lo, hi] : [hi, lo]
  if (kind === 'percent') return a <= 0 ? `前 ${b}%` : `${a}%–${b}%`
  return a <= 1 ? `前 ${b} ${unit}` : `第 ${a}–${b} ${unit}`
}

function years(y: [number, number]): string {
  const [a, b] = y[0] <= y[1] ? y : [y[1], y[0]]
  return a === b ? `${a} 年` : `${a}–${b} 年`
}

export function tagGroupText(group: TagItem[], max = 4): string {
  const reds = group.filter((t) => t.color === 'red')
  const blues = group.filter((t) => t.color === 'blue')
  const parts = [...reds.map((t) => t.name), ...blues.map((t) => `−${t.name}`)]
  if (!parts.length) return '（空组）'
  const shown = parts.slice(0, max).join(reds.length ? ' + ' : ' ').replace(/ \+ −/g, ' −')
  return parts.length > max ? `${shown} 等 ${parts.length} 个` : shown
}

/** 「治愈 + 日常 −百合 ｜或｜ 恋爱」 */
export function tagGroupsText(groups: TagGroups | undefined, max = 4): string | null {
  const gs = (groups ?? []).filter((g) => g.length > 0)
  if (!gs.length) return null
  return gs.map((g) => tagGroupText(g, max)).join(' ｜或｜ ')
}

export function isAllExcludeGroup(group: TagItem[]): boolean {
  return group.length > 0 && group.every((t) => t.color === 'blue')
}

/** 组块摘要：几行短句 */
export function summarizeBlock(b: Block): string[] {
  const out: string[] = []
  switch (b.kind) {
    case 'work-range': {
      const p = b.params
      out.push(years(p.years))
      out.push(
        p.rank_basis === 'per_year'
          ? `每年收藏${range(p.rank_lo, p.rank_hi, '名', p.rank_value_kind)}的作品`
          : `各年合并排，收藏${range(p.rank_lo, p.rank_hi, '名', p.rank_value_kind)}的作品`,
      )
      out.push(
        `每部取热度${range(p.role_rank_lo, p.role_rank_hi, '名', p.role_rank_kind)}（${p.roles_scope === 'main' ? '只要主角' : '主角+配角'}）`,
      )
      const t = tagGroupsText(p.tag_groups)
      if (t) out.push(`标签：${t}`)
      break
    }
    case 'work-list': {
      const p = b.params
      out.push(`清单里 ${countLines(p.work_lines)} 部作品`)
      if (b.color === 'red') {
        if (p.roles_scope && p.role_rank_kind && p.role_rank_lo != null && p.role_rank_hi != null)
          out.push(
            `每部取热度${range(p.role_rank_lo, p.role_rank_hi, '名', p.role_rank_kind)}（${p.roles_scope === 'main' ? '只要主角' : '主角+配角'}）`,
          )
        else out.push('还没设「每部取几个角色」→ 后端会当它是空的')
      } else out.push('排除这些作品的全部角色')
      break
    }
    case 'char-list':
      out.push(`清单里 ${countLines(b.params.char_lines)} 个角色`)
      break
    case 'char-range': {
      const p = b.params
      if (p.earliest_year) out.push(`最早登场 ${years(p.earliest_year)}`)
      if (p.latest_year) out.push(`最晚登场 ${years(p.latest_year)}`)
      if (p.genders?.length) out.push(`性别 ${p.genders.join(' ')}`)
      if (p.max_score) out.push(`最高评分 ${p.max_score[0]}–${p.max_score[1]}`)
      if (p.appear_works?.length) out.push(`在指定的 ${p.appear_works.length} 部作品里登场过`)
      const t = tagGroupsText(p.tag_groups)
      if (t) out.push(`标签：${t}`)
      if (!out.length) out.push('没设任何条件 = 全部角色')
      break
    }
  }
  return out
}
