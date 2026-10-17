/**
 * 「再筛」：条件 chip（每个写着「筛掉 N 人」）+「+ 条件」菜单（按类别分组）。
 * 条件之间是「且」；取反的写「不满足：」；停用的变淡、写「停用了」。
 */
import { useRef, useState } from 'react'
import { Popover as P } from 'radix-ui'
import { cn } from '@/lib/cn'
import { fmtInt } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  PopoverContent,
} from '@/components/ui/Overlay'
import { IconAlert, IconBan, IconPlus } from '@/lib/icons'
import { toast } from '@/components/ui/Toast'
import { useNameLookup } from '@/features/v2/hooks'
import type { Condition, ConditionType, EvalStep, ModeId } from '@/features/v2/types'
import { conditionComplete, newCondition, newId, takenIds } from '../spec'
import { COND_GROUPS, COND_META, NO_LOOKUP, conditionDetail, conditionText, condMeta, type CondGroup } from '../summary'
import { useWb2 } from '../store'
import { CondIcon } from './icons'
import { ExistingConditionPanel, NewConditionPanel } from './ConditionEditor'

/** 「+ 条件」菜单分两栏 */
const COLUMNS: CondGroup[][] = [
  ['character', 'list', 'sql'],
  ['grid', 'appearance'],
]

/** 弹层：不自己滚动、没有内边距（里面的 PanelFrame 分成「会滚动的内容」+「永远看得见的按钮」两段） */
const POPOVER_CLS = 'flex w-[26rem] max-w-[calc(100vw-2rem)] max-h-[var(--radix-popover-content-available-height)] flex-col overflow-hidden p-0'

function StepBadge({ step, c, zone }: { step: EvalStep | undefined; c: Condition; zone: 'ranges' | 'excludes' }) {
  if (!c.enabled || step?.skipped === 'disabled') return <span className="shrink-0 border-l border-border pl-2 text-xs text-fg-3">停用了</span>
  if (!step) return null
  if (step.skipped === 'empty')
    return (
      <span className="shrink-0 border-l border-border pl-2 text-xs text-warning-fg">
        {zone === 'excludes' ? '没填内容，不起作用' : '没填内容，先不筛'}
      </span>
    )
  if (step.skipped === 'error')
    return (
      <span className="shrink-0 border-l border-border pl-2 text-xs text-danger-fg" title={step.error ?? undefined}>
        出错了，没筛
      </span>
    )
  // 排除项里的条件是在圈「要排除的人」：写「符合 N 人」比「筛掉」好懂
  if (zone === 'excludes')
    return (
      <span className="tabular shrink-0 border-l border-border pl-2 text-xs text-fg-3" title={`这一条之前 ${fmtInt(step.before)} 人，之后 ${fmtInt(step.after)} 人`}>
        符合 {fmtInt(step.after)} 人
      </span>
    )
  const all = step.before > 0 && step.removed === step.before
  return (
    <span
      className={cn('tabular shrink-0 border-l border-border pl-2 text-xs', all ? 'font-medium text-danger-fg' : 'text-fg-3')}
      title={`这一条之前 ${fmtInt(step.before)} 人，之后 ${fmtInt(step.after)} 人`}
    >
      {all ? `筛掉全部 ${fmtInt(step.removed)} 人` : `筛掉 ${fmtInt(step.removed)} 人`}
    </span>
  )
}

function ConditionChip({
  c,
  step,
  zone,
  rangeId,
  mode,
  tagCount,
  stale,
}: {
  c: Condition
  step: EvalStep | undefined
  zone: 'ranges' | 'excludes'
  rangeId: string
  mode: ModeId
  tagCount: number
  stale: boolean
}) {
  const lk = useNameLookup()
  const edit = useWb2((s) => s.edit)
  const m = condMeta(c.type)
  const complete = conditionComplete(c)
  const update = (next: Condition) =>
    edit(`改条件「${m.short}」`, (s) => ({
      ...s,
      ranges: s.ranges.map((r) => (r.id === rangeId ? { ...r, conditions: r.conditions.map((x) => (x.id === c.id ? next : x)) } : r)),
      excludes: s.excludes.map((r) => (r.id === rangeId ? { ...r, conditions: r.conditions.map((x) => (x.id === c.id ? next : x)) } : r)),
    }), { coalesce: `${rangeId}:${c.id}` })
  const remove = () =>
    edit(`删掉条件「${m.short}」`, (s) => ({
      ...s,
      ranges: s.ranges.map((r) => (r.id === rangeId ? { ...r, conditions: r.conditions.filter((x) => x.id !== c.id) } : r)),
      excludes: s.excludes.map((r) => (r.id === rangeId ? { ...r, conditions: r.conditions.filter((x) => x.id !== c.id) } : r)),
    }))
  const detail = conditionDetail(c, lk)
  // 角色清单读成一句话：「在角色清单「某某」里」
  const head = c.type === 'char_list' ? '在角色清单' : m.short
  const tail = c.type === 'char_list' ? '里' : ''

  return (
    <P.Root>
      <P.Trigger asChild>
        <button
          type="button"
          data-slot="condition-chip"
          data-negate={c.negate || undefined}
          data-disabled={!c.enabled || undefined}
          className={cn(
            'group inline-flex min-h-8 max-w-full items-center gap-2 rounded-md bg-surface-2 py-1 pl-2 pr-2.5 text-left text-sm text-fg-1 ring-1 ring-inset ring-border transition-colors',
            'hover:bg-surface-3 hover:ring-border-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
            'data-[state=open]:ring-2 data-[state=open]:ring-primary-400',
            !c.enabled && 'opacity-60 [&_[data-text]]:line-through',
            !complete && c.enabled && 'ring-warning',
          )}
          aria-label={`编辑条件：${c.negate ? '不满足 ' : ''}${head} ${detail}${tail}`}
        >
          <span className="text-fg-3 [&_svg]:size-4">
            <CondIcon type={c.type} />
          </span>
          {c.negate && (
            <span className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded-sm bg-danger-bg px-1.5 text-xs font-medium text-danger-fg">
              <IconBan className="size-3" aria-hidden />
              不满足
            </span>
          )}
          <span data-text className={cn('min-w-0 truncate', stale && 'opacity-70')}>
            <span className="text-fg-2">{head}</span>
            {c.type === 'char_list' ? '' : ' '}
            <span className="font-medium">{detail}</span>
            {tail && <span className="text-fg-2">{tail}</span>}
          </span>
          {!complete && c.enabled && <IconAlert className="size-3.5 shrink-0 text-warning" aria-label="没填完整" />}
          <span className={cn(stale && 'opacity-50')}>
            <StepBadge step={step} c={c} zone={zone} />
          </span>
        </button>
      </P.Trigger>
      <PopoverContent align="start" className={POPOVER_CLS}>
        <ExistingConditionPanel c={c} onChange={update} onRemove={remove} mode={mode} tagCount={tagCount} zone={zone} />
      </PopoverContent>
    </P.Root>
  )
}

/** 「+ 条件」：先在菜单里选类型，再在弹层里填，填好了才加进方案 */
export function AddConditionMenu({
  onAdd,
  mode,
  tagCount,
  label = '条件',
  variant = 'secondary',
  confirmLabel,
  groups,
  zone = 'ranges',
}: {
  zone?: 'ranges' | 'excludes'
  onAdd: (c: Condition) => void
  mode: ModeId
  tagCount: number
  label?: string
  variant?: 'secondary' | 'ghost' | 'soft'
  confirmLabel?: string
  /** 只显示这些分组（默认全部） */
  groups?: CondGroup[]
}) {
  const [draft, setDraft] = useState<Condition | null>(null)
  // 刚新建时的样子：关掉时和它比，填过东西才提醒「没加上」
  const fresh = useRef<string>('')
  // 菜单里选了一项：等菜单完全关掉（它会把焦点锁在菜单里、关掉时还给按钮）之后再打开填写弹层，
  // 不然弹层里的输入框抢不到焦点，弹层还会以为「焦点跑到外面了」马上关掉
  const chosen = useRef<ConditionType | null>(null)
  const start = (type: ConditionType) => {
    const id = newId('c', takenIds(useWb2.getState().spec))
    const c = newCondition(type, id)
    fresh.current = JSON.stringify(c)
    setDraft(c)
  }
  /** 点弹层外面 / 按 Esc 关掉：填过东西就提醒一句，可以「接着填」 */
  const dismiss = () => {
    const d = draft
    setDraft(null)
    if (!d || JSON.stringify(d) === fresh.current) return
    toast.info(`没加上：${conditionText(d, NO_LOOKUP)}`, {
      id: 'cond-discard',
      description: '在点「加上这个条件」之前弹层关掉了。',
      action: { label: '接着填', onClick: () => setDraft(d) },
    })
  }
  const shown = COND_GROUPS.filter((g) => !groups || groups.includes(g.id))
  return (
    <P.Root open={!!draft} onOpenChange={(o) => !o && dismiss()}>
      <P.Anchor asChild>
        <span className="inline-flex">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant={variant} icon={<IconPlus />}>
                {label}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-[min(40rem,calc(100vw-2rem))] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto p-2 scroll-thin"
              onCloseAutoFocus={(e) => {
                const t = chosen.current
                if (t) {
                  e.preventDefault()
                  chosen.current = null
                  start(t)
                }
              }}
            >
              {/* 两栏（放得下的时候）：左边「角色本身 / 清单 / 自定义查询」，右边「游戏格子 / 登场作品」，一屏看完不用滚 */}
              <div className="grid grid-cols-[repeat(auto-fit,minmax(17rem,1fr))] gap-x-2">
                {COLUMNS.map((col, ci) => (
                  <div key={ci} className="flex min-w-0 flex-col">
                    {shown
                      .filter((g) => col.includes(g.id))
                      .map((g, gi) => (
                        <div key={g.id}>
                          {gi > 0 && <DropdownMenuSeparator />}
                          <DropdownMenuLabel>
                            <span className="text-fg-2">{g.label}</span>
                            <span className="ml-1.5 font-normal">{g.hint}</span>
                          </DropdownMenuLabel>
                          {COND_META.filter((m) => m.group === g.id).map((m) => (
                            <DropdownMenuItem
                              key={m.type}
                              icon={<CondIcon type={m.type} />}
                              onSelect={() => {
                                chosen.current = m.type
                              }}
                              className="h-auto min-h-[var(--control-h-sm)] py-1.5"
                            >
                              <span className="flex flex-col">
                                <span>{m.label}</span>
                                <span className="text-xs text-fg-3">{m.hint}</span>
                              </span>
                            </DropdownMenuItem>
                          ))}
                        </div>
                      ))}
                  </div>
                ))}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </P.Anchor>
      {draft && (
        <PopoverContent align="start" className={POPOVER_CLS} onOpenAutoFocus={(e) => e.preventDefault()} onFocusOutside={(e) => e.preventDefault()}>
          <NewConditionPanel
            c={draft}
            onChange={setDraft}
            onCancel={() => setDraft(null)}
            onConfirm={() => {
              onAdd(draft)
              setDraft(null)
            }}
            mode={mode}
            tagCount={tagCount}
            confirmLabel={confirmLabel}
            zone={zone}
          />
        </PopoverContent>
      )}
    </P.Root>
  )
}

/** 一个范围 / 排除项的全部条件 + 「+ 条件」 */
export function ConditionChips({
  zone,
  rangeId,
  conditions,
  steps,
  mode,
  tagCount,
  stale,
}: {
  zone: 'ranges' | 'excludes'
  rangeId: string
  conditions: Condition[]
  steps?: EvalStep[]
  mode: ModeId
  tagCount: number
  stale: boolean
}) {
  const edit = useWb2((s) => s.edit)
  const add = (c: Condition) =>
    edit(`加条件「${condMeta(c.type).short}」`, (s) => ({
      ...s,
      ranges: s.ranges.map((r) => (r.id === rangeId ? { ...r, conditions: [...r.conditions, c] } : r)),
      excludes: s.excludes.map((r) => (r.id === rangeId ? { ...r, conditions: [...r.conditions, c] } : r)),
    }))
  return (
    <div className="flex flex-wrap items-center gap-2">
      {conditions.map((c) => (
        <ConditionChip key={c.id} c={c} step={steps?.find((s) => s.condition_id === c.id)} zone={zone} rangeId={rangeId} mode={mode} tagCount={tagCount} stale={stale} />
      ))}
      <AddConditionMenu onAdd={add} mode={mode} tagCount={tagCount} label={conditions.length ? '条件' : '加条件'} variant="ghost" zone={zone} />
    </div>
  )
}
