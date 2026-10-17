/**
 * 一个范围（纳入）或一个排除项的卡片：
 *   顶部：纳入 / 排除 + 名字 + 人数 + 启用开关 + 菜单
 *   一句话（后端按模板生成，永远和下面的设置同步；后端没回来时用本地的兜底句子）
 *   从哪来 / 取角色 / 再筛（条件 chip 上写「筛掉 N 人」）
 *   底部：作品数 → 取到几人 → 筛完几人（只在这个范围的有几人）
 */
import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { fmtInt } from '@/lib/format'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Controls'
import { Input } from '@/components/ui/Input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/Overlay'
import { toast } from '@/components/ui/Toast'
import { IconAlert, IconArrowRight, IconCopyPlus, IconEllipsis, IconMinus, IconPencil, IconPlus, IconTrash } from '@/lib/icons'
import { useNameLookup } from '@/features/v2/hooks'
import type { EvalExclude, EvalRange, ModeId, RangeV2 } from '@/features/v2/types'
import { conditionComplete, newId, takenIds } from '../spec'
import { localSentence, pickApplies } from '../summary'
import { useWb2 } from '../store'
import { ConditionChips } from './ConditionChips'
import { PickEditor, SourceEditor } from './RangeParts'

function Section({ label, children, muted }: { label: string; children: ReactNode; muted?: boolean }) {
  return (
    <div className="grid gap-x-4 gap-y-1.5 @xl:grid-cols-[4.5rem_minmax(0,1fr)] @xl:items-start">
      <span className={cn('pt-1.5 text-sm font-medium', muted ? 'text-fg-3' : 'text-fg-2')}>{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function TitleEditor({ range, fallback, zone }: { range: RangeV2; fallback: string; zone: 'ranges' | 'excludes' }) {
  const edit = useWb2((s) => s.edit)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const commit = () => {
    const label = text.trim() || null
    setEditing(false)
    if (label !== (range.label ?? null)) edit('改名字', (s) => ({ ...s, [zone]: s[zone].map((r) => (r.id === range.id ? { ...r, label } : r)) }))
  }
  if (editing)
    return (
      <Input
        size="sm"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(false)
        }}
        placeholder={fallback}
        aria-label="范围名字"
        className="w-48"
      />
    )
  return (
    <button
      type="button"
      onClick={() => {
        setText(range.label ?? '')
        setEditing(true)
      }}
      className="group inline-flex min-w-0 items-center gap-1.5 rounded-sm text-left text-base font-semibold text-fg-1 hover:text-primary-800"
      title="点一下改名字"
    >
      <span className="truncate">{range.label?.trim() || fallback}</span>
      <IconPencil className="size-3.5 shrink-0 text-fg-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />
    </button>
  )
}

export function RangeCard({
  range,
  zone,
  index,
  evalRange,
  evalExclude,
  stale,
  mode,
  tagCount,
  poolTotal,
}: {
  range: RangeV2
  zone: 'ranges' | 'excludes'
  index: number
  evalRange?: EvalRange
  evalExclude?: EvalExclude
  stale: boolean
  mode: ModeId
  tagCount: number
  /** 题库总人数（排除项判断「是不是它把题库全排掉了」） */
  poolTotal?: number | null
}) {
  const edit = useWb2((s) => s.edit)
  const undo = useWb2((s) => s.undo)
  const lk = useNameLookup()
  const inc = zone === 'ranges'
  const fallback = `${inc ? '范围' : '排除'} ${index + 1}`
  const title = range.label?.trim() || fallback
  const sentence = (inc ? evalRange?.sentence : evalExclude?.sentence) || localSentence(range, lk)
  const error = inc ? evalRange?.error : evalExclude?.error
  // 纳入：筛完剩几人；排除：从题库里去掉几人（这一项本身匹配多少人写在底部）
  const count = inc ? evalRange?.final : evalExclude?.removed_from_pool
  const onConds = range.conditions.filter((c) => c.enabled)
  const steps = inc ? evalRange?.steps : evalExclude?.steps
  // 真正起作用的条件：启用了、填完整了、后端没报错跳过
  const effective = onConds.filter((c) => conditionComplete(c) && steps?.find((s) => s.condition_id === c.id)?.skipped !== 'error')
  const excludesEveryone = !inc && range.enabled && range.source.kind === 'all_characters' && effective.length === 0
  // 这一项把题库全排掉了：只有它一个启用的排除项、排除之后 0 人（有好几个排除项时说不清是谁，交给右栏的「题库是空的」提示）
  const enabledExcludes = useWb2((s) => s.spec.excludes.filter((r) => r.enabled).length)
  const wipesPool = !inc && range.enabled && !excludesEveryone && enabledExcludes === 1 && poolTotal === 0 && (evalExclude?.removed_from_pool ?? 0) > 0

  const setEnabled = (enabled: boolean) =>
    edit(enabled ? `启用${title}` : `停用${title}`, (s) => ({ ...s, [zone]: s[zone].map((r) => (r.id === range.id ? { ...r, enabled } : r)) }))
  const duplicate = () =>
    edit(`复制${title}`, (s) => {
      const taken = takenIds(s)
      const fresh = (prefix: 'r' | 'c') => {
        const id = newId(prefix, taken)
        taken.add(id)
        return id
      }
      const copy: RangeV2 = {
        ...range,
        id: fresh('r'),
        label: range.label ? `${range.label}（副本）` : null,
        conditions: range.conditions.map((c) => ({ ...c, id: fresh('c') })),
      }
      const list = s[zone].slice()
      list.splice(index + 1, 0, copy)
      return { ...s, [zone]: list }
    })
  const remove = () => {
    edit(`删掉${title}`, (s) => ({ ...s, [zone]: s[zone].filter((r) => r.id !== range.id) }))
    toast.info(`删掉了「${title}」`, { id: 'range-remove', action: { label: '撤销', onClick: undo } })
  }

  return (
    <Card
      data-slot="range-card"
      data-zone={zone}
      data-disabled={!range.enabled || undefined}
      className={cn('@container flex flex-col gap-4 p-4 @xl:p-5', !range.enabled && 'border-dashed')}
    >
      {/* 左边一条细色带：纳入红、排除蓝（加上徽标里的 ＋/－ 和文字，不只靠颜色） */}
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-1', inc ? 'bg-include' : 'bg-exclude', !range.enabled && 'opacity-30')} />

      <div className="relative z-[1] flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span
            className={cn(
              'inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-2 text-xs font-semibold',
              inc
                ? 'bg-[color-mix(in_oklab,var(--include)_14%,transparent)] text-[color-mix(in_oklab,var(--include)_80%,var(--text-1))]'
                : 'bg-[color-mix(in_oklab,var(--exclude)_14%,transparent)] text-[color-mix(in_oklab,var(--exclude)_80%,var(--text-1))]',
            )}
          >
            {inc ? <IconPlus className="size-3.5" aria-hidden /> : <IconMinus className="size-3.5" aria-hidden />}
            {inc ? '纳入' : '排除'}
          </span>
          <TitleEditor range={range} fallback={fallback} zone={zone} />
          <div className="ml-auto flex items-center gap-2">
            {range.enabled ? (
              <span
                className={cn('tabular text-lg font-semibold text-fg-1 transition-opacity', stale && 'opacity-45')}
                aria-live="polite"
                title={inc ? '这个范围筛完剩下的人数' : '从题库里去掉的人数'}
              >
                {count == null ? '—' : `${!inc && count > 0 ? '−' : ''}${fmtInt(count)}`}
                <span className="ml-1 text-sm font-normal text-fg-3">人</span>
              </span>
            ) : (
              <span className="text-sm text-fg-3">
                停用了（不算）{inc && evalRange ? `，本来有 ${fmtInt(evalRange.final)} 人` : ''}
              </span>
            )}
            <Switch checked={range.enabled} onChange={setEnabled} size="sm" aria-label={range.enabled ? `停用${title}` : `启用${title}`} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label={`${title}的更多操作`}>
                  <IconEllipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem icon={<IconCopyPlus />} onSelect={duplicate}>
                  复制一份
                </DropdownMenuItem>
                <DropdownMenuItem icon={<IconPencil />} onSelect={() => setEnabled(!range.enabled)}>
                  {range.enabled ? '先停用（留着设置）' : '重新启用'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem icon={<IconTrash />} tone="danger" onSelect={remove}>
                  删掉
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <p className={cn('text-base leading-body text-fg-1 transition-opacity', (stale || !range.enabled) && 'opacity-60')} data-slot="range-sentence">
          {sentence}
        </p>

        {error && (
          <p className="flex items-start gap-2 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger-fg">
            <IconAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {error}
          </p>
        )}
        {excludesEveryone && (
          <p className="flex items-start gap-2 rounded-md bg-warning-bg px-3 py-2 text-sm text-warning-fg">
            <IconAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            这一项现在会把所有人都排除掉（来源是整个角色库，又没有起作用的条件）：加一个条件、把空着的条件填上，或者先停用它。
          </p>
        )}
        {wipesPool && (
          <p className="flex items-start gap-2 rounded-md bg-warning-bg px-3 py-2 text-sm text-warning-fg">
            <IconAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            这一项把题库里的人全排掉了：改一下它的年份 / 名次 / 条件，或者先停用它。
          </p>
        )}

        <div className={cn('flex flex-col gap-3.5', !range.enabled && 'opacity-60')}>
          <Section label="从哪来">
            <SourceEditor range={range} mode={mode} zone={zone} />
          </Section>
          {pickApplies(range.source) ? (
            <Section label="取角色">
              <PickEditor range={range} zone={zone} />
            </Section>
          ) : (
            <Section label="取角色" muted>
              <p className="pt-1.5 text-xs text-fg-3">清单 / 整个角色库直接给出角色，不用按作品取</p>
            </Section>
          )}
          <Section label="再筛">
            <ConditionChips
              zone={zone}
              rangeId={range.id}
              conditions={range.conditions}
              steps={steps}
              mode={mode}
              tagCount={tagCount}
              stale={stale}
            />
          </Section>
        </div>

        {range.enabled && (inc ? evalRange : evalExclude) && (
          <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-3 text-xs text-fg-3 transition-opacity', stale && 'opacity-50')}>
            {inc && evalRange ? (
              <>
                {evalRange.works != null && (
                  <>
                    <span>
                      <b className="tabular font-medium text-fg-2">{fmtInt(evalRange.works)}</b> 部作品
                    </span>
                    <IconArrowRight className="size-3" aria-hidden />
                  </>
                )}
                <span>
                  取到 <b className="tabular font-medium text-fg-2">{fmtInt(evalRange.picked)}</b> 人
                </span>
                {onConds.length > 0 && (
                  <>
                    <IconArrowRight className="size-3" aria-hidden />
                    <span>
                      筛完 <b className="tabular font-medium text-fg-2">{fmtInt(evalRange.final)}</b> 人
                    </span>
                  </>
                )}
                <span className="ml-auto" title="这些人只在这个范围里，别的范围没有">
                  只在这个范围：<b className="tabular font-medium text-fg-2">{fmtInt(evalRange.unique)}</b> 人
                </span>
              </>
            ) : evalExclude ? (
              <>
                <span>
                  符合的 <b className="tabular font-medium text-fg-2">{fmtInt(evalExclude.matched)}</b> 人
                </span>
                <IconArrowRight className="size-3" aria-hidden />
                <span>
                  从题库里去掉 <b className="tabular font-medium text-fg-2">{fmtInt(evalExclude.removed_from_pool)}</b> 人
                </span>
              </>
            ) : null}
          </div>
        )}
      </div>
    </Card>
  )
}
