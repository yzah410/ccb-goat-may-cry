/**
 * 页头下面一行：出题方案（默认工作台当前方案，可换成任一已保存方案）、模式、题库人数、作品标签数。
 */
import { fmtInt } from '@/lib/format'
import { Select, type SelectOption } from '@/components/ui/Controls'
import { IconAlert } from '@/lib/icons'
import { usePlansV2 } from '@/features/v2/hooks'
import { MODE_BY_ID } from '@/features/workbench2/spec'
import { useIsDirtyV2, useWb2 } from '@/features/workbench2/store'
import type { ModeId } from '@/features/v2/types'
import type { SessionResp } from '../api'
import { useSoloSettings } from '../settings'

const WB = '__workbench__'

export function PlanPicker({ session, mode }: { session: SessionResp | null; mode: ModeId | null }) {
  const chosen = useSoloSettings((s) => s.planName)
  const set = useSoloSettings((s) => s.set)
  const wbPlan = useWb2((s) => s.planName)
  const dirty = useIsDirtyV2()
  const plans = usePlansV2()

  const wbLabel = `工作台当前方案（${wbPlan ?? '未命名'}${dirty ? '，有没保存的改动' : ''}）`
  const options: SelectOption[] = [{ value: WB, label: wbLabel }, ...(plans.data ?? []).map((p) => ({ value: p.name, label: p.name }))]
  // 选过的方案已经被删掉：照样列出来，读的时候会报错
  if (chosen && !options.some((o) => o.value === chosen)) options.push({ value: chosen, label: `${chosen}（找不到了）` })

  const errors = session?.errors ?? []
  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <span className="text-fg-3">出题方案</span>
        <Select
          size="sm"
          className="w-auto min-w-56 max-w-md"
          value={chosen ?? WB}
          options={options}
          onChange={(v) => set({ planName: v === WB ? null : v })}
          aria-label="出题方案"
        />
        {mode && <span className="text-fg-3">{MODE_BY_ID.get(mode)?.label ?? mode}模式</span>}
        <span className="text-fg-3">
          题库{' '}
          <span className="tabular font-medium text-fg-1">{session ? fmtInt(session.pool_total) : '…'}</span> 人
        </span>
      </div>
      {errors.length > 0 && (
        <p className="flex items-start gap-1.5 rounded-md bg-danger-bg px-3 py-2 text-xs text-danger-fg">
          <IconAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          方案里有没生效的部分（{errors.map((e) => e.message).join('；')}），题库按生效的部分出。
        </p>
      )}
    </div>
  )
}
