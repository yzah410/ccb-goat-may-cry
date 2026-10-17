/**
 * 标签笔记 / 方案库的服务端状态（react-query）。
 */
import { useEffect, useMemo } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { errorText, isApiError } from '@/lib/apiClient'
import { toast } from '@/components/ui/Toast'
import { downloadBlob } from '@/features/canvas/api'
import { tagnoteApi } from './api'
import { createDebouncedSaver, noteFilename } from './library'
import type { GenerateBody, LayoutCache, MapDetail, MapSamples, MapSummary, TagNoteData } from './types'

export const MAP_KEYS = {
  list: ['v2', 'maps'] as const,
  detail: (id: string) => ['v2', 'maps', 'detail', id] as const,
  /** 挂在 list 下面：列表刷新（新建、删除、改名之后）时「还有几张样例没载入」跟着刷新 */
  samples: ['v2', 'maps', 'samples'] as const,
}

/** 连不上后端（例如刚好在重启）时再试两次；别的错误不重试 */
const retryNetwork = (n: number, e: unknown) => isApiError(e) && e.kind === 'network' && n < 2
const retryDelay = (n: number) => 1500 * (n + 1)

export function useMaps() {
  return useQuery({
    queryKey: MAP_KEYS.list,
    queryFn: ({ signal }) => tagnoteApi.list(signal),
    staleTime: 60_000,
    retry: retryNetwork,
    retryDelay,
  })
}

export function useMapDetail(id: string | null) {
  return useQuery({
    queryKey: MAP_KEYS.detail(id ?? ''),
    queryFn: ({ signal }) => tagnoteApi.get(id as string, signal),
    enabled: !!id,
    // 换图时先留着上一张，新图到了再换，画面不闪白
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    retry: retryNetwork,
    retryDelay,
  })
}

/** 列表里的一项换成后端返回的新摘要 */
function patchListItem(qc: QueryClient, summary: MapSummary) {
  qc.setQueryData<MapSummary[]>(MAP_KEYS.list, (old) => old?.map((m) => (m.id === summary.id ? { ...m, ...summary } : m)))
}

export function useCreateMap() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: TagNoteData) => tagnoteApi.create(data),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: MAP_KEYS.list })
    },
    onError: (e) => toast.error('没能存进方案库', { description: errorText(e) }),
  })
}

export function useRenameMap() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => tagnoteApi.patch(id, { title }),
    onSuccess: (summary, { id, title }) => {
      patchListItem(qc, summary)
      qc.setQueryData<MapDetail>(MAP_KEYS.detail(id), (old) =>
        old ? { ...old, collection: { ...(old.collection ?? { title }), title: summary.title ?? title } } : old,
      )
      void qc.invalidateQueries({ queryKey: MAP_KEYS.list })
      toast.success('已改名', { description: summary.title ?? title })
    },
    onError: (e) => toast.error('改名失败', { description: errorText(e) }),
  })
}

export function useDeleteMap() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => tagnoteApi.remove(id),
    onSuccess: (_r, id) => {
      qc.setQueryData<MapSummary[]>(MAP_KEYS.list, (old) => old?.filter((m) => m.id !== id))
      qc.removeQueries({ queryKey: MAP_KEYS.detail(id) })
      void qc.invalidateQueries({ queryKey: MAP_KEYS.list })
    },
    onError: (e) => toast.error('删除失败', { description: errorText(e) }),
  })
}

/** 样例导图：一共几张、方案库里还没有的几张 */
export function useMapSamples() {
  return useQuery({
    queryKey: MAP_KEYS.samples,
    queryFn: ({ signal }) => tagnoteApi.samples(signal),
    staleTime: 60_000,
    retry: retryNetwork,
    retryDelay,
  })
}

/**
 * 一键载入全部样例导图。成功后先把按钮上的数换成后端给的（没有剩下的，按钮马上消失），
 * 再刷新方案库列表；列表刷新完才算结束，按钮的转圈一直转到新图出现在列表里。
 */
export function makeLoadSamples(qc: QueryClient, load = tagnoteApi.loadSamples) {
  return async () => {
    const r = await load()
    qc.setQueryData<MapSamples>(MAP_KEYS.samples, { total: r.total, remaining: r.remaining })
    await qc.invalidateQueries({ queryKey: MAP_KEYS.list })
    return r
  }
}

export function useLoadSamples() {
  const qc = useQueryClient()
  const load = useMemo(() => makeLoadSamples(qc), [qc])
  return useMutation({
    mutationFn: load,
    onSuccess: (r) => toast.success(r.loaded ? `载入了 ${r.loaded} 张样例导图` : '样例导图都已经在方案库里了'),
    onError: (e) => toast.error('样例导图没能载入', { description: errorText(e) }),
  })
}

/**
 * 每张图最后发出的那次布局请求的序号。放在模块里而不是 hook 里：离开方案库再回来时 hook 是新建的，
 * 旧 hook 发出的请求晚回来，也要认得出它是旧的。
 */
const layoutLatest = new Map<string, number>()
let layoutSeq = 0

/**
 * 存一张图的布局缓存（PATCH layout_cache），成功后更新本地缓存的详情（下次打开直接用，形状不变）。
 *
 * 返回的摘要不写回列表：布局不改列表上显示的东西；这次 PATCH 慢回来时，用户可能已经改了名，旧摘要会把新名字盖掉。
 * 同一张图先后发了几次，只认最后发出的那次（先发的晚回来，不能把新布局换回旧的）。
 */
export function makeLayoutSave(qc: QueryClient, patch = tagnoteApi.patch) {
  return (id: string, cache: LayoutCache) => {
    const mine = ++layoutSeq
    layoutLatest.set(id, mine)
    patch(id, { layout_cache: cache }).then(
      () => {
        if (layoutLatest.get(id) !== mine) return
        qc.setQueryData<MapDetail>(MAP_KEYS.detail(id), (old) => (old ? { ...old, layout_cache: cache } : old))
      },
      // 只是缓存：存不上下次打开会重新算，不打扰用户
      (e) => console.warn('[tagnote] 领地图布局没存上：', errorText(e)),
    )
  }
}

/** 领地图算出新布局 → 防抖 0.8 秒后存（见 makeLayoutSave）。离开页面时把还没存的立刻存掉。 */
export function useLayoutSaver(delay = 800) {
  const qc = useQueryClient()
  const saver = useMemo(() => createDebouncedSaver(makeLayoutSave(qc), delay), [qc, delay])
  useEffect(() => () => saver.flush(), [saver])
  return saver
}

export function useGenerateTagNote() {
  return useMutation({
    mutationFn: (body: GenerateBody) => tagnoteApi.generate(body),
    // 错误在页面上就地显示（作品太多、候选池为空、方案有错），不弹提示
  })
}

/** 方案库里的图 → 下载 Obsidian 笔记 */
export function useDownloadMapNote() {
  return useMutation({
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      const blob = await tagnoteApi.note(id)
      const fileName = noteFilename(title)
      downloadBlob(blob, fileName)
      return fileName
    },
    onSuccess: (fileName) => toast.success('笔记已下载', { description: fileName }),
    onError: (e) => toast.error('下载失败', { description: errorText(e) }),
  })
}

/** 还没存的作品集 → 下载 Obsidian 笔记 */
export function useDownloadDataNote() {
  return useMutation({
    mutationFn: async (data: TagNoteData) => {
      const blob = await tagnoteApi.noteFromData(data)
      const fileName = noteFilename(data.collection?.title ?? '')
      downloadBlob(blob, fileName)
      return fileName
    },
    onSuccess: (fileName) => toast.success('笔记已下载', { description: fileName }),
    onError: (e) => toast.error('下载失败', { description: errorText(e) }),
  })
}
