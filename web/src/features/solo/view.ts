/**
 * 反馈表、状态行、结算卡片要显示的文字和颜色：纯函数，组件只负责画。
 *
 * 颜色规则和猜猜呗游戏一致，用主题 token 表示：
 *   =  绿（命中）    + / -  黄（接近）    ++ / --  不填色（差得远）    ?  灰斜纹（有一方没有这个数）
 *   + 的意思是「猜的比答案大」→ 箭头 ↓（应该往小猜）；- → ↑。
 */
import type { EndBlock, FeedbackDisplay, FeedbackSym, Feedback, Grade, Status, Timing, TimingInterval } from './api'
import { GRADE_LABEL } from './grades'

// ---------------------------------------------------------------- 格子颜色 / 箭头
export type CellTone = 'hit' | 'near' | 'far' | 'unknown' | 'none'

export function toneOf(sym: FeedbackSym | 'yes' | 'no' | null | undefined): CellTone {
  switch (sym) {
    case '=':
    case 'yes':
      return 'hit'
    case '+':
    case '-':
      return 'near'
    case '++':
    case '--':
      return 'far'
    case '?':
      return 'unknown'
    default:
      return 'none'
  }
}

export function arrowOf(sym: FeedbackSym | null | undefined): '↓' | '↑' | '' {
  if (sym === '+' || sym === '++') return '↓'
  if (sym === '-' || sym === '--') return '↑'
  return ''
}

/** 读屏用：箭头的意思 */
export function arrowMeaning(sym: FeedbackSym | null | undefined): string {
  const a = arrowOf(sym)
  if (a === '↓') return sym === '++' ? '比答案大很多' : '比答案大一点'
  if (a === '↑') return sym === '--' ? '比答案小很多' : '比答案小一点'
  if (sym === '=') return '和答案一样'
  if (sym === '?') return '有一方没有这个数，比不了'
  return ''
}

/** 格子底色（主题 token；moonlit 深色底上也看得清） */
export const TONE_CLASS: Record<CellTone, string> = {
  hit: 'bg-[color-mix(in_oklab,var(--success)_30%,transparent)] text-success-fg ring-1 ring-inset ring-[color-mix(in_oklab,var(--success)_45%,transparent)]',
  near: 'bg-warning-bg text-warning-fg',
  far: 'text-fg-2',
  unknown:
    'bg-surface-2 text-fg-2 [background-image:repeating-linear-gradient(-45deg,transparent_0_4px,var(--border)_4px_8px)]',
  none: 'text-fg-2',
}

// ---------------------------------------------------------------- 数值
/** 年份 / 评分「无」→ 「无」（猜猜呗游戏里 -1 显示「无」，0 照常显示 0） */
export function orNone(v: number | null | undefined, fmt: (n: number) => string = String): string {
  return v == null || !Number.isFinite(v) ? '无' : fmt(v)
}

export function fmtRating(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/** 秒数：< 10 秒保留 1 位小数，其余取整 */
export function fmtSec(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—'
  return sec < 10 ? `${(Math.round(sec * 10) / 10).toFixed(1)} 秒` : `${Math.round(sec)} 秒`
}

/** 普通数字：最多 1 位小数，去掉末尾的 .0（「10」「2.5」「10.7」） */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const r = roundTo(n, 1)
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

/** 四舍五入到 digits 位小数（显示出来的就是这个数） */
function roundTo(n: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

/**
 * 平均 / 分界用的数字。digits = 1：和 fmtNum 一样（「12」「12.4」）；
 * digits > 1（为了看出大小多显示了小数）：写满这么多位，两个数的位数对齐（「12.04」「12.00」）。
 */
export function fmtAt(n: number, digits: number): string {
  if (!Number.isFinite(n)) return '—'
  return digits <= 1 ? fmtNum(n) : roundTo(n, digits).toFixed(digits)
}

/** 真实时长：秒 → 「35 秒」「12 分钟」「3 小时」「2 天」 */
export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—'
  if (sec < 60) return `${Math.round(sec)} 秒`
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟`
  if (sec < 86400) return `${Math.round(sec / 360) / 10} 小时`
  return `${Math.round(sec / 8640) / 10} 天`
}

// ---------------------------------------------------------------- 名字格
/**
 * 名字两行（和猜猜呗游戏一样：上行日文原名小字，下行中文名）。后端没给 name_cn / name_original 时只有一行 name。
 * 两行一样（只有原名、或者中文名就是原名）时只显示一行。
 */
export function nameLines(n: { name?: string | null; name_original?: string | null; name_cn?: string | null }): { top: string | null; main: string } {
  const name = (n.name ?? '').trim()
  const cn = (n.name_cn ?? '').trim()
  const orig = (n.name_original ?? '').trim()
  const main = cn || name || orig
  const top = orig && orig !== main ? orig : null
  return { top, main }
}

// ---------------------------------------------------------------- 标签格 / 共同出演
export interface TagView {
  text: string
  shared: boolean
  kind: 'subject' | 'char' | 'va'
}

/**
 * 标签格：作品标签 → 角色标签 → 声优，同名只留一个（猜猜呗游戏用 Set 去重）；任一处命中就算命中（猜猜呗游戏按字符串高亮）。
 * 猜中的那一行也走这里（猜猜呗游戏里猜中那一行只显示声优；这里照常显示全部标签）。
 */
export function mergeTags(d: Pick<FeedbackDisplay, 'subject_tags' | 'char_tags' | 'vas'> | null | undefined): TagView[] {
  if (!d) return []
  const out: TagView[] = []
  const at = new Map<string, number>()
  const add = (text: string, shared: boolean, kind: TagView['kind']) => {
    if (!text) return
    const i = at.get(text)
    if (i !== undefined) {
      if (shared) out[i]!.shared = true
      return
    }
    at.set(text, out.length)
    out.push({ text, shared, kind })
  }
  for (const t of d.subject_tags ?? []) add(t.tag, t.shared, 'subject')
  for (const t of d.char_tags ?? []) add(t.tag, t.shared, 'char')
  for (const v of d.vas ?? []) add(v.name, v.shared, 'va')
  return out
}

/**
 * 共同出演：第一个共同作品的名字，个数 > 1 时加「+N」。
 * 猜猜呗游戏里，第一个共同作品是特殊游戏时名字取不到，会显示成空绿块。这里依次退到 display.shared_work.name →
 * shared_appearances.firstCn / firstOriginal / first；都没有还有个数时写「共同作品」。
 */
export function sharedWorkView(fb: Pick<Feedback, 'display' | 'shared_appearances'> | null | undefined): { text: string; has: boolean } {
  const sw = fb?.display?.shared_work
  const sa = fb?.shared_appearances
  const count = sw?.count ?? sa?.count ?? 0
  if (!count) return { text: '', has: false }
  const name = sw?.name || sa?.firstCn || sa?.firstOriginal || sa?.first || sw?.name_original || '共同作品'
  return { text: count > 1 ? `${name} +${count - 1}` : name, has: true }
}

// ---------------------------------------------------------------- 状态行
/**
 * 「已错 N / 上限 次」。上限 = 3 + 宽免次数（status.limit），所以分子用全部没猜中的次数（misses），
 * 而不是 counted（= misses − 宽免，它要和 3 比）。两种写法判 Again 的时机一样。
 */
export function attemptsView(s: Status | null | undefined): { used: number; limit: number; text: string; full: boolean } {
  if (!s) return { used: 0, limit: 3, text: '已错 0 / 3 次', full: false }
  const limit = s.limit || 3 + (s.forgiven || 0)
  const used = s.misses
  const full = s.again_locked || used >= limit
  const extra = s.forgiven > 0 ? `（${s.forgiven} 次区分不了，不计，所以上限是 ${limit}）` : ''
  // 错满以后还能接着猜（猜中能看答案），次数会超过上限：这时不写「4 / 3」，直接说已经记 Again
  const text = full ? `已错 ${used} 次，到了上限 ${limit}，本局记 Again${extra}` : `已错 ${used} / ${limit} 次${extra}`
  return { used, limit, text, full }
}

// ---------------------------------------------------------------- 结算卡片
export function endedByText(end: Pick<EndBlock, 'ended_by' | 'again_locked' | 'hit_seq'>): string {
  const at = end.hit_seq != null ? `第 ${end.hit_seq} 次` : ''
  if (end.ended_by === 'surrender') return '投降了'
  const base = end.ended_by === 'exact' ? `${at}猜中了答案本人` : `${at}猜中了同一部作品的角色（算猜对）`
  return end.again_locked ? `${base}，但之前已经错满次数，记 Again` : base
}

/** 计时用到的结算信息：怎么结束的，决定要不要写「→ Good / Hard」 */
export type TimingCtx = Pick<EndBlock, 'ended_by' | 'again_locked' | 'hit_seq'>

/** 这个间隔多给的秒数（没有 bonus_sec = 0） */
const bonusOf = (iv: TimingInterval): number => (typeof iv.bonus_sec === 'number' && Number.isFinite(iv.bonus_sec) && iv.bonus_sec > 0 ? iv.bonus_sec : 0)

/** 间隔后面的说明：结束行是从作品里选的、多给了秒数 →「（从作品里选，+2 秒）」 */
export function intervalBonusText(iv: TimingInterval): string {
  const b = bonusOf(iv)
  return b > 0 ? `（从作品里选，+${fmtNum(b)} 秒）` : ''
}

/**
 * 实际用的分界线：后端给了 threshold_sec 就用它；没给时按 good_sec + 各间隔加时的平均自己算。
 * extra = 分界比 good_sec 多出来的秒数（各间隔加时的平均）。
 */
export function thresholdOf(t: Timing): { threshold: number; extra: number } {
  const n = t.intervals.length
  const sum = t.intervals.reduce((a, iv) => a + bonusOf(iv), 0)
  const thr =
    typeof t.threshold_sec === 'number' && Number.isFinite(t.threshold_sec) ? t.threshold_sec : n > 0 && sum > 0 ? t.good_sec + sum / n : t.good_sec
  const extra = thr - t.good_sec
  return { threshold: thr, extra: extra > 1e-9 ? extra : 0 }
}

/** 平均不超过分界就是 Good（恰好等于也算；和后端一样留 1e-9 的浮点余量） */
const withinThreshold = (avg: number, threshold: number): boolean => avg <= threshold + 1e-9

/**
 * 平均和分界显示几位小数：两个数用同一种精度，默认最多 1 位。
 * 判定是 Hard（平均 > 分界）但四舍五入后两个数一样（比如 12.04 和 12 都显示成「12」）时，多显示小数位，
 * 直到看得出平均比分界大；判定是 Good 时四舍五入不会让平均显示得比分界大，不用加。
 */
export function avgThresholdDigits(avg: number | null | undefined, threshold: number): number {
  let digits = 1
  if (avg == null || !Number.isFinite(avg) || !Number.isFinite(threshold) || withinThreshold(avg, threshold)) return digits
  while (digits < 6 && roundTo(avg, digits) <= roundTo(threshold, digits)) digits++
  return digits
}

/**
 * 分界那一段文字。没有加时：「分界 10 秒」。
 * 有加时：「分界 12 秒（10 + 2）」；只有部分间隔是从作品里选的：「分界 11 秒（10 + 2 × 1/2）」= 加时 × 有加时的间隔数 / 间隔总数。
 * digits = 分界显示几位小数（和平均一致，见 avgThresholdDigits）；括号里的设置值最多 1 位小数。
 */
export function thresholdText(t: Timing, digits = 1): string {
  const { threshold, extra } = thresholdOf(t)
  if (extra <= 0) return `分界 ${fmtAt(threshold, digits)} 秒`
  const bonuses = t.intervals.map(bonusOf).filter((b) => b > 0)
  const n = t.intervals.length
  const same = bonuses.length > 0 && bonuses.every((b) => Math.abs(b - bonuses[0]!) < 1e-9)
  let how = fmtNum(extra)
  if (same && bonuses.length < n) how = `${fmtNum(bonuses[0]!)} × ${bonuses.length}/${n}`
  return `分界 ${fmtAt(threshold, digits)} 秒（${fmtNum(t.good_sec)} + ${how}）`
}

/**
 * 计时：「第 2→3 次 6.2 秒」…；平均和分界。
 * 只有猜中、而且没错满次数时，评级才看计时，这时才写「→ Good / Hard」；投降或错满时写明「不按计时评级」。
 * 第 1、2 次就猜中：「第 N 次就猜中，不计时」。
 * 从作品里选的那次猜测（bonus_sec > 0）：间隔后面写「（从作品里选，+2 秒）」，分界写成「分界 12 秒（10 + 2）」。
 */
export function timingView(t: Timing | null | undefined, ctx?: TimingCtx | null): { intervals: string[]; summary: string } {
  if (!t || t.intervals.length === 0) {
    const n = ctx && ctx.ended_by !== 'surrender' ? ctx.hit_seq : null
    return { intervals: [], summary: n != null ? `第 ${n} 次就猜中，不计时` : '第 1、2 次就结束了，不计时' }
  }
  const digits = timingDigits(t)
  const intervals = t.intervals.map((iv) => `第 ${iv.from}→${iv.to} 次 ${secAt(iv.sec, digits)}${intervalBonusText(iv)}`)
  const avg = t.avg_sec
  const { threshold } = thresholdOf(t)
  const byTime = !ctx || (ctx.ended_by !== 'surrender' && !ctx.again_locked)
  let verdict = ''
  if (!byTime) verdict = ctx?.ended_by === 'surrender' ? '；投降了，不按计时评级' : '；错满了次数，不按计时评级'
  else if (avg != null) verdict = withinThreshold(avg, threshold) ? ' → Good' : ' → Hard'
  return { intervals, summary: `平均 ${secAt(avg, digits)}（${thresholdText(t, digits)}${verdict}）` }
}

/**
 * 计时里所有秒数（每段间隔、平均、分界）用同一种精度（见 avgThresholdDigits），
 * 免得只有一段间隔时写成「2→3 次 12 秒 · 平均 12.4 秒」这种对不上的样子。
 */
function timingDigits(t: Timing): number {
  return avgThresholdDigits(t.avg_sec, thresholdOf(t).threshold)
}

const secAt = (sec: number | null | undefined, digits: number): string => (sec == null || !Number.isFinite(sec) ? '—' : `${fmtAt(sec, digits)} 秒`)

/** 一行写完的计时（自动模式的结算卡片、右上角「上一局」的悬停说明）：「2→3 次 2.4 秒 · 3→4 次 0.9 秒 · 平均 1.7 秒（分界 10 秒 → Good）」 */
export function timingLine(end: Pick<EndBlock, 'timing'> & TimingCtx): string {
  const t = end.timing
  const digits = t ? timingDigits(t) : 1
  const parts = (t?.intervals ?? []).map((iv) => `${iv.from}→${iv.to} 次 ${secAt(iv.sec, digits)}${intervalBonusText(iv)}`)
  return [...parts, timingView(t, end).summary].join(' · ')
}

/** 上次出现：新角色 / 隔了几局（真实多久） */
export function gapView(end: Pick<EndBlock, 'gap_rounds' | 'gap_sec' | 'prev_grade'>): string {
  if (end.gap_rounds == null) return '新角色，第一次出现'
  const rounds = Math.round(end.gap_rounds)
  const real = end.gap_sec != null ? `（${fmtDuration(end.gap_sec)}前）` : ''
  const prev = end.prev_grade ? `，上次评 ${GRADE_LABEL[end.prev_grade as Grade] ?? end.prev_grade}` : ''
  return `上次出现隔了 ${rounds} 局${real}${prev}`
}

export function nextGapView(nextGap: number | null | undefined): string {
  if (nextGap == null || !Number.isFinite(nextGap)) return ''
  return `下次大约隔 ${Math.max(1, Math.round(nextGap))} 局再出`
}
