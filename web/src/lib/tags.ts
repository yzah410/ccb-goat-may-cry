/**
 * 作品标签 / 角色标签的展示分组。
 *
 * 注意：这套分组和后端导图用的 canvas_logic.TAG_GROUPS 是两份独立的表，不要当成一回事。
 *
 * 题材标签和制作公司标签分成两组显示（标签数据里两者混在一起）。
 *
 * 文件后半段是「按模式分栏」（columnizeWorkTags 等），规则在同目录 tagRules.json。
 */
import { useSyncExternalStore } from 'react'
import tagRulesRaw from './tagRules.json'

export const PLAYBACK_WHITELIST = ['TV', '剧场版', 'OVA', 'WEB', '动态漫画'] as const
export const SOURCE_TAGS = ['原创', '漫画改', '小说改', '游戏改'] as const

/** 主要题材（绿色高亮） */
const GENRE_PRIMARY = ['恋爱', '奇幻', '科幻', '后宫', '战斗', '校园', '百合', '日常', '治愈', '搞笑', '萌']

/** 次要题材（黄色） */
const GENRE_SECONDARY = [
  '热血', '青春', '运动', '音乐', '偶像', '3D', '悬疑', '猎奇', '推理', '欧美', '国产', '历史', 'BL', '耽美', '童年',
  '冒险', '机战', '萝卜', '竞技', '女性向', '乙女', '党争', '异世界', '泡面番', '催泪', '智斗',
]

/** 制作公司（标签数据里和题材混在一起，这里单独挑出来显示） */
const STUDIOS = [
  'AIC', 'GeekToys', 'ProductionIMS', '动画工房', 'TYOAnimations', '京阿尼', '东映', 'SUNRISE', 'TRIGGER', 'SHIN-EI',
  '日本动画公司', 'Satelight', 'SynergySP', 'GoHands', 'Engi', 'SANZIGEN', 'Troyca', 'A-1Pictures', 'MADHouse', 'BONES',
  'P.A.WORKS', 'MAPPA', 'SHAFT', 'GAINAX', 'J.C.STAFF', 'CloverWorks', 'ScienceSARU', 'CoMixWave', 'PolygonPictures',
  'CygamesPictures', 'ufotable', 'StudioPierrot', 'Production.I.G', 'WHITEFOX', 'LIDENFILMS', 'davidproduction', 'OLM',
  'orange', '手塚PRODUCTION', 'SevenArcs', 'ZEXCS', 'Diomedéa', 'ZERO-G', 'Arms', 'studiodeen', 'SILVERLINK.', 'BrainsBase',
  'Lerche', '8bit', 'Feel', 'GONZO', 'WITSTUDIO', 'TMS', 'StudioBind', 'KINEMACITRUS', '龙之子', 'XEBEC', 'Studio4℃',
]

/** 角色标签里要高亮的那些（可按需增删） */
const CHAR_HIGHLIGHT = [
  '异色瞳', '金瞳', '红瞳', '黑发', '巨乳', '温柔', '高中生', '反差萌', '腹黑', '大小姐', '特殊瞳孔', '遮单眼发', '下双马尾',
  'S属性', '眼罩', '女王(性格)', '狂气', '转学生', '嗜杀', '凛娇', '紫瞳', '红发', '短发', '呆毛', '萝莉', '实妹', '小天使',
  '单纯', '老好人', '双丸子头', '阿卡林',
]

const S_PRIMARY = new Set(GENRE_PRIMARY)
const S_SECONDARY = new Set(GENRE_SECONDARY)
const S_STUDIO = new Set(STUDIOS)
const S_PLAYBACK = new Set<string>(PLAYBACK_WHITELIST)
const S_SOURCE = new Set<string>(SOURCE_TAGS)
const S_CHAR_HI = new Set(CHAR_HIGHLIGHT)

export type WorkTagClass = 'genre-primary' | 'genre-secondary' | 'studio' | 'playback' | 'source' | 'other'

export function classifyWorkTag(tag: string): WorkTagClass {
  if (S_PLAYBACK.has(tag)) return 'playback'
  if (S_SOURCE.has(tag)) return 'source'
  if (S_PRIMARY.has(tag)) return 'genre-primary'
  if (S_SECONDARY.has(tag)) return 'genre-secondary'
  if (S_STUDIO.has(tag)) return 'studio'
  return 'other'
}

export interface GroupedWorkTags {
  genrePrimary: string[]
  genreSecondary: string[]
  studios: string[]
  /** 不在任何预设分组里的（折叠在「更多」里） */
  other: string[]
}

/** 按白名单顺序分组，保证同一角色每次显示顺序一致 */
export function groupWorkTags(tags: readonly string[] | null | undefined): GroupedWorkTags {
  const set = new Set(tags ?? [])
  const pick = (list: readonly string[]) => list.filter((t) => set.has(t))
  const known = new Set([...GENRE_PRIMARY, ...GENRE_SECONDARY, ...STUDIOS, ...PLAYBACK_WHITELIST, ...SOURCE_TAGS])
  return {
    genrePrimary: pick(GENRE_PRIMARY),
    genreSecondary: pick(GENRE_SECONDARY),
    studios: pick(STUDIOS),
    other: [...set].filter((t) => !known.has(t) && !/^\d{4}$/.test(t)),
  }
}

export function splitCharTags(tags: readonly string[] | null | undefined): { highlight: string[]; rest: string[] } {
  const list = tags ?? []
  return { highlight: list.filter((t) => S_CHAR_HI.has(t)), rest: list.filter((t) => !S_CHAR_HI.has(t)) }
}

export function isPlayback(tag: string): boolean {
  return S_PLAYBACK.has(tag)
}

// ================================================================ 按模式分栏
//
// 规则：tagRules.json（想加减标签直接改那个文件）。每个模式一组分组：
//   column 1 = 第一栏：只放非常通用、普适、基础的作品属性（动画 = 来源 + 播放形式；游戏 = 平台；书籍 = 形式 + 状态；三次元 = 形式 + 来源）
//   column 2 = 第二栏：题材 / 类别 / 公司
//   其余标签收进「+N 个标签」（鼠标移上去看）。
// 组内按列表顺序显示（不是按标注数）；hidden_patterns（四位数年份）哪一栏都不进，也不进「+N」；
// 「日本」不在任何列表里，所以进「+N」。
// 混合标签（「全部」模式，或者任何模式下走「退回规则」的角色 = 接口 grid.fallback 为 true；标签来自多种作品）：
//   - 一个标签在几个模式里都有时，按 union_order（动画 → 游戏 → 书籍 → 三次元）第一个出现的算；
//   - 角色有动画登场（接口 has_anime 为 true）：第一栏只放动画的第一栏分组（来源 + 播放形式），
//     别的模式的第一栏分组（书籍的形式、游戏的平台……）降到第二栏；
//   - 没有动画登场：四个模式的分组直接合在一起用，各模式的第一栏分组都留在第一栏；
//   - 两种情况第二栏都是动画的分组排最前，其余按 union_order（每个模式里按它自己的分组顺序）。
//   （tagRules.json 里 mixed.anime_first_when_has_anime 改成 false，就不看 has_anime、一律按「没有动画登场」算。）
// 动画模式的列表和上面的常量完全一样（有测试逐项对照）。

/** 标签配色：source 来源色、playback 播放形式色、genre-primary 绿色高亮、genre-secondary 次要题材色、studio 公司样式 */
export type TagStyle = 'source' | 'playback' | 'genre-primary' | 'genre-secondary' | 'studio'
export type TagRuleMode = 'anime' | 'game' | 'book' | 'real'
export const TAG_RULE_MODES: readonly TagRuleMode[] = ['anime', 'game', 'book', 'real']

export interface TagGroupRule {
  /** 例 `anime.source`（并集里各模式的组 id 会重名，用它区分） */
  key: string
  id: string
  mode: TagRuleMode
  /** 例「来源」「平台」（统计页「最常见的标签」的小标题） */
  label: string
  /** 这套规则里它在第几栏（混合规则里可能和 tagRules.json 写的不同，见 demoted） */
  column: 1 | 2
  style: TagStyle
  tags: readonly string[]
  /** 混合规则（角色有动画登场）里从第一栏降到第二栏的组 */
  demoted?: boolean
}

/**
 * 用哪套规则：
 * - anime / game / book / real：这个模式自己的；
 * - mixed：混合标签、角色没有动画登场（四个模式合在一起，各自的第一栏留在第一栏）；
 * - mixed-anime：混合标签、角色有动画登场（第一栏只留动画的来源 + 播放形式）。
 */
export type TagRuleKind = TagRuleMode | 'mixed' | 'mixed-anime'

export interface TagRuleSet {
  kind: TagRuleKind
  /** 显示顺序（第一栏、第二栏各自按这个顺序排组） */
  groups: readonly TagGroupRule[]
  /** 标签 → 它归哪一组 */
  byTag: ReadonlyMap<string, TagGroupRule>
}

const TAG_STYLES: readonly TagStyle[] = ['source', 'playback', 'genre-primary', 'genre-secondary', 'studio']
const isRuleMode = (m: unknown): m is TagRuleMode => typeof m === 'string' && (TAG_RULE_MODES as readonly string[]).includes(m)

type RawRules = { hidden_patterns?: unknown; modes?: Record<string, unknown>; union_order?: unknown; mixed?: { anime_first_when_has_anime?: unknown } }
const RAW = tagRulesRaw as RawRules
/** mixed.anime_first_when_has_anime（默认 true） */
const ANIME_FIRST_WHEN_HAS_ANIME = RAW.mixed?.anime_first_when_has_anime !== false

/** 读 tagRules.json：字段不对的组跳过（开发时 warn），同一组里重复的标签只留第一个 */
function loadGroups(mode: TagRuleMode): TagGroupRule[] {
  const list = RAW.modes?.[mode]
  if (!Array.isArray(list)) return []
  const out: TagGroupRule[] = []
  for (const g of list as (Record<string, unknown> | null)[]) {
    const col = g?.column
    const column = col === 1 || col === 2 ? col : null
    const style = g?.style as TagStyle
    if (!g || typeof g.id !== 'string' || !column || !TAG_STYLES.includes(style) || !Array.isArray(g.tags)) {
      if (import.meta.env.DEV) console.warn('[tagRules] 跳过了一组写得不对的规则', mode, g)
      continue
    }
    const tags = [...new Set((g.tags as unknown[]).filter((t): t is string => typeof t === 'string' && t.length > 0))]
    out.push({ key: `${mode}.${g.id}`, id: g.id, mode, label: typeof g.label === 'string' ? g.label : g.id, column, style, tags })
  }
  return out
}

const HIDDEN_PATTERNS: RegExp[] = (Array.isArray(RAW.hidden_patterns) ? RAW.hidden_patterns : ['^\\d{4}$'])
  .filter((p): p is string => typeof p === 'string')
  .map((p) => new RegExp(p))

const UNION_ORDER: TagRuleMode[] = (() => {
  const u = Array.isArray(RAW.union_order) ? RAW.union_order.filter(isRuleMode) : []
  // union_order 里漏写的模式补在后面（不会因为少写一个模式就丢掉整套规则）
  return [...new Set([...u, ...TAG_RULE_MODES])]
})()

/**
 * groups 按「谁先出现谁拥有这个标签」建索引，再按显示顺序排：第一栏的组在前（保持原顺序），第二栏的组在后（保持原顺序）。
 * 同一个标签在几组里都有时，byTag 指向第一个（混合规则里 = union_order 最靠前的模式）。
 */
function buildSet(kind: TagRuleKind, groups: TagGroupRule[]): TagRuleSet {
  const byTag = new Map<string, TagGroupRule>()
  for (const g of groups) for (const t of g.tags) if (!byTag.has(t)) byTag.set(t, g)
  return { kind, groups: [...groups.filter((g) => g.column === 1), ...groups.filter((g) => g.column === 2)], byTag }
}

/** 动画模式的题材两组（genre1 加粗 = 第 1 档）：没设置过分档时 = tagRules.json 原样 */
export interface AnimeTierOverride {
  /** 第 1 档（加粗的题材） */
  primary: readonly string[]
  /** 第 2–4 档（普通题材），按档的顺序 */
  secondary: readonly string[]
}

function buildRuleSets(override: AnimeTierOverride | null): Record<TagRuleKind, TagRuleSet> {
  const per = Object.fromEntries(TAG_RULE_MODES.map((m) => [m, loadGroups(m)])) as Record<TagRuleMode, TagGroupRule[]>
  if (override) per.anime = per.anime.map((g) => overrideGenre(g, override))
  // 混合规则的模式顺序：union_order（动画在最前）；「第二栏里动画的分组排最前」由这个顺序保证
  const ordered = UNION_ORDER.flatMap((m) => per[m])
  // 有动画登场：动画以外的模式的第一栏分组降到第二栏（保持各自模式里的相对顺序，所以第二栏 = 动画的组，然后按 union_order 每个模式一段）
  const demoted = ordered.map((g) => (g.mode !== 'anime' && g.column === 1 ? { ...g, column: 2 as const, demoted: true } : g))
  return {
    anime: buildSet('anime', per.anime),
    game: buildSet('game', per.game),
    book: buildSet('book', per.book),
    real: buildSet('real', per.real),
    mixed: buildSet('mixed', ordered),
    'mixed-anime': buildSet('mixed-anime', demoted),
  }
}

/**
 * 按分档改动画模式的 genre1 / genre2：genre1 = 第 1 档；genre2 = 第 2–4 档，再接上 tagRules.json 的 genre2 里
 * 不在任何一档的标签（例：耽美），保证这些已知的题材不会掉进「+N 个标签」。
 */
function overrideGenre(g: TagGroupRule, o: AnimeTierOverride): TagGroupRule {
  if (g.id === 'genre1') return { ...g, tags: [...new Set(o.primary)] }
  if (g.id !== 'genre2') return g
  const first = new Set(o.primary)
  return { ...g, tags: [...new Set([...o.secondary, ...g.tags])].filter((t) => !first.has(t)) }
}

let RULE_SETS: Record<TagRuleKind, TagRuleSet> = buildRuleSets(null)

// ---------------------------------------------------------------- 标签分档（设置页 / 开局问卷，后端 /v2/tiers）
let rulesVersion = 0
const rulesListeners = new Set<() => void>()

/**
 * 换动画模式的题材分组（null = 回到 tagRules.json 原样）。用分栏结果的组件要调 useTagRulesVersion()，换完会重画。
 * 由 features/tiers 在读到 /v2/tiers 以后调用；分档和默认值一样时传 null，按 tagRules.json 原样显示。
 */
export function setAnimeTierOverride(o: AnimeTierOverride | null): void {
  RULE_SETS = buildRuleSets(o)
  rulesVersion += 1
  for (const fn of rulesListeners) fn()
}

/** 订阅分栏规则的变化（返回版本号，只用来触发重画） */
export function useTagRulesVersion(): number {
  return useSyncExternalStore(
    (fn) => {
      rulesListeners.add(fn)
      return () => rulesListeners.delete(fn)
    },
    () => rulesVersion,
  )
}

export interface TagRuleOptions {
  /** 这个角色是「退回规则」算出来的（接口里 grid.fallback = true）→ 混合规则 */
  fallback?: boolean
  /** 角色有动画登场（接口里 has_anime）；只在混合规则里有用。没有这个字段时按 false 处理 */
  hasAnime?: boolean
}

/**
 * 某个角色的作品标签用哪套分栏规则。
 * @param mode 对局模式（anime / game / book / real / all）；all 或者不认识的值 → 混合规则
 */
export function tagRuleSet(mode: string | null | undefined, opts: TagRuleOptions = {}): TagRuleSet {
  if (!opts.fallback && isRuleMode(mode)) return RULE_SETS[mode]
  return opts.hasAnime && ANIME_FIRST_WHEN_HAS_ANIME ? RULE_SETS['mixed-anime'] : RULE_SETS.mixed
}

/** 四位数年份这类（tagRules.json 的 hidden_patterns）：哪一栏都不显示，也不算进「+N 个标签」 */
export function isHiddenWorkTag(tag: string): boolean {
  return HIDDEN_PATTERNS.some((r) => r.test(tag))
}

/** 这个标签在这套规则里归哪一组（不在任何组里 / 被隐藏 → null） */
export function workTagGroup(tag: string, rules: TagRuleSet): TagGroupRule | null {
  if (isHiddenWorkTag(tag)) return null
  return rules.byTag.get(tag) ?? null
}

export interface TagGroupHit {
  group: TagGroupRule
  /** 这一组里角色有的标签，按规则列表的顺序 */
  tags: string[]
}

export interface WorkTagColumns {
  /** 第一栏（作品属性），按组的顺序；空组不出现 */
  col1: TagGroupHit[]
  /** 第二栏（题材 / 类别 / 公司） */
  col2: TagGroupHit[]
  /** 其余（「+N 个标签」里的），保持传进来的顺序（= 游戏里的得分顺序） */
  other: string[]
  rules: TagRuleSet
}

/**
 * 把一个角色的作品标签（接口的 work_tags / grid.tags）按模式分成三栏。
 * 例（动画，后藤一里）：第一栏「漫画改 | TV 剧场版」，第二栏「百合 日常 搞笑 | 音乐 | CloverWorks」，其余 6 个进「+N」。
 * @param opts.fallback 接口的 grid.fallback；opts.hasAnime 接口的 has_anime（混合规则用）
 */
export function columnizeWorkTags(
  tags: readonly string[] | null | undefined,
  mode: string | null | undefined,
  opts: TagRuleOptions = {},
): WorkTagColumns {
  const rules = tagRuleSet(mode, opts)
  const present = new Set<string>()
  const other: string[] = []
  for (const t of tags ?? []) {
    if (typeof t !== 'string' || !t || present.has(t) || isHiddenWorkTag(t)) continue
    present.add(t)
    if (!rules.byTag.has(t)) other.push(t)
  }
  const col1: TagGroupHit[] = []
  const col2: TagGroupHit[] = []
  for (const g of rules.groups) {
    const hit = g.tags.filter((t) => present.has(t) && rules.byTag.get(t) === g)
    if (hit.length) (g.column === 1 ? col1 : col2).push({ group: g, tags: hit })
  }
  return { col1, col2, other, rules }
}

// ---------------------------------------------------------------- 统计页「最常见的标签」按模式分节
export interface TagCountItem {
  tag: string
  count: number
  /** 归哪类（决定颜色）；不在任何组里 = null（灰色） */
  style: TagStyle | null
}

export interface TagCountSection {
  /** 小标题：第一栏每组一节（同名的组合并，例如「全部」模式里动画和三次元都有「来源」、书籍和三次元都有「形式」） */
  label: string
  items: TagCountItem[]
}

export interface StatsTagInput {
  top_work_tags?: readonly { tag: string; count: number }[] | null
  /** 来源标签的人数（后端把来源标签从 top_work_tags 里拿出来单独数） */
  source?: Readonly<Record<string, number>> | null
  /** 播放形式的人数（同上：TV / 剧场版 / OVA / WEB / 动态漫画） */
  playback?: Readonly<Record<string, number>> | null
}

/**
 * 统计页「最常见的标签」：第一栏的每个分组各一节（动画 = 来源 / 播放形式；游戏 = 平台；书籍 = 形式 / 状态；三次元 = 形式 / 来源），
 * 其余合成「作品标签」一节（按分类配色）。每节按人数从多到少。
 * 「全部」模式按「没有动画登场」的混合规则分节（四个模式的第一栏分组都各成一节）：统计是整个题库合起来的，看不了单个角色有没有动画登场。
 * 注意：后端只给最常见的 30 个作品标签（来源、播放形式另算、是全的），所以少见的平台 / 形式可能不在里面。
 */
export function statsTagSections(
  stats: StatsTagInput | null | undefined,
  mode: string | null | undefined,
  opts: { workLimit?: number } = {},
): { sections: TagCountSection[]; workTags: TagCountItem[] } {
  const rules = tagRuleSet(mode, { hasAnime: false })
  const counts = new Map<string, number>()
  const add = (tag: string, n: number) => {
    if (!tag || !(n > 0) || isHiddenWorkTag(tag)) return
    counts.set(tag, Math.max(counts.get(tag) ?? 0, n))
  }
  for (const x of stats?.top_work_tags ?? []) add(x.tag, x.count)
  for (const [t, n] of Object.entries(stats?.source ?? {})) add(t, n)
  for (const [t, n] of Object.entries(stats?.playback ?? {})) add(t, n)

  // 稳定排序：人数一样时保持后端给的顺序
  const byCount = [...counts.entries()].map(([tag, count]) => ({ tag, count, group: rules.byTag.get(tag) ?? null })).sort((a, b) => b.count - a.count)
  const sectionMap = new Map<string, TagCountSection>()
  for (const g of rules.groups) if (g.column === 1 && !sectionMap.has(g.label)) sectionMap.set(g.label, { label: g.label, items: [] })
  const workTags: TagCountItem[] = []
  for (const x of byCount) {
    const item: TagCountItem = { tag: x.tag, count: x.count, style: x.group?.style ?? null }
    if (x.group?.column === 1) sectionMap.get(x.group.label)!.items.push(item)
    else workTags.push(item)
  }
  return {
    sections: [...sectionMap.values()].filter((s) => s.items.length > 0),
    workTags: workTags.slice(0, opts.workLimit ?? 16),
  }
}
