import { Reorder, useDragControls } from 'motion/react'
import { cn } from '@/lib/cn'
import { fmtWeight } from '@/lib/format'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Controls'
import { Tooltip } from '@/components/ui/Overlay'
import { EmptyState } from '@/components/data-display/Misc'
import {
  IconArrowDown,
  IconArrowUp,
  IconCalendar,
  IconGrip,
  IconInfo,
  IconList,
  IconMinus,
  IconPlus,
  IconSliders,
  IconUsers,
} from '@/lib/icons'
import { useDraft } from '../store'
import { summarizeBlock } from '../summary'
import { BLOCK_KINDS, KIND_DESC, KIND_LABEL, type Block, type BlockColor, type BlockKind } from '../schema'

export const KIND_ICON: Record<BlockKind, typeof IconCalendar> = {
  'work-range': IconCalendar,
  'work-list': IconList,
  'char-list': IconUsers,
  'char-range': IconSliders,
}

export function ColorBadge({ color, size = 'md' }: { color: BlockColor; size?: 'sm' | 'md' }) {
  return color === 'red' ? (
    <Badge tone="include" size={size}>
      <IconPlus />
      纳入
    </Badge>
  ) : (
    <Badge tone="exclude" size={size}>
      <IconMinus />
      排除
    </Badge>
  )
}

/** 四个「添加」按钮（一次点击就加；加完自动选中新组块） */
export function AddBlockButtons({ className }: { className?: string }) {
  const add = useDraft((s) => s.addBlock)
  return (
    <div className={cn('grid grid-cols-2 gap-2', className)}>
      {BLOCK_KINDS.map((k) => {
        const Icon = KIND_ICON[k]
        return (
          <Tooltip key={k} content={KIND_DESC[k]}>
            <Button size="sm" variant="secondary" icon={<Icon />} onClick={() => add(k)} className="justify-start">
              + {KIND_LABEL[k]}
            </Button>
          </Tooltip>
        )
      })}
    </div>
  )
}

function BlockCard({ block, index, total, selected }: { block: Block; index: number; total: number; selected: boolean }) {
  const controls = useDragControls()
  const select = useDraft((s) => s.select)
  const move = useDraft((s) => s.moveBlock)
  const updateBlock = useDraft((s) => s.updateBlock)
  const Icon = KIND_ICON[block.kind]
  const lines = summarizeBlock(block)

  return (
    <Reorder.Item value={block.id} dragListener={false} dragControls={controls} as="li" className="relative list-none">
      <div
        data-slot="block-card"
        data-selected={selected || undefined}
        className={cn(
          'group relative flex items-stretch gap-1 rounded-lg border bg-surface-1 shadow-1 transition-[border-color,background-color,box-shadow]',
          selected ? 'border-primary-400 bg-selected ring-1 ring-primary-400' : 'border-border hover:border-border-strong hover:shadow-2',
          !block.enabled && 'bg-surface-2',
        )}
      >
        <button
          type="button"
          aria-label={`拖动第 ${index + 1} 个组块排序`}
          onPointerDown={(e) => controls.start(e)}
          className="flex w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-l-lg text-fg-3 hover:bg-surface-2 hover:text-fg-2 active:cursor-grabbing"
        >
          <IconGrip className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => select(block.id)}
          aria-pressed={selected}
          className={cn('min-w-0 flex-1 py-3 pr-1 text-left outline-none', !block.enabled && 'opacity-60')}
        >
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="tabular text-xs font-medium text-fg-3">#{index + 1}</span>
            <ColorBadge color={block.color} size="sm" />
            <span className="inline-flex items-center gap-1 text-sm font-medium text-fg-1">
              <Icon className="size-3.5 text-fg-3" aria-hidden />
              {KIND_LABEL[block.kind]}
            </span>
            {block.color === 'red' && <span className="tabular text-xs text-fg-3">权重 {fmtWeight(block.weight)}</span>}
            {!block.enabled && (
              <Badge size="sm" tone="outline">
                已停用
              </Badge>
            )}
          </span>
          <span className="mt-1.5 flex flex-col gap-0.5">
            {lines.slice(0, 4).map((l, i) => (
              <span key={i} className="block truncate text-xs text-fg-2" title={l}>
                {l}
              </span>
            ))}
          </span>
        </button>
        <div className="flex shrink-0 flex-col items-center justify-between gap-1 py-2 pr-2">
          <Switch
            size="sm"
            checked={block.enabled}
            onChange={(v) => updateBlock(block.id, { enabled: v })}
            aria-label={block.enabled ? `停用第 ${index + 1} 个组块` : `启用第 ${index + 1} 个组块`}
          />
          <div className="flex flex-col">
            <Tooltip content="上移（顺序会影响结果）" side="left">
              <button
                type="button"
                disabled={index === 0}
                onClick={() => move(block.id, -1)}
                aria-label="上移"
                className="grid size-6 place-items-center rounded-sm text-fg-3 hover:bg-surface-2 hover:text-fg-1 disabled:pointer-events-none disabled:opacity-30"
              >
                <IconArrowUp className="size-3.5" />
              </button>
            </Tooltip>
            <Tooltip content="下移（顺序会影响结果）" side="left">
              <button
                type="button"
                disabled={index === total - 1}
                onClick={() => move(block.id, 1)}
                aria-label="下移"
                className="grid size-6 place-items-center rounded-sm text-fg-3 hover:bg-surface-2 hover:text-fg-1 disabled:pointer-events-none disabled:opacity-30"
              >
                <IconArrowDown className="size-3.5" />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </Reorder.Item>
  )
}

export function BlockList({ className }: { className?: string }) {
  const blocks = useDraft((s) => s.blocks)
  const selectedId = useDraft((s) => s.selectedId)
  const reorder = useDraft((s) => s.reorderBlocks)
  const ids = blocks.map((b) => b.id)

  return (
    <div className={cn('flex flex-col gap-3', className)} data-slot="block-list">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg text-fg-1">
          组块
          <span className="tabular rounded-full bg-surface-2 px-2 text-sm font-normal text-fg-2 ring-1 ring-inset ring-border">{blocks.length}</span>
        </h2>
        <Tooltip
          content="从上到下一个一个合成：纳入 = 把圈到的人加进来；排除 = 把圈到的人去掉。后面的纳入块能把前面排除掉的人再加回来，所以顺序会改变结果。"
          side="bottom"
        >
          <button type="button" className="inline-flex items-center gap-1 text-xs text-fg-3 hover:text-fg-2">
            <IconInfo className="size-3.5" />
            顺序有用吗？
          </button>
        </Tooltip>
      </div>
      <AddBlockButtons />
      {blocks.length === 0 ? (
        <EmptyState
          kind="no-blocks"
          size="sm"
          title="还没有组块"
          description="点上面的按钮加一个，最常用的是「作品范围」"
        />
      ) : (
        <Reorder.Group axis="y" values={ids} onReorder={reorder} as="ol" className="flex flex-col gap-2" aria-label="组块（顺序即合成顺序）">
          {blocks.map((b, i) => (
            <BlockCard key={b.id} block={b} index={i} total={blocks.length} selected={b.id === selectedId} />
          ))}
        </Reorder.Group>
      )}
    </div>
  )
}
