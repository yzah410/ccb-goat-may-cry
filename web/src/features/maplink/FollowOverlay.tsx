/**
 * 跟随格图区角落的两样小东西（都不挡作品卡、不抢注意力）：
 * - 字幕（左上）：「上一题：角色名《作品名》· 评级」，约 4 秒后淡出；改评级时文字跟着变
 * - 提示（左下）：「《作品》不在联动的图里」「单人猜猜呗换了方案『X』，已换用它的图组 · 撤销」；
 *   换了方案、新方案没有图组时另带「选图组」（打开跟随格的设置面板）
 * 右下角是引擎的缩放百分比：提示右边不超过它的左边，格子太窄就放到它上面（./follow.ts 的 noticeBox），文字在里面换行。
 * 小字、半透明底、短淡入淡出（系统要求减少动效时，全局 CSS 已把动画压成一瞬）。
 * 位置由 Workspace 算好传进来（./follow.ts 的 boardInRoot：引擎图区 .board-wrap 在工作区容器里的位置）。
 */
import { useEffect, useState } from 'react'
import { IconLayers, IconUndo, IconX } from '@/lib/icons'
import { cn } from '@/lib/cn'
import type { Rect } from '@/features/tagnote/workspace/types'
import { noticeBox } from './follow'
import { useFollowRuntime, type Caption, type Notice } from './followStore'

const FADE_MS = 200

/** 值变成 null 时先淡出再拿掉 */
function useFade<T>(value: T | null): { shown: T | null; visible: boolean } {
  const [shown, setShown] = useState<T | null>(value)
  const [visible, setVisible] = useState(value !== null)
  if (value !== null && shown !== value) {
    setShown(value)
    setVisible(true)
  } else if (value === null && visible) setVisible(false)
  useEffect(() => {
    if (value !== null || shown === null) return
    const t = setTimeout(() => setShown(null), FADE_MS)
    return () => clearTimeout(t)
  }, [value, shown])
  return { shown, visible }
}

export interface FollowOverlayProps {
  /** 图区在工作区容器里的位置；null = 跟随格不在 / 还没量出来 */
  board: Rect | null
  onUndo: () => void
  onDismiss: () => void
  /** 提示里的「选图组」：打开跟随格的设置面板 */
  onPanel: () => void
}

const linkBtn =
  'inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 font-medium text-primary hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-ring'

export function FollowOverlay({ board, onUndo, onDismiss, onPanel }: FollowOverlayProps) {
  const caption = useFollowRuntime((s) => s.caption)
  const notice = useFollowRuntime((s) => s.notice)
  const cap = useFade<Caption>(caption)
  const note = useFade<Notice>(notice)
  if (!board) return null
  const maxW = Math.max(120, board.w - 24)
  const nb = noticeBox(board)
  return (
    <>
      {cap.shown && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            'pointer-events-none absolute z-10 truncate rounded-md border border-border/60 bg-surface-glass px-2 py-1 text-xs text-fg-2 shadow-1 backdrop-blur-sm',
            'transition-opacity duration-200',
            cap.visible ? 'animate-[fade-in_var(--motion-duration)_var(--motion-ease)] opacity-100' : 'opacity-0',
          )}
          style={{ left: board.x + 8, top: board.y + 8, maxWidth: maxW }}
          data-follow-caption=""
        >
          {cap.shown.text}
        </div>
      )}
      {note.shown && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            'absolute z-10 flex flex-wrap items-center gap-x-1 gap-y-0.5 rounded-md border border-border/60 bg-surface-glass py-1 pl-2 pr-1 text-xs text-fg-2 shadow-1 backdrop-blur-sm',
            'transition-opacity duration-200',
            note.visible ? 'animate-[fade-in_var(--motion-duration)_var(--motion-ease)] opacity-100' : 'pointer-events-none opacity-0',
          )}
          // 左下、往上长；右边让出缩放百分比
          style={{ left: nb.left, top: nb.bottom, transform: 'translateY(-100%)', maxWidth: nb.maxWidth }}
          data-follow-notice=""
        >
          <span className="min-w-0 flex-[1_1_8rem] break-words leading-snug">{note.shown.text}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {note.shown.panel && (
              <button type="button" onClick={onPanel} className={linkBtn} data-follow-notice-panel="">
                <IconLayers className="size-3" />
                选图组
              </button>
            )}
            {note.shown.undo && (
              <button type="button" onClick={onUndo} className={linkBtn} data-follow-undo="">
                <IconUndo className="size-3" />
                撤销
              </button>
            )}
            <button
              type="button"
              aria-label="关掉这条提示"
              onClick={onDismiss}
              className="grid size-5 shrink-0 place-items-center rounded-sm text-fg-3 hover:bg-surface-3 hover:text-fg-1 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <IconX className="size-3" />
            </button>
          </span>
        </div>
      )}
    </>
  )
}
