/**
 * 出题器的前后端共用类型（镜像后端的 SpecV2 和接口返回）。
 * 后端多给的字段前端原样保留。
 */
import type { StatsResp } from '@/features/candidates/types'

// ---------------------------------------------------------------- 方案（SpecV2）
export type ModeId = 'anime' | 'game' | 'book' | 'real' | 'all'
/** 取角色时的角色身份 */
export type Role = '主角' | '配角'
/** 登场作品条件里的身份（多一个「客串」） */
export type AppearanceRole = '主角' | '配角' | '客串'
/** 含任一 / 含全部 / 至少含 k 个 / 都不含 */
export type Quant = 'any' | 'all' | 'at_least' | 'none'
export type GenderValue = '男' | '女' | '未知'
export type DrawMethod = 'per_character' | 'per_work' | 'range_share'
/**
 * 每部取前 N 名按什么排：heat = 角色热度（默认）；game = 和游戏一样。
 * 游戏按接口返回的顺序取，接口按角色 id 从小到大排（不是 Bangumi 页面顺序）。'bangumi' 是 'game' 的别名，读进来时当作 'game'。
 */
export type PickOrder = 'heat' | 'game'
export type RankScope = 'merged' | 'per_year'

export interface TagFilter {
  quant: Quant
  k?: number | null
  tags: string[]
  /** 和 tags 取并集 */
  tag_list_id?: string | null
  /**
   * 只对「作品本身的标签」有意义：main = 标注数 ≥ 该作品最高标签的 10%（默认）；any = 有人打过就算；
   * meta = Bangumi 公共标签（游戏的 Galgame 模式按它筛；补全用 kind=meta_tag）
   */
  tag_mode?: 'main' | 'any' | 'meta'
}

export interface RankSource {
  kind: 'rank'
  subject_types: number[]
  year_from: number | null
  year_to: number | null
  rank_from: number
  /** null = 全部 */
  rank_to: number | null
  rank_scope: RankScope
  /** 作品本身的标签（后端按游戏的做法：先筛再排名） */
  work_filter?: TagFilter | null
  /** 今天还没上映的作品算不算名次（默认 false，和游戏一样） */
  include_unaired?: boolean
  /**
   * 作品本身的标签什么时候生效。before_rank（默认，和游戏一样）= 先只留带这些标签的作品、再按热度取第 N 名；
   * after_rank = 先按热度取第 N 名、再只留带这些标签的
   */
  work_filter_order?: 'before_rank' | 'after_rank'
}
export interface WorkListSource {
  kind: 'work_list'
  list_id: string
}
export interface CharListSource {
  kind: 'char_list'
  list_id: string
}
export interface AllCharactersSource {
  kind: 'all_characters'
}
export type Source = RankSource | WorkListSource | CharListSource | AllCharactersSource
export type SourceKind = Source['kind']

export interface PickSpec {
  /** 默认 ['主角'] */
  roles: Role[]
  /** 每部最多取几人；null = 不限。默认：只要主角 → null（和游戏一样，主角全取）；加上配角 → 6 */
  per_work: number | null
  /** 默认 heat */
  order: PickOrder
}

interface CondBase {
  id: string
  enabled: boolean
  negate: boolean
}
export type NumericCondType = 'char_heat' | 'n_app' | 'earliest_year' | 'latest_year' | 'rating'
export type TagCondType = 'game_tags' | 'char_tags'

export type GenderCond = CondBase & { type: 'gender'; values: GenderValue[] }
export type NumericCond = CondBase & { type: NumericCondType; min?: number | null; max?: number | null }
export type TagCond = CondBase & { type: TagCondType } & TagFilter
export type VaCond = CondBase & { type: 'va'; names: string[] }
export type SourceTagCond = CondBase & { type: 'source_tag'; values: string[] }
export type AppearanceCond = CondBase & {
  type: 'appearance'
  subject_types?: number[] | null
  year_from?: number | null
  year_to?: number | null
  roles?: AppearanceRole[] | null
  work_tags?: TagFilter | null
  work_list_id?: string | null
}
export type CharListCond = CondBase & { type: 'char_list'; list_id: string }
export type SqlCond = CondBase & { type: 'sql'; sql: string; label?: string | null }

export type Condition = GenderCond | NumericCond | TagCond | VaCond | SourceTagCond | AppearanceCond | CharListCond | SqlCond
export type ConditionType = Condition['type']

export interface RangeV2 {
  /** 前端生成，例 r_k3x9 */
  id: string
  enabled: boolean
  label?: string | null
  /** 只在 draw.method = range_share 时有意义，默认 1 */
  share?: number | null
  source: Source
  pick: PickSpec
  /** 彼此之间是「且」 */
  conditions: Condition[]
}

export interface SpecMeta {
  name?: string
  note?: string
  created?: string
  updated?: string
}

export interface SpecV2 {
  version: 2
  game: { mode: ModeId; tag_count: number }
  /** 纳入：彼此之间是「或」 */
  ranges: RangeV2[]
  /** 排除：永远最后生效 */
  excludes: RangeV2[]
  draw: { method: DrawMethod; seed?: number | null }
  meta?: SpecMeta
}

// ---------------------------------------------------------------- /v2/evaluate
export interface EvalStep {
  condition_id: string
  before: number
  after: number
  removed: number
  /** 这一步为什么没筛（停用 / 没填内容 / 出错） */
  skipped?: null | 'disabled' | 'empty' | 'error'
  error?: string | null
}
export interface EvalRange {
  id: string
  sentence: string
  works: number | null
  picked: number
  steps: EvalStep[]
  final: number
  /** 只有这个范围有的人（= 删掉这个范围题库会少多少人） */
  unique: number
  error?: string | null
  /** 这个范围是否启用（停用的范围也照算一遍） */
  enabled?: boolean
  /** 这个范围里最终在题库里的人数（排除之后） */
  in_pool?: number
}
export interface EvalExclude {
  id: string
  sentence: string
  matched: number
  removed_from_pool: number
  error?: string | null
  steps?: EvalStep[]
  works?: number | null
  picked?: number
  enabled?: boolean
}
export interface EvaluateResp {
  total: number
  ranges: EvalRange[]
  excludes: EvalExclude[]
  warnings: string[]
  elapsed_ms: number
  /** 补全后的方案、是否命中缓存、第一次算的耗时 */
  spec?: SpecV2
  cached?: boolean
  compute_ms?: number
  /** 启用中的范围 / 排除项里没生效的部分（清单被删了、SQL 出错……）；界面上醒目提示 */
  errors?: { where: 'range' | 'exclude' | string; id: string; index?: number; message: string }[]
}

// ---------------------------------------------------------------- 候选 / 抽题
export interface GridV2 {
  mode: ModeId
  n: number
  tags: string[]
  n_app: number
  earliest: number | null
  latest: number | null
  rating: number | null
  source_tag: string | null
  fallback: boolean
}

export interface CandidateV2 {
  char_id: number
  character: {
    id: number
    name: string
    /** '♂' | '♀' | '?' */
    gender: string
    heat: number
    max_score?: number | null
    earliest_year?: number | null
    latest_year?: number | null
  }
  /** 固定 'char-weight'：「当前题目」和自动点击认识它 */
  mode: 'char-weight'
  weight: 1
  bound_work: { id: number; name: string; year: number | null } | null
  /** 游戏格子里的登场作品名（最多 10 个） */
  appearances: string[]
  /** = grid.tags */
  work_tags: string[]
  char_tags: string[]
  source_tag: string | null
  grid: GridV2
  vas: string[]
  /** 落在哪些范围里（范围 id） */
  ranges: string[]
  /** 角色有没有动画登场（作品标签的「混合规则」用，见 lib/tags.ts）；没有这个字段时当成 false */
  has_anime?: boolean
}

/** 题库是空的时候后端返回 char_id: null、character: null */
export type DrawV2 = CandidateV2 & { range_id: string | null; pool_total: number; seed: number; method?: DrawMethod }
export type DrawV2Resp = DrawV2 | (Omit<DrawV2, 'char_id' | 'character'> & { char_id: null; character: null })

export type CandidateSort = 'heat' | 'name' | 'random'

export interface CandidatesV2Resp {
  /** 按名字搜过之后的人数（后端另给 pool_total = 题库总人数） */
  total: number
  pool_total?: number
  page: number
  page_size: number
  items: CandidateV2[]
}

/** /v2/stats：形状同 features/candidates/types.ts 的 StatsResp */
export type StatsV2Resp = StatsResp

export interface CharacterDetail {
  character: CandidateV2['character'] & Record<string, unknown>
  grid: GridV2
  appearances: { subject_id: number; name: string; type: number; year: number | null; relation: string; heat: number }[]
  vas: string[]
  char_tags: string[]
}

// ---------------------------------------------------------------- /v2/meta
export interface ModeInfo {
  id: ModeId
  label: string
  types: number[]
}
export interface MetaResp {
  db: {
    path?: string
    dump_name?: string
    built_at?: string
    today?: string
    counts?: Record<string, number>
    tags_api_subjects?: number
    tags_dump_subjects?: number
    [k: string]: unknown
  }
  modes: ModeInfo[]
  default_spec: SpecV2
  tag_count_range: [number, number]
}

// ---------------------------------------------------------------- /v2/suggest
export type SuggestKind = 'game_tag' | 'work_tag' | 'meta_tag' | 'char_tag' | 'va' | 'work' | 'character'
export interface SuggestItem {
  value: string
  label: string
  count: number
  id?: number
}

// ---------------------------------------------------------------- 清单
export type ListKind = 'character' | 'work' | 'tag'
export interface ListItemV2 {
  id?: number
  name: string
}
export interface ListV2 {
  id: string
  name: string
  kind: ListKind
  items: ListItemV2[]
  note?: string | null
  created?: string
  updated?: string
  /** 保存角色 / 作品清单时，只有名字的项按库里的名字补 id 的结果 */
  resolve_report?: { resolved?: number; ambiguous?: { name: string; candidates?: unknown[]; picked?: unknown }[]; unresolved?: string[] } | null
}

// ---------------------------------------------------------------- 方案（存储）
export interface PlanV2Summary {
  name: string
  file?: string
  mode?: string
  updated?: string | null
  created?: string | null
  note?: string | null
  total?: number | null
}

// ---------------------------------------------------------------- 问数据 / SQL
export interface SqlColumnInfo {
  name: string
  type?: string
  /** 一句中文说明 */
  note?: string
  [k: string]: unknown
}
export interface SqlTableInfo {
  name: string
  kind?: 'table' | 'view' | 'temp' | string
  note?: string
  columns: SqlColumnInfo[]
  [k: string]: unknown
}
export interface SqlSchemaResp {
  tables: SqlTableInfo[]
  notes?: string[] | string
  /** 例子：一句话 + SQL */
  examples?: { q: string; sql: string }[]
  [k: string]: unknown
}
export interface SqlResp {
  columns: string[]
  rows: unknown[][]
  truncated: boolean
  elapsed_ms: number
}

// ---------------------------------------------------------------- AI
/** api = 后端直接调服务商的接口（默认）；claude / codex = 本机命令行 */
export type AiEngineId = 'api' | 'claude' | 'codex'
export interface AiEngine {
  id: AiEngineId
  available: boolean
  channel_ok: boolean
  note?: string | null
  /** 给人看的名字：api 是服务商名或接口域名，命令行是「Claude（本机命令行）」这样 */
  label?: string | null
  model?: string | null
}
export interface AiStatusResp {
  engines: AiEngine[]
  default: AiEngineId | null
}
export interface AiFillResp {
  ok: boolean
  spec: SpecV2
  changes: string[]
  defaults_used: string[]
  note?: string | null
  alternative?: { label: string; spec: SpecV2; total: number } | null
  total: number
  engine: string
  elapsed_ms: number
  error?: string | null
  /** 人数是 0 或太多时，后端算好的放宽 / 收紧建议 */
  suggestions?: { desc: string; total: number }[] | null
  /** 提示，例「角色的作品标签『xx』库里没有（最接近：…）」 */
  warnings?: string[] | null
  error_code?: string | null
}
export interface AiAskResp {
  ok: boolean
  sql: string
  explanation: string
  scope_note: string
  columns: string[]
  rows: unknown[][]
  truncated: boolean
  save_hint?: { kind: ListKind; id_column: string } | null
  engine: string
  elapsed_ms: number
  error?: string | null
}

// ---------------------------------------------------------------- /v2/status（不阻塞）
export interface V2Status {
  phase: 'idle' | 'loading' | 'ready' | 'no_db' | 'error' | string
  /** 例「读取动画模式画像」 */
  stage?: string | null
  db_path?: string
  loaded_modes?: string[]
  ready?: boolean
}

// ---------------------------------------------------------------- AI：流式接口与预热
// 后端：预热进程池 + 流式接口（SSE）。填工作台时 AI 输出对当前方案的修改（JSON Patch），标签名不存在时后端自动换或给候选；
// 问数据先写说明再写 SQL，写完自动运行，SQL 报错不自动重试（fixable = true，前端给「让 AI 改」）。
export type AiKind = 'fill' | 'ask'
/** 名字属于哪一类（和后端一致）：角色的作品标签 / 角色标签 / 作品本身的标签 / 公共标签 / 声优 */
export type AiNameStyle = 'game' | 'char' | 'work' | 'meta' | 'va'
export interface AiTiming {
  /** 发出请求 → AI 写出第一个字（毫秒，后端计时） */
  ai_first_token_ms?: number | null
  /** 发出请求 → AI 写完（毫秒，后端计时；不含后端算人数 / 跑 SQL） */
  ai_total_ms?: number | null
  /** 用的是不是提前开好的 AI 进程 */
  warm?: boolean | null
  /** 用的预热进程开了多少秒（刚开不久的进程可能还在启动，会慢一点） */
  warm_age_s?: number | null
  ai_output_tokens?: number | null
}
export interface AiNameCandidate {
  name: string
  count: number
}
/** 后端已经自动换掉的名字（唯一且足够接近）：例「你说的『后宫番』库里叫『后宫』，已替换」 */
export interface AiTagReplaced {
  from: string
  to: string
  /** 换成的那个写法在库里有多少个 */
  to_count?: number | null
  style: AiNameStyle
  what: string
  /** 换得不对时可以改选的其它写法 */
  others: AiNameCandidate[]
  message: string
}
/** 后端拿不准、原样保留的名字：前端给可点的替换按钮 */
export interface AiTagFix {
  name: string
  style: AiNameStyle
  what: string
  candidates: AiNameCandidate[]
  message: string
}
export interface AiFillResult extends AiFillResp, AiTiming {
  tag_replaced?: AiTagReplaced[]
  tag_fixes?: AiTagFix[]
  /** AI 输出了几条修改（-1 = AI 没给修改列表，直接给了整份方案） */
  patch_ops?: number | null
  sentences?: string[]
  /** note 拆开的两半：AI 自己的话 / 后端的放宽收紧模板句（有 suggestions 列表时界面只显示 ai_note，免得同一组建议出现两遍） */
  ai_note?: string | null
  suggestion_note?: string | null
}
export interface AiAskResult extends AiAskResp, AiTiming {
  /** SQL 运行耗时（毫秒）；SQL 报错时为 null */
  sql_ms?: number | null
  /** SQL 报错了、可以点「让 AI 改」 */
  fixable?: boolean
  error_code?: string | null
  /** SQL 的原始报错（发给「让 AI 改」用） */
  sql_error?: string | null
  /** 这次是「让 AI 改」的结果时：改之前的 SQL */
  fixed_from?: string | null
  scope_facts?: string | null
}
export interface AiStreamStatus {
  /** start / queue / thinking / writing / checking / sql / restart */
  stage: string
  message: string
  /** 从请求开始算的毫秒数 */
  ms: number
  warm?: boolean
}
export interface AiWarmResp {
  ok: boolean
  warming: AiKind[]
  note?: string | null
}
