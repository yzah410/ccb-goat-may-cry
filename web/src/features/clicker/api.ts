/**
 * 自动点击接口（once / dry_run / probe / cancel / status / auto）。
 * 注意：/autoclick/once 是「立刻返回 + 后台执行」，结果要轮询 /autoclick/status 看。
 */
import { api } from '@/lib/apiClient'
import type { ConfigPayload } from '@/features/blocks/schema'
import type { ClickerMode, LocateResult } from './normalize'

export interface OnceBody {
  mode: ClickerMode
  char_id?: number | null
  char_name?: string | null
  work_name_hint?: string | null
}

export interface OnceResp {
  task_id: string
  accepted: boolean
  message?: string | null
  state?: string | null
}

export interface AutoResp {
  ok: boolean
  result?: string
  error?: string
}

export interface ProbeResp {
  ok: boolean
  browser?: string | null
  pages?: { url?: string; title?: string }[]
  matched_pages?: { url?: string; title?: string }[]
  connected?: boolean
  cdp?: string
  error?: string | null
  /** 连不上的原因（ok 时为 null）：refused = 端口没人听；timeout = 端口在但不回；error = 其他 */
  error_code?: 'refused' | 'timeout' | 'error' | null
}

/**
 * POST /autoclick/cancel 的结果（接口最多等 2 秒看任务停没停）：
 * cancelled = 已经停下；cancelling = 已发取消、还没停；stuck = 5 秒还没停、后端已重置浏览器连接；no_task = 没有在跑的任务
 */
export interface CancelResp {
  ok: boolean
  result?: 'cancelled' | 'cancelling' | 'stuck' | 'no_task' | (string & {})
}

export const clickerApi = {
  status: () => api.get<unknown>('/autoclick/status', { timeoutMs: 8000 }),
  once: (body: OnceBody) => api.post<OnceResp>('/autoclick/once', body),
  /**
   * 只定位不点击（POST /autoclick/dry_run，同步返回定位结果）。
   */
  dryRun: (body: OnceBody & { in_page?: boolean }) =>
    api.post<LocateResult>('/autoclick/dry_run', { in_page: true, ...body }, { timeoutMs: 60_000 }),
  probe: () => api.get<ProbeResp>('/autoclick/probe', { timeoutMs: 8000 }),
  cancel: () => api.post<CancelResp>('/autoclick/cancel'),
  /** 自动模式：每一轮按经典工作台的组块配置抽题（需要经典工作台数据）；停止 / 状态用 /autoclick/auto/stop、/autoclick/status */
  autoStart: (mode: ClickerMode, config: ConfigPayload) => api.post<AutoResp>('/autoclick/auto/start', { mode, config }),
  /** 自动模式：每一轮按工作台的方案（SpecV2）抽题 */
  autoStartV2: (mode: ClickerMode, spec: unknown) => api.post<AutoResp>('/v2/autoclick/auto/start', { mode, spec }),
  autoStop: () => api.post<AutoResp>('/autoclick/auto/stop', undefined, { timeoutMs: 20_000 }),
}
