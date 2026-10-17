/**
 * 经典工作台的可用状态和样例方案。
 * 经典工作台需要经典工作台数据：后端装了经典工作台数据才加载它，没装时 /classic/status 返回 available=false，
 * 前端据此在导航里隐藏经典工作台的入口，直接打开它的页面时显示说明页（见 docs/legacy.md 的「经典工作台」一节）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, errorText } from '@/lib/apiClient'
import { toast } from '@/components/ui/Toast'
import { PLANS_KEY } from '@/features/plans/hooks'

export interface ClassicStatus {
  /** 经典工作台数据已加载，经典工作台可用 */
  available: boolean
  /** 经典工作台数据里的动画作品数 / 角色数（不可用时为 0） */
  works: number
  chars: number
  /** 仓库附带的样例方案个数（examples/classic-plans/） */
  sample_plans: number
  /** 不可用时的原因（可用时为 null） */
  reason: string | null
}

export interface LoadSamplesResp {
  ok: boolean
  /** 这次新放进方案库的个数 */
  added: number
  /** 方案库里已经有同名方案、没动的个数 */
  skipped: number
}

/** GET /status：经典工作台数据里的作品数、角色数（经典工作台用的数据） */
export interface ClassicCounts {
  works: number
  chars: number
  ready: boolean
}

/** GET /ext/meta：经典工作台数据文件的新鲜度 */
export interface DataMeta {
  data_root?: string
  files: { key: string; name: string; path: string; required?: boolean; exists: boolean; size?: number | null; mtime?: number | null }[]
  plans_count?: number
  server_time?: number
}

export const classicApi = {
  status: () => api.get<ClassicStatus>('/classic/status', { timeoutMs: 8000 }),
  counts: () => api.get<ClassicCounts>('/status', { timeoutMs: 8000 }),
  meta: () => api.get<DataMeta>('/ext/meta', { timeoutMs: 8000 }),
  loadSamples: () => api.post<LoadSamplesResp>('/classic/samples/load', undefined, { timeoutMs: 30_000 }),
}

export const CLASSIC_STATUS_KEY = ['classic', 'status'] as const

/** 经典工作台能不能用（页面加载时读一次；设置页「测试并使用」会连同别的查询一起刷新） */
export function useClassicStatus() {
  return useQuery({ queryKey: CLASSIC_STATUS_KEY, queryFn: classicApi.status, staleTime: 60_000, retry: false })
}

/** 没查完、查不到、或后端没装经典工作台数据时都是 false：经典工作台的入口先不显示 */
export function useClassicAvailable(): boolean {
  return useClassicStatus().data?.available === true
}

/** 「载入样例方案」：把仓库附带的样例方案放进经典方案库，已有同名方案的不覆盖 */
export function useLoadSamples() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: classicApi.loadSamples,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: PLANS_KEY })
      toast.success(r.added ? `载入了 ${r.added} 个样例方案` : '样例方案都已经在方案库里了', {
        description: r.skipped ? `${r.skipped} 个同名方案没动` : undefined,
      })
    },
    onError: (e) => toast.error('载入样例方案失败', { description: errorText(e) }),
  })
}

/** 数据页用：经典工作台数据的作品数、角色数（经典工作台数据没装时不请求） */
export function useClassicCounts() {
  const enabled = useClassicAvailable()
  return useQuery({ queryKey: ['classic', 'counts'], queryFn: classicApi.counts, enabled, staleTime: 60_000, retry: 1 })
}

/** 数据页用：经典工作台数据文件的新鲜度（经典工作台数据没装时不请求） */
export function useClassicMeta() {
  const enabled = useClassicAvailable()
  return useQuery({ queryKey: ['classic', 'meta'], queryFn: classicApi.meta, enabled, staleTime: 60_000, retry: 1 })
}
