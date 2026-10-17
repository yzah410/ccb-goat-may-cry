/**
 * 范围卡片里的两段：「从哪来」和「取角色」。两段永远有值（可以改，不能删）。
 */
import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import { SegmentedControl, Select } from '@/components/ui/Controls'
import { NumberField } from '@/components/ui/NumberField'
import { Tooltip } from '@/components/ui/Overlay'
import { IconHelp, IconX } from '@/lib/icons'
import { ListPicker, ToggleChips } from '@/features/v2/components/Fields'
import type { ModeId, PickSpec, RangeV2, Role, Source, SourceKind } from '@/features/v2/types'
import { DEFAULT_PER_WORK, DEFAULT_RANK_TO, RANK_SUBJECT_TYPES, SUBJECT_TYPE_LABEL, defaultRankSource, emptyTagFilter, pickWithRoles, typesOfMode } from '../spec'
import { useWb2 } from '../store'
import { TagFilterEditor } from './TagFilterEditor'

function Label({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-fg-3">
      {children}
      {hint && (
        <Tooltip content={hint}>
          <span className="cursor-help text-fg-3 hover:text-fg-1" tabIndex={0} aria-label={hint}>
            <IconHelp className="size-3.5" />
          </span>
        </Tooltip>
      )}
    </span>
  )
}

/** 一组控件：小标签 + 控件，窄的时候自动换行 */
function Group({ label, hint, children, className }: { label: ReactNode; hint?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5', className)}>
      <Label hint={hint}>{label}</Label>
      {children}
    </div>
  )
}

const SOURCE_KIND_OPTIONS: { value: SourceKind; label: string; hint: string }[] = [
  { value: 'rank', label: '按热度排名的作品', hint: '年份、作品类型、热度第几名（和猜猜呗的设置面板一样）' },
  { value: 'work_list', label: '作品清单里的作品', hint: '你自己建的作品清单' },
  { value: 'char_list', label: '角色清单里的角色', hint: '直接用你建的角色清单，不按作品取' },
  { value: 'all_characters', label: '不限作品（整个角色库）', hint: '十几万人，一般要配合条件用；排除区里常用' },
]

// ---------------------------------------------------------------- 从哪来
export function SourceEditor({ range, mode, zone }: { range: RangeV2; mode: ModeId; zone: 'ranges' | 'excludes' }) {
  const edit = useWb2((s) => s.edit)
  const src = range.source
  const id = range.id
  const setSource = (label: string, next: Source, coalesce?: string) =>
    edit(label, (s) => ({
      ...s,
      [zone]: s[zone].map((r) => (r.id === id ? { ...r, source: next } : r)),
    }), coalesce ? { coalesce: `${id}:${coalesce}` } : undefined)

  const changeKind = (k: SourceKind) => {
    if (k === src.kind) return
    const y = new Date().getFullYear()
    const next: Source =
      k === 'rank' ? defaultRankSource(y, typesOfMode(mode)) : k === 'all_characters' ? { kind: k } : { kind: k, list_id: '' }
    setSource('换「从哪来」', next)
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="w-full max-w-64">
        <Select<SourceKind> size="sm" value={src.kind} onChange={changeKind} options={SOURCE_KIND_OPTIONS} aria-label="从哪来" />
      </div>
      {src.kind === 'rank' && <RankEditor src={src} setSource={setSource} mode={mode} />}
      {(src.kind === 'work_list' || src.kind === 'char_list') && (
        <ListPicker
          kind={src.kind === 'work_list' ? 'work' : 'character'}
          value={src.list_id || null}
          onChange={(lid) => setSource('选清单', { ...src, list_id: lid ?? '' })}
          className="max-w-64"
        />
      )}
      {src.kind === 'all_characters' && (
        <p className="text-xs text-fg-3">
          {zone === 'ranges'
            ? '整个角色库有十几万人：记得在「再筛」里加条件缩小范围。'
            : '配合「再筛」里的条件用：满足条件的人会从题库里去掉。'}
        </p>
      )}
    </div>
  )
}

function RankEditor({
  src,
  setSource,
  mode,
}: {
  src: Extract<Source, { kind: 'rank' }>
  setSource: (label: string, next: Source, coalesce?: string) => void
  mode: ModeId
}) {
  const [showFilter, setShowFilter] = useState(!!src.work_filter)
  const all = src.rank_to === null
  const wf = src.work_filter ?? null
  const order = src.work_filter_order === 'after_rank' ? 'after_rank' : 'before_rank'
  const rankReversed = !all && src.rank_to !== null && src.rank_from > src.rank_to
  const yearReversed = src.year_from != null && src.year_to != null && src.year_from > src.year_to
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
        <Group label="类型">
          <ToggleChips
            ariaLabel="作品类型"
            atLeastOne
            values={src.subject_types.map(String)}
            onChange={(v) => setSource('改作品类型', { ...src, subject_types: v.map(Number) })}
            options={RANK_SUBJECT_TYPES.map((t) => ({ value: String(t), label: SUBJECT_TYPE_LABEL[t] }))}
          />
        </Group>
        <Group label="年份" hint="作品的年份（放送 / 发售）；留空 = 不限">
          <NumberField
            value={src.year_from}
            onCommit={(v) => setSource('改起始年', { ...src, year_from: v }, 'year_from')}
            allowEmpty
            integer
            min={1900}
            max={2100}
            size="sm"
            className="w-[4.5rem]"
            placeholder="不限"
            aria-label="起始年"
          />
          <span className="text-fg-3">–</span>
          <NumberField
            value={src.year_to}
            onCommit={(v) => setSource('改结束年', { ...src, year_to: v }, 'year_to')}
            allowEmpty
            integer
            min={1900}
            max={2100}
            size="sm"
            className="w-[4.5rem]"
            placeholder="不限"
            aria-label="结束年"
          />
          <span className="text-xs text-fg-3">年</span>
        </Group>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
        <Group label="热度" hint="按作品的收藏人数排名（同分按 id）；没有角色的作品也占名次，和游戏一样">
          {all ? (
            <span className="text-sm font-medium text-fg-1">全部作品</span>
          ) : (
            <>
              <span className="text-sm text-fg-2">第</span>
              <NumberField
                value={src.rank_from}
                onCommit={(v) => v !== null && setSource('改热度排名', { ...src, rank_from: v }, 'rank_from')}
                integer
                min={1}
                size="sm"
                className="w-16"
                aria-label="从第几名"
                fallback={1}
              />
              <span className="text-fg-3">–</span>
              <NumberField
                value={src.rank_to}
                onCommit={(v) => v !== null && setSource('改热度排名', { ...src, rank_to: v }, 'rank_to')}
                integer
                min={1}
                size="sm"
                className="w-[4.5rem]"
                aria-label="到第几名"
                fallback={DEFAULT_RANK_TO}
              />
              <span className="text-sm text-fg-2">名</span>
            </>
          )}
          <Button
            size="sm"
            variant={all ? 'soft' : 'secondary'}
            onClick={() => setSource(all ? '热度改回前 50 部' : '热度改成全部', { ...src, rank_from: 1, rank_to: all ? DEFAULT_RANK_TO : null })}
            title={all ? '改回按名次取' : '不按名次，年份里的全部作品'}
          >
            {all ? '改回按名次' : '全部'}
          </Button>
        </Group>
        {!all && (
          <SegmentedControl
            size="sm"
            value={src.rank_scope}
            onChange={(v) => setSource(v === 'per_year' ? '改成每年分别取' : '改成合并排名', { ...src, rank_scope: v })}
            aria-label="排名方式"
            options={[
              { value: 'merged', label: '合并排名', title: '这些年的作品放在一起排名，取第几名到第几名' },
              { value: 'per_year', label: '每年分别取', title: '每一年各自排名，每年都取第几名到第几名' },
            ]}
          />
        )}
      </div>
      {(rankReversed || yearReversed) && (
        <p className="text-xs text-danger-fg">
          {yearReversed ? '起始年比结束年还晚' : '「第几名」起点比终点大'}：人数算不出来，把两个数对调一下。
        </p>
      )}
      {showFilter || wf ? (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-bg-elevated p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs text-fg-2">
              <span className="font-medium text-fg-1">作品本身的标签</span>：
              {order === 'after_rank'
                ? '先按热度取第几名到第几名，再只留下其中带这些标签的作品。'
                : '先只留下带这些标签的作品，再在里面按热度取第几名到第几名（和游戏的 Galgame 模式一样）。'}
            </p>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="不按作品标签筛"
              onClick={() => {
                setShowFilter(false)
                if (wf) setSource('去掉作品本身的标签', { ...src, work_filter: null })
              }}
            >
              <IconX />
            </Button>
          </div>
          <TagFilterEditor
            value={wf ?? emptyTagFilter(true)}
            onChange={(f) => setSource('改作品本身的标签', { ...src, work_filter: f }, 'work_filter')}
            kind="work_tag"
            mode={mode}
            showTagMode
          />
          {!all && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-fg-3">先筛标签还是先排名（人数会不一样）</span>
              <SegmentedControl
                size="sm"
                value={order}
                onChange={(o) => setSource(o === 'after_rank' ? '改成先排名再筛标签' : '改成先筛标签再排名', { ...src, work_filter_order: o })}
                aria-label="先筛标签还是先排名"
                options={[
                  { value: 'before_rank', label: '先筛标签，再取前几名（和游戏一样）', title: '例：带 Galgame 标签的游戏里，热度前 50 部' },
                  { value: 'after_rank', label: '先取前几名，再筛标签', title: '例：热度前 50 部游戏里，带 Galgame 标签的那几部' },
                ]}
              />
            </div>
          )}
        </div>
      ) : (
        <button type="button" onClick={() => setShowFilter(true)} className="self-start text-xs text-link hover:underline">
          + 只要带某些标签的作品（作品本身的标签，例：Galgame）
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 取角色
type RolesKey = 'main' | 'both' | 'side'
const ROLES_OF: Record<RolesKey, Role[]> = { main: ['主角'], both: ['主角', '配角'], side: ['配角'] }
function rolesKey(roles: Role[]): RolesKey {
  return roles.includes('配角') ? (roles.includes('主角') ? 'both' : 'side') : 'main'
}

export function PickEditor({ range, zone }: { range: RangeV2; zone: 'ranges' | 'excludes' }) {
  const edit = useWb2((s) => s.edit)
  const p = range.pick
  const id = range.id
  const setPick = (label: string, next: PickSpec, coalesce?: string) =>
    edit(label, (s) => ({ ...s, [zone]: s[zone].map((r) => (r.id === id ? { ...r, pick: next } : r)) }), coalesce ? { coalesce: `${id}:${coalesce}` } : undefined)
  const unlimited = p.per_work === null
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
      <SegmentedControl<RolesKey>
        size="sm"
        value={rolesKey(p.roles)}
        onChange={(k) => setPick(k === 'main' ? '改成只要主角' : k === 'both' ? '改成主角和配角' : '改成只要配角', pickWithRoles(p, ROLES_OF[k]))}
        aria-label="取哪些角色"
        options={[
          { value: 'main', label: '只要主角' },
          { value: 'both', label: '主角和配角' },
          { value: 'side', label: '只要配角' },
        ]}
      />
      <Group label="每部">
        {unlimited ? (
          <span className="text-sm font-medium text-fg-1">不限人数</span>
        ) : (
          <>
            <span className="text-sm text-fg-2">最多</span>
            <NumberField
              value={p.per_work}
              onCommit={(v) => v !== null && setPick('改每部人数', { ...p, per_work: v }, 'per_work')}
              integer
              min={1}
              max={999}
              size="sm"
              className="w-14"
              aria-label="每部最多取几人"
              fallback={DEFAULT_PER_WORK}
            />
            <span className="text-sm text-fg-2">人</span>
          </>
        )}
        <Button size="sm" variant={unlimited ? 'soft' : 'secondary'} onClick={() => setPick(unlimited ? '每部限制成最多 6 人' : '每部改成不限', { ...p, per_work: unlimited ? DEFAULT_PER_WORK : null })}>
          {unlimited ? '限制人数' : '不限'}
        </Button>
      </Group>
      {!unlimited && (
        <Group label="取前几名按" hint="每部作品里按什么顺序取前 N 个：角色热度（默认，更适合背热门），或者和游戏一样">
          <SegmentedControl
            size="sm"
            value={p.order}
            onChange={(o) => setPick(o === 'heat' ? '改成按角色热度取' : '改成和游戏一样的顺序取', { ...p, order: o })}
            aria-label="按什么顺序取"
            options={[
              { value: 'heat', label: '角色热度' },
              { value: 'game', label: '和游戏一样', title: '猜猜呗按接口返回的顺序取前 N 个，接口按角色 id 从小到大排（不是 Bangumi 页面顺序）' },
            ]}
          />
        </Group>
      )}
      <p className="w-full text-xs text-fg-3">和游戏一样：只要主角时不限人数；加上配角时每部取 6 个（换选项时会自动改，之后也可以自己改）。</p>
    </div>
  )
}
