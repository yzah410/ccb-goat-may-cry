/**
 * 「导图已联动」小灯：单人页卡片右上角一个很小的圆点，不抢注意力。
 * - 亮（主题的成功色）：导图那边开着跟随（开着好几个导图窗口时，任何一个有效就亮）。心跳迟到不马上灰：单人页先 ping 一下，导图会立刻回应（它的窗口被遮住时定时器会被浏览器压慢）。悬停：导图已联动
 * - 灰：亮过，之后心跳超过 10 秒、ping 也没人应答，或导图说它关了（map:bye）。悬停：导图联动已断开
 * - 不显示：从没连上，或所有导图窗口都设了「不显示小灯」
 * 状态怎么算见 ./logic.ts 的 lampState；颜色只用主题 token（bg-success / bg-border-strong），换主题也适用。
 */
import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/components/ui/Overlay'
import { LAMP_TIP, lampState, presenceWantsDot, type LampState } from './logic'
import { useMapPresence } from './soloLink'

/** 每秒重新看一次「有没有掉线」；还没亮过就不走计时器（发 ping 的计时器在 soloLink.ts） */
function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    // 刚激活时 now 可能是旧的（比最近一次心跳还早）：lampState 把它当“刚收到”，亮；最多一秒后第一次计时就校正
    const t = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(t)
  }, [active, intervalMs])
  return now
}

/** 只负责画（测试里直接传 lamp） */
export function LampDot({ lamp, className }: { lamp: Exclude<LampState, 'hidden'>; className?: string }) {
  const tip = LAMP_TIP[lamp]
  return (
    <Tooltip content={tip} side="left">
      {/* 点周围留一圈透明的感应区（16px，正好放在卡片 16px 的内边距里，不盖住里面的按钮），不然 8px 的小点很难悬停到 */}
      <span role="img" aria-label={tip} data-maplink-lamp={lamp} className={cn('inline-flex size-4 shrink-0 cursor-default items-center justify-center', className)}>
        <span className={cn('block size-2 rounded-full', lamp === 'on' ? 'bg-success' : 'bg-border-strong')} />
      </span>
    </Tooltip>
  )
}

export function MapLinkLamp({ className }: { className?: string }) {
  const s = useMapPresence((x) => x.state)
  const now = useNow(presenceWantsDot(s))
  const lamp = lampState(s, now)
  if (lamp === 'hidden') return null
  return <LampDot lamp={lamp} className={className} />
}
