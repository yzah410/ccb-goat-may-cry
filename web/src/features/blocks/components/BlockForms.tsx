/**
 * 四种组块的参数表单。每个区块下面用一句人话复述「现在圈的是什么」。
 */
import { useState, type ReactNode } from 'react'
import { SegmentedControl, Switch } from '@/components/ui/Controls'
import { RangePair, YearRange } from '@/components/ui/NumberField'
import { Input, Textarea } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { IconAlert, IconInfo } from '@/lib/icons'
import { countLines } from '@/lib/format'
import { cn } from '@/lib/cn'
import { CHAR_RANGE_PRESETS, DEFAULT_ROLE_RANK } from '../defaults'
import { useDraft } from '../store'
import type { BlockOf, Gender } from '../schema'
import { TagGroupEditor } from './TagGroupEditor'

export function Section({
  title,
  hint,
  aside,
  children,
  className,
}: {
  title: string
  hint?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('flex flex-col gap-3 border-t border-border pt-5 first:border-t-0 first:pt-0', className)}>
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-fg-1">{title}</h4>
        {aside}
      </div>
      {children}
      {hint && <p className="text-xs leading-body text-fg-3">{hint}</p>}
    </section>
  )
}

function Sentence({ children }: { children: ReactNode }) {
  return <p className="rounded-sm bg-surface-2 px-3 py-2 text-sm text-fg-2">{children}</p>
}

const rangeText = (lo: number, hi: number, kind: 'rank' | 'percent') => {
  const [a, b] = lo <= hi ? [lo, hi] : [hi, lo]
  return kind === 'percent' ? `前 ${a}%–${b}%` : a <= 1 ? `前 ${b} 名` : `第 ${a}–${b} 名`
}

/** 「每部作品取哪些角色」：作品范围 / 作品列（纳入块）共用 */
function RoleRankFields({
  scope,
  kind,
  lo,
  hi,
  onChange,
}: {
  scope: 'main' | 'all'
  kind: 'rank' | 'percent'
  lo: number
  hi: number
  onChange: (patch: Partial<{ roles_scope: 'main' | 'all'; role_rank_kind: 'rank' | 'percent'; role_rank_lo: number; role_rank_hi: number }>) => void
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          size="sm"
          value={scope}
          onChange={(v) => onChange({ roles_scope: v })}
          aria-label="角色范围"
          options={[
            { value: 'main', label: '只要主角' },
            { value: 'all', label: '主角 + 配角' },
          ]}
        />
        <SegmentedControl
          size="sm"
          value={kind}
          onChange={(v) => onChange({ role_rank_kind: v })}
          aria-label="按名次还是百分比"
          options={[
            { value: 'rank', label: '按名次' },
            { value: 'percent', label: '按百分比' },
          ]}
        />
      </div>
      <RangePair
        lo={lo}
        hi={hi}
        min={kind === 'percent' ? 0 : 1}
        max={kind === 'percent' ? 100 : undefined}
        step={kind === 'percent' ? 5 : 1}
        unit={kind === 'percent' ? '%' : '名'}
        onChange={(a, b) => onChange({ role_rank_lo: a, role_rank_hi: b })}
      />
      <Sentence>
        每部作品里，按热度排，取{rangeText(lo, hi, kind)}的{scope === 'main' ? '主角' : '角色（主角和配角一起排）'}。
      </Sentence>
    </>
  )
}

// ---------------------------------------------------------------- 作品范围
export function WorkRangeForm({ block }: { block: BlockOf<'work-range'> }) {
  const update = useDraft((s) => s.updateParams)
  const p = block.params
  const set = (patch: Record<string, unknown>) => update(block.id, patch)
  return (
    <div className="flex flex-col gap-5">
      <Section title="年份" hint="作品的放送/上映年份，两头都算。">
        <YearRange value={p.years} onChange={(years) => set({ years })} />
      </Section>

      <Section title="作品标签" hint="只认作品标签（例如 日常、治愈、百合）。">
        <TagGroupEditor mode="work-only" value={p.tag_groups} onChange={(tag_groups) => set({ tag_groups })} />
      </Section>

      <Section title="按收藏数取哪些作品">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            size="sm"
            value={p.rank_basis}
            onChange={(rank_basis) => set({ rank_basis })}
            aria-label="怎么排名"
            options={[
              { value: 'per_year', label: '每年分别排', title: '每一年单独按收藏数排名，每年各取一段' },
              { value: 'merged', label: '所有年份合起来排', title: '把范围内所有年份的作品放在一起排一次' },
            ]}
          />
          <SegmentedControl
            size="sm"
            value={p.rank_value_kind}
            onChange={(rank_value_kind) => set({ rank_value_kind })}
            aria-label="按名次还是百分比"
            options={[
              { value: 'rank', label: '按名次' },
              { value: 'percent', label: '按百分比' },
            ]}
          />
        </div>
        <RangePair
          lo={p.rank_lo}
          hi={p.rank_hi}
          min={p.rank_value_kind === 'percent' ? 0 : 1}
          max={p.rank_value_kind === 'percent' ? 100 : undefined}
          step={p.rank_value_kind === 'percent' ? 5 : 1}
          unit={p.rank_value_kind === 'percent' ? '%' : '名'}
          onChange={(rank_lo, rank_hi) => set({ rank_lo, rank_hi })}
        />
        <Sentence>
          {p.rank_basis === 'per_year' ? '每一年' : '所有年份放在一起'}，按收藏数排，取{rangeText(p.rank_lo, p.rank_hi, p.rank_value_kind)}的作品
          {p.rank_value_kind === 'percent' ? '（按百分比时至少会留 1 部）' : ''}。
        </Sentence>
      </Section>

      <Section title="每部作品取哪些角色">
        <RoleRankFields
          scope={p.roles_scope}
          kind={p.role_rank_kind}
          lo={p.role_rank_lo}
          hi={p.role_rank_hi}
          onChange={set}
        />
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------- 作品列
const LINE_HELP = '每行一个。可以写名字、id，或者「名字 空格 id」「id 空格 名字」，混着写也行。'

export function WorkListForm({ block }: { block: BlockOf<'work-list'> }) {
  const update = useDraft((s) => s.updateParams)
  const p = block.params
  const set = (patch: Record<string, unknown>) => update(block.id, patch)
  const incomplete = !(p.roles_scope && p.role_rank_kind && p.role_rank_lo != null && p.role_rank_hi != null)
  return (
    <div className="flex flex-col gap-5">
      <Section title="作品清单" hint={LINE_HELP} aside={<span className="text-xs text-fg-3">{countLines(p.work_lines)} 行</span>}>
        <Textarea
          rows={10}
          value={p.work_lines}
          onChange={(e) => set({ work_lines: e.target.value })}
          placeholder={'例如：\n间谍过家家\n8\n孤独摇滚 328609'}
          aria-label="作品清单"
        />
      </Section>
      {block.color === 'red' ? (
        <Section title="每部作品取哪些角色">
          {incomplete && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-warning-bg px-3 py-2 text-sm text-warning-fg">
              <span className="flex items-center gap-1.5">
                <IconAlert className="size-4" />
                还没设「每部取几个角色」，后端会把这个组块当成空的。
              </span>
              <Button size="sm" variant="secondary" onClick={() => set({ ...DEFAULT_ROLE_RANK })}>
                补上默认值
              </Button>
            </div>
          )}
          <RoleRankFields
            scope={p.roles_scope ?? 'all'}
            kind={p.role_rank_kind ?? 'rank'}
            lo={p.role_rank_lo ?? 1}
            hi={p.role_rank_hi ?? 5}
            onChange={(patch) => set({ ...DEFAULT_ROLE_RANK, ...pick(p), ...patch })}
          />
        </Section>
      ) : (
        <p className="flex items-start gap-1.5 rounded-sm bg-info-bg px-3 py-2 text-sm text-info-fg">
          <IconInfo className="mt-0.5 size-4 shrink-0" />
          排除块会去掉清单里每部作品的全部角色（主角 + 配角），不看「每部取几个」。
        </p>
      )}
    </div>
  )
}

function pick(p: BlockOf<'work-list'>['params']) {
  const out: Record<string, unknown> = {}
  for (const k of ['roles_scope', 'role_rank_kind', 'role_rank_lo', 'role_rank_hi'] as const) if (p[k] !== undefined) out[k] = p[k]
  return out
}

// ---------------------------------------------------------------- 角色列
export function CharListForm({ block }: { block: BlockOf<'char-list'> }) {
  const update = useDraft((s) => s.updateParams)
  const p = block.params
  return (
    <Section title="角色清单" hint={LINE_HELP} aside={<span className="text-xs text-fg-3">{countLines(p.char_lines)} 行</span>}>
      <Textarea
        rows={14}
        value={p.char_lines}
        onChange={(e) => update(block.id, { char_lines: e.target.value })}
        placeholder={'例如：\n三谷结衣\n176787\n142354 宫本武藏\n命运 97758'}
        aria-label="角色清单"
      />
    </Section>
  )
}

// ---------------------------------------------------------------- 角色范围
const GENDERS: { value: Gender; label: string }[] = [
  { value: '♀', label: '♀ 女' },
  { value: '♂', label: '♂ 男' },
  { value: '?', label: '? 未知' },
]

export function CharRangeForm({ block }: { block: BlockOf<'char-range'> }) {
  const update = useDraft((s) => s.updateParams)
  const replace = useDraft((s) => s.replaceParams)
  const p = block.params
  const set = (patch: Record<string, unknown>) => update(block.id, patch)
  const unset = (key: string) => {
    const next: Record<string, unknown> = { ...p }
    delete next[key]
    replace(block.id, next)
  }
  const toggle = (key: 'earliest_year' | 'latest_year' | 'max_score', on: boolean) =>
    on ? set({ [key]: [...CHAR_RANGE_PRESETS[key]] }) : unset(key)

  const genders = p.genders ?? []
  const noCondition =
    !p.earliest_year && !p.latest_year && !genders.length && !p.max_score && !p.appear_works?.length && !(p.tag_groups ?? []).some((g) => g.length)

  return (
    <div className="flex flex-col gap-5">
      {noCondition && block.color === 'red' && (
        <p className="flex items-start gap-1.5 rounded-sm bg-warning-bg px-3 py-2 text-sm text-warning-fg">
          <IconAlert className="mt-0.5 size-4 shrink-0" />
          还没设任何条件：这个纳入块会把数据里的全部角色都加进来。
        </p>
      )}
      <Section
        title="最早登场年"
        aside={<LimitSwitch on={!!p.earliest_year} onChange={(v) => toggle('earliest_year', v)} />}
        hint={p.earliest_year ? '角色第一次登场的年份要落在这个区间里（没有登场年份的角色会被排掉）。' : '不限'}
      >
        {p.earliest_year && <YearRange value={p.earliest_year} onChange={(earliest_year) => set({ earliest_year })} />}
      </Section>
      <Section
        title="最晚登场年"
        aside={<LimitSwitch on={!!p.latest_year} onChange={(v) => toggle('latest_year', v)} />}
        hint={p.latest_year ? '角色最后一次登场的年份要落在这个区间里。' : '不限'}
      >
        {p.latest_year && <YearRange value={p.latest_year} onChange={(latest_year) => set({ latest_year })} />}
      </Section>
      <Section title="性别" hint={genders.length ? `只要：${genders.join(' ')}` : '都不选 = 不限'}>
        <div className="flex flex-wrap gap-2" role="group" aria-label="性别">
          {GENDERS.map((g) => {
            const on = genders.includes(g.value)
            return (
              <button
                key={g.value}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = on ? genders.filter((x) => x !== g.value) : [...genders, g.value]
                  set({ genders: next })
                }}
                className={cn(
                  'h-[var(--control-h-sm)] rounded-full px-3 text-sm ring-1 ring-inset transition-colors',
                  on ? 'bg-primary-100 text-primary-800 ring-primary-300' : 'bg-surface-1 text-fg-2 ring-border-strong hover:bg-surface-2',
                )}
              >
                {g.label}
              </button>
            )
          })}
        </div>
      </Section>
      <Section
        title="最高评分"
        aside={<LimitSwitch on={!!p.max_score} onChange={(v) => toggle('max_score', v)} />}
        hint={p.max_score ? '角色的最高评分（0–10）要落在这个区间里。' : '不限'}
      >
        {p.max_score && (
          <RangePair lo={p.max_score[0]} hi={p.max_score[1]} min={0} max={10} step={0.1} unit="分" onChange={(a, b) => set({ max_score: [a, b] })} />
        )}
      </Section>
      <Section title="标签" hint="可以混用：作品标签、角色标签、声优、原作来源。">
        <TagGroupEditor mode="mixed" value={p.tag_groups} onChange={(tag_groups) => set({ tag_groups })} />
      </Section>
      <Section title="登场作品（可选）" hint="填作品 id，用逗号隔开：角色至少在其中一部里登场过。留空 = 不限。">
        <IdListInput
          value={p.appear_works}
          onCommit={(ids) => (ids.length ? set({ appear_works: ids }) : unset('appear_works'))}
        />
      </Section>
    </div>
  )
}

/** 逗号分隔的 id 列表：打字时保留原文（敲逗号不会被吃掉），能解析的 id 立即生效 */
function IdListInput({ value, onCommit }: { value: number[] | undefined; onCommit: (ids: number[]) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const parse = (s: string) =>
    s
      .split(/[,，\s]+/)
      .map((x) => parseInt(x.trim(), 10))
      .filter((x) => !Number.isNaN(x))
  return (
    <Input
      value={draft ?? (value ?? []).join(', ')}
      onFocus={() => setDraft((value ?? []).join(', '))}
      onChange={(e) => {
        setDraft(e.target.value)
        onCommit(parse(e.target.value))
      }}
      onBlur={() => setDraft(null)}
      placeholder="例如 8, 123, 456"
      aria-label="登场作品 id"
    />
  )
}

function LimitSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-fg-2">
      {on ? '限定' : '不限'}
      <Switch size="sm" checked={on} onChange={onChange} aria-label={on ? '切换为不限' : '限定范围'} />
    </label>
  )
}
