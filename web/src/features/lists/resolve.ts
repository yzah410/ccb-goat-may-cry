/**
 * 清单「粘贴一批」：把一段文字拆成一行一个（也认逗号、顿号），数字当 id，其余当名字；
 * 名字用 /v2/suggest 在库里对号：完全一样的只有一个 → 对上；有好几个同名 → 先用热度最高的，并列出来让用户换；
 * 一个都对不上 → 列出来（附上最接近的几个，点一下就能加）。
 */
import { v2Api } from '@/features/v2/api'
import type { ListItemV2, ListKind, SuggestItem, SuggestKind } from '@/features/v2/types'

export interface ParsedPaste {
  ids: number[]
  names: string[]
}

/** 一行一个；也认中英文逗号、顿号、分号、Tab；去重，保留顺序 */
export function parsePasted(text: string, kind: ListKind): ParsedPaste {
  const parts = text
    .split(/[\n\r,，、;；\t]+/)
    .map((s) => s.trim().replace(/^[#＃]/, ''))
    .filter(Boolean)
  const ids: number[] = []
  const names: string[] = []
  const seenI = new Set<number>()
  const seenN = new Set<string>()
  for (const p of parts) {
    if (kind !== 'tag' && /^\d+$/.test(p)) {
      const n = Number(p)
      if (!seenI.has(n)) {
        seenI.add(n)
        ids.push(n)
      }
    } else if (!seenN.has(p)) {
      seenN.add(p)
      names.push(p)
    }
  }
  return { ids, names }
}

export interface ResolveOutcome {
  /** 能加进清单的 */
  added: ListItemV2[]
  /** 同名的有好几个：先用了 picked，candidates 可以换 */
  ambiguous: { name: string; picked: SuggestItem; candidates: SuggestItem[] }[]
  /** 对不上的：附上最接近的几个 */
  unresolved: { name: string; near: SuggestItem[] }[]
}

const KIND_SUGGEST: Record<ListKind, SuggestKind[]> = {
  character: ['character'],
  work: ['work'],
  // 标签清单：角色的作品标签（游戏格子）和作品本身的标签，哪边有都算
  tag: ['game_tag', 'work_tag'],
}

/** 一个名字是不是「完全一样」：值一样，或者 label 是「名字（……）」这种带说明的 */
export function exactMatches(name: string, items: SuggestItem[]): SuggestItem[] {
  const n = name.trim()
  return items.filter((it) => it.value === n || it.label === n || it.label.startsWith(`${n}（`))
}

async function pool<T, R>(xs: T[], limit: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length)
  let i = 0
  const worker = async () => {
    while (i < xs.length) {
      const k = i++
      out[k] = await f(xs[k]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, worker))
  return out
}

export async function resolvePasted(kind: ListKind, parsed: ParsedPaste, onProgress?: (done: number, total: number) => void): Promise<ResolveOutcome> {
  // id：后端保存时按 id 补名字（这里名字先空着）
  const added: ListItemV2[] = parsed.ids.map((id) => ({ id, name: '' }))
  const ambiguous: ResolveOutcome['ambiguous'] = []
  const unresolved: ResolveOutcome['unresolved'] = []
  let done = 0
  const results = await pool(parsed.names, 4, async (name) => {
    const found: SuggestItem[] = []
    for (const sk of KIND_SUGGEST[kind]) {
      try {
        found.push(...(await v2Api.suggest(sk, name, { limit: 8 })))
      } catch {
        /* 补全失败当作没找到 */
      }
    }
    onProgress?.(++done, parsed.names.length)
    return { name, found }
  })
  for (const { name, found } of results) {
    const exact = exactMatches(name, found)
    if (kind === 'tag') {
      if (exact.length) added.push({ name: exact[0]!.value })
      else unresolved.push({ name, near: dedupe(found).slice(0, 5) })
      continue
    }
    if (exact.length === 1) added.push({ id: exact[0]!.id, name: exact[0]!.value })
    else if (exact.length > 1) {
      const sorted = [...exact].sort((a, b) => b.count - a.count)
      added.push({ id: sorted[0]!.id, name: sorted[0]!.value })
      ambiguous.push({ name, picked: sorted[0]!, candidates: sorted })
    } else unresolved.push({ name, near: found.slice(0, 5) })
  }
  return { added, ambiguous, unresolved }
}

function dedupe(xs: SuggestItem[]): SuggestItem[] {
  const seen = new Set<string>()
  return xs.filter((x) => (seen.has(x.value) ? false : (seen.add(x.value), true)))
}

/** 合并进已有的项（按 id；没有 id 的按名字），返回新数组和真正新加了几个 */
export function mergeItems(existing: ListItemV2[], incoming: ListItemV2[]): { items: ListItemV2[]; added: number } {
  const key = (it: ListItemV2) => (it.id != null ? `i:${it.id}` : `n:${it.name}`)
  const seen = new Set(existing.map(key))
  const items = [...existing]
  let added = 0
  for (const it of incoming) {
    const k = key(it)
    if (seen.has(k)) continue
    seen.add(k)
    items.push(it)
    added++
  }
  return { items, added }
}
