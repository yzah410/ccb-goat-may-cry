/**
 * 搜索下拉的数据：几种来源（本地角色 / 本地作品 / Bangumi 在线 / 作品下的角色）统一成一种项，组件只画这一种。
 * - 本地搜索是全库，不限于当前方案；不依赖 Bangumi 在线接口（在线接口可能慢或连不上）
 * - 「搜 Bangumi 全库」打开时用在线搜索（搜别名用）；本地库里没有的项照样列出来，但选不了，写「本地库没有」
 * - 本地搜索（/v2/solo/search）命中的是别名或另一个名字时，小字行写「别名：…」
 */
import type { SuggestItem } from '@/features/v2/types'
import type { BgmSearchItem, GuessVia, SoloSearchItem, WorkCharacter } from './api'

/**
 * 输入框的搜索状态：char = 搜角色；works = 搜作品（作品列表）；work-chars = 搜作品时进了某部作品的角色列表。
 * 页面上只分两种（「角色 | 作品」）：works 和 work-chars 都算「搜作品」。
 */
export type SearchView = 'char' | 'works' | 'work-chars'

/** 在输入框里打字之后：搜角色还是搜角色；搜作品时（包括在作品的角色列表里）回到作品列表、按新打的字搜 */
export function viewAfterTyping(view: SearchView): SearchView {
  return view === 'char' ? 'char' : 'works'
}

/** 猜完一次（输入框清空）之后：留在原来那种状态；从作品里选的 → 回到作品列表（空的，等打字） */
export function viewAfterGuess(view: SearchView): SearchView {
  return view === 'char' ? 'char' : 'works'
}

/** 这次猜测是怎么选出来的（发给后端的 via）：只有从作品的角色列表里选的算 work */
export function viaOf(view: SearchView): GuessVia {
  return view === 'work-chars' ? 'work' : 'name'
}

/** 「别名：…」（只有命中的名字和显示的名字不一样时才有） */
function aliasText(it: SuggestItem): string {
  const m = (it as SoloSearchItem).matched
  return typeof m === 'string' && m.trim() && m !== it.value ? `别名：${m}` : ''
}

const joinSub = (...parts: string[]) => parts.filter(Boolean).join(' · ')

export interface SearchItem {
  key: string
  kind: 'char' | 'work'
  /** 角色 id 或作品 id；没有 id 的项选不了 */
  id: number | null
  title: string
  sub: string
  /** 显示头像（只有角色有） */
  avatarId: number | null
  disabled: boolean
  /** 选不了的原因（显示在项的右边） */
  disabledText?: string
}

/**
 * 「名字（最佳作品）」→「最佳作品」（取末尾那一对括号里的内容，括号可以嵌套）。
 * 末尾没有括号：给了 value 且 label 和它不一样 → 整个 label；否则 ''。
 */
export function parenPart(label: string | null | undefined, value?: string): string {
  if (!label) return ''
  const s = label.trim()
  const isClose = (c: string) => c === '）' || c === ')'
  const isOpen = (c: string) => c === '（' || c === '('
  if (s.length > 0 && isClose(s[s.length - 1]!)) {
    // 从末尾往前找配对的左括号（作品名里自己也可能带括号）
    let depth = 0
    for (let i = s.length - 1; i >= 0; i--) {
      const c = s[i]!
      if (isClose(c)) depth++
      else if (isOpen(c) && --depth === 0) return s.slice(i + 1, -1).trim()
    }
  }
  return value !== undefined && s !== value ? s : ''
}

export function fromLocalCharacters(items: readonly SuggestItem[]): SearchItem[] {
  return items.map((it, i) => {
    const id = typeof it.id === 'number' ? it.id : null
    return {
      key: `c-${id ?? `x${i}`}`,
      kind: 'char',
      id,
      title: it.value,
      sub: joinSub(parenPart(it.label, it.value), aliasText(it)),
      avatarId: id,
      disabled: id == null,
      disabledText: id == null ? '缺角色 id' : undefined,
    }
  })
}

export function fromLocalWorks(items: readonly SuggestItem[]): SearchItem[] {
  return items.map((it, i) => {
    const id = typeof it.id === 'number' ? it.id : null
    return {
      key: `w-${id ?? `x${i}`}`,
      kind: 'work',
      id,
      title: it.value,
      sub: joinSub(parenPart(it.label, it.value), aliasText(it)),
      avatarId: null,
      disabled: id == null,
      disabledText: id == null ? '缺作品 id' : undefined,
    }
  })
}

export function fromBgm(items: readonly BgmSearchItem[], kind: 'char' | 'work'): SearchItem[] {
  return items.map((it) => {
    const cn = (it.name_cn ?? '').trim()
    const jp = (it.name ?? '').trim()
    const title = cn || jp || String(it.id)
    const sub = [cn && jp && cn !== jp ? jp : '', kind === 'work' ? parenPart(it.label) : ''].filter(Boolean).join(' · ')
    return {
      key: `${kind === 'char' ? 'bc' : 'bw'}-${it.id}`,
      kind,
      id: it.id,
      title,
      sub,
      avatarId: kind === 'char' ? it.id : null,
      disabled: !it.in_library,
      disabledText: it.in_library ? undefined : '本地库没有',
    }
  })
}

export function fromWorkCharacters(items: readonly WorkCharacter[]): SearchItem[] {
  return items.map((it) => ({
    key: `wc-${it.id}`,
    kind: 'char',
    id: it.id,
    title: it.name,
    sub: [it.relation, it.gender && it.gender !== '?' ? it.gender : ''].filter(Boolean).join(' · '),
    avatarId: it.id,
    disabled: false,
  }))
}
