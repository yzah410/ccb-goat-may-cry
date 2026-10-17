/**
 * 「当前题目」：点了「设为当前」之后，在每种布局的固定位置都显示选的是谁：顶栏/侧栏布局是右上角小卡，分栏布局在右侧上下文面板，自动点击页顶部也有。
 */
import { Link } from 'react-router'
import { cn } from '@/lib/cn'
import { copyText } from '@/lib/clipboard'
import { fmtScore, fmtYearSpan, relativeTime } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from '@/components/ui/Overlay'
import { toast } from '@/components/ui/Toast'
import { Card } from '@/components/ui/Card'
import { CharacterTags } from '@/components/data-display/CharacterCard'
import { EmptyState, GenderBadge } from '@/components/data-display/Misc'
import { IconArrowRight, IconCopy, IconLoader, IconScanSearch, IconSend, IconStar, IconX } from '@/lib/icons'
import { usePick } from '@/features/candidates/store'
import { useClickerTask } from '@/features/clicker/store'
import { useDryRun, useSendToGuessr } from '@/features/clicker/hooks'
import type { CandidateV2 } from '@/features/v2/types'
import { tagRuleInput } from '@/features/workbench2/card'
import { WorkTagColumnsView } from '@/features/workbench2/components/CharacterCardV2'
import { useShellNav } from './nav'

/** 当前题目的内容区（小卡弹层、分栏右侧面板、自动点击页都用） */
export function CurrentPickBody({ showDryRun = true, className }: { showDryRun?: boolean; className?: string }) {
  const pick = usePick((s) => s.pick)
  const clear = usePick((s) => s.clear)
  const { send, isPending } = useSendToGuessr()
  const dry = useDryRun()
  const nav = useShellNav()

  if (!pick)
    return (
      <EmptyState
        kind="no-pick"
        size="sm"
        title="还没有当前题目"
        description="在工作台点「抽一题」，或者在「候选池」里点「设为当前」"
        action={
          <>
            <Button size="sm" variant="secondary" onClick={() => nav.go('workbench')}>
              去工作台抽一题
            </Button>
            <Button size="sm" variant="ghost" onClick={() => nav.go('pool')}>
              去候选池挑
            </Button>
          </>
        }
      />
    )

  const c = pick.item.character
  const r = dry.data
  // 题目带 grid 时作品标签按那一局的模式分栏（和候选池卡片一样），不带就不分栏
  const v2 = (pick.item as { grid?: unknown }).grid ? (pick.item as unknown as CandidateV2) : null
  const rule = v2 ? tagRuleInput(v2) : null
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <IconStar className="size-4 shrink-0 text-accent" aria-hidden />
            <span className="truncate text-lg font-semibold text-fg-1" title={c.name}>
              {c.name}
            </span>
            <GenderBadge gender={c.gender} />
          </div>
          <p className="mt-1 text-xs text-fg-3">
            评分 {fmtScore(c.max_score ?? 0)} · {fmtYearSpan(c.earliest_year, c.latest_year)} 年登场 ·{' '}
            {pick.source === 'draw' ? '随机抽到的' : '候选里挑的'} · {relativeTime(pick.at)}
          </p>
        </div>
        <Tooltip content="清除当前题目">
          <button
            type="button"
            onClick={clear}
            aria-label="清除当前题目"
            className="grid size-7 shrink-0 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg-1"
          >
            <IconX className="size-4" />
          </button>
        </Tooltip>
      </div>

      {v2 && rule ? (
        <WorkTagColumnsView tags={v2.grid?.tags ?? v2.work_tags} mode={rule.mode} fallback={rule.fallback} hasAnime={rule.hasAnime} compact />
      ) : (
        <CharacterTags item={pick.item} compact />
      )}

      <div className="flex flex-col gap-2 rounded-md bg-surface-2 p-3">
        {/* 只有在「自动点击」页它是这一页的主操作；其他地方（弹层、分栏侧面板）降级，免得和页面自己的主按钮抢 */}
        <Button variant={nav.current === 'clicker' ? 'primary' : 'soft'} icon={<IconSend />} loading={isPending} onClick={() => send(pick.item)}>
          发到猜猜呗
        </Button>
        <div className="flex flex-wrap gap-2">
          {showDryRun && (
            <Tooltip content="只找到它在搜索结果里的位置，不点">
              <Button
                size="sm"
                variant="ghost"
                icon={<IconScanSearch />}
                loading={dry.isPending}
                onClick={() => dry.mutate({ item: pick.item, mode: 'host' })}
              >
                只定位不点击
              </Button>
            </Tooltip>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<IconCopy />}
            onClick={async () => {
              if (await copyText(c.name)) toast.success(`已复制「${c.name}」`, { id: 'copy' })
            }}
          >
            复制名字
          </Button>
        </div>
        {r && (
          <p className={cn('rounded-sm px-2 py-1 text-xs', r.ok ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg')}>
            {r.ok ? (r.summary ?? `能找到：第 ${r.nth ?? '?'} 项`) : (r.error ?? '没找到')}
          </p>
        )}
      </div>

      {!nav.embedded && nav.current !== 'clicker' && (
        <Link to="/clicker" className="inline-flex items-center gap-1 self-start text-sm text-link hover:underline">
          去「自动点击」看日志 <IconArrowRight className="size-3.5" />
        </Link>
      )}
    </div>
  )
}

/** 顶部右上角的小卡：点开是弹层 */
export function CurrentPickChip({ className }: { className?: string }) {
  const pick = usePick((s) => s.pick)
  const pending = useClickerTask((s) => !!s.pending)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="current-pick-chip"
          className={cn(
            'flex h-9 min-w-0 max-w-64 items-center gap-2 rounded-md border px-3 text-sm shadow-1 transition-colors',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
            pick
              ? 'border-[color-mix(in_oklab,var(--accent)_45%,var(--border))] bg-surface-1 text-fg-1 hover:bg-surface-2'
              : 'border-dashed border-border-strong bg-surface-1 text-fg-3 hover:text-fg-2',
            className,
          )}
          aria-label={pick ? `当前题目：${pick.item.character.name}` : '当前题目：还没有'}
        >
          {pending ? (
            <IconLoader className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
          ) : (
            <IconStar className={cn('size-4 shrink-0', pick ? 'text-accent' : 'text-fg-3')} aria-hidden />
          )}
          <span className="shrink-0 text-xs text-fg-3">当前题目</span>
          <span className="min-w-0 truncate font-medium">{pick ? pick.item.character.name : '无'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem]">
        <CurrentPickBody />
      </PopoverContent>
    </Popover>
  )
}

/** 卡片版（分栏布局右侧、自动点击页） */
export function CurrentPickCard({ className }: { className?: string }) {
  const pick = usePick((s) => s.pick)
  return (
    <Card ornament={pick ? 'featured' : undefined} className={cn('p-4', className)}>
      {/* 内容包一层 relative + z-[1]：主题的 CardOrnament 是 absolute 定位的装饰层，
          没定位的内容按 CSS 绘制顺序会被它盖住（候选池的角色卡片也是这样写的） */}
      <div className="relative z-[1]">
        <p className="mb-3 text-xs font-medium tracking-wide text-fg-3">当前题目</p>
        <CurrentPickBody />
      </div>
    </Card>
  )
}
