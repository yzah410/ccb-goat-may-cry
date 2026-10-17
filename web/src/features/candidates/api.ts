/**
 * 候选相关接口。页面层只调这里，不用管后端「有的要包 {config}、有的不包」的差异：
 *   /preview、/draw      → 请求体是裸 ConfigPayload
 *   /candidates、/stats  → 请求体是 { config, ... }
 */
import { api } from '@/lib/apiClient'
import { clamp } from '@/lib/format'
import type { ConfigPayload } from '@/features/blocks/schema'
import type { CandidatesResp, DrawResult, PreviewResp, StatsResp } from './types'

export const candidatesApi = {
  /** 快速探针：总人数 + 最多 30 个样本（不排序、不分页） */
  preview: (config: ConfigPayload, signal?: AbortSignal) => api.post<PreviewResp>('/preview', config, { signal }),

  /** 按权重随机抽一个（seed 固定时结果固定） */
  draw: (config: ConfigPayload, signal?: AbortSignal) => api.post<DrawResult>('/draw', config, { signal }),

  /** 候选列表（后端分页，每页 1–20；排序固定：年份 ↑、权重 ↓、评分 ↓、作品名、角色名） */
  list: (config: ConfigPayload, page: number, pageSize: number, signal?: AbortSignal) =>
    api.post<CandidatesResp>(
      '/candidates',
      { config, page: Math.max(1, Math.floor(page)), page_size: clamp(Math.floor(pageSize), 1, 20) },
      { signal, timeoutMs: 90_000 },
    ),

  /** 统计：年份、性别、标签的分布 */
  stats: (config: ConfigPayload, signal?: AbortSignal) =>
    api.post<StatsResp>('/stats', { config }, { signal, timeoutMs: 90_000 }),
}
