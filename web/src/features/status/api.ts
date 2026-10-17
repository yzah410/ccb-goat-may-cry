import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/apiClient'

/** GET /v2/status（不阻塞）：后端在线时返回出题器库加载到哪一步（phase: idle / loading / ready / no_db / error） */
export interface StatusResp {
  phase: string
  stage?: string | null
  ready?: boolean
}

export const statusApi = {
  status: () => api.get<StatusResp>('/v2/status', { timeoutMs: 8000 }),
}

export const STATUS_KEY = ['status'] as const

/** 后端在不在线（页面加载时读一次；设置页「测试并使用」会刷新它） */
export function useBackendStatus() {
  return useQuery({ queryKey: STATUS_KEY, queryFn: statusApi.status, staleTime: 60_000, retry: 1 })
}
