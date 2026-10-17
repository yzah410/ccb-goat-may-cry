/**
 * 矢量 emoji（fluent-emoji-flat，离线子集）。
 *
 * - 静态用法（知道名字）：也可以直接 `import IconX from '~icons/fluent-emoji-flat/xxx'`（unplugin-icons，任意图标都行）
 * - 动态用法（按标签名映射）：<Emoji name="television" /> 或 emojiForTag('TV')
 *   动态用法只能用 emoji-names.ts 里登记过的名字（它们被打进了离线子集）。
 */
import { addCollection, Icon } from '@iconify/react/offline'
import subset from 'virtual:emoji-subset'
import { GENRE_EMOJI, PLAYBACK_EMOJI, SOURCE_EMOJI, UI_EMOJI, type UiEmojiKind } from './emoji-names'
import { cn } from './cn'

addCollection(subset)

export type TagEmojiKind = 'playback' | 'source' | 'genre' | 'any'

/** 标签名 → emoji 图标名；没登记返回 undefined */
export function emojiForTag(tag: string, kind: TagEmojiKind = 'any'): string | undefined {
  if (kind === 'playback') return PLAYBACK_EMOJI[tag]
  if (kind === 'source') return SOURCE_EMOJI[tag]
  if (kind === 'genre') return GENRE_EMOJI[tag]
  return PLAYBACK_EMOJI[tag] ?? SOURCE_EMOJI[tag] ?? GENRE_EMOJI[tag]
}

export function emojiForUi(kind: UiEmojiKind): string {
  return UI_EMOJI[kind]
}

export interface EmojiProps {
  /** fluent-emoji-flat 里的图标名，例如 television */
  name: string
  /** 像素或 CSS 长度，默认 1em */
  size?: number | string
  className?: string
  /** 有意义的 emoji 请给 label（读屏会读）；纯装饰不用给 */
  label?: string
}

export function Emoji({ name, size = '1em', className, label }: EmojiProps) {
  return (
    <Icon
      icon={`fluent-emoji-flat:${name}`}
      width={size}
      height={size}
      className={cn('inline-block shrink-0 align-[-0.125em]', className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
    />
  )
}
