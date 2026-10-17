/**
 * 标签分档 / 公式（后端 GET / PUT /v2/tiers，存在 data/tag_tiers.json）。
 * configured = false：还没选过公式 → 开局问卷（TiersGate）弹出来。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/apiClient'

export const TIER_KEYS = ['G_1', 'G_2', 'G_3', 'G_4'] as const
export type TierKey = (typeof TIER_KEYS)[number]
export type Tiers = Record<TierKey, string[]>

export interface FormulaChar {
  id: number
  name: string
}

/** 公式：2–3 个角色；null = 跳过了问卷 / 只用默认分档 */
export interface Formula {
  chars: FormulaChar[]
}

export interface TiersResp {
  configured: boolean
  formula: Formula | null
  tiers: Tiers
  /** 默认分档（没选公式时用的固定分档） */
  defaults: Tiers
  /** 来源 / 播放形式 / 制作公司：固定的组，不能放进分档 */
  fixed: Record<'G_source' | 'G_format' | 'G_staff', string[]>
  updated: string | null
  /** data/tag_tiers.json 读不了时的原因（这时用默认分档） */
  error: string | null
}

export const TIERS_KEY = ['v2', 'tiers'] as const

export const tiersApi = {
  get: (signal?: AbortSignal) => api.get<TiersResp>('/v2/tiers', { signal }),
  save: (body: { formula: Formula | null; tiers: Tiers }) => api.put<TiersResp>('/v2/tiers', body),
}

export function useTiers() {
  return useQuery({ queryKey: TIERS_KEY, queryFn: ({ signal }) => tiersApi.get(signal), staleTime: Infinity, retry: 1 })
}

export function useSaveTiers() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: tiersApi.save,
    onSuccess: (data) => qc.setQueryData(TIERS_KEY, data),
  })
}

export function sameTiers(a: Tiers, b: Tiers): boolean {
  return TIER_KEYS.every((k) => a[k].length === b[k].length && a[k].every((t, i) => t === b[k][i]))
}

export const TIER_LABEL: Record<TierKey, string> = { G_1: '第 1 档', G_2: '第 2 档', G_3: '第 3 档', G_4: '第 4 档' }
