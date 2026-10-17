/**
 * 题库与抽取：页面的视觉重心 = 题库人数（大字）+「抽一题」（本页唯一的主按钮）+「去候选池看全部 N 人」。
 * 下面是抽题方式（三种，默认「每个角色机会均等」）、随机种子；再下面是抽到的人（角色卡片的紧凑版）。
 */
import { useState, type ReactNode } from 'react'
import { RadioGroup as RG } from 'radix-ui'
import { cn } from '@/lib/cn'
import { fmtInt, relativeTime } from '@/lib/format'
import { errorText } from '@/lib/apiClient'
import { useShellNav } from '@/app/shell/nav'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { NumberField } from '@/components/ui/NumberField'
import { EmptyState, WorkBadge } from '@/components/data-display/Misc'
import { IconAlert, IconArrowRight, IconChevronUp, IconDice, IconLoader, IconRefresh, IconSliders, IconUserSearch, IconUsers } from '@/lib/icons'
import { useSetPick } from '@/features/candidates/hooks'
import { useCandidateView, usePick } from '@/features/candidates/store'
import { isV2Missing, useV2LoadingStage } from '@/features/v2/hooks'
import type { DrawMethod, DrawV2 } from '@/features/v2/types'
import { conditionComplete, enabledRangeCount, poolKey, rangeTitle } from '../spec'
import { useWb2, useWb2Draw } from '../store'
import { useDrawV2, type EvaluateView } from '../hooks'
import { CharacterCardV2 } from './CharacterCardV2'

const METHODS: { value: DrawMethod; label: string; hint: ReactNode }[] = [
  {
    value: 'per_character',
    label: '每个角色机会均等',
    hint: '题库里每个人被抽到的概率一样。',
  },
  {
    value: 'per_work',
    label: '先抽作品，再抽角色',
    hint: '和猜猜呗自己随机出题一样：先随机一部作品，再从它在题库里的角色里随机一个（主角少的作品，角色更容易被抽到）。',
  },
  {
    value: 'range_share',
    label: '按范围占比',
    hint: '先按你给每个范围设的占比选一个范围，再在里面随机（例：近 5 年热门占 70%、老番占 30%）。',
  },
]

/** 题库人数的大字：全站唯一超出 6 档字号的地方（fs-6 × 1.75），是这一页的视觉重心 */
const HERO = 'text-[length:calc(var(--fs-6)*1.75)] leading-none'

/** 「去候选池看全部 N 人」：题库人数旁边的入口（题库里有谁在独立的候选池页，不列在工作台下面） */
function PoolLink({ total, compact }: { total: number | null | undefined; compact?: boolean }) {
  const nav = useShellNav()
  if (!total) return null
  return (
    <Button
      variant={compact ? 'ghost' : 'link'}
      size="sm"
      icon={compact ? <IconUserSearch /> : undefined}
      onClick={() => nav.go('pool')}
      className={compact ? undefined : 'gap-1 text-sm'}
      data-action="open-pool"
    >
      去候选池看全部 {fmtInt(total)} 人
      {!compact && <IconArrowRight aria-hidden />}
    </Button>
  )
}

export function PoolHero({ ev, compact }: { ev: EvaluateView; compact?: boolean }) {
  const total = ev.data?.total
  const zero = total === 0
  return (
    <div className={cn('flex min-w-0', compact ? 'items-center gap-3' : 'flex-col gap-1')}>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-1.5 text-sm text-fg-2">
          <IconUsers className="size-4" aria-hidden />
          题库
          {ev.fetching && <IconLoader className="size-3.5 animate-spin text-fg-3" aria-label="正在算" />}
        </span>
        <span className={cn('flex items-baseline gap-1.5', ev.stale && 'opacity-45 transition-opacity')} aria-live="polite">
          {total == null ? (
            ev.error ? (
              <span className="text-lg font-semibold text-danger-fg">算不出来</span>
            ) : (
              <span className={cn('skeleton rounded-md', compact ? 'h-8 w-20' : 'h-11 w-28')} />
            )
          ) : (
            <>
              <span
                className={cn(
                  'tabular font-semibold tracking-tight',
                  compact ? 'text-[length:calc(var(--fs-6)*1.3)] leading-none' : HERO,
                  zero ? 'text-danger-fg' : 'text-[color-mix(in_oklab,var(--primary)_75%,var(--text-1))]',
                )}
              >
                {fmtInt(total)}
              </span>
              <span className="text-base text-fg-2">人</span>
            </>
          )}
        </span>
      </div>
      <div className={cn(compact ? 'shrink-0 self-end' : 'self-start', ev.stale && 'opacity-60')}>
        <PoolLink total={total} compact={compact} />
      </div>
    </div>
  )
}

/** 排除项：来源是整个角色库、又没有起作用的条件 = 会把所有人都排除掉 */
function useWipingExcludes(ev: EvaluateView): string[] {
  const spec = useWb2((s) => s.spec)
  return spec.excludes
    .filter((r) => r.enabled && r.source.kind === 'all_characters')
    .filter((r) => {
      const steps = ev.data?.excludes.find((x) => x.id === r.id)?.steps
      return !r.conditions.some((c) => c.enabled && conditionComplete(c) && steps?.find((s) => s.condition_id === c.id)?.skipped !== 'error')
    })
    .map((r) => rangeTitle(spec, r.id))
}

function Notices({ ev }: { ev: EvaluateView }) {
  const stage = useV2LoadingStage(ev.slow)
  const wiping = useWipingExcludes(ev)
  const errors = ev.data?.errors ?? []
  // 后端会把 errors 也写进 warnings，这里去掉重复的；有「排除所有人」的排除项时，后端附带的「（不影响人数）」不成立，也不显示
  const warnings = (ev.data?.warnings ?? []).filter((w) => !errors.some((e) => w.includes(e.message)) && !(wiping.length > 0 && w.includes('不影响人数')))
  return (
    <>
      {ev.slow && (
        <p className="flex items-start gap-2 rounded-md bg-info-bg px-3 py-2 text-xs text-info-fg" role="status">
          <IconLoader className="mt-px size-3.5 shrink-0 animate-spin" aria-hidden />
          <span>
            正在加载数据：第一次用某个模式时，后端要把这个模式的角色数据读进内存，要几秒到十几秒。
            {stage && <span className="mt-0.5 block font-medium">现在：{stage}</span>}
          </span>
        </p>
      )}
      {!!ev.error && (
        <div className="flex flex-col gap-2 rounded-md bg-danger-bg px-3 py-2 text-xs text-danger-fg">
          <span>
            {isV2Missing(ev.error)
              ? '后端没有出题器接口（/v2）：后端可能是更新代码之前启动的。关掉后端和前端窗口，重新运行启动脚本（Windows：start-all.bat；macOS / Linux：start-all.sh）。'
              : `人数没算出来：${errorText(ev.error)}`}
          </span>
          <Button size="sm" variant="ghost" icon={<IconRefresh />} className="self-start" onClick={ev.refetch}>
            再算一次
          </Button>
        </div>
      )}
      {wiping.length > 0 && (
        <p className="flex items-start gap-1.5 rounded-md bg-danger-bg px-3 py-2 text-xs text-danger-fg">
          <IconAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          「{wiping.join('、')}」会把所有人都排除掉：来源是整个角色库，又没有起作用的条件。填上条件，或者先停用它。
        </p>
      )}
      {errors.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md border border-[color-mix(in_oklab,var(--danger)_40%,transparent)] bg-danger-bg px-3 py-2 text-xs text-danger-fg">
          {errors.map((e, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <IconAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>
                <b className="font-medium">{e.where === 'exclude' ? '排除项' : '范围'}有一部分没生效：</b>
                {e.message}
              </span>
            </li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md bg-warning-bg px-3 py-2 text-xs text-warning-fg">
          {warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <IconAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              {w}
            </li>
          ))}
        </ul>
      )}
      {ev.data?.total === 0 && !ev.stale && (
        <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-fg-2">题库是空的：放宽某个范围的条件，或者看看是不是排除得太多了。</p>
      )}
    </>
  )
}

/** 各个范围各有多少人（2 个以上范围、或者有排除项时才显示） */
function Breakdown({ ev }: { ev: EvaluateView }) {
  const spec = useWb2((s) => s.spec)
  const d = ev.data
  if (!d) return null
  const ranges = spec.ranges.filter((r) => r.enabled)
  const excludes = spec.excludes.filter((r) => r.enabled)
  if (ranges.length < 2 && excludes.length === 0) return null
  return (
    <dl className={cn('flex flex-col gap-1 text-xs transition-opacity', ev.stale && 'opacity-50')}>
      {ranges.map((r) => {
        const e = d.ranges.find((x) => x.id === r.id)
        return (
          <div key={r.id} className="flex items-baseline gap-2">
            <dt className="min-w-0 flex-1 truncate text-fg-2">
              <span className="mr-1 font-semibold text-[color-mix(in_oklab,var(--include)_80%,var(--text-1))]">＋</span>
              {rangeTitle(spec, r.id)}
            </dt>
            <dd className="tabular text-fg-1">{e ? `${fmtInt(e.final)} 人` : '—'}</dd>
          </div>
        )
      })}
      {excludes.map((r) => {
        const e = d.excludes.find((x) => x.id === r.id)
        return (
          <div key={r.id} className="flex items-baseline gap-2">
            <dt className="min-w-0 flex-1 truncate text-fg-2">
              <span className="mr-1 font-semibold text-[color-mix(in_oklab,var(--exclude)_80%,var(--text-1))]">－</span>
              {rangeTitle(spec, r.id)}
            </dt>
            <dd className="tabular text-fg-1">{e ? `去掉 ${fmtInt(e.removed_from_pool)} 人` : '—'}</dd>
          </div>
        )
      })}
      {ranges.length > 1 && <p className="pt-0.5 text-fg-3">同一个人在几个范围里都有，只算一次</p>}
    </dl>
  )
}

/** 怎么抽：默认收起成一行（右栏要吸顶，不能太高），点「改」展开 */
export function DrawSettings({ collapsible = true }: { collapsible?: boolean }) {
  const spec = useWb2((s) => s.spec)
  const edit = useWb2((s) => s.edit)
  const [open, setOpen] = useState(!collapsible)
  const multi = enabledRangeCount(spec) >= 2
  const method = spec.draw.method === 'range_share' && !multi ? 'per_character' : spec.draw.method
  const setMethod = (m: DrawMethod) => edit(`抽题方式改成「${METHODS.find((x) => x.value === m)?.label}」`, (s) => ({ ...s, draw: { ...s.draw, method: m } }))
  const on = spec.ranges.filter((r) => r.enabled)
  const shareSum = on.reduce((a, r) => a + (r.share ?? 1), 0) || 1
  const cur = METHODS.find((m) => m.value === method)!
  if (!open)
    return (
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 text-sm">
          <span className="text-fg-3">怎么抽：</span>
          <span className="text-fg-1">{cur.label}</span>
          {method === 'per_character' && <span className="ml-1.5 text-xs text-fg-3">（默认）</span>}
          {spec.draw.seed != null && <span className="ml-1.5 text-xs text-fg-3">· 种子 {spec.draw.seed}</span>}
        </div>
        <Button size="sm" variant="ghost" icon={<IconSliders />} onClick={() => setOpen(true)} aria-expanded={false}>
          改
        </Button>
      </div>
    )
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-fg-2">怎么抽</span>
        {collapsible && (
          <Button size="sm" variant="ghost" icon={<IconChevronUp />} onClick={() => setOpen(false)} aria-expanded>
            收起
          </Button>
        )}
      </div>
      <RG.Root value={method} onValueChange={(v) => setMethod(v as DrawMethod)} className="flex flex-col gap-1" aria-label="抽题方式">
        {METHODS.map((m) => {
          const disabled = m.value === 'range_share' && !multi
          return (
            <label
              key={m.value}
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-2',
                method === m.value && 'bg-surface-2',
                disabled && 'cursor-not-allowed opacity-55 hover:bg-transparent',
              )}
            >
              <RG.Item
                value={m.value}
                disabled={disabled}
                className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-border-strong bg-surface-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[state=checked]:border-primary"
              >
                <RG.Indicator className="size-2 rounded-full bg-primary" />
              </RG.Item>
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5 text-sm text-fg-1">
                  {m.label}
                  {m.value === 'per_character' && <Badge size="sm" tone="neutral">默认</Badge>}
                </span>
                <span className="mt-0.5 block text-xs text-fg-3">{disabled ? '有 2 个以上启用的范围时才能用。' : m.hint}</span>
              </span>
            </label>
          )
        })}
      </RG.Root>
      {method === 'range_share' && multi && (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <span className="text-xs text-fg-3">每个范围的占比（数字越大越常被抽到；去掉排除后是空的范围不参与）</span>
          {on.map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-fg-1">{rangeTitle(spec, r.id)}</span>
              <NumberField
                value={r.share ?? 1}
                onCommit={(v) =>
                  v !== null &&
                  edit('改范围占比', (s) => ({ ...s, ranges: s.ranges.map((x) => (x.id === r.id ? { ...x, share: v } : x)) }), { coalesce: `${r.id}:share` })
                }
                min={0}
                step={1}
                fallback={1}
                size="sm"
                className="w-16"
                aria-label={`${rangeTitle(spec, r.id)}的占比`}
              />
              <span className="tabular w-12 text-right text-xs text-fg-3">{Math.round(((r.share ?? 1) / shareSum) * 100)}%</span>
            </div>
          ))}
        </div>
      )}
      <label className="flex flex-wrap items-center gap-2 text-sm text-fg-2">
        随机种子
        <NumberField
          value={spec.draw.seed ?? null}
          onCommit={(v) => edit(v === null ? '清空随机种子' : '改随机种子', (s) => ({ ...s, draw: { ...s.draw, seed: v } }), { coalesce: 'seed' })}
          allowEmpty
          integer
          size="sm"
          className="w-24"
          placeholder="不设"
          aria-label="随机种子"
        />
        <span className="text-xs text-fg-3">{spec.draw.seed == null ? '不设 = 每次随机' : '设了 = 每次抽到同一个人'}</span>
      </label>
    </div>
  )
}

/** 抽题按钮（本页唯一的 primary） */
export function DrawButton({ ev, className, size = 'lg' }: { ev: EvaluateView; className?: string; size?: 'md' | 'lg' }) {
  const draw = useDrawV2()
  const noRange = useWb2((s) => enabledRangeCount(s.spec) === 0)
  const empty = ev.data?.total === 0 && !ev.stale
  return (
    <Button
      variant="primary"
      size={size}
      icon={<IconDice />}
      loading={draw.isPending}
      disabled={noRange || empty}
      onClick={draw.run}
      className={className}
      data-action="draw"
      title={noRange ? '先启用或加一个纳入范围' : empty ? '题库是空的' : undefined}
    >
      抽一题
    </Button>
  )
}

/** 宽屏右栏（吸顶）：人数大字 + 各范围人数 + 提示 + 抽一题 + 怎么抽 */
export function PoolCard({ ev }: { ev: EvaluateView }) {
  return (
    <Card ornament="featured" className="p-5" data-slot="pool-card">
      <div className="relative z-[1] flex flex-col gap-4">
        <PoolHero ev={ev} />
        <Breakdown ev={ev} />
        <Notices ev={ev} />
        <DrawButton ev={ev} className="w-full" />
        <div className="border-t border-border pt-3">
          <DrawSettings />
        </div>
      </div>
    </Card>
  )
}

/** 窄屏时吸顶的一条：人数 + 抽一题（宽屏时这一条藏起来，用右栏的 PoolCard） */
export function PoolBar({ ev, className }: { ev: EvaluateView; className?: string }) {
  return (
    <div
      data-slot="pool-bar"
      className={cn(
        'glass sticky top-[var(--shell-sticky-top,0px)] z-20 -mx-2 flex items-center gap-3 rounded-lg border border-border px-3 py-2 shadow-2',
        className,
      )}
    >
      <PoolHero ev={ev} compact />
      <DrawButton ev={ev} size="md" className="ml-auto" />
    </div>
  )
}

/** 窄屏时放在编辑区下面：各范围人数、提示、怎么抽（人数和按钮在吸顶条里） */
export function PoolDetailsCard({ ev }: { ev: EvaluateView }) {
  return (
    <Card className="p-4">
      <div className="flex flex-col gap-3">
        <h2 className="text-base text-fg-1">题库与抽取</h2>
        <Breakdown ev={ev} />
        <Notices ev={ev} />
        <DrawSettings collapsible={false} />
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------- 抽到的人
/**
 * 抽到的人：角色卡片（和候选池页同一个组件的紧凑版）——头像、名字、评分 / 热度 / 登场、分栏标签 + 「+N 个标签」、
 * 时间线、代表作 +N 部（悬停看其余作品）；操作：设为当前题目 / 复制名字 / 再抽一次。不画游戏格子、不把全部作品列出来。
 */
export function DrawResultCard() {
  const last = useWb2Draw((s) => s.last)
  const spec = useWb2((s) => s.spec)
  const pick = usePick((s) => s.pick)
  const showCharTags = useCandidateView((s) => s.showCharTags)
  const setPick = useSetPick()
  const draw = useDrawV2()
  if (!last)
    return (
      <Card>
        <EmptyState kind="no-result" size="sm" title="还没抽" description="点「抽一题」，从题库里随机抽一个角色" />
      </Card>
    )
  const d: DrawV2 = last.data
  const isCurrent = pick?.item.char_id === d.char_id
  const changed = last.key !== poolKey(spec)
  const multiRange = enabledRangeCount(spec) >= 2
  const rangeNames = multiRange ? d.ranges.map((id) => rangeTitle(spec, id)).filter((t) => !t.startsWith('（')) : null
  // 「先抽作品、再抽角色」：后端把这次先抽到的作品放在 bound_work 里，显示在卡片底部
  const drawnWork = d.method === 'per_work' ? d.bound_work : null
  return (
    <div key={`${d.char_id}-${last.at}`} className="animate-[slide-up_var(--motion-duration)_var(--motion-ease)]" data-slot="draw-result">
      <CharacterCardV2
        item={d}
        compact
        featured
        isCurrent={isCurrent}
        onSetCurrent={() => setPick({ ...d, appear_count: d.grid?.n_app }, 'draw')}
        setCurrentLabel="设为当前题目"
        showCharTags={showCharTags}
        rangeNames={rangeNames}
        notice={changed ? <p className="rounded-sm bg-warning-bg px-3 py-2 text-xs text-warning-fg">方案改过了，这是改之前抽到的。</p> : undefined}
        meta={
          <p className="mt-1 text-xs text-fg-3">
            从 {fmtInt(d.pool_total)} 人里抽的 · {relativeTime(last.at)}
            {spec.draw.seed != null && ' · 设了随机种子，每次都是同一个人'}
            {isCurrent && <span className="block text-fg-2">已经是当前题目了：右上角「当前题目」里可以发到猜猜呗</span>}
          </p>
        }
        footer={
          drawnWork ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-primary-50 px-3 py-2 text-sm text-primary-900">
              <span>这次先抽到的作品：</span>
              <WorkBadge name={drawnWork.name} year={drawnWork.year} />
            </div>
          ) : undefined
        }
        extraActions={
          <Button variant="ghost" size="sm" icon={<IconRefresh />} loading={draw.isPending} onClick={draw.run}>
            再抽一次
          </Button>
        }
      />
    </div>
  )
}
