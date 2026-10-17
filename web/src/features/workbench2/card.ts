/**
 * 候选池 / 抽到的人的角色卡片要显示的数，从接口的字段里取。纯函数，有单测。
 *
 * 卡片上每个数对应接口（POST /v2/candidates 的 items[]、POST /v2/draw）的哪个字段：
 *
 * | 卡片上 | 字段 | 说明 |
 * |---|---|---|
 * | 评分 | `grid.rating` | 登场作品里的最高评分（游戏格子的「最高分」）；null、-1 或 0（没人评过分）→ 「—」 |
 * | 热度 | `character.heat` | 角色热度：Bangumi 上收藏这个角色的人数 |
 * | 登场 N 部 | `grid.n_app` | 这个模式下游戏算的登场作品数（游戏格子的「作品数」）；和 `appear_count` 相同 |
 * | 时间线两端 | `grid.earliest` / `grid.latest` | 最早 / 最晚登场年；null 或 -1 = 没有 → 「登场年份未知」 |
 * | 代表作 | `appear_best.name`（= 取到这个角色的作品 `bound_work`）| 它在 `appearances` 里时用它；不在（例如按动画范围取、游戏模式算格子）就用 `appearances[0]` |
 * | 代表作后面的「+N 部」 | `grid.n_app − 1` | 悬停列出 `appearances` 里其余的名字（接口最多给 10 个，其余写「还有 K 部」） |
 * | 作品标签 | `grid.tags`（= `work_tags`） | 游戏格子里会显示的作品标签，按 `lib/tagRules.json` 分栏：规则看 `grid.mode`；「全部」模式或 `grid.fallback` 时用混合规则，再看 `has_anime`（有动画登场 → 第一栏只留动画的来源 + 播放形式） |
 * | 所在范围 | `ranges` | 角色落在哪些纳入范围里（范围 id → 范围名）；只在启用了 2 个以上范围时显示 |
 */
import type { TagStyle } from '@/lib/tags'
import type { TagChipKind } from '@/components/data-display/TagChip'
import type { CandidateV2 } from '@/features/v2/types'

/** 分栏规则里的配色 → 标签芯片的样子（来源加粗、播放形式普通、绿色题材加粗 / 普通、公司灰底带楼房图标） */
export function chipForStyle(style: TagStyle | null): { kind: TagChipKind; emphasis: 'strong' | 'soft' } {
  switch (style) {
    case 'source':
      return { kind: 'source', emphasis: 'strong' }
    case 'playback':
      return { kind: 'playback', emphasis: 'soft' }
    case 'genre-primary':
      return { kind: 'genre', emphasis: 'strong' }
    case 'genre-secondary':
      return { kind: 'genre', emphasis: 'soft' }
    case 'studio':
      return { kind: 'studio', emphasis: 'soft' }
    default:
      return { kind: 'work', emphasis: 'soft' }
  }
}

/**
 * 作品标签分栏要的三个开关（lib/tags.ts 的 columnizeWorkTags）：模式 = grid.mode；退回规则 = grid.fallback；
 * 有没有动画登场 = has_anime（后端字段，顶层和 character 里各一份；字段缺失时当成 false）。
 * has_anime 的定义：动画模式画像里不是退回规则、登场数 > 0；和当前选的模式无关。
 */
export function tagRuleInput(
  item: Pick<CandidateV2, 'grid'> & { has_anime?: boolean | null; character?: unknown },
): { mode: string | undefined; fallback: boolean; hasAnime: boolean } {
  const ch = item.character as { has_anime?: boolean | null } | null | undefined
  return { mode: item.grid?.mode, fallback: !!item.grid?.fallback, hasAnime: !!(item.has_anime ?? ch?.has_anime) }
}

/** -1 / null / NaN → null（接口里「没有」有两种写法） */
export function presentNum(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(v) || v < 0 ? null : v
}

export interface CardNumbers {
  /** 最高评分；没有 = null */
  rating: number | null
  heat: number
  /** 登场作品数（游戏格子的「作品数」） */
  nApp: number
  earliest: number | null
  latest: number | null
}

export function cardNumbers(item: Pick<CandidateV2, 'character' | 'grid'>): CardNumbers {
  const g = item.grid
  const c = item.character
  const rating = presentNum(g?.rating ?? c.max_score ?? null)
  return {
    // 0 分 = 没人评过分（游戏里显示 0），卡片上当成「没有」
    rating: rating && rating > 0 ? rating : null,
    heat: c.heat ?? 0,
    nApp: Math.max(0, g?.n_app ?? 0),
    earliest: presentNum(g?.earliest ?? c.earliest_year ?? null),
    latest: presentNum(g?.latest ?? c.latest_year ?? null),
  }
}

export interface RepresentativeWork {
  /** 代表作名字；没有任何登场作品 = null */
  name: string | null
  /** 只有用的是 appear_best（取到这个角色的作品）时才知道年份 */
  year: number | null
  /** 除了代表作还有几部（= 登场数 − 1） */
  more: number
  /** 悬停时列出的其余作品（接口给的名字，最多 10 个里去掉代表作） */
  others: string[]
  /** 其余作品里接口没给名字的有几部（「…还有 K 部」） */
  unnamed: number
}

type WorkFields = Pick<CandidateV2, 'appearances' | 'grid'> & {
  appear_best?: { name?: string | null; year?: number | null } | null
  bound_work?: { name?: string | null; year?: number | null } | null
}

/**
 * 代表作 + 「+N 部」。
 * 代表作优先用「取到这个角色的作品」（appear_best / bound_work），但只在它确实是这个模式下的登场作品之一时用
 * （例如动画范围取的人、对局模式是游戏：取到他的动画不算游戏格子里的登场），否则用登场作品第一部；这样「+N 部」永远 = 登场数 − 1。
 */
export function representativeWork(item: WorkFields): RepresentativeWork {
  const apps = (item.appearances ?? []).filter((a) => typeof a === 'string' && a.length > 0)
  const nApp = Math.max(0, item.grid?.n_app ?? apps.length)
  const bound = item.appear_best ?? item.bound_work ?? null
  const useBound = !!bound?.name && apps.includes(bound.name)
  const name = useBound ? bound!.name! : (apps[0] ?? null)
  if (!name) return { name: null, year: null, more: 0, others: [], unnamed: 0 }
  const others = apps.filter((a) => a !== name)
  const more = Math.max(0, Math.max(nApp, apps.length) - 1)
  return { name, year: useBound ? (bound!.year ?? null) : null, more, others, unnamed: Math.max(0, more - others.length) }
}
