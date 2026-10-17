/**
 * 方案库的纯逻辑：来源说明、分组、搜索、笔记文件名、布局缓存的防抖保存。不碰 React，方便测试。
 */
import type { GenerateErrorInfo } from './api'
import type { LayoutCache, MapSummary, TagMode, TagNoteData } from './types'

// ---------------------------------------------------------------- 来源
export interface SourceMeta {
  /** 列表里的分组标题 */
  label: string
  /** 标题区、下拉框里的短标记 */
  short: string
  tone: 'primary' | 'outline' | 'neutral'
  /** 删除确认框里的说明 */
  deleteNote: string
}

// 前两种来源是仓库自带的样例导图（examples/maps/）
const SAMPLE_NOTE = '只从方案库里删除这张图，examples/maps/ 里的样例文件不受影响；之后点「载入全部样例导图」可以重新载入。'

// 来源取值：manual = 手工整理的导图，batch = 批量生成的导图，outsetter = 在出题器里新建的导图
export const SOURCE_ORDER = ['manual', 'batch', 'outsetter'] as const

export const SOURCE_META: Record<string, SourceMeta> = {
  manual: { label: '样例导图（精选）', short: '精选样例', tone: 'primary', deleteNote: SAMPLE_NOTE },
  batch: { label: '样例导图（补充年份）', short: '补充样例', tone: 'outline', deleteNote: SAMPLE_NOTE },
  outsetter: { label: '在这里新建的', short: '在这里新建', tone: 'neutral', deleteNote: '这张图是在出题器里新建的，删除后不能恢复。' },
}

const OTHER_META: SourceMeta = { label: '其它来源', short: '其它来源', tone: 'neutral', deleteNote: '删除后不能恢复。' }

export function sourceMeta(source: string | null | undefined): SourceMeta {
  return (source && SOURCE_META[source]) || OTHER_META
}

// ---------------------------------------------------------------- 搜索
export function searchTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/** 每个词都要在标题或某个共有标签里出现（不分大小写） */
export function matchesTerms(item: Pick<MapSummary, 'title' | 'common_tags'>, terms: string[]): boolean {
  if (!terms.length) return true
  const title = item.title.toLowerCase()
  const tags = (item.common_tags ?? []).map((t) => t.toLowerCase())
  return terms.every((t) => title.includes(t) || tags.some((g) => g.includes(t)))
}

// ---------------------------------------------------------------- 分组：按年份，新的在上
export interface MapGroup {
  /** 折叠状态按它存：'new'、'y2024'、'd1990-1999'、'none' */
  key: string
  /** 小组标题：「在这里新建的」「2024」「1990–1999」「没有年份」 */
  label: string
  /** new = 在这里新建的（放最上面）；year = 一年；span = 一个或几个年代；none = 没有年份（放最下面） */
  kind: 'new' | 'year' | 'span' | 'none'
  items: MapSummary[]
}

export interface SourceCount {
  source: string
  meta: SourceMeta
  count: number
}

export interface GroupOptions {
  query?: string
  /** 'all' 或某个来源 */
  source?: string
}

/** 一个年代的图超过这么多张，就按年分组；不超过就整个年代一组 */
const DENSE_DECADE = 24
/** 较早的年代图很少时，相邻几个年代并成一组，凑够这么多张为止 */
const SMALL_SPAN = 6

const sourceOf = (it: MapSummary): string => it.source || 'other'
const years = (group: string | null): number[] => (group?.match(/\d{4}/g) ?? []).map(Number)
const firstYear = (it: MapSummary): number | null => years(it.group)[0] ?? null
const lastYear = (it: MapSummary): number | null => years(it.group).at(-1) ?? null
const decadeOf = (y: number): number => Math.floor(y / 10) * 10

function sourceRank(source: string): number {
  const i = (SOURCE_ORDER as readonly string[]).indexOf(source)
  return i < 0 ? SOURCE_ORDER.length : i
}

const byTitle = (a: MapSummary, b: MapSummary) => a.title.localeCompare(b.title, 'zh-Hans-CN') || a.id.localeCompare(b.id)

/** 年份组里：精选样例在前，补充样例其次；同来源里起始年份新的在前，再按结束年份、标题 */
const inYearGroup = (a: MapSummary, b: MapSummary) =>
  sourceRank(sourceOf(a)) - sourceRank(sourceOf(b)) ||
  (firstYear(b) ?? 0) - (firstYear(a) ?? 0) ||
  (lastYear(b) ?? 0) - (lastYear(a) ?? 0) ||
  byTitle(a, b)

/** 在这里新建的：生成时间新的在前 */
const newestFirst = (a: MapSummary, b: MapSummary) =>
  (b.generated_at ?? b.updated_at).localeCompare(a.generated_at ?? a.updated_at) || byTitle(a, b)

/** 每个来源有几张图（筛选按钮用）：精选样例 → 补充样例 → 在这里新建 → 其它 */
export function sourceCounts(items: MapSummary[]): SourceCount[] {
  const counts = new Map<string, number>()
  for (const it of items) counts.set(sourceOf(it), (counts.get(sourceOf(it)) ?? 0) + 1)
  return [...counts.keys()]
    .sort((a, b) => sourceRank(a) - sourceRank(b) || a.localeCompare(b))
    .map((source) => ({ source, meta: sourceMeta(source === 'other' ? null : source), count: counts.get(source) ?? 0 }))
}

/**
 * 按年份分组，新的在上：
 * - 在这里新建的单独一组，放最上面；没有年份的放最下面
 * - 其余按 group 里的第一个年份（「1995-1999」算 1995）归到年代；图多的年代按年分组，图少的整个年代一组，
 *   很早、很少的几个年代并成一组
 * 分组的划分只看全部图（不看搜索和来源筛选），换筛选时组不会变来变去；筛完空了的组不显示。
 */
export function buildGroups(items: MapSummary[], opts: GroupOptions = {}): MapGroup[] {
  const terms = searchTerms(opts.query ?? '')
  const source = opts.source ?? 'all'

  // 1. 划分：年代 → 按年 / 整个年代 / 几个年代并成一组
  const perDecade = new Map<number, number>()
  for (const it of items) {
    const y = firstYear(it)
    if (sourceOf(it) === 'outsetter' || y === null) continue
    const d = decadeOf(y)
    perDecade.set(d, (perDecade.get(d) ?? 0) + 1)
  }
  const spanOf = new Map<number, { key: string; label: string; from: number }>()
  let run: number[] = []
  let runCount = 0
  const flush = () => {
    if (!run.length) return
    const from = run[0]
    const to = run[run.length - 1] + 9
    const span = { key: `d${from}-${to}`, label: `${from}–${to}`, from }
    for (const d of run) spanOf.set(d, span)
    run = []
    runCount = 0
  }
  for (const d of [...perDecade.keys()].sort((a, b) => a - b)) {
    const n = perDecade.get(d) ?? 0
    if (n > DENSE_DECADE) {
      flush()
      continue
    }
    if (run.length && d !== run[run.length - 1] + 10) flush() // 中间隔着空年代就不并
    run.push(d)
    runCount += n
    if (runCount >= SMALL_SPAN) flush()
  }
  flush()

  // 2. 装进组（这一步才看搜索和来源筛选）
  const groups = new Map<string, MapGroup & { order: number }>()
  const put = (key: string, label: string, kind: MapGroup['kind'], order: number, it: MapSummary) => {
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { key, label, kind, order, items: [] }))
    g.items.push(it)
  }
  for (const it of items) {
    if (source !== 'all' && sourceOf(it) !== source) continue
    if (!matchesTerms(it, terms)) continue
    const y = firstYear(it)
    if (sourceOf(it) === 'outsetter') put('new', SOURCE_META.outsetter.label, 'new', Infinity, it)
    else if (y === null) put('none', '没有年份', 'none', -Infinity, it)
    else {
      const span = spanOf.get(decadeOf(y))
      if (span) put(span.key, span.label, 'span', span.from, it)
      else put(`y${y}`, String(y), 'year', y, it)
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.order - a.order)
    .map(({ order: _order, ...g }) => ({ ...g, items: [...g.items].sort(g.kind === 'new' ? newestFirst : inYearGroup) }))
}

/** 列表里的先后顺序（拍平），删除后选「下一张」、没选过时默认选第一张用 */
export function flatOrder(groups: MapGroup[]): MapSummary[] {
  return groups.flatMap((g) => g.items)
}

/** 删掉 id 之后该选哪张：它后面那张；它是最后一张就选前面那张；没了就 null */
export function neighborAfterDelete(order: MapSummary[], id: string): string | null {
  const i = order.findIndex((m) => m.id === id)
  if (i < 0) return order[0]?.id ?? null
  return order[i + 1]?.id ?? order[i - 1]?.id ?? null
}

// ---------------------------------------------------------------- 笔记文件名
// 和后端 backend/v2/tagnote_note.py 的 note_filename 一致（Windows 和 Obsidian 都能用；Obsidian 链接里不能有 # ^ [ ] |）
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\\/:*?"<>|#^[\]\x00-\x1f]/g

export function noteFilename(title: string): string {
  const name = (title || '').replace(BAD_CHARS, ' ').trim().replace(/\.+$/, '') || '标签笔记'
  return Array.from(name.replace(/\s+/g, ' ')).slice(0, 120).join('') + '.md'
}

// ---------------------------------------------------------------- 存进方案库 / 下载前整理数据
/** 换标题、带上布局缓存（引擎 getLayoutCache() 的结果；空对象就不带） */
export function withTitleAndLayout(data: TagNoteData, title: string, layout?: LayoutCache | null): TagNoteData {
  const out: TagNoteData = { ...data, collection: { ...(data.collection ?? { title }), title } }
  const merged = { ...(data.layout_cache ?? {}), ...(layout ?? {}) }
  if (Object.keys(merged).length) out.layout_cache = merged
  return out
}

// ---------------------------------------------------------------- 布局缓存：防抖保存
export interface DebouncedSaver {
  /** 记下「这张图的布局变了」；delay 毫秒内同一张图只存最后一次 */
  schedule: (id: string, cache: LayoutCache) => void
  /** 立刻把等着的都存掉（卸载时用） */
  flush: () => void
  /** 丢掉这张图还没存的布局（删除这张图之前用，免得删完又 PATCH 一次） */
  cancel: (id: string) => void
  pending: () => string[]
}

export function createDebouncedSaver(save: (id: string, cache: LayoutCache) => void, delay = 800): DebouncedSaver {
  const waiting = new Map<string, { timer: ReturnType<typeof setTimeout>; cache: LayoutCache }>()
  const fire = (id: string) => {
    const w = waiting.get(id)
    if (!w) return
    clearTimeout(w.timer)
    waiting.delete(id)
    save(id, w.cache)
  }
  return {
    schedule(id, cache) {
      const old = waiting.get(id)
      if (old) clearTimeout(old.timer)
      waiting.set(id, { cache, timer: setTimeout(() => fire(id), delay) })
    },
    flush() {
      for (const id of [...waiting.keys()]) fire(id)
    },
    cancel(id) {
      const w = waiting.get(id)
      if (!w) return
      clearTimeout(w.timer)
      waiting.delete(id)
    },
    pending: () => [...waiting.keys()],
  }
}

// ---------------------------------------------------------------- 新建标签笔记的文字
export const UNTITLED = '未命名方案'
/** 作品超过这个数就提示画面会挤 */
export const CROWDED_WORKS = 30

export const TAG_MODE_TEXT: Record<TagMode, string> = {
  map: '和导出的 .canvas 导图上显示的标签一样。',
  full: '含制作人员等零散标签。',
}

/** 生成失败时显示的那一句（和导出 .canvas 的说法一致） */
export function generateErrorText(info: GenerateErrorInfo): string {
  switch (info.code) {
    case 'too_many_works':
      return info.count !== null
        ? `合并后有 ${info.count} 部作品，标签笔记最多 ${info.limit ?? 80} 部。`
        : `合并后的作品太多，标签笔记最多 ${info.limit ?? 80} 部。`
    case 'empty_pool':
      return '候选池为空，先放宽筛选范围。'
    case 'spec_has_errors':
      return `先修好方案中没生效的部分：${info.messages.join('；') || info.message}`
    default:
      return `没生成出来：${info.message}`
  }
}
