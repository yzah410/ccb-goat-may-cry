/**
 * AI 接口的设置（后端 GET / PUT /v2/ai/config、POST /v2/ai/test、POST /v2/ai/models）。
 * 后端从不把 API key 发回来：只给 has_key（存没存）和 key_hint（「…后 4 位」）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/apiClient'
import { V2_KEYS } from '@/features/v2/hooks'
import type { AiProtocol } from './providers'

export interface AiApiConfig {
  protocol: AiProtocol
  preset: string | null
  base_url: string
  model: string
  max_tokens: number | null
  has_key: boolean
  key_hint: string
  /** key 来自环境变量 OUTSETTER_AI_API_KEY（网页改不了） */
  key_from_env: boolean
  /** 按现在的设置输入条能不能用（和 AI 状态里 API 那一项的判断一样） */
  configured: boolean
  /** 不能用的原因；能用时是 null */
  problem: string | null
}

/** 发给后端的表单。api_key 不带 = 不改；clear_key = 清掉存着的 key */
export interface AiConfigBody {
  protocol: AiProtocol
  preset: string | null
  base_url: string
  model: string
  max_tokens: number | null
  api_key?: string
  clear_key?: boolean
}

export interface AiConfigSaveResp {
  ok: boolean
  /** 例：接口地址换了、存着的 key 被清掉时的提示；key 来自环境变量、又换了接口地址时的提醒 */
  message: string | null
  key_cleared: boolean
  config: AiApiConfig
}

export interface AiTestResp {
  ok: boolean
  ms: number
  reply: string | null
  error: string | null
  error_code?: string | null
}

export interface AiModelsResp {
  ok: boolean
  models: string[]
  error: string | null
}

export const AI_CONFIG_KEY = ['v2', 'ai-config'] as const

export const aiConfigApi = {
  get: (signal?: AbortSignal) => api.get<AiApiConfig>('/v2/ai/config', { signal }),
  save: (body: AiConfigBody) => api.put<AiConfigSaveResp>('/v2/ai/config', body),
  /** 用表单里还没保存的值发一个很短的请求 */
  test: (body: AiConfigBody) => api.post<AiTestResp>('/v2/ai/test', body, { timeoutMs: 75_000 }),
  models: (body: AiConfigBody) => api.post<AiModelsResp>('/v2/ai/models', body, { timeoutMs: 30_000 }),
}

export function useAiConfig() {
  return useQuery({ queryKey: AI_CONFIG_KEY, queryFn: ({ signal }) => aiConfigApi.get(signal), staleTime: Infinity, retry: 1 })
}

/** 保存后：更新这份设置，并让 AI 状态（输入条用的）重新查一次 */
export function useSaveAiConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: aiConfigApi.save,
    onSuccess: (data) => {
      qc.setQueryData(AI_CONFIG_KEY, data.config)
      void qc.invalidateQueries({ queryKey: V2_KEYS.aiStatus })
    },
  })
}
