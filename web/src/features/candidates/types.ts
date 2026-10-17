/** 角色 / 抽题结果 / 统计的类型（「当前题目」、角色卡片、经典工作台的 /preview /draw /candidates /stats 响应在用） */
import type { DrawMode } from '@/features/blocks/schema'

export interface CharacterBrief {
  id: number
  /** name_cn 优先 */
  name: string
  /** "?" / "♂" / "♀" */
  gender: string
  heat: number
  max_score?: number | null
  earliest_year?: number | null
  latest_year?: number | null
}

export interface WorkRef {
  id: number | null
  name: string
  year: number | null
  favorites?: number
}

/** /draw 的响应（也是候选条目的主体） */
export interface DrawResult {
  mode: DrawMode
  char_id: number | null
  character: CharacterBrief | null
  bound_work_id?: number | null
  bound_work?: { id: number; name: string; year: number | null } | null
  appear_count?: number | null
  /** 代表作品；只知道名字时 id / year 为 null */
  appear_best?: WorkRef | null
  work_count?: number | null
  appearances?: string[] | null
  source_tag?: string | null
  playback_tags?: string[] | null
  work_tags?: string[] | null
  char_tags?: string[] | null
}

/** 一定有角色的抽题结果 */
export type ResolvedCharacter = DrawResult & { char_id: number; character: CharacterBrief }

export interface CandidateItem extends ResolvedCharacter {
  /** 在候选池里的最终权重（多个纳入块取最大） */
  weight: number
}

export interface CandidatesResp {
  total: number
  page: number
  page_size: number
  items: CandidateItem[]
}

export interface PreviewSample {
  id: number
  name: string
  gender: string
  heat: number
  weight: number
  earliest_year: number | null
  latest_year: number | null
}

export interface PreviewResp {
  total_candidates: number
  /** 最多 30 个，顺序不保证 */
  sample: PreviewSample[]
}

/** 候选统计：经典工作台 POST /stats 的响应（backend/api_ext.py）；工作台的 StatsV2Resp（features/v2/types.ts）直接用这个类型 */
export interface StatsResp {
  total: number
  by_year: { year: number; count: number }[]
  by_gender: Record<string, number>
  top_work_tags: { tag: string; count: number }[]
  top_char_tags: { tag: string; count: number }[]
  playback: Record<string, number>
  source: Record<string, number>
  year_min?: number | null
  year_max?: number | null
  avg_score?: number | null
  no_year?: number
  elapsed_ms?: number
}

export function isResolved(r: DrawResult | null | undefined): r is ResolvedCharacter {
  return !!r && r.char_id != null && !!r.character
}
