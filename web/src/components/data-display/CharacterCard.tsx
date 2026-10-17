import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { copyText } from '@/lib/clipboard'
import { fmtCompact, fmtScore, fmtWeight } from '@/lib/format'
import { groupWorkTags, isPlayback, splitCharTags } from '@/lib/tags'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { toast } from '@/components/ui/Toast'
import { IconChevronUp, IconCopy, IconPin, IconSend, IconStar, IconTarget } from '@/lib/icons'
import { usePrefs } from '@/features/settings/store'
import { useBgmAvatar } from '@/features/candidates/avatar'
import type { DrawResult, ResolvedCharacter } from '@/features/candidates/types'
import { TagChip } from './TagChip'
import { MiniStats } from './StatTile'
import { AppearanceTimeline } from './AppearanceTimeline'
import { GenderBadge, WorkBadge } from './Misc'

export interface CharacterCardProps {
  item: ResolvedCharacter & { weight?: number }
  /** 全局「显示角色标签」开关 */
  showCharTags?: boolean
  /** 主角卡（抽题结果 / 当前题目）：主题的 CardOrnament 会画装饰 */
  featured?: boolean
  /** 它就是当前题目 */
  isCurrent?: boolean
  onSetCurrent?: () => void
  /** 发到猜猜呗（由外层传进来，卡片本身不知道点击器） */
  onSend?: () => void
  sending?: boolean
  /** 「发到猜猜呗」按钮的样式；页面已经有 primary 时用 soft（每页只有一个 primary） */
  sendVariant?: 'primary' | 'soft'
  /** 行模式展开后才有「收起」 */
  onCollapse?: () => void
  /** 列表里的序号 */
  rank?: number
  extraActions?: ReactNode
  className?: string
}

/** 名字 + 性别 + 统计 + 标签 + 登场时间线 —— 候选卡片、抽题结果都用它 */
export function CharacterCard({
  item,
  showCharTags,
  featured,
  isCurrent,
  onSetCurrent,
  onSend,
  sending,
  sendVariant = 'primary',
  onCollapse,
  rank,
  extraActions,
  className,
}: CharacterCardProps) {
  const c = item.character
  const avatarsOn = usePrefs((s) => s.avatars)
  const avatar = useBgmAvatar(c.id, avatarsOn)
  const appearCount = item.appear_count ?? item.work_count ?? item.appearances?.length ?? null
  const bestName = item.appear_best?.name ?? item.appearances?.[0] ?? null

  const stats = [
    { label: '评分', value: fmtScore(c.max_score ?? 0), title: '角色登场作品里的最高评分' },
    { label: '热度', value: fmtCompact(c.heat), title: '热度（heat）' },
    { label: '登场', value: appearCount != null ? `${appearCount} 部` : '—' },
  ]
  if (typeof item.weight === 'number') stats.push({ label: '权重', value: `×${fmtWeight(item.weight)}`, title: '在候选池里的权重（多个纳入组块取最大）' })

  const onCopy = async () => {
    const ok = await copyText(c.name)
    if (ok) toast.success(`已复制「${c.name}」`, { id: 'copy' })
    else toast.error('复制失败', { description: '浏览器不让写剪贴板，手动选中名字复制吧' })
  }

  return (
    <Card
      ornament={featured ? 'featured' : undefined}
      selected={isCurrent}
      className={cn('@container p-5', className)}
      data-char-id={c.id}
    >
      {/* 内容在装饰层（CardOrnament，absolute）上面：relative + z-[1]，和 CurrentPickCard 一致 */}
      <div className="relative z-[1] flex flex-col gap-4">
        {/* 头部：名字 + 操作 */}
        <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            {avatarsOn && (
              <div className="size-14 shrink-0 overflow-hidden rounded-lg bg-surface-2 ring-1 ring-inset ring-border">
                {avatar ? <img src={avatar} alt="" className="size-full object-cover object-top" loading="lazy" /> : null}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {rank != null && <span className="tabular text-xs text-fg-3">#{rank}</span>}
                <h3 className="min-w-0 truncate text-xl text-fg-1" title={c.name}>
                  {c.name}
                </h3>
                <GenderBadge gender={c.gender} />
                {isCurrent && (
                  <Badge tone="accent">
                    <IconStar />
                    当前题目
                  </Badge>
                )}
              </div>
              <MiniStats className="mt-3" items={stats} />
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 @xl:flex-col @xl:items-end">
            {onSend && (
              <Button variant={sendVariant} size="sm" icon={<IconSend />} loading={sending} onClick={onSend}>
                发到猜猜呗
              </Button>
            )}
            {onSetCurrent && !isCurrent && (
              <Button variant="secondary" size="sm" icon={<IconTarget />} onClick={onSetCurrent}>
                设为当前
              </Button>
            )}
            <Button variant="ghost" size="sm" icon={<IconCopy />} onClick={onCopy}>
              复制名字
            </Button>
            {extraActions}
          </div>
        </div>

        <CharacterTags item={item} showCharTags={showCharTags} />

        <AppearanceTimeline
          earliest={c.earliest_year}
          latest={c.latest_year}
          bestName={bestName}
          bestYear={item.appear_best?.year ?? null}
          count={appearCount}
          appearances={item.appearances}
        />

        {item.mode === 'work-weight' && item.bound_work && (
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-primary-50 px-3 py-2 text-sm text-primary-900">
            <IconPin className="size-4 text-primary" aria-hidden />
            <span>这次按作品权重抽的作品：</span>
            <WorkBadge name={item.bound_work.name} year={item.bound_work.year} />
          </div>
        )}

        {onCollapse && (
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" icon={<IconChevronUp />} onClick={onCollapse}>
              收起
            </Button>
          </div>
        )}
      </div>
    </Card>
  )
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px self-center bg-border" />
}

/** 标签：形式 + 来源 ｜ 主要题材 ｜ 次要题材 ｜ 制作公司 ｜ +更多；角色标签单独一块（跟着全局开关） */
export function CharacterTags({ item, showCharTags, compact }: { item: DrawResult; showCharTags?: boolean; compact?: boolean }) {
  const [more, setMore] = useState(false)
  const playback = (item.playback_tags ?? []).filter(isPlayback)
  const g = groupWorkTags(item.work_tags)
  const ct = splitCharTags(item.char_tags)
  const size = compact ? 'sm' : 'md'
  const hasGenres = g.genrePrimary.length + g.genreSecondary.length > 0

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {item.source_tag && <TagChip kind="source" label={item.source_tag} size={size} emphasis="strong" />}
        {playback.map((t) => (
          <TagChip key={t} kind="playback" label={t} size={size} />
        ))}
        {(item.source_tag || playback.length > 0) && hasGenres && <Divider />}
        {g.genrePrimary.map((t) => (
          <TagChip key={t} kind="genre" label={t} size={size} emphasis="strong" />
        ))}
        {g.genreSecondary.map((t) => (
          <TagChip key={t} kind="genre" label={t} size={size} />
        ))}
        {g.studios.length > 0 && <Divider />}
        {g.studios.map((t) => (
          <TagChip key={t} kind="studio" label={t} size={size} />
        ))}
        {more &&
          g.other.map((t) => (
            <TagChip key={t} kind="work" label={t} size={size} />
          ))}
        {g.other.length > 0 && (
          <button
            type="button"
            onClick={() => setMore((v) => !v)}
            className="h-6 rounded-full px-2 text-xs text-fg-3 ring-1 ring-inset ring-border transition-colors hover:bg-surface-2 hover:text-fg-1"
            aria-expanded={more}
          >
            {more ? '收起标签' : `+${g.other.length} 个标签`}
          </button>
        )}
      </div>
      {showCharTags && (item.char_tags?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md bg-surface-2 p-2">
          {ct.highlight.map((t) => (
            <TagChip key={t} kind="char" label={t} size="sm" emphasis="strong" />
          ))}
          {ct.rest.map((t) => (
            <TagChip key={t} kind="char" label={t} size="sm" />
          ))}
        </div>
      )}
    </div>
  )
}
