/**
 * 格子之间的分隔线：看得见的只有 1px，能抓的范围左右各宽 3px。
 * 拖动时只改工作区的临时比例（onLive，每一格跟着动），松手才写进存储（onCommit）；两边都不小于最小尺寸。
 * 双击 = 两边平分；键盘：方向键每次挪 2%。
 */
import { useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { dragSizes, type SplitterGeom } from './tree'

const HIT = 3

export interface SplitterProps {
  geom: SplitterGeom
  onLive: (sizes: number[] | null) => void
  onCommit: (sizes: number[]) => void
}

export function Splitter({ geom, onLive, onCommit }: SplitterProps) {
  const { dir, line, index, sizes, avail, minA, minB } = geom
  const row = dir === 'row'
  const start = useRef<{ pos: number; sizes: number[]; last: number[] | null } | null>(null)
  const [dragging, setDragging] = useState(false)

  const end = (commit: boolean) => {
    const s = start.current
    start.current = null
    setDragging(false)
    onLive(null)
    if (commit && s?.last) onCommit(s.last)
  }

  const nudge = (delta: number) => onCommit(dragSizes(sizes, index, delta, minA, minB))

  return (
    <div
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label={row ? '拖动调整左右两格的宽度' : '拖动调整上下两格的高度'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(((sizes[index] ?? 0) / ((sizes[index] ?? 0) + (sizes[index + 1] ?? 0) || 1)) * 100)}
      tabIndex={0}
      className={cn('group absolute z-10 touch-none outline-none', row ? 'cursor-col-resize' : 'cursor-row-resize')}
      style={
        row
          ? { left: line.x - HIT, top: line.y, width: line.w + HIT * 2, height: line.h }
          : { left: line.x, top: line.y - HIT, width: line.w, height: line.h + HIT * 2 }
      }
      data-ws-splitter={`${geom.splitId}:${index}`}
      onPointerDown={(e) => {
        if (e.button !== 0 || avail <= 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { pos: row ? e.clientX : e.clientY, sizes, last: null }
        setDragging(true)
      }}
      onPointerMove={(e) => {
        const s = start.current
        if (!s) return
        const delta = ((row ? e.clientX : e.clientY) - s.pos) / avail
        s.last = dragSizes(s.sizes, index, delta, minA, minB)
        onLive(s.last)
      }}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onLostPointerCapture={() => {
        if (start.current) end(true)
      }}
      onDoubleClick={() => nudge(((sizes[index] ?? 0) + (sizes[index + 1] ?? 0)) / 2 - (sizes[index] ?? 0))}
      onKeyDown={(e) => {
        const back = row ? 'ArrowLeft' : 'ArrowUp'
        const fwd = row ? 'ArrowRight' : 'ArrowDown'
        if (e.key !== back && e.key !== fwd) return
        e.preventDefault()
        nudge(e.key === fwd ? 0.02 : -0.02)
      }}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute transition-colors',
          row ? 'inset-y-0 left-1/2 w-px -translate-x-1/2' : 'inset-x-0 top-1/2 h-px -translate-y-1/2',
          dragging ? 'bg-primary' : 'bg-border group-hover:bg-border-strong group-focus-visible:bg-ring',
        )}
      />
    </div>
  )
}
