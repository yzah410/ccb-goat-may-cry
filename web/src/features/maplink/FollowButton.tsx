/**
 * 标签栏右边的「跟随」按钮（链条）：这一格跟随单人猜猜呗——答完一题，这一格切到答案所在的图并高亮作品卡。
 * - 没在跟随 / 就是这一格在跟随：点开设置面板
 * - 别的格子在跟随：点了 = 跟随移到这一格（图组、设置都不变），不开面板
 * 样子：带边框的按钮「联动」；跟随中 = 实心主色「联动中」；别的格子在跟随 = 虚线边框「移到这格」。
 * 格子窄（标签栏不到 20rem）时文字收起，只留图标，边框还在。
 * 单人猜猜呗说了再见时，按钮左边一行小字「单人猜猜呗已断开」。
 */
import { IconLink } from '@/lib/icons'
import { cn } from '@/lib/cn'
import type { LinkStatus } from './followStore'

export interface FollowButtonProps {
  /** 这一格在跟随 */
  following: boolean
  /** 别的格子在跟随 */
  elsewhere: boolean
  link: LinkStatus
  /** 面板开着（按钮保持按下的样子） */
  open: boolean
  disabled?: boolean
  onClick: (anchor: DOMRect) => void
}

export function FollowButton({ following, elsewhere, link, open, disabled, onClick }: FollowButtonProps) {
  const tip = disabled
    ? '这个浏览器不支持标签页之间通信，用不了做题联动'
    : following
      ? '跟随单人猜猜呗中：答完一题，这一格切到答案所在的图。点开设置'
      : elsewhere
        ? '把跟随移到这一格（图组和设置不变）'
        : '跟随单人猜猜呗：答完一题，这一格切到答案所在的图'
  return (
    <>
      {following && link === 'bye' && (
        <span className="mr-1 shrink-0 whitespace-nowrap text-xs text-fg-3" data-follow-bye="">
          单人猜猜呗已断开
        </span>
      )}
      <button
        type="button"
        aria-label={following ? '跟随单人猜猜呗（跟随中）' : elsewhere ? '把跟随移到这一格' : '跟随单人猜猜呗'}
        aria-pressed={following}
        aria-haspopup={elsewhere ? undefined : 'dialog'}
        aria-expanded={elsewhere ? undefined : open}
        title={tip}
        disabled={disabled}
        onClick={(e) => onClick(e.currentTarget.getBoundingClientRect())}
        className={cn(
          // 圆角胶囊：和下面引擎顶栏的按钮（封面 / 配色 / 全屏）一个样式
          'inline-flex h-7 shrink-0 select-none items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium leading-none',
          'transition-[background-color,color,border-color] active:translate-y-px',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40',
          following
            ? cn('border border-transparent bg-primary text-on-primary shadow-1 hover:bg-primary-hover', open && 'bg-primary-hover')
            : cn(
                'border bg-surface-1 text-fg-1 shadow-1 hover:border-primary/60 hover:bg-surface-2',
                elsewhere ? 'border-dashed border-border-strong' : 'border-border-strong',
                open && 'border-primary/60 bg-surface-2',
              ),
        )}
        data-follow-btn={following ? 'on' : 'off'}
      >
        <IconLink className={cn('size-4 shrink-0', !following && 'text-primary')} aria-hidden />
        <span className="hidden @[20rem]:inline">{following ? '联动中' : elsewhere ? '移到这格' : '联动'}</span>
      </button>
    </>
  )
}
