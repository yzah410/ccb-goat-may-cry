/**
 * 分栏布局（split）右侧的上下文面板：当前题目 + 候选人数 + 点击器状态。
 * 其他布局不显示它（当前题目在右上角小卡里）。
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/cn'
import { v2Api } from '@/features/v2/api'
import { evalKey } from '@/features/workbench2/spec'
import { useWb2 } from '@/features/workbench2/store'
import { useCanvasSource } from '@/features/canvas/store'
import { fmtInt, relativeTime } from '@/lib/format'
import { StatTile } from '@/components/data-display/StatTile'
import { LogLineView } from '@/components/data-display/Misc'
import { IconActivity, IconUsers } from '@/lib/icons'
import { useResults } from '@/features/candidates/store'
import { useConfigPayload } from '@/features/candidates/hooks'
import { useClickerStatus } from '@/features/clicker/hooks'
import { STATE_LABEL } from '@/features/clicker/normalize'
import { CurrentPickCard } from './CurrentPick'
import { useShellNav } from './nav'

/** 工作台当前方案的题库人数：只读缓存（enabled: false），不在别的页面额外发请求 */
function useCachedPoolTotal(): number | null {
  const spec = useWb2((s) => s.spec)
  const key = useMemo(() => evalKey(spec), [spec])
  const q = useQuery({ queryKey: ['v2', 'evaluate', key], queryFn: () => v2Api.evaluate(spec), enabled: false })
  return q.data?.total ?? null
}

const CLASSIC_ROUTES = new Set(['classic', 'candidates'])

export function ContextPanel({ className }: { className?: string }) {
  const preview = useResults((s) => s.preview)
  const { fp } = useConfigPayload()
  const nav = useShellNav()
  const poolTotal = useCachedPoolTotal()
  const canvasSource = useCanvasSource((s) => s.source)
  const classic = CLASSIC_ROUTES.has(nav.current) || (nav.current === 'canvas' && canvasSource === 'classic')
  const status = useClickerStatus({ enabled: !nav.embedded, idleMs: 6000 })
  const v = status.data
  const last = (v?.logs ?? []).filter((l) => l.level !== 'debug').slice(-3)

  return (
    <div className={cn('flex flex-col gap-4 p-4', className)}>
      <CurrentPickCard />
      {classic ? (
        <StatTile
          size="sm"
          icon={<IconUsers />}
          label="经典工作台候选人数（最近一次预览）"
          value={preview ? fmtInt(preview.data.total_candidates) : '—'}
          hint={preview ? (preview.fp === fp ? relativeTime(preview.at) : '方案改过了，需要重新预览') : '在经典工作台点「预览人数」'}
          stale={!!preview && preview.fp !== fp}
        />
      ) : (
        <StatTile
          size="sm"
          icon={<IconUsers />}
          label="工作台题库人数"
          value={poolTotal != null ? fmtInt(poolTotal) : '—'}
          hint={poolTotal != null ? '工作台现在的方案' : '打开工作台就会算'}
        />
      )}
      <div className="rounded-lg border border-border bg-surface-1 p-4 shadow-1">
        <div className="mb-2 flex items-center gap-2 text-sm text-fg-3">
          <IconActivity className="size-4" />
          <span>自动点击</span>
          <span className="ml-auto text-xs">
            {nav.embedded
              ? '（对比模式不轮询）'
              : status.isError
                ? '连不上'
                : v
                  ? v.autoRunning
                    ? '自动模式运行中'
                    : v.busy
                      ? (STATE_LABEL[v.state ?? ''] ?? '执行中')
                      : v.state === 'closed'
                        ? STATE_LABEL.closed
                        : '空闲'
                  : '…'}
          </span>
        </div>
        {last.length ? (
          <div className="flex flex-col gap-0.5">
            {last.map((l, i) => (
              <LogLineView key={i} line={l} compact />
            ))}
          </div>
        ) : (
          <p className="text-xs text-fg-3">还没有日志</p>
        )}
      </div>
    </div>
  )
}
