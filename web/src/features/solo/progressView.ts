/**
 * 左上角进度条要显示的数：纯函数，SoloProgress 只负责画。
 *
 * 后端（backend/v2/solo/scheduler.py 的 progress()）给的是：
 *   total    0–100：全组每人巩固度的平均 × 100（已稳定算 1，巩固中按「隔过的最长局数 ÷ 稳定线」算一部分，其余算 0）
 *   segments 四类人数：已稳定 / 巩固中 / 学习中 / 未出现
 *   parts    每类对 total 的贡献（百分点）；学习中、未出现恒为 0；四个相加和 total 可能差 0.01
 * 条长 = total；条里按 parts 把 total 分成「已稳定」「巩固中」两段，以 total 为准。
 */
import type { Progress } from './api'

export type ProgressKind = 'stable' | 'consolidating' | 'learning' | 'unseen'
export const PROGRESS_KINDS: readonly ProgressKind[] = ['stable', 'consolidating', 'learning', 'unseen']

export interface ProgressBarView {
  /** 条长（占整条的百分比，0–100） */
  total: number
  /** 「42.5%」 */
  totalText: string
  /** 两段各占整条的百分比；相加 = total */
  stable: number
  consolidating: number
  /** 「本次 +1.2%」；没有这个数或为 0 时 null，不显示 */
  delta: string | null
  /** 四类人数（后端没给的类按 0） */
  counts: Record<ProgressKind, number>
  /** 「已稳定」要隔几局（取整）；后端没给 = null */
  stableGap: number | null
  saturated: boolean
}

const round2 = (v: number) => Math.round(v * 100) / 100
const clampPct = (v: number) => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0)

/** 百分比数字（非负）：≥ 1 保留 1 位小数，< 1 保留 2 位；去掉末尾的 0（42.50 → 42.5，3.0 → 3，0.004 → 0） */
export function fmtPct(v: number): string {
  const a = Number.isFinite(v) ? Math.abs(v) : 0
  return String(Number(a.toFixed(a >= 1 ? 1 : 2)))
}

/** 「本次 +1.2%」「本次 −0.4%」；0 或 null → null */
export function deltaText(delta: number | null | undefined): string | null {
  if (delta == null || !Number.isFinite(delta)) return null
  const s = fmtPct(Math.abs(delta))
  if (s === '0') return null
  return `本次 ${delta > 0 ? '+' : '−'}${s}%`
}

/**
 * 两段的宽度：按「已稳定」「巩固中」两个 part 的比例分 total。
 * - parts 相加和 total 不一致（四舍五入差 0.01，或者别的原因）：照比例缩放到 total，两段相加正好 = total。
 * - 两个 part 都是 0 但 total > 0（数据不完整）：整条画成「已稳定」的颜色，不猜比例。
 */
export function splitBar(p: Pick<Progress, 'total' | 'parts'>): { total: number; stable: number; consolidating: number } {
  const total = round2(clampPct(p.total))
  if (total <= 0) return { total: 0, stable: 0, consolidating: 0 }
  const pctOf = (id: ProgressKind) => clampPct(p.parts.find((x) => x.id === id)?.pct ?? 0)
  const s = pctOf('stable')
  const c = pctOf('consolidating')
  if (s + c <= 0) return { total, stable: total, consolidating: 0 }
  const stable = round2((total * s) / (s + c))
  return { total, stable, consolidating: round2(total - stable) }
}

export function progressBarView(p: Progress): ProgressBarView {
  const bar = splitBar(p)
  const counts: Record<ProgressKind, number> = { stable: 0, consolidating: 0, learning: 0, unseen: 0 }
  for (const s of p.segments) if ((PROGRESS_KINDS as readonly string[]).includes(s.id)) counts[s.id as ProgressKind] = Math.max(0, Math.round(s.count))
  const gap = p.stable_gap
  return {
    ...bar,
    totalText: `${fmtPct(bar.total)}%`,
    delta: deltaText(p.session_delta),
    counts,
    stableGap: gap != null && Number.isFinite(gap) && gap > 0 ? Math.round(gap) : null,
    saturated: p.saturated,
  }
}

/** 悬停说明：四类各多少人、各是什么意思（一类一行） */
export function progressLegend(v: Pick<ProgressBarView, 'counts' | 'stableGap'>): { kind: ProgressKind; text: string }[] {
  const g = v.stableGap
  const stableWhen = g != null ? `隔 ${g} 局以上再出仍然记得` : '隔得够久（到稳定线）再出仍然记得'
  const notYet = g != null ? `最长一次还不到 ${g} 局` : '还没隔到稳定线'
  return [
    { kind: 'stable', text: `已稳定 ${v.counts.stable} 人：${stableWhen}（第一次出就认出的也算）` },
    { kind: 'consolidating', text: `巩固中 ${v.counts.consolidating} 人：隔几局再出记得过，但${notYet}` },
    { kind: 'learning', text: `学习中 ${v.counts.learning} 人：出过题，还没有隔几局再记起来过（第一次没认出，或答错跌回）；不占条的长度` },
    { kind: 'unseen', text: `未出现 ${v.counts.unseen} 人：还没出过题` },
  ]
}
