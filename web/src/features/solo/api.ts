/**
 * 单人猜猜呗的接口（后端 /v2/solo/*）。请求和返回的类型都集中在这个文件里。
 *
 * - 答案只在后端：一局结束前前端拿不到答案；结束时一次性给 EndBlock。
 * - 评级在后端算，前端只显示、让用户改（regrade）。
 * - 错误格式 {ok:false, error:<代码>, message:<中文>}：apiClient 已经把 message 放进 ApiError.message，
 *   代码用 soloErrorCode(e) 取。
 */
import { api, isApiError } from '@/lib/apiClient'
import type { CandidateV2, ModeId, SpecV2, SuggestItem } from '@/features/v2/types'

// ---------------------------------------------------------------- 基本取值
export type Grade = 'easy' | 'good' | 'hard' | 'again'
export const GRADES: readonly Grade[] = ['easy', 'good', 'hard', 'again']
/** work = 猜中同一部作品的角色就算对（前端只用这一种）；char = 必须猜中角色本人（后端接受这个值，前端界面里没有入口） */
export type Practice = 'work' | 'char'
/** 反馈符号：+ = 猜的比答案大（所以箭头朝下）；? = 有一方没有这个数 */
export type FeedbackSym = '=' | '+' | '++' | '-' | '--' | '?'
export type EndedBy = 'exact' | 'work' | 'surrender'

// ---------------------------------------------------------------- 进度（调度器）
export interface ProgressSegment {
  id: string
  label: string
  count: number
}
export interface ProgressPart {
  id: string
  label: string
  /** 这一段对总进度的贡献（百分比，0–100）；unseen 恒为 0 */
  pct: number
}
export interface Progress {
  /** 0–100 */
  total: number
  segments: ProgressSegment[]
  parts: ProgressPart[]
  stable_gap?: number | null
  /** 本组暂时练到饱和 */
  saturated: boolean
  /** 调度器附带的事件列表（前端不读这个字段） */
  events: unknown[]
  /** 本次会话涨了多少（百分点，保留 2 位小数）；读不出来 = null */
  session_delta: number | null
}

// ---------------------------------------------------------------- 一局的状态 / 行
export interface Status {
  rows: number
  misses: number
  forgiven: number
  /** = misses - forgiven */
  counted: number
  again_locked: boolean
  /** = 3 + forgiven（按 misses 算的上限） */
  limit: number
}

/** solo_feedback 里给前端画表用的那一块（猜的角色自己的值 + 哪些标签是共有的） */
export interface FeedbackDisplay {
  id: number
  name: string
  gender: string
  /** '♂' | '♀' | '?' */
  gender_symbol: string
  popularity: number
  heat: number
  comments: number
  rating: number | null
  n_app: number
  earliest: number | null
  latest: number | null
  has_profile: boolean
  subject_tags: { tag: string; shared: boolean }[]
  char_tags: { tag: string; shared: boolean }[]
  vas: { name: string; shared: boolean }[]
  shared_work: { name: string | null; name_original: string | null; count: number }
}

/** solo_feedback 的结果去掉 answer_id、correct */
export interface Feedback {
  guess_id: number
  mode: ModeId
  subject_tag_num: number
  character_tag_num: number
  gender: { guess: string; feedback: 'yes' | 'no' }
  popularity: { guess: number; feedback: FeedbackSym }
  rating: { guess: number | null; feedback: FeedbackSym }
  shared_appearances: { first: string; firstOriginal: string | null; firstCn: string | null; count: number }
  appearancesCount: { guess: number; feedback: FeedbackSym }
  metaTags: { guess: string[]; shared: string[] }
  latestAppearance: { guess: number | null; feedback: FeedbackSym }
  earliestAppearance: { guess: number | null; feedback: FeedbackSym }
  display: FeedbackDisplay
}

/** 这次猜的角色是怎么找到的：name = 按名字搜到的（含 Bangumi 在线搜索）；work = 搜作品后从作品的角色列表里选的 */
export type GuessVia = 'name' | 'work'

export interface GuessRow {
  seq: number
  kind: 'guess'
  /** 距开局秒数 */
  t_offset: number
  guess_id: number
  /** 这次猜的角色是怎么找到的 */
  via?: GuessVia | null
  name: string
  /** 日文原名 / 中文名（可能没有；没有就只显示 name） */
  name_original?: string | null
  name_cn?: string | null
  feedback: Feedback
  hit: boolean
  /** 猜的就是答案本人 */
  exact: boolean
  /** 这次没猜中但不计入次数（和答案按已亮信息区分不了） */
  forgiven: boolean
}
export interface TimeoutRow {
  seq: number
  kind: 'timeout'
  t_offset: number
  hit?: false
  forgiven?: false
  /** 超时行没有 via（后端给 null） */
  via?: null
}
export type Row = GuessRow | TimeoutRow

// ---------------------------------------------------------------- 结束块
export interface TimingInterval {
  from: number
  to: number
  sec: number
  /** 结束行（to 那一行）是怎么选的；超时行 null */
  via?: GuessVia | null
  /** 这个间隔多给的秒数（结束行是从作品里选的 = work_bonus_sec，否则 0） */
  bonus_sec?: number
}
export interface Timing {
  /** 第 2→3、3→4… 行的间隔 */
  intervals: TimingInterval[]
  avg_sec: number | null
  good_sec: number
  /** 开局时的「从作品里选时多给几秒」 */
  work_bonus_sec?: number
  /** 实际用的分界线 = good_sec + 各间隔加时的平均；没有这个字段时前端按 intervals 自己算（view.ts 的 thresholdOf） */
  threshold_sec?: number
}

export interface EndBlock {
  round_id: string
  answer_id: number
  answer_name: string
  /** 答案的日文原名 / 中文名（字段名同 GuessRow，可能没有；没有就只显示 answer_name） */
  name_original?: string | null
  name_cn?: string | null
  card: CandidateV2
  grade_auto: Grade
  /** = grade_auto；改评级后以 regrade 的返回为准 */
  grade: Grade
  ended_by: EndedBy
  again_locked: boolean
  hit_seq: number | null
  rows: number
  misses: number
  forgiven: number
  timing: Timing
  why: string
  why_label: string
  /** 上次出现到这次隔了几局（新角色 null） */
  gap_rounds: number | null
  gap_sec: number | null
  prev_grade: Grade | null
  /** 评级后的新间隔（局） */
  next_gap: number | null
  progress: Progress
  // ---- 导图联动用（缺这几项时前端按「没有」处理）
  /** 这道题的作品列表：[绑定作品] + 当前模式下全部登场作品（subject_id，去重，绑定在前）；导图按它找「答案在哪张图里」 */
  answer_work_ids?: number[]
  /** 答案的绑定作品 subject_id（没有 = null） */
  bound_work_id?: number | null
  /** 这局猜过但没猜中的角色（不含超时行，按角色去重）；work_ids 最多 50 个 */
  wrong_guesses?: WrongGuess[]
}

export interface WrongGuess {
  char_id: number
  name: string
  work_ids: number[]
}

// ---------------------------------------------------------------- 请求 / 响应
export interface SessionBody {
  spec: SpecV2
  plan_name?: string | null
  practice?: Practice
  /** 新角色保底：每 N 局至少 1 个新角色（0 = 不保底） */
  new_every?: number
}
export interface SessionResp {
  session_id: string
  mode: ModeId
  practice: Practice
  plan_name: string | null
  pool_total: number
  pool_ids: number[]
  default_subject_tag_num: number
  new_every?: number
  errors: { message: string }[]
  warnings: string[]
  progress: Progress
}

export interface StartBody {
  session_id: string
  subject_tag_num: number
  character_tag_num: number
  good_sec: number
  time_limit_sec: number | null
  /** 从作品里选时 Good / Hard 分界多给的秒数（0–10） */
  work_bonus_sec: number
}
export interface RoundStarted {
  round_id: string
  round_no: number
  subject_tag_num: number
  character_tag_num: number
  good_sec: number
  time_limit_sec: number | null
  /** 后端回显的值 */
  work_bonus_sec?: number
  status: Status
  progress: Progress
}
export interface AllParked {
  round_id: null
  reason: string
  progress: Progress
}
export type StartResp = RoundStarted | AllParked

export interface GuessResp {
  row: Row
  status: Status
  end: EndBlock | null
}
export interface SurrenderResp {
  end: EndBlock
}
export interface RegradeResp {
  round_id: string
  grade: Grade
  grade_auto: Grade
  next_gap: number | null
  progress: Progress
}

export interface BgmSearchItem {
  id: number
  name: string
  name_cn: string
  in_library: boolean
  label: string
}

export interface WorkCharacter {
  id: number
  name: string
  relation: string
  relation_code: number
  heat: number
  gender: string
  n_app: number
}
export interface WorkCharactersResp {
  subject: { id: number; name: string; type: number; year: number | null; heat: number }
  mode: ModeId
  total: number
  items: WorkCharacter[]
}

/** 本地容错搜索（GET /v2/solo/search）的一项。value / label / count / id 和 /v2/suggest 一样 */
export interface SoloSearchItem extends SuggestItem {
  /** 命中的别名或另一个名字（原文；和 value 一样时没有） */
  matched?: string | null
  /** exact / prefix / contains / fuzzy（不显示） */
  match?: string
}
export interface SoloSearchResp {
  items: SoloSearchItem[]
  /**
   * true = 用了容错搜索；false = 后端容错索引还没建好，这次只按原名精确搜（下拉底部提示一句）；
   * null = 响应里没有这个字段（不提示）
   */
  fuzzy: boolean | null
}
export type SoloSearchKind = 'character' | 'work'

// ---------------------------------------------------------------- 解析（容错：缺字段时补默认值，不崩）
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** /v2/solo/search 的返回：外层有没有 ok 都行；项里缺字段补默认值，不是对象的项丢掉 */
export function normalizeSearch(raw: unknown): SoloSearchResp {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.items) ? raw.items : []
  const items: SoloSearchItem[] = list.filter(isObj).map((it) => {
    const value = typeof it.value === 'string' ? it.value : String(it.value ?? '')
    const matched = typeof it.matched === 'string' && it.matched.trim() && it.matched !== value ? it.matched : null
    return {
      value,
      label: typeof it.label === 'string' ? it.label : value,
      count: num(it.count),
      id: typeof it.id === 'number' && Number.isFinite(it.id) ? it.id : undefined,
      matched,
      match: typeof it.match === 'string' ? it.match : undefined,
    }
  })
  const fuzzy = isObj(raw) && typeof raw.fuzzy === 'boolean' ? raw.fuzzy : null
  return { items, fuzzy }
}

/** 进度：缺字段补默认值，百分比夹到 0–100 */
export function normalizeProgress(raw: unknown): Progress | null {
  if (!isObj(raw)) return null
  const clamp = (x: number) => Math.min(100, Math.max(0, x))
  const segs = Array.isArray(raw.segments) ? raw.segments.filter(isObj) : []
  const parts = Array.isArray(raw.parts) ? raw.parts.filter(isObj) : []
  const delta = raw.session_delta
  return {
    total: clamp(num(raw.total)),
    segments: segs.map((s) => ({ id: String(s.id ?? ''), label: String(s.label ?? s.id ?? ''), count: num(s.count) })),
    parts: parts.map((p) => ({ id: String(p.id ?? ''), label: String(p.label ?? p.id ?? ''), pct: clamp(num(p.pct)) })),
    stable_gap: typeof raw.stable_gap === 'number' ? raw.stable_gap : null,
    saturated: raw.saturated === true,
    events: Array.isArray(raw.events) ? raw.events : [],
    session_delta: typeof delta === 'number' && Number.isFinite(delta) ? delta : null,
  }
}

/** 开局的返回：round_id 是 null = 选不出题（全部停放） */
export function isAllParked(r: StartResp): r is AllParked {
  return r.round_id == null
}

export function isGrade(v: unknown): v is Grade {
  return typeof v === 'string' && (GRADES as readonly string[]).includes(v)
}

/** 后端错误代码（{ok:false, error:<代码>}）；不是业务错误 → null */
export function soloErrorCode(e: unknown): string | null {
  if (!isApiError(e) || e.kind !== 'http') return null
  const d = e.detail
  if (isObj(d) && typeof d.error === 'string') return d.error
  return null
}

// ---------------------------------------------------------------- 调用
/** 第一次用某个模式时后端要把数据读进内存（和 /v2/evaluate 一样给足时间） */
const SESSION_TIMEOUT = 120_000
const enc = encodeURIComponent

async function search(kind: SoloSearchKind, q: string, limit: number, signal?: AbortSignal): Promise<SoloSearchResp> {
  return normalizeSearch(await api.get<unknown>('/v2/solo/search', { query: { kind, q, limit }, signal, timeoutMs: 10_000 }))
}

export const soloApi = {
  createSession: (body: SessionBody, signal?: AbortSignal) =>
    api.post<SessionResp>('/v2/solo/session', body, { signal, timeoutMs: SESSION_TIMEOUT }),
  startRound: (body: StartBody) => api.post<StartResp>('/v2/solo/round/start', body, { timeoutMs: 30_000 }),
  /** via：name = 按名字搜到的（默认）；work = 从作品的角色列表里选的（结算时分界线多给 work_bonus_sec 秒） */
  guess: (session_id: string, round_id: string, guess_id: number, via: GuessVia = 'name') =>
    api.post<GuessResp>('/v2/solo/round/guess', { session_id, round_id, guess_id, via }, { timeoutMs: 30_000 }),
  timeout: (session_id: string, round_id: string) =>
    api.post<GuessResp>('/v2/solo/round/timeout', { session_id, round_id }, { timeoutMs: 15_000 }),
  surrender: (session_id: string, round_id: string) =>
    api.post<SurrenderResp>('/v2/solo/round/surrender', { session_id, round_id }, { timeoutMs: 30_000 }),
  regrade: (session_id: string, round_id: string, grade: Grade) =>
    api.post<RegradeResp>('/v2/solo/round/regrade', { session_id, round_id, grade }, { timeoutMs: 15_000 }),
  /** Bangumi 在线搜索（搜别名用）。连不上 → 502 bgm_unavailable */
  bgmSearch: async (kind: 'character' | 'subject', q: string, mode: ModeId, signal?: AbortSignal) => {
    const r = await api.get<unknown>('/v2/solo/bgm_search', { query: { kind, q, mode, limit: 10 }, signal, timeoutMs: 15_000 })
    return (Array.isArray(r) ? r : isObj(r) && Array.isArray(r.items) ? r.items : []) as BgmSearchItem[]
  },
  workCharacters: (sid: number, mode: ModeId, signal?: AbortSignal) =>
    api.get<WorkCharactersResp>(`/v2/solo/work_characters/${enc(String(sid))}`, { query: { mode }, signal, timeoutMs: 20_000 }),
  /** 本地搜索（全库，能容错、能搜别名）：GET /v2/solo/search */
  search,
}
