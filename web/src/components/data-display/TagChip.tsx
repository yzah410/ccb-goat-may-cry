import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Emoji, emojiForTag } from '@/lib/emoji'
import { IconBuilding, IconMinus, IconPlus, IconTag, IconUser, IconX } from '@/lib/icons'

/**
 * 标签芯片：按业务语义 token 着色 + 每类一个图标/矢量 emoji。
 * - playback / source / genre：优先用 emoji 映射表（lib/emoji-names.ts）
 * - studio / char / va / work / other：用 lucide 图标
 * - tone=include/exclude：标签组编辑器里用（＋ 纳入 / － 排除，颜色 + 图标 + 读屏文字三重表达）
 */
export type TagChipKind = 'playback' | 'source' | 'genre' | 'studio' | 'char' | 'va' | 'work' | 'other'

const KIND_VAR: Record<TagChipKind, string | null> = {
  playback: 'var(--tag-playback)',
  source: 'var(--tag-source)',
  genre: 'var(--tag-genre)',
  char: 'var(--tag-char)',
  va: 'var(--tag-va)',
  studio: null,
  work: null,
  other: null,
}

export interface TagChipProps {
  label: string
  kind: TagChipKind
  /** strong = 高亮（主要题材 / 高亮角色标签）；soft = 普通 */
  emphasis?: 'strong' | 'soft'
  /** 纳入 / 排除（标签组编辑器） */
  tone?: 'include' | 'exclude'
  /** 覆盖自动 emoji；传 null 表示不要 emoji */
  emoji?: string | null
  onRemove?: () => void
  size?: 'sm' | 'md'
  title?: string
  className?: string
  suffix?: ReactNode
}

function kindIcon(kind: TagChipKind) {
  if (kind === 'studio') return <IconBuilding aria-hidden />
  if (kind === 'char') return <IconUser aria-hidden />
  if (kind === 'va') return <Emoji name="microphone" />
  return <IconTag aria-hidden />
}

export function TagChip({ label, kind, emphasis = 'soft', tone, emoji, onRemove, size = 'md', title, className, suffix }: TagChipProps) {
  const color = tone === 'include' ? 'var(--include)' : tone === 'exclude' ? 'var(--exclude)' : KIND_VAR[kind]
  const emojiName =
    emoji === null ? undefined : (emoji ?? (kind === 'playback' || kind === 'source' || kind === 'genre' ? emojiForTag(label, kind) : undefined))
  const style: CSSProperties | undefined = color
    ? ({
        '--chip': color,
        backgroundColor: `color-mix(in oklab, var(--chip) ${emphasis === 'strong' ? 20 : 11}%, transparent)`,
        color: `color-mix(in oklab, var(--chip) ${emphasis === 'strong' ? 82 : 72}%, var(--text-1))`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, var(--chip) ${emphasis === 'strong' ? 34 : 22}%, transparent)`,
      } as CSSProperties)
    : undefined

  return (
    <span
      data-slot="tag-chip"
      data-kind={kind}
      data-tone={tone}
      title={title}
      style={style}
      className={cn(
        'inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-full leading-none',
        '[&_svg]:size-3.5 [&_svg]:shrink-0',
        size === 'sm' ? 'h-5 px-2 text-xs' : 'h-6 px-2.5 text-sm',
        emphasis === 'strong' && 'font-medium',
        !color && 'bg-surface-2 text-fg-2 ring-1 ring-inset ring-border',
        className,
      )}
    >
      {tone === 'include' && <IconPlus aria-hidden />}
      {tone === 'exclude' && <IconMinus aria-hidden />}
      {tone && <span className="sr-only">{tone === 'include' ? '纳入' : '排除'}</span>}
      {emojiName ? <Emoji name={emojiName} size={size === 'sm' ? 12 : 14} /> : !tone && kind !== 'genre' && kind !== 'playback' && kind !== 'source' ? kindIcon(kind) : null}
      <span className="truncate">{label}</span>
      {suffix}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`移除 ${label}`}
          className="-mr-1 ml-0.5 grid size-4 place-items-center rounded-full opacity-70 transition-opacity hover:bg-[color-mix(in_oklab,currentColor_15%,transparent)] hover:opacity-100"
        >
          <IconX className="size-3" />
        </button>
      )}
    </span>
  )
}
