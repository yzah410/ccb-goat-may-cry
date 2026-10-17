/**
 * 导图联动的后端接口（/v2/maplink/*，后端 backend/v2/maplink.py、maplink_router.py）：
 * - 预选：按方案算「该开哪几张图」（贪心，覆盖方案里几乎所有题）
 * - 图组存储：按方案记住用户选的那组图
 * 错误格式 {ok:false, error:<代码>, message:<中文>}：apiClient 已经把 message 放进 ApiError.message，代码用 maplinkErrorCode(e) 取。
 */
import { api, isApiError } from '@/lib/apiClient'
import type { SpecV2 } from '@/features/v2/types'

const enc = encodeURIComponent

/** 预选的默认值（后端也是这两个） */
export const PRESELECT_DEFAULT_CAP = 8
export const PRESELECT_DEFAULT_TARGET = 0.95

/** spec 和 plan_name 二选一：给了 spec 就用它；只给 plan_name 就读已保存的方案 */
export interface PreselectBody {
  spec?: SpecV2
  plan_name?: string
  /** 最多选几张图（1–100，默认 8） */
  cap?: number
  /** 目标覆盖率（0–1，默认 0.95）：达到后停止加图 */
  target?: number
}

/** 预选结果里的一张图（只列覆盖 ≥ 1 个题库角色的图，按覆盖数降序） */
export interface PreselectMap {
  id: string
  title: string
  group: string | null
  source: string | null
  /** 用户最近一次编辑的时间；没编辑过时是生成日期；都没有 = null */
  edited_at: string | null
  /** 这张图覆盖的题库角色 id（升序）。前端勾选 / 取消图时用它在本地重算覆盖，不用再请求 */
  covers: number[]
}

/** 被预选跳过的坏图：文件名不合规 / JSON 损坏 / 内容校验不过。一张图坏了不影响其他图预选 */
export interface SkippedMap {
  /** 图 id（文件名不合规的是文件名去掉 .json） */
  id: string
  /** 中文原因 */
  reason: string
}

/** 题库里的一个角色（pool 里按热度降序） */
export interface PoolChar {
  char_id: number
  name: string
  bound_work_id: number | null
  bound_work_name: string | null
}

export interface PreselectResult {
  /** 题库总人数 */
  pool_total: number
  /** 选中的图 id，按选中顺序（先选的覆盖得最多） */
  picked: string[]
  /** 选中的图合起来覆盖了多少人 */
  covered: number
  maps: PreselectMap[]
  /** 整个题库（按热度降序）：前端改了勾选以后，本地算「没覆盖的人」要用名字和绑定作品 */
  pool: PoolChar[]
  /** 题库里有多少人在所有图里都没有（不管选没选） */
  no_map: number
  /** 这些人的 id */
  no_map_ids: number[]
  /** 读不出来、没参与预选的坏图（按图 id 升序；没有坏图 = 空数组） */
  skipped: SkippedMap[]
  /** 方案本身的问题（和 /v2/solo/session 一样） */
  errors: { message: string }[]
  warnings: string[]
}

/** 一个方案记住的图组 */
export interface MapSet {
  plan_key: string
  map_ids: string[]
  updated_at: string | null
}

/** 后端错误体里的 error 代码（bad_cap / bad_target / bad_field / empty_pool / not_found / bad_spec / storage ...）；不是业务错误 = undefined */
export function maplinkErrorCode(e: unknown): string | undefined {
  if (!isApiError(e) || e.kind !== 'http') return undefined
  const d = e.detail as { error?: unknown } | null
  return d && typeof d.error === 'string' ? d.error : undefined
}

export const maplinkApi = {
  preselect: (body: PreselectBody, signal?: AbortSignal) =>
    api.post<PreselectResult>('/v2/maplink/preselect', body, { signal, timeoutMs: 60_000 }),

  /**
   * 读某个方案的图组。没存过 → null。
   * 注意区分「没存过」（后端 404 + error=not_found）和「后端没有这个接口」（404 但没有 error 代码）：后者按错误抛出。
   */
  getSet: async (planKey: string, signal?: AbortSignal): Promise<MapSet | null> => {
    try {
      return await api.get<MapSet>(`/v2/maplink/sets/${enc(planKey)}`, { signal })
    } catch (e) {
      if (isApiError(e) && e.status === 404 && maplinkErrorCode(e) === 'not_found') return null
      throw e
    }
  },

  /** 保存（整体替换）某个方案的图组；重复的 id 后端会去掉 */
  putSet: (planKey: string, mapIds: string[], signal?: AbortSignal) =>
    api.put<MapSet>(`/v2/maplink/sets/${enc(planKey)}`, { map_ids: mapIds }, { signal }),
}
