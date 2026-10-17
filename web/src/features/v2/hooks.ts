/**
 * 出题器通用 hooks：meta、自动补全、清单、方案、AI 状态。
 * 查询 key 都以 'v2' 开头；改了清单 / 方案会让相关查询失效。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { errorText, isApiError } from '@/lib/apiClient'
import { toast } from '@/components/ui/Toast'
import type { NameLookup } from '@/features/workbench2/summary'
import { normalizeSpec } from '@/features/workbench2/spec'
import { v2Api, type ListBody } from './api'
import { aiAvailabilityOf, type AiAvailability } from './aiAvailability'
import type { ListKind, ListV2, ModeId, SpecV2, SuggestKind } from './types'

export const V2_KEYS = {
  meta: ['v2', 'meta'] as const,
  lists: ['v2', 'lists'] as const,
  plans: ['v2', 'plans'] as const,
  aiStatus: ['v2', 'ai-status'] as const,
  schema: ['v2', 'sql-schema'] as const,
}

/** 后端没有 /v2 接口（404）：可能后端是更新代码之前启动的，页面提示重启 */
export function isV2Missing(e: unknown): boolean {
  return isApiError(e) && e.endpointMissing
}

export function useV2Meta() {
  return useQuery({ queryKey: V2_KEYS.meta, queryFn: ({ signal }) => v2Api.meta(signal), staleTime: 5 * 60_000, retry: 1 })
}

/** 输入框防抖 */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return v
}

/** 某个请求跑了超过 ms 毫秒（给「正在加载数据」这类提示用） */
export function useSlow(active: boolean, ms = 1200): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!active) return
    const t = window.setTimeout(() => setSlow(true), ms)
    return () => {
      window.clearTimeout(t)
      setSlow(false)
    }
  }, [active, ms])
  return active && slow
}

/** 从某个时间点到现在过了几秒（AI 进行中的计时） */
export function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since == null) return
    const t = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(t)
  }, [since])
  return since == null ? 0 : Math.max(0, Math.floor((now - since) / 1000))
}

// ---------------------------------------------------------------- 自动补全
export function useSuggest(kind: SuggestKind, q: string, opts: { mode?: ModeId; n?: number; enabled?: boolean; limit?: number } = {}) {
  // 作品标签（游戏格子）的数字按对局设置算：模式 + 作品标签数
  const needsMode = kind === 'game_tag'
  const mode = needsMode ? opts.mode : undefined
  const n = needsMode ? opts.n : undefined
  return useQuery({
    queryKey: ['v2', 'suggest', kind, mode ?? null, n ?? null, q, opts.limit ?? 20],
    queryFn: ({ signal }) => v2Api.suggest(kind, q, { mode, n, limit: opts.limit, signal }),
    enabled: opts.enabled ?? true,
    staleTime: 10 * 60_000,
    retry: false,
  })
}

// ---------------------------------------------------------------- 清单
export function useListsV2(enabled = true) {
  return useQuery({ queryKey: V2_KEYS.lists, queryFn: ({ signal }) => v2Api.lists(signal), staleTime: 30_000, enabled, retry: 1 })
}

/** 按种类取清单（下拉框用） */
export function useListsOfKind(kind: ListKind): { lists: ListV2[]; isPending: boolean; isError: boolean } {
  const q = useListsV2()
  const lists = useMemo(() => (q.data ?? []).filter((l) => l.kind === kind), [q.data, kind])
  return { lists, isPending: q.isPending, isError: q.isError }
}

/** 清单 id → 名字（条件摘要用） */
export function useNameLookup(): NameLookup {
  const q = useListsV2()
  return useMemo(() => {
    const m = new Map((q.data ?? []).map((l) => [l.id, l.name]))
    return { list: (id: string) => m.get(id) ?? (q.data ? null : '…') }
  }, [q.data])
}

export function useSaveList() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: ListBody }) => (id ? v2Api.updateList(id, body) : v2Api.createList(body)),
    onSuccess: (l, v) => {
      void qc.invalidateQueries({ queryKey: V2_KEYS.lists })
      toast.success(v.id ? `已保存清单「${v.body.name}」` : `建好了清单「${l?.name ?? v.body.name}」`, { id: 'list-save' })
    },
    onError: (e) => toast.error('清单没保存成', { description: errorText(e) }),
  })
}

export function useDeleteList() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (l: ListV2) => v2Api.deleteList(l.id),
    onSuccess: (_r, l) => {
      void qc.invalidateQueries({ queryKey: V2_KEYS.lists })
      toast.success(`删掉了清单「${l.name}」`)
    },
    onError: (e) => toast.error('删除失败', { description: errorText(e) }),
  })
}

// ---------------------------------------------------------------- 方案
export function usePlansV2(enabled = true) {
  return useQuery({ queryKey: V2_KEYS.plans, queryFn: ({ signal }) => v2Api.plans(signal), staleTime: 15_000, enabled, retry: 1 })
}

/**
 * 方案列表 + 每个方案的内容（方案库显示摘要、清单页算「被哪些方案用到」）。
 * 列表里没有方案内容，所以逐个 GET（最多 80 个，每个缓存 1 分钟）。
 */
export function usePlansV2WithSpecs(enabled = true) {
  const list = usePlansV2(enabled)
  const names = useMemo(() => (list.data ?? []).slice(0, 80).map((p) => p.name), [list.data])
  const combine = useCallback(
    (rs: { data?: unknown; isPending: boolean }[]) => {
      const m = new Map<string, unknown>()
      rs.forEach((r, i) => {
        if (r.data) m.set(names[i]!, r.data)
      })
      return { map: m, pending: rs.some((r) => r.isPending) }
    },
    [names],
  )
  const specs = useQueries({
    queries: names.map((n) => ({
      queryKey: ['v2', 'plan', n],
      queryFn: () => v2Api.plan(n),
      staleTime: 60_000,
      enabled,
      retry: false,
    })),
    combine,
  })
  const withSpecs = useMemo(() => {
    const out = new Map<string, SpecV2>()
    for (const p of list.data ?? []) {
      const raw = specs.map.get(p.name)
      if (raw) out.set(p.name, normalizeSpec(raw).spec)
    }
    return out
  }, [list.data, specs.map])
  return { list, specs: withSpecs, specsPending: specs.pending }
}

export function useInvalidatePlansV2() {
  const qc = useQueryClient()
  return useCallback(() => void qc.invalidateQueries({ queryKey: V2_KEYS.plans }), [qc])
}

// ---------------------------------------------------------------- AI
export function useAiStatus() {
  return useQuery({ queryKey: V2_KEYS.aiStatus, queryFn: () => v2Api.aiStatus(), staleTime: 60_000, retry: 1, refetchOnWindowFocus: true })
}

/** AI 能不能用；不能用的时候给一句原因（不报错）。判断逻辑在 aiAvailability.ts */
export function useAiAvailability(): AiAvailability {
  const q = useAiStatus()
  return useMemo(() => {
    if (q.isPending) return { ...aiAvailabilityOf(undefined), reason: null, loading: true }
    if (q.isError) {
      const reason = isV2Missing(q.error) ? '后端没有 AI 接口（后端可能是更新代码之前启动的，重新运行启动脚本）' : `查不到 AI 状态：${errorText(q.error)}`
      return { ...aiAvailabilityOf(undefined), reason }
    }
    return aiAvailabilityOf(q.data)
  }, [q.isPending, q.isError, q.error, q.data])
}

/** 后端数据加载到哪一步（只在「等太久」的时候轮询 /v2/status，给「正在加载数据」提示补一句具体的） */
export function useV2LoadingStage(active: boolean): string | null {
  const q = useQuery({
    queryKey: ['v2', 'status'],
    queryFn: ({ signal }) => v2Api.status(signal),
    enabled: active,
    refetchInterval: active ? 800 : false,
    retry: false,
    staleTime: 0,
  })
  if (!active || !q.data) return null
  return q.data.phase === 'loading' && q.data.stage ? q.data.stage : null
}
