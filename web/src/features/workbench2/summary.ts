/**
 * 把方案的各部分翻译成中文短句（条件 chip、「从哪来」「取角色」的一行摘要、没连上后端时的兜底句子）。纯函数，有单测。
 * 文案：直接写对象和条件（例：「作品标签同时含：百合、日常」）；数字用千分位。
 */
import { fmtInt } from '@/lib/format'
import type { Condition, ConditionType, PickSpec, Quant, RangeV2, Source, TagFilter } from '@/features/v2/types'
import { SUBJECT_TYPE_LABEL } from './spec'

// ---------------------------------------------------------------- 条件的分组
export type CondGroup = 'character' | 'grid' | 'appearance' | 'list' | 'sql'

export const COND_GROUPS: { id: CondGroup; label: string; hint: string }[] = [
  { id: 'character', label: '角色本身', hint: '和对局设置无关' },
  { id: 'grid', label: '游戏格子里显示的东西', hint: '按「对局设置」的模式和作品标签数算，和游戏里的格子对得上' },
  { id: 'appearance', label: '登场作品', hint: '至少有一部登场作品同时满足你给的所有要求' },
  { id: 'list', label: '清单', hint: '在不在你自己建的角色清单里' },
  { id: 'sql', label: '自定义查询', hint: '用「问数据」写出来的查询；数据更新后自动重算' },
]

export interface CondMeta {
  type: ConditionType
  group: CondGroup
  /** 菜单里的全名 */
  label: string
  /** chip 上的短名 */
  short: string
  /** 菜单里的一句说明 */
  hint: string
}

export const COND_META: CondMeta[] = [
  { type: 'gender', group: 'character', label: '性别', short: '性别', hint: '男 / 女 / 未知' },
  { type: 'char_heat', group: 'character', label: '角色热度', short: '角色热度', hint: 'Bangumi 上收藏这个角色的人数' },
  { type: 'char_tags', group: 'character', label: '角色标签（外观）', short: '角色标签', hint: '黑发、红瞳、双马尾……（来自上游的角色标签表）' },
  { type: 'va', group: 'character', label: '声优', short: '声优', hint: '配过这个角色的声优，含任一' },
  {
    type: 'game_tags',
    group: 'grid',
    label: '角色的作品标签（游戏格子里那组）',
    short: '作品标签（格子）',
    hint: '游戏格子里显示的那几个作品标签，随「作品标签数」变',
  },
  { type: 'source_tag', group: 'grid', label: '来源', short: '来源', hint: '原创 / 漫画改 / 小说改 / 游戏改' },
  { type: 'n_app', group: 'grid', label: '登场数', short: '登场数', hint: '游戏格子里的「作品数」' },
  { type: 'earliest_year', group: 'grid', label: '最早登场年', short: '最早登场', hint: '游戏格子里的最早登场年份' },
  { type: 'latest_year', group: 'grid', label: '最晚登场年', short: '最晚登场', hint: '游戏格子里的最晚登场年份' },
  { type: 'rating', group: 'grid', label: '最高评分', short: '最高评分', hint: '登场作品里最高的 Bangumi 评分' },
  {
    type: 'appearance',
    group: 'appearance',
    label: '有一部登场作品满足……',
    short: '登场作品',
    hint: '例：2024 年有一部动画里当主角（最早 / 最晚登场年不一定是 2024）',
  },
  { type: 'char_list', group: 'list', label: '在某个角色清单里', short: '角色清单', hint: '取反 = 不在清单里' },
  { type: 'sql', group: 'sql', label: '自定义查询（SQL）', short: '查询', hint: '在「问数据」页写好、存成条件；也可以直接写' },
]
export const COND_META_BY_TYPE = new Map(COND_META.map((m) => [m.type, m]))

export function condMeta(type: string): CondMeta {
  return (
    COND_META_BY_TYPE.get(type as ConditionType) ?? { type: type as ConditionType, group: 'sql', label: `未知条件（${type}）`, short: type, hint: '' }
  )
}

/** 两种作品标签名字不同；界面上在旁边用这句话说明区别 */
export const TWO_KINDS_OF_WORK_TAGS =
  '「角色的作品标签」是把这个角色所有登场作品的标签加权合起来算的（主角 ×3、配角 ×1），就是游戏格子里显示的那几个，会随作品标签数变；「作品本身的标签」是某一部作品自己被打的标签，用在「从哪来」和「登场作品」里。'

// ---------------------------------------------------------------- 名字查找（清单 id → 名字）
export interface NameLookup {
  list: (id: string) => string | null
}
export const NO_LOOKUP: NameLookup = { list: () => null }

function listName(id: string | null | undefined, lk: NameLookup): string {
  if (!id) return '（还没选清单）'
  const n = lk.list(id)
  return n ? `「${n}」` : '（清单已删除）'
}

// ---------------------------------------------------------------- 标签筛选
const QUANT_TEXT: Record<Quant, string> = { any: '含任一', all: '同时含', at_least: '至少含', none: '都不含' }
export const QUANT_LABEL: Record<Quant, string> = { any: '含任一', all: '含全部', at_least: '至少含 k 个', none: '都不含' }

function joinTags(tags: string[], max = 4): string {
  if (tags.length <= max) return tags.join('、')
  return `${tags.slice(0, max).join('、')} 等 ${tags.length} 个`
}

export function tagFilterText(f: TagFilter | null | undefined, lk: NameLookup = NO_LOOKUP): string {
  if (!f) return '（没设）'
  const parts: string[] = []
  if (f.tags.length) parts.push(joinTags(f.tags))
  if (f.tag_list_id) parts.push(`标签清单${listName(f.tag_list_id, lk)}`)
  const what = parts.length ? parts.join(' + ') : '（还没选标签）'
  const q = f.quant === 'at_least' ? `至少含 ${f.k ?? '?'} 个` : QUANT_TEXT[f.quant]
  const mode = f.tag_mode === 'any' ? '（有人打过就算）' : f.tag_mode === 'meta' ? '（公共标签）' : ''
  return `${q}：${what}${mode}`
}

// ---------------------------------------------------------------- 数值区间
function fmtNum(n: number, type: ConditionType): string {
  if (type === 'rating') return String(Math.round(n * 10) / 10)
  if (type === 'earliest_year' || type === 'latest_year') return String(n)
  return fmtInt(n)
}

export function rangeText(min: number | null | undefined, max: number | null | undefined, type: ConditionType, unit = ''): string {
  const u = unit ? ` ${unit}` : ''
  if (min != null && max != null) return min === max ? `= ${fmtNum(min, type)}${u}` : `${fmtNum(min, type)}–${fmtNum(max, type)}${u}`
  if (min != null) return `≥ ${fmtNum(min, type)}${u}`
  if (max != null) return `≤ ${fmtNum(max, type)}${u}`
  return '（还没设范围）'
}

const NUM_UNIT: Partial<Record<ConditionType, string>> = { n_app: '部', earliest_year: '年', latest_year: '年', rating: '分' }

// ---------------------------------------------------------------- 条件
function typesText(types: readonly number[] | null | undefined): string {
  if (!types || !types.length) return ''
  return types.map((t) => SUBJECT_TYPE_LABEL[t] ?? `类型${t}`).join('/')
}

function yearsText(a: number | null | undefined, b: number | null | undefined): string {
  if (a != null && b != null) return a === b ? `${a} 年` : `${a}–${b} 年`
  if (a != null) return `${a} 年以后`
  if (b != null) return `${b} 年以前`
  return ''
}

/** 条件的内容（不含「不满足」前缀）：「女」「≥ 1,000」「同时含：百合、日常」 */
export function conditionDetail(c: Condition, lk: NameLookup = NO_LOOKUP): string {
  switch (c.type) {
    case 'gender':
      return c.values.length ? c.values.join('或') : '（还没选）'
    case 'char_heat':
    case 'n_app':
    case 'earliest_year':
    case 'latest_year':
    case 'rating':
      return rangeText(c.min, c.max, c.type, NUM_UNIT[c.type])
    case 'game_tags':
    case 'char_tags':
      return tagFilterText(c, lk)
    case 'va':
      return c.names.length ? `${joinTags(c.names, 3)}（任一）` : '（还没选声优）'
    case 'source_tag':
      return c.values.length ? c.values.join('或') : '（还没选）'
    case 'appearance': {
      const parts: string[] = []
      const when = yearsText(c.year_from, c.year_to)
      const what = typesText(c.subject_types) || '作品'
      parts.push(when ? `${when}的${what}` : what)
      if (c.roles?.length) parts.push(`在里面是${c.roles.join('或')}`)
      if (c.work_tags && (c.work_tags.tags.length || c.work_tags.tag_list_id)) parts.push(`作品本身的标签${tagFilterText(c.work_tags, lk)}`)
      if (c.work_list_id) parts.push(`在作品清单${listName(c.work_list_id, lk)}里`)
      return `至少一部：${parts.join('，')}`
    }
    case 'char_list':
      return listName(c.list_id, lk)
    case 'sql': {
      if (c.label?.trim()) return c.label.trim()
      const first = c.sql.trim().split(/\s+/).join(' ')
      return first ? (first.length > 36 ? `${first.slice(0, 36)}…` : first) : '（还没写查询）'
    }
    default:
      return JSON.stringify(c)
  }
}

/** chip 上的完整一句：「作品标签（格子） 同时含：百合、日常」；取反加「不满足：」 */
export function conditionText(c: Condition, lk: NameLookup = NO_LOOKUP): string {
  const m = condMeta(c.type)
  const body = c.type === 'char_list' ? `在角色清单${conditionDetail(c, lk)}里` : `${m.short} ${conditionDetail(c, lk)}`
  return c.negate ? `不满足：${body}` : body
}

// ---------------------------------------------------------------- 从哪来 / 取角色
export function rankWindowText(from: number, to: number | null): string {
  if (to === null) return from <= 1 ? '全部' : `第 ${fmtInt(from)} 名以后`
  if (from <= 1) return `前 ${fmtInt(to)} 部`
  return `第 ${fmtInt(from)}–${fmtInt(to)} 名`
}

export function sourceText(s: Source, lk: NameLookup = NO_LOOKUP): string {
  switch (s.kind) {
    case 'rank': {
      const years = yearsText(s.year_from, s.year_to) || '不限年份'
      const types = typesText(s.subject_types) || '作品'
      const win = rankWindowText(s.rank_from, s.rank_to)
      const per = s.rank_scope === 'per_year' && s.rank_to !== null ? '每年' : ''
      const head = win === '全部' ? `${years}的全部${types}` : `${years}${per}热度${win}${types}`
      const hasWf = !!s.work_filter && (s.work_filter.tags.length > 0 || !!s.work_filter.tag_list_id)
      if (!hasWf) return head
      const wf = `作品本身的标签${tagFilterText(s.work_filter, lk)}`
      // 默认（和游戏一样）先按作品标签筛、再排名；after_rank 才是先排名再筛
      if (s.work_filter_order === 'after_rank' || win === '全部') return `${head}，其中${wf}的作品`
      return `${years}${types}里${wf}的作品中，${per}热度${win}`
    }
    case 'work_list':
      return `作品清单${listName(s.list_id, lk)}里的作品`
    case 'char_list':
      return `角色清单${listName(s.list_id, lk)}里的角色`
    case 'all_characters':
      return '整个角色库（不限作品）'
  }
}

export function pickText(p: PickSpec): string {
  const roles = p.roles.includes('配角') ? (p.roles.includes('主角') ? '主角和配角' : '只要配角') : '只要主角'
  if (p.per_work === null) return `${roles}，每部不限人数`
  const order = p.order === 'game' ? '和游戏一样的顺序' : '按角色热度'
  return `${roles}，每部最多 ${p.per_work} 人（${order}）`
}

/** 「取角色」这一步对这种来源有没有用（清单里的角色、整个角色库不按作品取） */
export function pickApplies(s: Source): boolean {
  return s.kind === 'rank' || s.kind === 'work_list'
}

/** 方案一行摘要（方案库、打开方案用）：「动画 · 标签数 6 · 2 个范围 · 1 个排除 · 机会均等」 */
export function specBrief(spec: {
  game: { mode: string; tag_count: number }
  ranges: { enabled: boolean }[]
  excludes: { enabled: boolean }[]
  draw: { method: string }
}): string {
  const modeLabel: Record<string, string> = { anime: '动画', game: '游戏', book: '书籍', real: '三次元', all: '全部' }
  const method: Record<string, string> = { per_character: '机会均等', per_work: '先抽作品', range_share: '按范围占比' }
  const on = (xs: { enabled: boolean }[]) => xs.filter((x) => x.enabled).length
  const parts = [
    modeLabel[spec.game.mode] ?? spec.game.mode,
    `标签数 ${spec.game.tag_count}`,
    `${on(spec.ranges)} 个范围`,
    ...(spec.excludes.length ? [`${on(spec.excludes)} 个排除`] : []),
    method[spec.draw.method] ?? spec.draw.method,
  ]
  return parts.join(' · ')
}

/** 方案里用到的清单 id（清单页「被哪些方案用到」） */
export function listIdsInSpec(spec: { ranges: RangeV2[]; excludes: RangeV2[] }): Set<string> {
  const ids = new Set<string>()
  const tf = (f: { tag_list_id?: string | null } | null | undefined) => {
    if (f?.tag_list_id) ids.add(f.tag_list_id)
  }
  for (const r of [...spec.ranges, ...spec.excludes]) {
    const s = r.source
    if ((s.kind === 'work_list' || s.kind === 'char_list') && s.list_id) ids.add(s.list_id)
    if (s.kind === 'rank') tf(s.work_filter)
    for (const c of r.conditions) {
      if (c.type === 'game_tags' || c.type === 'char_tags') tf(c)
      else if (c.type === 'char_list' && c.list_id) ids.add(c.list_id)
      else if (c.type === 'appearance') {
        tf(c.work_tags)
        if (c.work_list_id) ids.add(c.work_list_id)
      }
    }
  }
  return ids
}

/**
 * 后端还没回来（或连不上）时卡片顶上的兜底句子。真正显示的是后端的 sentence（按同一套意思生成）。
 */
export function localSentence(r: RangeV2, lk: NameLookup = NO_LOOKUP): string {
  const src = sourceText(r.source, lk)
  const who = pickApplies(r.source)
    ? `${src}的${r.pick.roles.includes('配角') ? (r.pick.roles.includes('主角') ? '主角和配角' : '配角') : '主角'}`
    : src
  const on = r.conditions.filter((c) => c.enabled)
  if (!on.length) return who
  return `${who}里，${on.map((c) => conditionText(c, lk)).join('，并且')}的角色`
}
