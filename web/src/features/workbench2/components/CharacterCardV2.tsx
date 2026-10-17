/**
 * 工作台的角色卡片，数据来自出题器接口。
 *
 * 名字 + 性别 + 操作；评分 / 热度 / 登场（+ 所在范围）；作品标签分三栏「第一栏 | 第二栏 | +N 个标签」（按 lib/tagRules.json，
 * 每个模式各一套）；最早–最晚登场时间线；「代表作 +N 部」鼠标移上去看其余作品。不画游戏格子、不把全部作品列出来。
 * 每个数对应接口哪个字段：features/workbench2/card.ts 顶上的表。
 *
 * 用在：候选池页（完整版）、工作台右栏「抽到的人」（compact：窄栏里用、标签小一号）、单人猜猜呗的结算卡片。
 * 头像跟着「设置 → 显示角色头像」开关，关着（默认）就不画头像、也不请求。
 */
import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { copyText } from '@/lib/clipboard'
import { fmtCompact, fmtInt, fmtScore } from '@/lib/format'
import { columnizeWorkTags, splitCharTags, useTagRulesVersion, type TagGroupHit } from '@/lib/tags'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Tooltip } from '@/components/ui/Overlay'
import { toast } from '@/components/ui/Toast'
import { TagChip } from '@/components/data-display/TagChip'
import { MiniStats } from '@/components/data-display/StatTile'
import { GenderBadge, WorkBadge } from '@/components/data-display/Misc'
import { AppearanceTimeline } from '@/components/data-display/AppearanceTimeline'
import { IconChevronUp, IconCopy, IconSend, IconStar, IconTarget, IconUser } from '@/lib/icons'
import { usePrefs } from '@/features/settings/store'
import { useBgmAvatar } from '@/features/candidates/avatar'
import type { CandidateV2 } from '@/features/v2/types'
import { cardNumbers, chipForStyle, representativeWork, tagRuleInput } from '../card'

// ---------------------------------------------------------------- 头像
/** 跟着「设置 → 显示角色头像」开关；关着就不画（名字那一栏占满宽度），也不请求 */
function CardAvatar({ id, compact }: { id: number; compact?: boolean }) {
  const show = usePrefs((s) => s.avatars)
  const url = useBgmAvatar(id, show)
  if (!show) return null
  return (
    <div
      className={cn('shrink-0 overflow-hidden rounded-lg bg-surface-2 ring-1 ring-inset ring-border', compact ? 'size-16' : 'size-14')}
      aria-hidden
    >
      {url ? (
        <img src={url} alt="" className="size-full object-cover object-top" loading="lazy" />
      ) : (
        <div className={cn('grid size-full place-items-center text-fg-3', url === undefined && 'skeleton')}>{url === '' && <IconUser className="size-1/2" />}</div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 作品标签三栏
function Divider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px self-center bg-border" />
}

/**
 * 一段标签（第一栏 / 第二栏的题材 / 第二栏的公司）。前面要竖线时，竖线和这一段的第一个标签粘在一起（inline-flex）：
 * 换行时竖线跟着它的标签走，不会出现「一行末尾孤零零一道竖线」。
 */
function ChipBlock({ hits, size, divider }: { hits: TagGroupHit[]; size: 'sm' | 'md'; divider?: boolean }) {
  const chips = hits.flatMap((h) =>
    h.tags.map((t) => {
      const c = chipForStyle(h.group.style)
      return <TagChip key={`${h.group.key}:${t}`} kind={c.kind} label={t} size={size} emphasis={c.emphasis} title={`${h.group.label}：${t}`} />
    }),
  )
  if (!chips.length) return null
  const [first, ...rest] = chips
  return (
    <>
      {divider ? (
        <span className="inline-flex max-w-full items-center gap-1.5">
          <Divider />
          {first}
        </span>
      ) : (
        first
      )}
      {rest}
    </>
  )
}

/**
 * 作品标签：第一栏（作品属性）｜ 第二栏的题材 / 类别 ｜ 第二栏的公司 ｜「+N 个标签」（悬停看是哪些，点一下展开，展开后能收起）。
 * 第二栏里公司类的组（style = studio）统一放在最后、前面加一道竖线（「题材 | 公司」）；其余组的先后照规则。
 * 角色标签单独一块，跟着「显示角色标签」开关。
 */
export function WorkTagColumnsView({
  tags,
  mode,
  fallback,
  hasAnime,
  charTags,
  showCharTags,
  compact,
}: {
  tags: readonly string[] | null | undefined
  mode: string | null | undefined
  /** 退回规则算出来的（grid.fallback）：用混合规则 */
  fallback?: boolean
  /** 角色有动画登场（has_anime）：混合规则里第一栏只留动画的来源 + 播放形式 */
  hasAnime?: boolean
  charTags?: readonly string[] | null
  showCharTags?: boolean
  compact?: boolean
}) {
  const [more, setMore] = useState(false)
  const size = compact ? 'sm' : 'md'
  useTagRulesVersion() // 分档改了（设置页 / 开局问卷）→ 重画
  const c = columnizeWorkTags(tags, mode, { fallback, hasAnime })
  const genres = c.col2.filter((h) => h.group.style !== 'studio')
  const studios = c.col2.filter((h) => h.group.style === 'studio')
  const ct = splitCharTags(charTags)
  const empty = c.col1.length + c.col2.length + c.other.length === 0

  return (
    <div className="flex flex-col gap-2" data-slot="work-tag-columns">
      <div className="flex flex-wrap items-center gap-1.5">
        {empty && <span className="text-sm text-fg-3">没有作品标签</span>}
        <ChipBlock hits={c.col1} size={size} />
        <ChipBlock hits={genres} size={size} divider={c.col1.length > 0} />
        <ChipBlock hits={studios} size={size} divider={c.col1.length > 0 || genres.length > 0} />
        {more && c.other.map((t) => <TagChip key={`other:${t}`} kind="work" label={t} size={size} />)}
        {c.other.length > 0 &&
          (more ? (
            <button
              type="button"
              onClick={() => setMore(false)}
              className="h-6 rounded-full px-2 text-xs text-fg-3 ring-1 ring-inset ring-border transition-colors hover:bg-surface-2 hover:text-fg-1"
              aria-expanded
            >
              收起标签
            </button>
          ) : (
            <Tooltip
              content={
                <span className="block">
                  <span className="block opacity-75">其余 {c.other.length} 个标签（点一下展开）</span>
                  <span className="mt-0.5 block">{c.other.join(' · ')}</span>
                </span>
              }
            >
              <button
                type="button"
                onClick={() => setMore(true)}
                className="h-6 rounded-full px-2 text-xs text-fg-3 ring-1 ring-inset ring-border transition-colors hover:bg-surface-2 hover:text-fg-1"
                aria-expanded={false}
                aria-label={`还有 ${c.other.length} 个标签：${c.other.join('、')}`}
              >
                +{c.other.length} 个标签
              </button>
            </Tooltip>
          ))}
      </div>
      {showCharTags && (charTags?.length ?? 0) > 0 && (
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

// ---------------------------------------------------------------- 代表作
/**
 * 「代表作 xxx +N 部」：鼠标移上去（或键盘聚焦）列出其余作品。
 * 时间线直接用 AppearanceTimeline（不给它代表作），这一行自己画：接口的 appearances 最多 10 个名字、总数是登场数，
 * AppearanceTimeline 的悬停列表是按「名字列表的长度」算的，对不上。
 */
function RepresentativeLine({ item }: { item: CandidateV2 }) {
  const w = representativeWork(item)
  if (!w.name) return null
  const badge = <WorkBadge name={w.name} year={w.year} extra={w.more > 0 ? `+${w.more} 部` : undefined} title={w.more > 0 ? undefined : w.name} />
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-xs text-fg-3">代表作</span>
      {w.more > 0 ? (
        <Tooltip
          content={
            <span className="block">
              <span className="block opacity-75">其余 {w.more} 部登场作品</span>
              {w.others.map((n, i) => (
                <span key={`${n}-${i}`} className="block truncate">
                  {n}
                </span>
              ))}
              {w.unnamed > 0 && <span className="block opacity-75">…还有 {fmtInt(w.unnamed)} 部</span>}
            </span>
          }
        >
          <span className="min-w-0" tabIndex={0}>
            {badge}
          </span>
        </Tooltip>
      ) : (
        badge
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 卡片
export interface CharacterCardV2Props {
  item: CandidateV2
  /** 窄栏版（工作台右栏「抽到的人」）：头像大一点、标签小一号、内边距小一点 */
  compact?: boolean
  /** 主角卡（抽到的人）：主题的 CardOrnament 会画装饰 */
  featured?: boolean
  isCurrent?: boolean
  onSetCurrent?: () => void
  /** 「设为当前」按钮上的字（候选池写「设为当前」，抽到的人写「设为当前题目」） */
  setCurrentLabel?: string
  /** 它是当前题目时显示「发到猜猜呗」（外面传进来，卡片本身不知道点击器） */
  onSend?: () => void
  sending?: boolean
  showCharTags?: boolean
  /** 列表视图展开后才有「收起」 */
  onCollapse?: () => void
  rank?: number
  /** 所在范围（范围名）：启用了 2 个以上范围时才传 */
  rangeNames?: string[] | null
  /** 放在名字下面的一行小字（抽到的人：从几人里抽的、什么时候） */
  meta?: ReactNode
  /** 卡片最上面的提示（抽到的人：方案改过了） */
  notice?: ReactNode
  /** 放在代表作下面（抽到的人、按「先抽作品」抽的：这次先抽到的作品） */
  footer?: ReactNode
  extraActions?: ReactNode
  className?: string
}

export function CharacterCardV2({
  item,
  compact,
  featured,
  isCurrent,
  onSetCurrent,
  setCurrentLabel = '设为当前',
  onSend,
  sending,
  showCharTags,
  onCollapse,
  rank,
  rangeNames,
  meta,
  notice,
  footer,
  extraActions,
  className,
}: CharacterCardV2Props) {
  const c = item.character
  const g = item.grid
  const n = cardNumbers(item)
  const rule = tagRuleInput(item)

  const stats: { label: string; value: ReactNode; title?: string }[] = [
    { label: '评分', value: n.rating != null ? fmtScore(n.rating) : '—', title: '登场作品里的最高评分（游戏格子里的「最高分」）' },
    { label: '热度', value: fmtCompact(n.heat), title: '角色热度：Bangumi 上收藏这个角色的人数' },
    { label: '登场', value: `${fmtInt(n.nApp)} 部`, title: '这个模式下游戏算的登场作品数（游戏格子里的「作品数」）' },
  ]
  if (rangeNames?.length) {
    const text = rangeNames.join('、')
    stats.push({
      label: '所在范围',
      value: (
        <span className="block max-w-40 truncate" title={text}>
          {text}
        </span>
      ),
      title: '这个角色落在工作台的哪个纳入范围里',
    })
  }

  const onCopy = async () => {
    const ok = await copyText(c.name)
    if (ok) toast.success(`已复制「${c.name}」`, { id: 'copy' })
    else toast.error('复制失败', { description: '浏览器不让写剪贴板，手动选中名字复制吧' })
  }

  return (
    <Card
      ornament={featured ? 'featured' : undefined}
      selected={isCurrent}
      className={cn('@container', compact ? 'p-4' : 'p-5', className)}
      data-char-id={c.id}
      data-slot="character-card"
    >
      {/* 内容在装饰层（CardOrnament，absolute）上面：relative + z-[1] */}
      <div className={cn('relative z-[1] flex flex-col', compact ? 'gap-3' : 'gap-4')}>
        {notice}
        {/* 头部：名字 + 操作（卡片够宽时操作在右边一列，窄的时候换到下面一行） */}
        <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <CardAvatar id={c.id} compact={compact} />
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
              {meta}
              <MiniStats className={compact ? 'mt-2' : 'mt-3'} items={stats} />
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 @xl:flex-col @xl:items-end">
            {onSend && isCurrent && (
              <Button variant="soft" size="sm" icon={<IconSend />} loading={sending} onClick={onSend}>
                发到猜猜呗
              </Button>
            )}
            {onSetCurrent && !isCurrent && (
              <Button variant={compact ? 'soft' : 'secondary'} size="sm" icon={<IconTarget />} onClick={onSetCurrent}>
                {setCurrentLabel}
              </Button>
            )}
            <Button variant="ghost" size="sm" icon={<IconCopy />} onClick={onCopy}>
              复制名字
            </Button>
            {extraActions}
          </div>
        </div>

        <WorkTagColumnsView
          tags={g?.tags ?? item.work_tags}
          mode={rule.mode}
          fallback={rule.fallback}
          hasAnime={rule.hasAnime}
          charTags={item.char_tags}
          showCharTags={showCharTags}
          compact={compact}
        />
        {rule.fallback && (
          <p className="-mt-1 text-xs text-fg-3">
            这个模式下 ta 没有主角 / 配角登场，游戏按 ta 所有类型的作品来算（退回规则），标签也按几个模式合起来的规则分栏。
          </p>
        )}

        <div className="flex flex-col gap-2">
          {n.nApp === 0 ? (
            <p className="rounded-sm bg-warning-bg px-2 py-1 text-xs text-warning-fg">这个模式下没有算得上的登场作品：游戏格子里作品数是 0、年份和评分都是问号。</p>
          ) : (
            <AppearanceTimeline earliest={n.earliest} latest={n.latest} />
          )}
          <RepresentativeLine item={item} />
        </div>

        {footer}

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
