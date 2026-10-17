import { useCallback, useMemo } from 'react'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { errorText, isApiError } from '@/lib/apiClient'
import { toast } from '@/components/ui/Toast'
import { useDraftConfig } from '@/features/blocks/store'
import { configFingerprint, hasEnabledInclude, toConfigPayload, validateConfig } from '@/features/blocks/payload'
import type { ConfigPayload } from '@/features/blocks/schema'
import { candidatesApi } from './api'
import { useCandidateView, usePick, useResults } from './store'
import { isResolved, type ResolvedCharacter } from './types'

/**
 * 当前草稿 → 发给后端的配置 + 指纹。
 * 筛选类请求的 theme 固定传 null：主题只影响界面，不该让切主题触发重新请求。
 */
export function useConfigPayload(): { payload: ConfigPayload; fp: string } {
  const cfg = useDraftConfig()
  return useMemo(() => ({ payload: toConfigPayload(cfg, null), fp: configFingerprint(cfg) }), [cfg])
}

function precheck(payload: ConfigPayload): boolean {
  const issues = validateConfig(payload)
  if (issues.length) {
    toast.error('配置有问题，没发给后端', { description: issues.join('；') })
    return false
  }
  return true
}

/** 「预览人数」：只要总数 + 样本 */
export function usePreviewAction() {
  const { payload, fp } = useConfigPayload()
  const setPreview = useResults((s) => s.setPreview)
  const m = useMutation({
    mutationFn: (v: { payload: ConfigPayload; fp: string }) => candidatesApi.preview(v.payload),
    onSuccess: (data, v) => setPreview(v.fp, data),
    onError: (e) => toast.error('预览失败', { description: errorText(e) }),
  })
  const { mutate } = m
  const run = useCallback(() => {
    if (!precheck(payload)) return
    if (!hasEnabledInclude(payload.blocks))
      toast.warning('没有启用的纳入块', { description: '候选池一定是空的：至少要有一个「纳入」组块' })
    mutate({ payload, fp })
  }, [payload, fp, mutate])
  return { run, isPending: m.isPending }
}

/** 「随机抽一题」：调 /draw（加权随机；设了种子结果固定），顺手刷新人数 */
export function useDrawAction() {
  const { payload, fp } = useConfigPayload()
  const setDraw = useResults((s) => s.setDraw)
  const setPreview = useResults((s) => s.setPreview)
  const previewFp = useResults((s) => s.preview?.fp)
  const m = useMutation({
    mutationFn: async (v: { payload: ConfigPayload; fp: string; withPreview: boolean }) => {
      const [draw, preview] = await Promise.all([
        candidatesApi.draw(v.payload),
        v.withPreview ? candidatesApi.preview(v.payload).catch(() => null) : Promise.resolve(null),
      ])
      return { draw, preview }
    },
    onSuccess: ({ draw, preview }, v) => {
      setDraw(v.fp, draw)
      if (preview) setPreview(v.fp, preview)
      if (!isResolved(draw)) toast.warning('一个都没抽到', { description: '候选池是空的：检查一下组块（至少要有一个启用的纳入块）' })
    },
    onError: (e) => toast.error('抽题失败', { description: errorText(e) }),
  })
  const { mutate } = m
  const run = useCallback(() => {
    if (!precheck(payload)) return
    mutate({ payload, fp, withPreview: previewFp !== fp })
  }, [payload, fp, previewFp, mutate])
  return { run, isPending: m.isPending }
}

/** 候选列表（后端分页）。翻页时保留上一页内容，避免闪白。 */
export function useCandidates(page: number, enabled = true) {
  const { payload, fp } = useConfigPayload()
  const pageSize = useCandidateView((s) => s.pageSize)
  return useQuery({
    queryKey: ['candidates', fp, page, pageSize],
    queryFn: ({ signal }) => candidatesApi.list(payload, page, pageSize, signal),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    retry: (n, e) => !(isApiError(e) && (e.kind === 'network' || e.kind === 'http')) && n < 1,
  })
}

/** 候选统计（/stats） */
export function useCandidateStats(enabled = true) {
  const { payload, fp } = useConfigPayload()
  return useQuery({
    queryKey: ['stats', fp],
    queryFn: ({ signal }) => candidatesApi.stats(payload, signal),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/** 「设为当前」：记住这个角色，并弹出提示告诉用户已设好 */
export function useSetPick() {
  const setPick = usePick((s) => s.setPick)
  return useCallback(
    (item: ResolvedCharacter, source: 'draw' | 'candidates') => {
      setPick(item, source)
      toast.success(`「${item.character.name}」设为当前题目`, {
        id: 'pick',
        description: '右上角「当前题目」里可以直接发到猜猜呗',
      })
    },
    [setPick],
  )
}
