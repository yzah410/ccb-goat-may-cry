/**
 * 标签笔记 / 方案库接口（后端 /v2/tagnote、/v2/maps、/v2/map_samples）。页面层只调这里。
 */
import { api, isApiError, request } from '@/lib/apiClient'
import { asArray } from '@/features/v2/api'
import type { GenerateBody, MapDetail, MapPatch, MapSamples, MapSamplesLoaded, MapSummary, TagNoteData } from './types'

const enc = encodeURIComponent

/** 生成要把整个候选池过一遍（和导出 .canvas 一样），给足时间 */
const GENERATE_TIMEOUT = 120_000

export const tagnoteApi = {
  /** 当前工作台方案 → 作品集 JSON（不含 layout_cache） */
  generate: (body: GenerateBody) => api.post<TagNoteData>('/v2/tagnote', body, { timeoutMs: GENERATE_TIMEOUT }),
  /** 作品集 JSON → Obsidian 笔记（.md） */
  noteFromData: (data: TagNoteData) => api.post<Blob>('/v2/tagnote/note', { data }, { responseType: 'blob' }),

  list: async (signal?: AbortSignal): Promise<MapSummary[]> => asArray<MapSummary>(await api.get<unknown>('/v2/maps', { signal })),
  get: (id: string, signal?: AbortSignal) => api.get<MapDetail>(`/v2/maps/${enc(id)}`, { signal }),
  create: (data: TagNoteData) => api.post<MapSummary>('/v2/maps', { data }),
  patch: (id: string, changes: MapPatch) => request<MapSummary>(`/v2/maps/${enc(id)}`, { method: 'PATCH', body: changes }),
  /** 204 没有正文：按文本读，免得 JSON 解析报错 */
  remove: async (id: string): Promise<void> => {
    await api.del<string>(`/v2/maps/${enc(id)}`, { responseType: 'text' })
  },
  note: (id: string) => api.get<Blob>(`/v2/maps/${enc(id)}/note`, { responseType: 'blob' }),

  /** 样例导图：一共几张、方案库里还没有的几张 */
  samples: (signal?: AbortSignal) => api.get<MapSamples>('/v2/map_samples', { signal }),
  /** 把方案库里还没有的样例导图都复制进来；已有同 id 的图跳过，不覆盖 */
  loadSamples: () => api.post<MapSamplesLoaded>('/v2/map_samples/load'),
}

// ---------------------------------------------------------------- 生成时的错误
export type GenerateErrorInfo =
  | { code: 'too_many_works'; count: number | null; limit: number | null; message: string }
  | { code: 'empty_pool'; message: string }
  | { code: 'spec_has_errors'; messages: string[]; message: string }
  | { code: 'other'; message: string }

/** 后端 409 的三种情况拆出来（错误体：{ ok: false, error, message, ...extra }），其余归为 other */
export function generateErrorInfo(e: unknown): GenerateErrorInfo {
  const message = e instanceof Error ? e.message : String(e)
  if (!isApiError(e) || e.kind !== 'http') return { code: 'other', message }
  const body = (e.detail ?? {}) as { error?: unknown; count?: unknown; limit?: unknown; errors?: unknown }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  if (body.error === 'too_many_works') return { code: 'too_many_works', count: num(body.count), limit: num(body.limit), message }
  if (body.error === 'empty_pool') return { code: 'empty_pool', message }
  if (body.error === 'spec_has_errors') {
    const list = Array.isArray(body.errors) ? body.errors : []
    const messages = list
      .map((x) => (x && typeof x === 'object' && typeof (x as { message?: unknown }).message === 'string' ? (x as { message: string }).message : null))
      .filter((x): x is string => !!x)
    return { code: 'spec_has_errors', messages, message }
  }
  return { code: 'other', message }
}
