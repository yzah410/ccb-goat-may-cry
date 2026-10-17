/**
 * 纳入区（范围之间是「或」）和排除区（永远最后生效，和放在哪里无关）。
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/Overlay'
import { EmptyState } from '@/components/data-display/Misc'
import { toast } from '@/components/ui/Toast'
import { IconChevronDown, IconFilm, IconListChecks, IconMinus, IconPlus, IconUsers } from '@/lib/icons'
import type { Condition, EvaluateResp, RangeV2, Source } from '@/features/v2/types'
import { defaultRankSource, newId, newRange, takenIds, typesOfMode } from '../spec'
import { condMeta } from '../summary'
import { useWb2 } from '../store'
import { AddConditionMenu } from './ConditionChips'
import { RangeCard } from './RangeCard'

function ZoneHead({ tone, title, children, extra }: { tone: 'include' | 'exclude'; title: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-lg text-fg-1">
          <span
            aria-hidden
            className={cn(
              'grid size-6 place-items-center rounded-full text-on-primary [&_svg]:size-3.5',
              tone === 'include' ? 'bg-include' : 'bg-exclude',
            )}
          >
            {tone === 'include' ? <IconPlus /> : <IconMinus />}
          </span>
          {title}
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-fg-2">{children}</p>
      </div>
      {extra}
    </div>
  )
}

export function RangesZone({ ev, stale }: { ev: EvaluateResp | undefined; stale: boolean }) {
  const ranges = useWb2((s) => s.spec.ranges)
  const game = useWb2((s) => s.spec.game)
  const edit = useWb2((s) => s.edit)
  const add = () =>
    edit('再加一个范围', (s) => {
      const r = newRange(newId('r', takenIds(s)), defaultRankSource(new Date().getFullYear(), typesOfMode(s.game.mode)))
      return { ...s, ranges: [...s.ranges, r] }
    })
  return (
    <section aria-label="纳入范围" className="flex flex-col gap-3">
      <ZoneHead tone="include" title="纳入范围">
        角色只要落在<strong className="font-medium text-fg-1">任意一个</strong>范围里就进题库；一个范围里的条件要<strong className="font-medium text-fg-1">同时</strong>满足。
      </ZoneHead>
      {ranges.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong bg-surface-1">
          <EmptyState
            kind="no-candidates"
            size="sm"
            title="还没有纳入范围，题库是空的"
            description="加一个范围：默认是近 10 年热度前 50 部作品的主角"
            action={
              <Button variant="secondary" icon={<IconPlus />} onClick={add}>
                加一个范围
              </Button>
            }
          />
        </div>
      ) : (
        ranges.map((r, i) => (
          <RangeCard
            key={r.id}
            range={r}
            zone="ranges"
            index={i}
            evalRange={ev?.ranges.find((x) => x.id === r.id)}
            stale={stale}
            mode={game.mode}
            tagCount={game.tag_count}
            poolTotal={ev?.total}
          />
        ))
      )}
      {ranges.length > 0 && (
        <Button variant="secondary" icon={<IconPlus />} className="self-start" onClick={add}>
          再加一个范围
        </Button>
      )}
    </section>
  )
}

/** 排除项默认：按作品取的时候主角配角都算、不限人数（「排除这些作品里的角色」一般是要全排掉） */
function newExclude(id: string, source: Source, conditions: Condition[] = []): RangeV2 {
  return { ...newRange(id, source), pick: { roles: ['主角', '配角'], per_work: null, order: 'heat' }, conditions }
}

export function ExcludesZone({ ev, stale }: { ev: EvaluateResp | undefined; stale: boolean }) {
  const excludes = useWb2((s) => s.spec.excludes)
  const game = useWb2((s) => s.spec.game)
  const edit = useWb2((s) => s.edit)
  const addWith = (label: string, make: (id: string, s: { game: { mode: string } }) => RangeV2) =>
    edit(label, (s) => ({ ...s, excludes: [...s.excludes, make(newId('r', takenIds(s)), s)] }))

  const menu = (
    <div className="flex flex-wrap items-center gap-2">
      <AddConditionMenu
        zone="excludes"
        label="排除满足条件的角色"
        confirmLabel="排除这些人"
        mode={game.mode}
        tagCount={game.tag_count}
        onAdd={(c) => addWith(`排除：${condMeta(c.type).short}`, (id) => newExclude(id, { kind: 'all_characters' }, [c]))}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="secondary" icon={<IconPlus />}>
            排除一个清单 / 一批作品
            <IconChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuItem icon={<IconListChecks />} onSelect={() => addWith('排除一个角色清单', (id) => newExclude(id, { kind: 'char_list', list_id: '' }))}>
            排除一个角色清单（例：已经记住的角色）
          </DropdownMenuItem>
          <DropdownMenuItem icon={<IconFilm />} onSelect={() => addWith('排除一个作品清单里的角色', (id) => newExclude(id, { kind: 'work_list', list_id: '' }))}>
            排除一个作品清单里的角色
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={<IconUsers />}
            onSelect={() => {
              // 默认的年份 / 名次和默认范围一样，一启用题库就空了：先停用着，改好再打开
              addWith('排除某些作品里的角色', (id) => ({ ...newExclude(id, defaultRankSource(new Date().getFullYear(), typesOfMode(game.mode))), enabled: false }))
              toast.info('加了一个排除项，先停用着', { description: '改好要排除哪些年份、第几名的作品，再打开它右上角的开关' })
            }}
          >
            排除某些作品里的角色（按年份、热度选作品）
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )

  return (
    <section aria-label="排除" className="flex flex-col gap-3">
      <ZoneHead tone="exclude" title="排除" extra={excludes.length > 0 ? menu : undefined}>
        排除<strong className="font-medium text-fg-1">永远最后生效</strong>，和它放在哪里、排第几无关：题库 =（所有纳入范围合起来）−（所有排除项合起来）。
      </ZoneHead>
      {excludes.map((r, i) => (
        <RangeCard
          key={r.id}
          range={r}
          zone="excludes"
          index={i}
          evalExclude={ev?.excludes.find((x) => x.id === r.id)}
          stale={stale}
          mode={game.mode}
          tagCount={game.tag_count}
          poolTotal={ev?.total}
        />
      ))}
      {excludes.length === 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border-strong px-4 py-4">
          <p className="text-sm text-fg-3">还没有排除项。常见用法：排除一个角色清单（例如已经记住的角色）、排除某个性别、排除某几部作品。</p>
          {menu}
        </div>
      )}
    </section>
  )
}
