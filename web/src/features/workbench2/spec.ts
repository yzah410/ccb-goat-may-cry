/**
 * 工作台方案（SpecV2）的默认值、工厂函数、规整、指纹。纯函数，全部有单测（workbench2.test.ts）。
 *
 * - 默认方案（动画、标签数 6、近 10 年热度前 50 部的主角、每部最多 6 人、按热度、机会均等）
 * - 规整（normalizeSpec）：读本地草稿、打开方案、AI 返回的方案都先过一遍。缺的补默认值、不合法的换默认值并记一条中文警告；
 *   认识的字段按固定顺序排好（指纹稳定），**不认识的字段原样保留**（后端以后可能加字段）。
 */
import type {
  AppearanceRole,
  Condition,
  ConditionType,
  DrawMethod,
  GenderValue,
  ModeId,
  PickOrder,
  PickSpec,
  Quant,
  RangeV2,
  Role,
  Source,
  SpecMeta,
  SpecV2,
  TagFilter,
} from '@/features/v2/types'

// ---------------------------------------------------------------- 常量
export interface ModeDef {
  id: ModeId
  label: string
  /** 这个模式对应的条目类型（和上游 getCharacterAppearances 一致） */
  types: number[]
}

export const MODES: ModeDef[] = [
  { id: 'anime', label: '动画', types: [2] },
  { id: 'game', label: '游戏', types: [4] },
  { id: 'book', label: '书籍', types: [1] },
  { id: 'real', label: '三次元', types: [6] },
  { id: 'all', label: '全部', types: [1, 2, 4, 6] },
]
export const MODE_BY_ID = new Map(MODES.map((m) => [m.id, m]))
export const MODE_IDS = MODES.map((m) => m.id)

/** 条目类型（1 书籍、2 动画、3 音乐、4 游戏、6 三次元）。音乐只在「登场作品」条件里有意义 */
export const SUBJECT_TYPE_LABEL: Record<number, string> = { 1: '书籍', 2: '动画', 3: '音乐', 4: '游戏', 6: '三次元' }
/** 「从哪来」可选的作品类型（顺序 = 界面顺序） */
export const RANK_SUBJECT_TYPES = [2, 4, 1, 6] as const
/** 「登场作品」条件可选的作品类型 */
export const APPEARANCE_SUBJECT_TYPES = [2, 4, 1, 6, 3] as const

export const ROLES: Role[] = ['主角', '配角']
export const APPEARANCE_ROLES: AppearanceRole[] = ['主角', '配角', '客串']
export const GENDERS: GenderValue[] = ['男', '女', '未知']
export const SOURCE_TAG_VALUES = ['原创', '漫画改', '小说改', '游戏改'] as const
export const QUANTS: Quant[] = ['any', 'all', 'at_least', 'none']
export const DRAW_METHODS: DrawMethod[] = ['per_character', 'per_work', 'range_share']

export const TAG_COUNT_MIN = 0
export const TAG_COUNT_MAX = 10
/** 默认作品标签数 6（猜猜呗游戏默认 4，本项目用 6） */
export const DEFAULT_TAG_COUNT = 6
/** 加上配角时每部取几个（和游戏一样：characterNum 默认 6）；只要主角时不限（null） */
export const DEFAULT_PER_WORK = 6
export const DEFAULT_RANK_TO = 50

// ---------------------------------------------------------------- id
function rand4(): string {
  let s = ''
  for (let i = 0; i < 4; i++) s += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 36)]
  return s
}

/** 生成一个不和 taken 重复的 id（范围 r_xxxx、条件 c_xxxx） */
export function newId(prefix: 'r' | 'c', taken: ReadonlySet<string> = new Set()): string {
  for (let i = 0; i < 50; i++) {
    const id = `${prefix}_${rand4()}`
    if (!taken.has(id)) return id
  }
  return `${prefix}_${Date.now().toString(36)}`
}

/** 方案里已经用掉的全部 id（范围 + 排除 + 条件） */
export function takenIds(spec: SpecV2): Set<string> {
  const s = new Set<string>()
  for (const r of [...spec.ranges, ...spec.excludes]) {
    s.add(r.id)
    for (const c of r.conditions) s.add(c.id)
  }
  return s
}

// ---------------------------------------------------------------- 默认值
export function typesOfMode(mode: ModeId): number[] {
  return [...(MODE_BY_ID.get(mode)?.types ?? [2])]
}

export function defaultRankSource(year: number, types: number[] = [2]): Source {
  return {
    kind: 'rank',
    subject_types: [...types],
    year_from: year - 10,
    year_to: year,
    rank_from: 1,
    rank_to: DEFAULT_RANK_TO,
    rank_scope: 'merged',
    work_filter: null,
  }
}

/** 默认：只要主角、每部不限人数（和游戏一样：只要主角时主角全取）、按角色热度 */
export function defaultPick(): PickSpec {
  return { roles: ['主角'], per_work: null, order: 'heat' }
}

/**
 * 换「取哪些角色」时顺带改每部人数（和游戏一样）：只要主角 → 不限；加上配角、原来是不限 → 每部 6 个。
 * 自己填过数字的（不是 null）加上配角时保留。
 */
export function pickWithRoles(p: PickSpec, roles: Role[]): PickSpec {
  const onlyMain = roles.length === 1 && roles[0] === '主角'
  if (onlyMain) return { ...p, roles, per_work: null }
  return { ...p, roles, per_work: p.per_work === null ? DEFAULT_PER_WORK : p.per_work }
}

export function newRange(id: string, source: Source): RangeV2 {
  return { id, enabled: true, label: null, share: null, source, pick: defaultPick(), conditions: [] }
}

/** 打开工作台时的状态（年份按当天算）；和测试里的默认方案 JSON 一模一样（键的顺序也一样） */
export function defaultSpec(today: Date = new Date()): SpecV2 {
  const y = today.getFullYear()
  return {
    version: 2,
    game: { mode: 'anime', tag_count: DEFAULT_TAG_COUNT },
    ranges: [newRange('r_default', defaultRankSource(y))],
    excludes: [],
    draw: { method: 'per_character', seed: null },
  }
}

export function emptyTagFilter(withMode = false): TagFilter {
  return withMode ? { quant: 'any', k: null, tags: [], tag_list_id: null, tag_mode: 'main' } : { quant: 'any', k: null, tags: [], tag_list_id: null }
}

/** 「+ 条件」菜单新建一个条件（先在弹层里填，填好了才加进方案） */
export function newCondition(type: ConditionType, id: string): Condition {
  const base = { id, enabled: true, negate: false }
  switch (type) {
    case 'gender':
      // 不预选：用户点哪个就是哪个（预选一个值的话，用户再点另一个会变成两个都选）
      return { ...base, type, values: [] }
    case 'char_heat':
    case 'n_app':
    case 'earliest_year':
    case 'latest_year':
    case 'rating':
      return { ...base, type, min: null, max: null }
    case 'game_tags':
    case 'char_tags':
      return { ...base, type, ...emptyTagFilter(false) }
    case 'va':
      return { ...base, type, names: [] }
    case 'source_tag':
      return { ...base, type, values: [] }
    case 'appearance':
      return { ...base, type, subject_types: null, year_from: null, year_to: null, roles: null, work_tags: null, work_list_id: null }
    case 'char_list':
      return { ...base, type, list_id: '' }
    case 'sql':
      return { ...base, type, sql: '', label: null }
  }
}

// ---------------------------------------------------------------- 条件是否填完整
export function tagFilterComplete(f: TagFilter | null | undefined): boolean {
  if (!f) return false
  const hasTags = f.tags.length > 0 || !!f.tag_list_id
  if (!hasTags) return false
  if (f.quant === 'at_least') return typeof f.k === 'number' && f.k >= 1
  return true
}

/** 填完整了吗（没填完整的新条件不让加；已有的条件被改空了，界面上提醒） */
export function conditionComplete(c: Condition): boolean {
  switch (c.type) {
    case 'gender':
      return c.values.length > 0
    case 'char_heat':
    case 'n_app':
    case 'earliest_year':
    case 'latest_year':
    case 'rating':
      return c.min != null || c.max != null
    case 'game_tags':
    case 'char_tags':
      return tagFilterComplete(c)
    case 'va':
      return c.names.length > 0
    case 'source_tag':
      return c.values.length > 0
    case 'appearance':
      return (
        (c.subject_types?.length ?? 0) > 0 ||
        c.year_from != null ||
        c.year_to != null ||
        (c.roles?.length ?? 0) > 0 ||
        tagFilterComplete(c.work_tags) ||
        !!c.work_list_id
      )
    case 'char_list':
      return !!c.list_id
    case 'sql':
      return c.sql.trim().length > 0
  }
}

// ---------------------------------------------------------------- 指纹
/** 键按字母排序的 JSON：同样的内容不管键的顺序如何，指纹都一样（本地草稿、后端、AI 给的键顺序可能不同） */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/** 方案指纹（去掉 meta：名字、时间不算「改动」）。用来判断有没有没保存的改动 */
export function specFingerprint(spec: SpecV2): string {
  const { meta: _meta, ...rest } = spec
  return stableStringify(rest)
}

/**
 * 「人数」的查询 key：只放会影响 /v2/evaluate 结果的东西。
 * 抽题方式 / 种子 / 范围名字 / 占比 / meta 都不影响人数，改它们不重新请求。
 */
export function evalKey(spec: SpecV2): string {
  const strip = (r: RangeV2) => {
    const { label: _l, share: _s, ...rest } = r
    return rest
  }
  return stableStringify({ game: spec.game, ranges: spec.ranges.map(strip), excludes: spec.excludes.map(strip) })
}

/** 列候选 / 统计的 key：人数 key + 抽题无关，所以同 evalKey */
export const poolKey = evalKey

// ---------------------------------------------------------------- 规整
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** 把 known 里的键按顺序放前面，再把原对象里不认识的键原样接在后面 */
function withUnknown<T extends object>(known: T, raw: Obj, knownKeys: readonly string[]): T {
  const out: Obj = { ...(known as Obj) }
  for (const [k, v] of Object.entries(raw)) if (!knownKeys.includes(k) && !(k in out)) out[k] = v
  return out as T
}

function intOrNull(v: unknown): number | null {
  return isInt(v) ? v : null
}
function numOrNull(v: unknown): number | null {
  return isNum(v) ? v : null
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []
}
function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)]
}

const TAG_FILTER_KEYS = ['quant', 'k', 'tags', 'tag_list_id', 'tag_mode'] as const

export function normalizeTagFilter(raw: unknown, withMode: boolean, warn: (m: string) => void, where: string): TagFilter | null {
  if (raw == null) return null
  if (!isObj(raw)) {
    warn(`${where}：标签筛选的格式不对，已去掉`)
    return null
  }
  const quant = QUANTS.includes(raw.quant as Quant) ? (raw.quant as Quant) : 'any'
  if (raw.quant !== undefined && quant !== raw.quant) warn(`${where}：认不出量词「${String(raw.quant)}」，改成「含任一」`)
  const k = isInt(raw.k) && raw.k >= 0 ? raw.k : null
  const tags = uniq(strArray(raw.tags).map((t) => t.trim()))
  const tag_list_id = str(raw.tag_list_id) || null
  const out: TagFilter = { quant, k, tags, tag_list_id }
  if (withMode) out.tag_mode = raw.tag_mode === 'any' || raw.tag_mode === 'meta' ? raw.tag_mode : 'main'
  return out
}

function normalizeSource(raw: unknown, year: number, warn: (m: string) => void, where: string): Source {
  if (!isObj(raw)) {
    warn(`${where}：「从哪来」缺了，用默认值（近 10 年热度前 50 部动画）`)
    return defaultRankSource(year)
  }
  switch (raw.kind) {
    case 'rank': {
      let types = uniq(Array.isArray(raw.subject_types) ? raw.subject_types.filter((t): t is number => isInt(t) && t in SUBJECT_TYPE_LABEL) : [])
      if (!types.length) {
        warn(`${where}：没有作品类型，改成动画`)
        types = [2]
      }
      const rank_from = isInt(raw.rank_from) && raw.rank_from >= 1 ? raw.rank_from : 1
      let rank_to = raw.rank_to === null ? null : isInt(raw.rank_to) && raw.rank_to >= 1 ? raw.rank_to : DEFAULT_RANK_TO
      if (rank_to !== null && rank_to < rank_from) rank_to = rank_from
      const known = {
        kind: 'rank' as const,
        subject_types: types,
        year_from: intOrNull(raw.year_from),
        year_to: intOrNull(raw.year_to),
        rank_from,
        rank_to,
        rank_scope: raw.rank_scope === 'per_year' ? ('per_year' as const) : ('merged' as const),
        work_filter: normalizeTagFilter(raw.work_filter, true, warn, `${where}的作品本身的标签`),
      }
      return withUnknown(known, raw, ['kind', 'subject_types', 'year_from', 'year_to', 'rank_from', 'rank_to', 'rank_scope', 'work_filter'])
    }
    case 'work_list':
    case 'char_list': {
      const list_id = str(raw.list_id) ?? ''
      if (!list_id) warn(`${where}：还没选清单`)
      return withUnknown({ kind: raw.kind, list_id }, raw, ['kind', 'list_id'])
    }
    case 'all_characters':
      return withUnknown({ kind: 'all_characters' as const }, raw, ['kind'])
    default:
      warn(`${where}：认不出「从哪来」的类型「${String(raw.kind)}」，换成默认值`)
      return defaultRankSource(year)
  }
}

function normalizePick(raw: unknown): PickSpec {
  if (!isObj(raw)) return defaultPick()
  const roles = ROLES.filter((r) => Array.isArray(raw.roles) && raw.roles.includes(r))
  const rs: Role[] = roles.length ? roles : ['主角']
  const onlyMain = rs.length === 1 && rs[0] === '主角'
  // 没写 per_work：和游戏一样，只要主角 → 不限；加上配角 → 6
  const per_work =
    raw.per_work === null ? null : isInt(raw.per_work) && raw.per_work >= 1 ? raw.per_work : onlyMain && raw.per_work === undefined ? null : DEFAULT_PER_WORK
  // 'bangumi' 是 'game' 的别名（游戏按角色 id 从小到大取，不是 Bangumi 页面顺序）
  const order: PickOrder = raw.order === 'game' || raw.order === 'bangumi' ? 'game' : 'heat'
  const known: PickSpec = { roles: rs, per_work, order }
  return withUnknown(known, raw, ['roles', 'per_work', 'order'])
}

const COND_TYPES: ConditionType[] = [
  'gender',
  'char_heat',
  'game_tags',
  'char_tags',
  'va',
  'source_tag',
  'n_app',
  'earliest_year',
  'latest_year',
  'rating',
  'appearance',
  'char_list',
  'sql',
]

export function normalizeCondition(raw: unknown, taken: Set<string>, warn: (m: string) => void, where: string): Condition | null {
  if (!isObj(raw)) {
    warn(`${where}：有一个条件格式不对，已去掉`)
    return null
  }
  let id = str(raw.id) ?? ''
  if (!id || taken.has(id)) id = newId('c', taken)
  taken.add(id)
  const base = { id, enabled: raw.enabled !== false, negate: raw.negate === true }
  const type = raw.type as ConditionType
  if (!COND_TYPES.includes(type)) {
    warn(`${where}：认不出条件类型「${String(raw.type)}」，原样保留（后端可能不认）`)
    return { ...raw, ...base } as unknown as Condition
  }
  const keep = (known: Obj, keys: string[]) => withUnknown(known, raw, ['id', 'enabled', 'negate', 'type', ...keys]) as unknown as Condition
  switch (type) {
    case 'gender': {
      const values = GENDERS.filter((g) => Array.isArray(raw.values) && raw.values.includes(g))
      return keep({ ...base, type, values }, ['values'])
    }
    case 'char_heat':
    case 'n_app':
    case 'earliest_year':
    case 'latest_year':
    case 'rating': {
      const conv = type === 'rating' ? numOrNull : intOrNull
      return keep({ ...base, type, min: conv(raw.min), max: conv(raw.max) }, ['min', 'max'])
    }
    case 'game_tags':
    case 'char_tags': {
      const f = normalizeTagFilter(raw, false, warn, where) ?? emptyTagFilter(false)
      return keep({ ...base, type, ...f }, [...TAG_FILTER_KEYS])
    }
    case 'va':
      return keep({ ...base, type, names: uniq(strArray(raw.names).map((n) => n.trim())) }, ['names'])
    case 'source_tag':
      return keep({ ...base, type, values: uniq(strArray(raw.values)) }, ['values'])
    case 'appearance': {
      const st = Array.isArray(raw.subject_types) ? uniq(raw.subject_types.filter((t): t is number => isInt(t) && t in SUBJECT_TYPE_LABEL)) : null
      const roles = Array.isArray(raw.roles) ? APPEARANCE_ROLES.filter((r) => (raw.roles as unknown[]).includes(r)) : null
      return keep(
        {
          ...base,
          type,
          subject_types: st && st.length ? st : null,
          year_from: intOrNull(raw.year_from),
          year_to: intOrNull(raw.year_to),
          roles: roles && roles.length ? roles : null,
          work_tags: normalizeTagFilter(raw.work_tags, true, warn, `${where}的登场作品标签`),
          work_list_id: str(raw.work_list_id) || null,
        },
        ['subject_types', 'year_from', 'year_to', 'roles', 'work_tags', 'work_list_id'],
      )
    }
    case 'char_list':
      return keep({ ...base, type, list_id: str(raw.list_id) ?? '' }, ['list_id'])
    case 'sql':
      return keep({ ...base, type, sql: str(raw.sql) ?? '', label: str(raw.label) || null }, ['sql', 'label'])
  }
}

function normalizeRange(raw: unknown, year: number, taken: Set<string>, warn: (m: string) => void, where: string): RangeV2 | null {
  if (!isObj(raw)) {
    warn(`${where}格式不对，已去掉`)
    return null
  }
  let id = str(raw.id) ?? ''
  if (!id || taken.has(id)) id = newId('r', taken)
  taken.add(id)
  const conds = Array.isArray(raw.conditions) ? raw.conditions : []
  const conditions = conds
    .map((c, i) => normalizeCondition(c, taken, warn, `${where}的第 ${i + 1} 个条件`))
    .filter((c): c is Condition => c !== null)
  // 占比可以是 0（这个范围不参与抽题），只有负数 / 不是数字才当没写
  const share = isNum(raw.share) && raw.share >= 0 ? raw.share : null
  const known: RangeV2 = {
    id,
    enabled: raw.enabled !== false,
    label: str(raw.label)?.trim() || null,
    share,
    source: normalizeSource(raw.source, year, warn, where),
    pick: normalizePick(raw.pick),
    conditions,
  }
  return withUnknown(known as unknown as Obj, raw, ['id', 'enabled', 'label', 'share', 'source', 'pick', 'conditions']) as unknown as RangeV2
}

export interface NormalizeResult {
  spec: SpecV2
  warnings: string[]
}

/**
 * 任何来源的方案 → 合法的 SpecV2。
 * 合法方案规整后逐字节不变（往返测试保证）；不认识的字段原样保留。
 */
export function normalizeSpec(raw: unknown, today: Date = new Date()): NormalizeResult {
  const warnings: string[] = []
  const warn = (m: string) => warnings.push(m)
  const year = today.getFullYear()
  if (!isObj(raw)) return { spec: defaultSpec(today), warnings: ['方案不是一个对象，换成了默认方案'] }

  const g = isObj(raw.game) ? raw.game : {}
  let mode: ModeId = 'anime'
  if (MODE_IDS.includes(g.mode as ModeId)) mode = g.mode as ModeId
  else if (g.mode !== undefined) warn(`认不出模式「${String(g.mode)}」，改成动画`)
  let tag_count = DEFAULT_TAG_COUNT
  if (isInt(g.tag_count) && g.tag_count >= TAG_COUNT_MIN && g.tag_count <= TAG_COUNT_MAX) tag_count = g.tag_count
  else if (g.tag_count !== undefined) warn(`作品标签数「${String(g.tag_count)}」不在 0–10 里，改成 ${DEFAULT_TAG_COUNT}`)

  const taken = new Set<string>()
  const ranges = (Array.isArray(raw.ranges) ? raw.ranges : [])
    .map((r, i) => normalizeRange(r, year, taken, warn, `纳入范围 ${i + 1}`))
    .filter((r): r is RangeV2 => r !== null)
  const excludes = (Array.isArray(raw.excludes) ? raw.excludes : [])
    .map((r, i) => normalizeRange(r, year, taken, warn, `排除 ${i + 1}`))
    .filter((r): r is RangeV2 => r !== null)

  const d = isObj(raw.draw) ? raw.draw : {}
  const method: DrawMethod = DRAW_METHODS.includes(d.method as DrawMethod) ? (d.method as DrawMethod) : 'per_character'
  if (d.method !== undefined && method !== d.method) warn(`认不出抽题方式「${String(d.method)}」，改成「每个角色机会均等」`)
  const seed = isInt(d.seed) ? d.seed : null

  const spec: SpecV2 = withUnknown(
    {
      version: 2 as const,
      game: withUnknown({ mode, tag_count }, g, ['mode', 'tag_count']),
      ranges,
      excludes,
      draw: withUnknown({ method, seed }, d, ['method', 'seed']),
    } as unknown as Obj,
    raw,
    ['version', 'game', 'ranges', 'excludes', 'draw', 'meta'],
  ) as unknown as SpecV2
  if (isObj(raw.meta)) {
    const m: SpecMeta = {}
    for (const k of ['name', 'note', 'created', 'updated'] as const) {
      const v = str(raw.meta[k])
      if (v !== null) m[k] = v
    }
    spec.meta = withUnknown(m as Obj, raw.meta, ['name', 'note', 'created', 'updated']) as SpecMeta
  }
  return { spec, warnings }
}

// ---------------------------------------------------------------- 小工具
export function sameSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  const s = new Set(a)
  return b.every((x) => s.has(x))
}

export function allRanges(spec: SpecV2): RangeV2[] {
  return [...spec.ranges, ...spec.excludes]
}

export function findRange(spec: SpecV2, id: string): { range: RangeV2; zone: 'ranges' | 'excludes'; index: number } | null {
  const i = spec.ranges.findIndex((r) => r.id === id)
  if (i >= 0) return { range: spec.ranges[i]!, zone: 'ranges', index: i }
  const j = spec.excludes.findIndex((r) => r.id === id)
  if (j >= 0) return { range: spec.excludes[j]!, zone: 'excludes', index: j }
  return null
}

/** 改某个范围 / 排除项（按 id 找，两个区都找） */
export function mapRange(spec: SpecV2, id: string, f: (r: RangeV2) => RangeV2): SpecV2 {
  if (spec.ranges.some((r) => r.id === id)) return { ...spec, ranges: spec.ranges.map((r) => (r.id === id ? f(r) : r)) }
  if (spec.excludes.some((r) => r.id === id)) return { ...spec, excludes: spec.excludes.map((r) => (r.id === id ? f(r) : r)) }
  return spec
}

export function mapCondition(spec: SpecV2, rangeId: string, condId: string, f: (c: Condition) => Condition): SpecV2 {
  return mapRange(spec, rangeId, (r) => ({ ...r, conditions: r.conditions.map((c) => (c.id === condId ? f(c) : c)) }))
}

/** 范围在界面上叫什么：用户起的名字，否则「范围 N」/「排除 N」 */
export function rangeTitle(spec: SpecV2, id: string): string {
  const hit = findRange(spec, id)
  if (!hit) return '（已删除的范围）'
  return hit.range.label?.trim() || `${hit.zone === 'ranges' ? '范围' : '排除'} ${hit.index + 1}`
}

/** 启用的纳入范围数（抽题方式 C 至少要 2 个） */
export function enabledRangeCount(spec: SpecV2): number {
  return spec.ranges.filter((r) => r.enabled).length
}

/**
 * 换模式时：从「旧模式那类作品」里取的范围，作品类型跟着换（例：动画 → 游戏，范围也改成从游戏里取）。
 * 理由：猜猜呗里「分类」同时决定出题范围和格子怎么算，所以出题范围通常也要跟着换。不需要可以撤销。
 */
export function switchMode(s: SpecV2, mode: ModeId): { spec: SpecV2; moved: string[] } {
  const oldTypes = typesOfMode(s.game.mode)
  const newTypes = typesOfMode(mode)
  const moved: string[] = []
  const move = (zone: 'ranges' | 'excludes') =>
    s[zone].map((r) => {
      if (r.source.kind !== 'rank' || !sameSet(r.source.subject_types, oldTypes) || sameSet(oldTypes, newTypes)) return r
      moved.push(rangeTitle(s, r.id))
      return { ...r, source: { ...r.source, subject_types: [...newTypes] } }
    })
  const spec: SpecV2 = { ...s, game: { ...s.game, mode }, ranges: move('ranges'), excludes: move('excludes') }
  return { spec, moved }
}
