/**
 * 工作台的服务端状态：人数（evaluate，改完防抖 300ms）、候选、统计、抽题、方案的打开 / 保存。
 * 「人数」换新结果前保留旧结果（变淡），不闪骨架屏。
 */
import { useCallback, useMemo } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { errorText, isApiError } from '@/lib/apiClient'
import { toast } from '@/components/ui/Toast'
import { confirm } from '@/components/ui/Confirm'
import { v2Api } from '@/features/v2/api'
import { useDebounced, useSlow, useV2Meta, V2_KEYS } from '@/features/v2/hooks'
import type { CandidateSort, DrawV2, EvaluateResp, SpecV2 } from '@/features/v2/types'
import { defaultSpec, evalKey, normalizeSpec, poolKey } from './spec'
import { useIsDirtyV2, useWb2, useWb2Draw } from './store'

export const EVAL_DEBOUNCE_MS = 300

/** 连不上后端（例如后端刚好在重启）时自动再试两次（1.5 秒、3 秒后）；别的错误不重试 */
const retryNetwork = (n: number, e: unknown) => isApiError(e) && e.kind === 'network' && n < 2
const retryDelay = (n: number) => 1500 * (n + 1)

/** 当前方案 + 防抖后的方案（发请求用后者） */
export function useDebouncedSpec(): { spec: SpecV2; dSpec: SpecV2; settling: boolean } {
  const spec = useWb2((s) => s.spec)
  const dSpec = useDebounced(spec, EVAL_DEBOUNCE_MS)
  const settling = evalKey(spec) !== evalKey(dSpec)
  return { spec, dSpec, settling }
}

export interface EvaluateView {
  data: EvaluateResp | undefined
  /** 显示的是旧结果（方案刚改、还在等防抖或等后端） */
  stale: boolean
  fetching: boolean
  /** 第一次加载某个模式时后端比较慢：超过 1.2 秒就提示「正在加载数据」 */
  slow: boolean
  error: unknown
  refetch: () => void
  key: string
}

export function useEvaluate(): EvaluateView {
  const { dSpec, settling } = useDebouncedSpec()
  const key = useMemo(() => evalKey(dSpec), [dSpec])
  const q = useQuery({
    queryKey: ['v2', 'evaluate', key],
    queryFn: ({ signal }) => v2Api.evaluate(dSpec, signal),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    retry: retryNetwork,
    retryDelay,
  })
  const slow = useSlow(q.isFetching, 1200)
  return {
    data: q.data,
    stale: settling || q.isPlaceholderData || (q.isFetching && !!q.data),
    fetching: q.isFetching || settling,
    slow,
    error: q.isError ? q.error : null,
    refetch: () => void q.refetch(),
    key,
  }
}

/** 候选列表（后端分页）；换页保留上一页，避免闪白。随机打乱用 seed（同一个 seed 翻页顺序稳定） */
export function useCandidatesV2(args: { page: number; pageSize: number; sort: CandidateSort; q: string; seed?: number; enabled?: boolean }) {
  const { dSpec } = useDebouncedSpec()
  const key = useMemo(() => poolKey(dSpec), [dSpec])
  const seed = args.sort === 'random' ? (args.seed ?? 0) : undefined
  return useQuery({
    queryKey: ['v2', 'candidates', key, args.page, args.pageSize, args.sort, args.q, seed ?? null],
    queryFn: ({ signal }) =>
      v2Api.candidates({ spec: dSpec, page: args.page, page_size: args.pageSize, sort: args.sort, q: args.q || undefined, seed }, signal),
    enabled: args.enabled ?? true,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    retry: retryNetwork,
    retryDelay,
  })
}

export function useStatsV2(enabled: boolean) {
  const { dSpec } = useDebouncedSpec()
  const key = useMemo(() => poolKey(dSpec), [dSpec])
  return useQuery({
    queryKey: ['v2', 'stats', key],
    queryFn: ({ signal }) => v2Api.stats(dSpec, signal),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    retry: retryNetwork,
    retryDelay,
  })
}

/** 「抽一题」：用当前方案（不等防抖）调 /v2/draw */
export function useDrawV2() {
  const setDraw = useWb2Draw((s) => s.set)
  const m = useMutation({
    mutationFn: async (spec: SpecV2) => ({ key: poolKey(spec), data: await v2Api.draw(spec, spec.draw.seed ?? null) }),
    onSuccess: ({ key, data }) => {
      if (data.char_id == null || !data.character) {
        toast.warning('一个都没抽到', { description: '题库是空的：放宽条件，或者看看排除项' })
        return
      }
      setDraw(key, data as DrawV2)
    },
    onError: (e) => toast.error('抽题失败', { description: errorText(e) }),
  })
  const { mutate } = m
  const run = useCallback(() => mutate(useWb2.getState().spec), [mutate])
  return { run, isPending: m.isPending }
}

// ---------------------------------------------------------------- 方案：打开 / 保存 / 新建
export function useLoadPlanV2() {
  const dirty = useIsDirtyV2()
  return useCallback(
    async (name: string): Promise<boolean> => {
      if (dirty) {
        const cur = useWb2.getState().planName
        const ok = await confirm({
          title: '当前方案有改动还没保存',
          description: `打开「${name}」会换掉现在的方案${cur ? `（「${cur}」）` : ''}。换掉之后还能用「撤销」找回来。`,
          confirmLabel: '打开',
        })
        if (!ok) return false
      }
      try {
        const raw = await v2Api.plan(name)
        const { spec, warnings } = normalizeSpec(raw)
        useWb2.getState().loadPlan(name, spec, warnings)
        useWb2Draw.getState().clear()
        toast.success(`打开了「${name}」`, {
          description: warnings.length ? `自动修正了 ${warnings.length} 处：${warnings.slice(0, 2).join('；')}${warnings.length > 2 ? '…' : ''}` : undefined,
        })
        return true
      } catch (e) {
        toast.error(`打开「${name}」失败`, { description: errorText(e) })
        return false
      }
    },
    [dirty],
  )
}

/** 保存到某个名字（同名覆盖；要不要确认由调用方决定） */
export function useSavePlanV2() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (name: string) => {
      const s = useWb2.getState()
      const now = new Date().toISOString()
      const created = s.planName === name ? (s.spec.meta?.created ?? now) : now
      const spec: SpecV2 = { ...s.spec, meta: { ...(s.spec.meta ?? {}), name, created, updated: now } }
      await v2Api.savePlan(name, spec)
      return { name, spec }
    },
    onSuccess: ({ name, spec }) => {
      // meta（名字、时间）写回草稿：不进撤销历史、不算「改动」
      useWb2.setState((s) => ({ spec: { ...s.spec, meta: spec.meta } }))
      useWb2.getState().markSaved(name)
      void qc.invalidateQueries({ queryKey: V2_KEYS.plans })
      toast.success(`保存了「${name}」`, { id: 'plan-v2-save' })
    },
    onError: (e, name) => toast.error(`「${name}」没保存成`, { description: errorText(e) }),
  })
}

export function useDeletePlanV2() {
  const qc = useQueryClient()
  return useCallback(
    async (name: string): Promise<boolean> => {
      const ok = await confirm({ title: `删除方案「${name}」？`, description: '删了就找不回来了（后端直接删文件）。', confirmLabel: '删除', tone: 'danger' })
      if (!ok) return false
      try {
        await v2Api.deletePlan(name)
        if (useWb2.getState().planName === name) useWb2.setState({ planName: null })
        await qc.invalidateQueries({ queryKey: V2_KEYS.plans })
        toast.success(`删掉了「${name}」`)
        return true
      } catch (e) {
        toast.error(`删除「${name}」失败`, { description: errorText(e) })
        return false
      }
    },
    [qc],
  )
}

/** 新建（回到默认）：有改动先确认；可以撤销 */
export function useNewPlanV2() {
  const dirty = useIsDirtyV2()
  const meta = useV2Meta()
  return useCallback(async () => {
    if (dirty) {
      const ok = await confirm({
        title: '回到默认方案？',
        description: '现在的方案有改动还没保存。回到默认之后，还能用「撤销」找回来。',
        confirmLabel: '回到默认',
      })
      if (!ok) return
    }
    const fromBackend = meta.data?.default_spec ? normalizeSpec(meta.data.default_spec).spec : null
    useWb2.getState().newPlan(fromBackend ?? defaultSpec())
    useWb2Draw.getState().clear()
    toast.info('回到了默认方案', { description: '近 10 年热度前 50 部动画的主角；想找回刚才的，点「撤销」' })
  }, [dirty, meta.data])
}
