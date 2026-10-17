/**
 * 单人猜猜呗页面用的 hooks：出题方案（工作台当前 / 已保存方案）、倒计时。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { v2Api } from '@/features/v2/api'
import type { SpecV2 } from '@/features/v2/types'
import { normalizeSpec } from '@/features/workbench2/spec'
import { useWb2 } from '@/features/workbench2/store'
import { useSoloSettings } from './settings'

export interface SoloSource {
  /** null = 还在读方案 / 读不到 */
  spec: SpecV2 | null
  /** 发给后端记日志用的方案名（工作台没保存过 = null） */
  planName: string | null
  kind: 'workbench' | 'plan'
  loading: boolean
  error: unknown
}

/** 出题用的方案：默认工作台当前方案（含没保存的改动）；设置里选了已保存方案就读那个 */
export function useSoloSource(): SoloSource {
  const chosen = useSoloSettings((s) => s.planName)
  const wbSpec = useWb2((s) => s.spec)
  const wbPlan = useWb2((s) => s.planName)
  const q = useQuery({
    // 和方案库 / 清单页用的是同一个 key（同一个接口、同样的数据）
    queryKey: ['v2', 'plan', chosen],
    queryFn: () => v2Api.plan(chosen!),
    enabled: chosen != null,
    staleTime: 60_000,
    retry: false,
  })
  const planSpec = useMemo(() => (q.data ? normalizeSpec(q.data).spec : null), [q.data])
  if (chosen == null) return { spec: wbSpec, planName: wbPlan, kind: 'workbench', loading: false, error: null }
  return { spec: planSpec, planName: chosen, kind: 'plan', loading: q.isPending, error: q.error }
}

/**
 * 倒计时：deadline（Date.now() 毫秒）到了调一次 onExpire。deadline 变了（新的一行 / 新的一局）就重新开始。
 * 返回剩余毫秒；deadline 为 null（不限时 / 不在猜）返回 null。
 */
export function useCountdown(deadline: number | null, onExpire: () => void): number | null {
  const [now, setNow] = useState(() => Date.now())
  const cb = useRef(onExpire)
  useEffect(() => {
    cb.current = onExpire
  })
  useEffect(() => {
    if (deadline == null) return
    let fired = false
    const t = window.setInterval(() => {
      const n = Date.now()
      setNow(n)
      if (!fired && n >= deadline) {
        fired = true
        cb.current()
      }
    }, 200)
    return () => window.clearInterval(t)
  }, [deadline])
  return deadline == null ? null : Math.max(0, deadline - now)
}
