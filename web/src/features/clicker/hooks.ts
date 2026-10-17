import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { errorText } from '@/lib/apiClient'
import { toast } from '@/components/ui/Toast'
import { validateConfig } from '@/features/blocks/payload'
import type { ConfigPayload } from '@/features/blocks/schema'
import type { ResolvedCharacter } from '@/features/candidates/types'
import { clickerApi } from './api'
import { logsSince, markLogs, normalizeStatus, taskOutcome, type ClickerMode } from './normalize'
import { useClickerTask } from './store'

export const CLICKER_STATUS_KEY = ['clicker', 'status'] as const

/** 轮询点击器状态：有任务在跑 900ms 一次，空闲时慢一点 */
export function useClickerStatus(opts: { enabled?: boolean; idleMs?: number } = {}) {
  const pending = useClickerTask((s) => !!s.pending)
  return useQuery({
    queryKey: CLICKER_STATUS_KEY,
    queryFn: async () => normalizeStatus(await clickerApi.status()),
    enabled: opts.enabled ?? true,
    refetchInterval: (q) => {
      const d = q.state.data
      if (pending || d?.busy || d?.autoRunning) return 900
      return opts.idleMs ?? 4000
    },
    retry: false,
    staleTime: 400,
  })
}

/** 「发到猜猜呗」：把角色交给后端去点（立刻返回，结果由 ClickerTaskWatcher 盯） */
export function useSendToGuessr() {
  const qc = useQueryClient()
  const start = useClickerTask((s) => s.start)
  const pending = useClickerTask((s) => s.pending)
  const m = useMutation({
    mutationFn: async ({ item, mode }: { item: ResolvedCharacter; mode: ClickerMode }) => {
      // 记下发送时刻（这样才能认出「这次任务」新产生的日志）
      const marker = markLogs()
      const res = await clickerApi.once({ mode, char_id: item.char_id, char_name: item.character.name })
      return { res, marker, item, mode }
    },
    onSuccess: ({ res, marker, item, mode }) => {
      if (!res.accepted) {
        toast.warning('后端没接这个任务', { description: res.message ?? '可能上一个任务还没结束' })
        return
      }
      start({ taskId: res.task_id, charName: item.character.name, mode, marker })
      toast.info(`正在把「${item.character.name}」发到猜猜呗…`, {
        id: 'clicker-task',
        description: '房主模式：填进出题弹窗',
        duration: 60_000,
      })
      void qc.invalidateQueries({ queryKey: CLICKER_STATUS_KEY })
    },
    onError: (e) => toast.error('发送失败', { description: errorText(e) }),
  })
  return {
    send: (item: ResolvedCharacter, mode: ClickerMode = 'host') => m.mutate({ item, mode }),
    isPending: m.isPending || !!pending,
  }
}

/** 全局挂一个：盯着正在跑的单发任务，结束时弹成功/失败提示（不用自己读日志判断） */
export function ClickerTaskWatcher() {
  const pending = useClickerTask((s) => s.pending)
  const markBusy = useClickerTask((s) => s.markBusy)
  const finish = useClickerTask((s) => s.finish)
  const { data, error } = useClickerStatus({ enabled: !!pending })

  useEffect(() => {
    if (!pending) return
    if (error) {
      finish(false, errorText(error))
      toast.error(`「${pending.charName}」的发送状态拿不到了`, { id: 'clicker-task', description: errorText(error) })
      return
    }
    if (!data) return
    if (data.busy) {
      markBusy()
      if (Date.now() - pending.startedAt > 120_000) {
        finish(false, '等了两分钟还没结束')
        toast.error(`「${pending.charName}」发了很久还没结束`, { id: 'clicker-task', description: '去「自动点击」页看看日志' })
      }
      return
    }
    // 任务还没真正开始（后端偶尔慢半拍）：给它 2.5 秒
    if (!pending.seenBusy && Date.now() - pending.startedAt < 2500) return
    const out = taskOutcome(data, logsSince(data, pending.marker)) ?? { ok: false, message: '没拿到结果，去「自动点击」页看日志' }
    finish(out.ok, out.message)
    if (out.ok) toast.success(`「${pending.charName}」发到猜猜呗了`, { id: 'clicker-task', description: out.message })
    else toast.error(`「${pending.charName}」没发成功`, { id: 'clicker-task', description: out.message })
  }, [pending, data, error, markBusy, finish])

  return null
}

/** 自动模式：开始（带上当前方案配置）/ 停止 */
export function useAutoControl() {
  const qc = useQueryClient()
  const refresh = () => void qc.invalidateQueries({ queryKey: CLICKER_STATUS_KEY })
  const start = useMutation({
    // spec 有值 = 按工作台的方案抽题；否则按经典工作台的组块配置抽题
    mutationFn: async ({ mode, config, spec }: { mode: ClickerMode; config?: ConfigPayload; spec?: unknown }) => {
      if (spec) return clickerApi.autoStartV2(mode, spec)
      if (!config) throw new Error('没有方案')
      const issues = validateConfig(config)
      if (issues.length) throw new Error(`方案配置有问题：${issues.join('；')}`)
      return clickerApi.autoStart(mode, config)
    },
    onSuccess: (r) => {
      if (!r.ok) toast.error('自动模式没启动', { description: r.error ?? '后端没说原因' })
      else if (r.result === 'auto_already_running') toast.info('自动模式本来就在跑')
      else toast.success('自动模式开始了', { description: '每一轮由后端按当前方案抽题并立刻出题' })
      refresh()
    },
    onError: (e) => toast.error('自动模式没启动', { description: errorText(e) }),
  })
  const stop = useMutation({
    mutationFn: () => clickerApi.autoStop(),
    onSuccess: (r) => {
      if (!r.ok) toast.error('没停下来', { description: r.error ?? '' })
      else if (r.result === 'auto_not_running') toast.info('自动模式本来就没在跑')
      else toast.success('自动模式停了')
      refresh()
    },
    onError: (e) => toast.error('没停下来', { description: errorText(e) }),
  })
  return { start, stop }
}

/** 只定位不点击 */
export function useDryRun() {
  const setDryRun = useClickerTask((s) => s.setDryRun)
  return useMutation({
    mutationFn: ({ item, mode }: { item: ResolvedCharacter; mode: ClickerMode }) =>
      clickerApi.dryRun({ mode, char_id: item.char_id, char_name: item.character.name }),
    onSuccess: (r, v) => setDryRun(r, v.item.character.name),
    onError: (e) => toast.error('验证失败', { description: errorText(e) }),
  })
}

/** 看 Chrome 调试端口和猜猜呗标签页 */
export function useProbe(enabled = true) {
  return useQuery({
    queryKey: ['clicker', 'probe'],
    queryFn: () => clickerApi.probe(),
    enabled,
    refetchInterval: 8000,
    retry: false,
  })
}
