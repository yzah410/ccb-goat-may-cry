/**
 * 把 GET /autoclick/status 的响应（backend/clicker/models.py 的 ClickerStatus）规整成界面用的形态：
 *   { connected, browser_ok, cdp_port, page_url, page_role, state, busy, task_id, target, strategy_used,
 *     attempts, last_error, last_result, logs: {ts, level, msg}[], auto: {...}, updated_at,
 *     running, manual_running, auto_running, log_lines: string[] }
 *
 * 缺字段就是 null（界面上不显示），不报错。
 */

/** 只有房主出题 */
export type ClickerMode = 'host'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success'

export interface LogLine {
  /** Unix 毫秒；读不出时间 → null */
  ts: number | null
  level: LogLevel
  msg: string
}

export interface PlanOption {
  path: string
  keyword: string
  keyword_label?: string
  index?: number | null
  more_clicks?: number
  subject_id?: number | null
  subject_name?: string | null
  subject_index?: number | null
  cost?: number
  note?: string | null
}

export interface LocateResult {
  ok: boolean
  dry_run?: boolean
  mode?: ClickerMode | null
  char_id?: number | null
  path?: string | null
  keyword?: string | null
  keyword_label?: string | null
  index?: number | null
  nth?: number | null
  more_clicks?: number
  subject_id?: number | null
  subject_name?: string | null
  evidence?: string | null
  evidence_detail?: string | null
  source?: 'page' | 'api' | 'none'
  clicked?: boolean
  confirmed?: boolean
  verified?: boolean
  summary?: string | null
  warnings?: string[]
  error?: string | null
  plan?: PlanOption[]
  elapsed_ms?: number | null
}

export interface AutoView {
  running: boolean
  mode: ClickerMode | null
  round: number | null
  failed: number | null
  startedAt: number | null
  lastRoundAt: number | null
  lastCharId: number | null
  lastCharName: string | null
  waitingFor: string | null
  provider: string | null
  stopReason: string | null
}

export interface ClickerView {
  /** 单次任务在跑 */
  busy: boolean
  autoRunning: boolean
  /** Playwright 是否已接上 Chrome */
  connected: boolean | null
  /** Chrome 调试端口能不能访问 */
  browserOk: boolean | null
  cdpPort: number | null
  pageUrl: string | null
  pageRole: string | null
  /** idle / locating / typing / selecting / confirming / done / error，以及 cancelling / stuck / closed（取消中 / 取消卡住 / 后端关闭） */
  state: string | null
  taskId: string | null
  target: { char_id?: number | null; name?: string | null; name_cn?: string | null; work_hint?: string | null } | null
  strategyUsed: string | null
  lastError: string | null
  lastResult: LocateResult | null
  auto: AutoView
  logs: LogLine[]
  updatedAt: number | null
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)

function normLog(v: unknown): LogLine | null {
  if (!isObj(v)) return null
  const msg = typeof v.msg === 'string' ? v.msg : ''
  if (!msg) return null
  let level = (typeof v.level === 'string' ? v.level : 'info') as LogLevel
  if (!['debug', 'info', 'warn', 'error', 'success'].includes(level)) level = 'info'
  // 后端把「成功」也记成 info（消息里带 ✅），这里按 ✅ 补成 success，方便着色
  if (level === 'info' && /✅/.test(msg)) level = 'success'
  const ts = num(v.ts)
  return { ts: ts === null ? null : ts < 1e12 ? ts * 1000 : ts, level, msg }
}

export function normalizeStatus(raw: unknown): ClickerView {
  const r = isObj(raw) ? raw : {}
  const rawLogs = Array.isArray(r.logs) ? r.logs : []
  const logs = rawLogs.map(normLog).filter((x): x is LogLine => x !== null)
  const a = isObj(r.auto) ? r.auto : {}
  const autoRunning = bool(a.running) ?? false
  const t = isObj(r.target) ? r.target : null
  const lr = isObj(r.last_result) ? (r.last_result as unknown as LocateResult) : null
  const mode = (m: unknown): ClickerMode | null => (m === 'host' ? m : null)
  return {
    busy: bool(r.busy) ?? false,
    autoRunning,
    connected: bool(r.connected),
    browserOk: bool(r.browser_ok),
    cdpPort: num(r.cdp_port),
    pageUrl: str(r.page_url),
    pageRole: str(r.page_role),
    state: str(r.state),
    taskId: str(r.task_id),
    target: t
      ? {
          char_id: num(t.char_id),
          name: str(t.name),
          name_cn: str(t.name_cn),
          work_hint: str(t.work_hint),
        }
      : null,
    strategyUsed: str(r.strategy_used),
    lastError: str(r.last_error),
    lastResult: lr,
    auto: {
      running: autoRunning,
      mode: mode(a.mode),
      round: num(a.round),
      failed: num(a.failed),
      startedAt: num(a.started_at),
      lastRoundAt: num(a.last_round_at),
      lastCharId: num(a.last_char_id),
      lastCharName: str(a.last_char_name),
      waitingFor: str(a.waiting_for),
      provider: str(a.provider),
      stopReason: str(a.stop_reason),
    },
    logs,
    updatedAt: num(r.updated_at),
  }
}

export const STATE_LABEL: Record<string, string> = {
  idle: '空闲',
  locating: '正在定位',
  typing: '正在输入',
  selecting: '正在选择',
  confirming: '正在确认',
  done: '完成',
  error: '出错了',
  // 取消 / 关服相关的 3 个取值（backend/clicker/API.md）
  cancelling: '正在取消…',
  stuck: '取消卡住了，正在重置浏览器连接',
  closed: '后端已关闭',
}

/**
 * 每个状态用什么颜色：progress = 主色、进行中（转圈）；warning = 警告色、进行中（取消中）；
 * danger = 危险色（出错、取消卡住）；success = 成功色；neutral = 灰（空闲、后端已关闭）。
 */
export type StateTone = 'progress' | 'warning' | 'danger' | 'success' | 'neutral'
export const STATE_TONE: Record<string, StateTone> = {
  idle: 'neutral',
  locating: 'progress',
  typing: 'progress',
  selecting: 'progress',
  confirming: 'progress',
  done: 'success',
  error: 'danger',
  cancelling: 'warning',
  stuck: 'danger',
  closed: 'neutral',
}

/** 当前标签页的身份（backend/clicker/API.md「page_role」） */
export const ROLE_LABEL: Record<string, string> = {
  host_lobby: '房主 · 本局没开始（可以出题）',
  setter: '出题人 · 出题弹窗开着',
  setter_ingame: '出题人 · 本局进行中',
  guesser: '玩家 · 局内（可以猜）',
  guest_lobby: '玩家 · 本局没开始',
  observer: '旁观 · 局内没有搜索框',
  single: '单人模式',
  not_joined: '还没进房间',
  unknown: '看不出来',
  host: '房主',
  guest: '玩家',
}

/** 状态机的步骤（API.md「state 状态机」） */
export const STEPS: { key: string; label: string }[] = [
  { key: 'locating', label: '找页面' },
  { key: 'typing', label: '输入' },
  { key: 'selecting', label: '选择' },
  { key: 'confirming', label: '确认' },
  { key: 'done', label: '完成' },
]

/** 凭什么认定「就是这一项」：可信度从高到低 */
export const EVIDENCE: Record<string, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  resp_id: { label: '游戏搜索响应里的 id', tone: 'success' },
  react_key: { label: '结果项的 React key（= 角色 id）', tone: 'success' },
  img_id: { label: '头像地址里的 id', tone: 'warning' },
  text: { label: '只按名字文字', tone: 'neutral' },
  planned: { label: '离线预测（没在页面里验证）', tone: 'neutral' },
}

/** 发送前记下的「日志位置」，用来找出这次任务新产生的日志 */
export interface LogMarker {
  sentAt: number
}

export function markLogs(): LogMarker {
  return { sentAt: Date.now() }
}

/** 这次任务之后新出现的日志（按时间戳） */
export function logsSince(v: ClickerView, m: LogMarker): LogLine[] {
  return v.logs.filter((l) => (l.ts ?? 0) >= m.sentAt - 1500)
}

/**
 * 判断一次单发任务的结果（任务结束、busy 变回 false 之后调用）。
 * 先看 state / last_error；这两样给不出结论时，看这次新增日志的文字。
 */
export function taskOutcome(v: ClickerView, fresh: LogLine[]): { ok: boolean; message: string } | null {
  // 取消中（cancelling）/ 取消卡住（stuck）时 busy 仍是 true：任务还没真正停下，继续等
  if (v.busy) return null
  if (v.state === 'closed') return { ok: false, message: v.lastError ?? '点击器已关闭（后端正在退出）' }
  if (v.state === 'error' || v.lastError) return { ok: false, message: v.lastError ?? '执行失败' }
  if (v.state === 'done') return { ok: true, message: v.lastResult?.summary ?? '完成了' }
  for (let i = fresh.length - 1; i >= 0; i--) {
    const l = fresh[i]!
    if (l.level === 'error') return { ok: false, message: l.msg }
    if (l.level === 'success') return { ok: true, message: l.msg }
  }
  return fresh.length ? { ok: true, message: fresh[fresh.length - 1]!.msg } : null
}
