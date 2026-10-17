/** 数字、时间、大小的格式化（全部中文口语化） */

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** 78218 → "78,218" */
export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return Math.round(n).toLocaleString('zh-CN')
}

/** 78218 → "7.8 万"；9999 → "9,999" */
export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  if (Math.abs(n) >= 10000) {
    const w = n / 10000
    return `${w >= 100 ? Math.round(w) : w.toFixed(1).replace(/\.0$/, '')} 万`
  }
  return fmtInt(n)
}

/** 评分保留 1 位小数 */
export function fmtScore(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return n.toFixed(1)
}

/** 权重：整数不带小数，小数最多 2 位 */
export function fmtWeight(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} 秒`
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function toDate(v: string | number | Date | null | undefined): Date | null {
  if (v === null || v === undefined || v === '') return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** "2026-08-01 16:17" */
export function fmtDateTime(v: string | number | Date | null | undefined): string {
  const d = toDate(v)
  if (!d) return '—'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "2026-08-01" */
export function fmtDate(v: string | number | Date | null | undefined): string {
  const d = toDate(v)
  if (!d) return '—'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** "刚刚" / "5 分钟前" / "3 小时前" / "昨天" / "4 天前" / "2026-08-01" */
export function relativeTime(v: string | number | Date | null | undefined, now: number = Date.now()): string {
  const d = toDate(v)
  if (!d) return '—'
  const diff = (now - d.getTime()) / 1000
  if (diff < 0) return fmtDateTime(d)
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  const days = Math.floor(diff / 86400)
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return fmtDate(d)
}

/** 年份区间："2022" 或 "2022–2025"；缺值显示 — */
export function fmtYearSpan(a: number | null | undefined, b: number | null | undefined): string {
  if (a == null && b == null) return '—'
  if (a == null) return `? – ${b}`
  if (b == null || a === b) return String(a)
  return `${a}–${b}`
}

/** 严格整数：只接受 [-]数字；空串 → null；其他 → NaN（调用方据此提示「只能填整数」） */
export function parseIntStrict(s: string): number | null {
  const v = s.trim()
  if (v === '') return null
  if (!/^-?\d+$/.test(v)) return Number.NaN
  const n = Number(v)
  return Number.isSafeInteger(n) ? n : Number.NaN
}

/** 解析数字（允许小数）；空串 → null；非法 → NaN */
export function parseNumberLoose(s: string): number | null {
  const v = s.trim()
  if (v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : Number.NaN
}

/** 数文本里非空行数 */
export function countLines(text: string | null | undefined): number {
  if (!text) return 0
  return text.split(/\r?\n/).filter((x) => x.trim()).length
}
