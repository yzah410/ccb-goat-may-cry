/**
 * 开局问卷的推荐数据和配对算法。
 *
 * recs.json 是预先算好、随前端打包的静态数据（本仓库不含生成脚本）；口径：动画模式、每个角色 6 个标签，和游戏一样：
 * - tags：会进分档的标签（按常见程度排），freq 是它们在各年热度前 300 部动画主角里的出现率；
 * - chars：热度够高、叫得出名字的角色。标签完全一样的只留一个代表，其余放在 alts（例：同一部作品里标签完全相同的几个主要角色）；
 * - singles：单人就带 5 个以上分档标签的角色（同一系列只留一个）；pairs：预先算好的两人组合。
 * 分档规则：两人的标签 → 第 1 档；第 3 个人新带来的 → 第 2 档；其余 → 第 3 档；第 4 档空着。
 */
import raw from './recs.json'
import type { FormulaChar, Tiers } from './api'

export interface RecChar {
  idx: number
  id: number
  name: string
  work: string
  heat: number
  /** 带的分档标签（tags 的下标，从常见到少见） */
  k: readonly number[]
  /** 标签完全一样、可以互相替换的角色 */
  alts: readonly FormulaChar[]
}

export interface Recs {
  generated: string
  tags: readonly string[]
  freq: readonly number[]
  chars: readonly RecChar[]
  singles: readonly number[]
  pairs: readonly (readonly [number, number])[]
}

type RawRecs = {
  generated: string
  tags: string[]
  freq: number[]
  chars: [number, string, string, number, number[], [number, string][]][]
  singles: number[]
  pairs: [number, number][]
}

export function parseRecs(r: RawRecs): Recs {
  return {
    generated: r.generated,
    tags: r.tags,
    freq: r.freq,
    chars: r.chars.map(([id, name, work, heat, k, alts], idx) => ({
      idx,
      id,
      name,
      work,
      heat,
      k,
      alts: alts.map(([aid, aname]) => ({ id: aid, name: aname })),
    })),
    singles: r.singles,
    pairs: r.pairs,
  }
}

export const RECS: Recs = parseRecs(raw as unknown as RawRecs)

/** 公式里的一个位置：代表角色 + 实际显示 / 保存的是谁（代表自己，或者某个标签一样的替换角色） */
export interface Slot {
  rep: number
  shown: FormulaChar
}

export function slotOf(recs: Recs, rep: number, shown?: FormulaChar): Slot {
  const c = recs.chars[rep]!
  return { rep, shown: shown ?? { id: c.id, name: c.name } }
}

/** 这个位置可以换成的其他人（代表 + 替换角色，去掉正在显示的） */
export function swapOptions(recs: Recs, slot: Slot): FormulaChar[] {
  const c = recs.chars[slot.rep]!
  return [{ id: c.id, name: c.name }, ...c.alts].filter((x) => x.id !== slot.shown.id)
}

export function unionOf(recs: Recs, reps: readonly (number | null | undefined)[]): Set<number> {
  const s = new Set<number>()
  for (const r of reps) if (r != null) for (const t of recs.chars[r]!.k) s.add(t)
  return s
}

export interface Ranked {
  idx: number
  /** 在 base 之外新带来的标签（tags 下标，从常见到少见） */
  add: number[]
}

/**
 * 给定已选角色的标签（base），按「新带来几个分档标签」从多到少排；一样多时常见标签多的在前，再按热度。
 * 新带来的标签一模一样的只留第一个（效果相同，列出来没有意义）；一个新标签都不带的不要。
 */
export function rankAdds(recs: Recs, base: ReadonlySet<number>, exclude: ReadonlySet<number>, limit = 8): Ranked[] {
  const rows: { idx: number; add: number[]; w: number; heat: number }[] = []
  for (const c of recs.chars) {
    if (exclude.has(c.idx)) continue
    const add = c.k.filter((t) => !base.has(t))
    if (!add.length) continue
    rows.push({ idx: c.idx, add, w: add.reduce((s, t) => s + (recs.freq[t] ?? 0), 0), heat: c.heat })
  }
  rows.sort((a, b) => b.add.length - a.add.length || b.w - a.w || b.heat - a.heat || a.idx - b.idx)
  const seen = new Set<string>()
  const out: Ranked[] = []
  for (const r of rows) {
    const key = r.add.join(',')
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ idx: r.idx, add: r.add })
    if (out.length >= limit) break
  }
  return out
}

/** 按公式分档：两人的标签 → 第 1 档；第 3 个人新带来的 → 第 2 档；其余 → 第 3 档；第 4 档空着。档内按常见程度排。 */
export function tiersFor(recs: Recs, a: number, b: number, c: number | null): Tiers {
  const t1 = unionOf(recs, [a, b])
  const t2 = c == null ? new Set<number>() : new Set([...recs.chars[c]!.k].filter((t) => !t1.has(t)))
  const pick = (f: (i: number) => boolean) => recs.tags.filter((_, i) => f(i))
  return {
    G_1: pick((i) => t1.has(i)),
    G_2: pick((i) => t2.has(i)),
    G_3: pick((i) => !t1.has(i) && !t2.has(i)),
    G_4: [],
  }
}

export interface SearchHit {
  idx: number
  /** 搜到的是代表还是某个替换角色 */
  shown: FormulaChar
}

/** 按名字搜（代表和替换角色都搜）：完全一样 > 开头一样 > 包含；同一档按热度 */
export function searchChars(recs: Recs, q: string, exclude: ReadonlySet<number> = new Set(), limit = 30): SearchHit[] {
  const s = q.trim().toLowerCase()
  if (!s) return []
  const hits: { hit: SearchHit; rank: number; heat: number }[] = []
  for (const c of recs.chars) {
    if (exclude.has(c.idx)) continue
    let best: { who: FormulaChar; rank: number } | null = null
    for (const who of [{ id: c.id, name: c.name }, ...c.alts]) {
      const n = who.name.toLowerCase()
      const rank = n === s ? 0 : n.startsWith(s) ? 1 : n.includes(s) ? 2 : -1
      if (rank >= 0 && (!best || rank < best.rank)) best = { who, rank }
    }
    if (best) hits.push({ hit: { idx: c.idx, shown: best.who }, rank: best.rank, heat: c.heat })
  }
  hits.sort((a, b) => a.rank - b.rank || b.heat - a.heat)
  return hits.slice(0, limit).map((h) => h.hit)
}
