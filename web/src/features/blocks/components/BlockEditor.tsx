import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { SegmentedControl, Switch } from '@/components/ui/Controls'
import { NumberField } from '@/components/ui/NumberField'
import { Tooltip } from '@/components/ui/Overlay'
import { toast } from '@/components/ui/Toast'
import { EmptyState } from '@/components/data-display/Misc'
import { IconCopyPlus, IconHelp, IconMinus, IconPlus, IconTrash } from '@/lib/icons'
import { useDraft, useSelectedBlock } from '../store'
import { KIND_DESC, KIND_LABEL } from '../schema'
import { CharListForm, CharRangeForm, WorkListForm, WorkRangeForm } from './BlockForms'
import { KIND_ICON } from './BlockList'

/** 右侧组块编辑器：颜色（纳入/排除）、启用、权重、按类型的参数表单 */
export function BlockEditor({ className }: { className?: string }) {
  const block = useSelectedBlock()
  const index = useDraft((s) => s.blocks.findIndex((b) => b.id === s.selectedId))
  const setColor = useDraft((s) => s.setColor)
  const updateBlock = useDraft((s) => s.updateBlock)
  const removeBlock = useDraft((s) => s.removeBlock)
  const insertBlock = useDraft((s) => s.insertBlock)
  const duplicate = useDraft((s) => s.duplicateBlock)

  if (!block)
    return (
      <Card className={className}>
        <EmptyState kind="no-blocks" title="选左边的一个组块来编辑" description="还没有组块的话，先点「+ 作品范围」" />
      </Card>
    )

  const Icon = KIND_ICON[block.kind]
  const onDelete = () => {
    const r = removeBlock(block.id)
    if (!r) return
    toast.info(`删掉了第 ${r.index + 1} 个组块（${KIND_LABEL[r.block.kind]}）`, {
      id: 'block-delete',
      action: { label: '撤销', onClick: () => insertBlock(r.block, r.index) },
    })
  }

  return (
    <Card className={className} data-slot="block-editor">
      <div className="flex flex-col gap-4 border-b border-border px-5 pb-4 pt-5">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-2 text-fg-2 ring-1 ring-inset ring-border">
            <Icon className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg text-fg-1">
              第 {index + 1} 个组块 · {KIND_LABEL[block.kind]}
            </h3>
            <p className="mt-0.5 text-sm text-fg-3">{KIND_DESC[block.kind]}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            value={block.color}
            onChange={(c) => setColor(block.id, c)}
            aria-label="纳入还是排除"
            tone={(v) => (v === 'red' ? 'include' : 'exclude')}
            options={[
              { value: 'red', label: '纳入', icon: <IconPlus />, title: '把这个组块圈到的角色加进候选池' },
              { value: 'blue', label: '排除', icon: <IconMinus />, title: '把这个组块圈到的角色从候选池去掉' },
            ]}
          />
          <label className="flex cursor-pointer items-center gap-2 text-sm text-fg-2">
            <Switch checked={block.enabled} onChange={(v) => updateBlock(block.id, { enabled: v })} aria-label="启用" />
            启用
          </label>
          <div className="ml-auto flex gap-1">
            <Tooltip content="复制一份（放在它下面）">
              <Button size="sm" variant="ghost" icon={<IconCopyPlus />} onClick={() => duplicate(block.id)}>
                复制
              </Button>
            </Tooltip>
            <Button size="sm" variant="danger-ghost" icon={<IconTrash />} onClick={onDelete}>
              删除
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1 text-sm font-medium text-fg-2">
            权重
            <Tooltip content="这个纳入块圈到的每个角色都拿这个权重；同一个人被几个纳入块圈到，取最大的那个（不是加起来）。排除块不用权重。">
              <span tabIndex={0} className="text-fg-3">
                <IconHelp className="size-3.5" />
              </span>
            </Tooltip>
          </span>
          <NumberField
            value={block.weight}
            onCommit={(v) => updateBlock(block.id, { weight: v ?? 0 })}
            min={0}
            step={0.1}
            fallback={0}
            disabled={block.color !== 'red'}
            aria-label="权重"
            className="w-24"
            size="sm"
          />
          <span className="text-xs text-fg-3">
            {block.color === 'red' ? '越大越容易被随机抽到（非数字或负数会变成 0）' : '排除块不用权重'}
          </span>
        </div>
      </div>
      <div className="px-5 py-5">
        {block.kind === 'work-range' && <WorkRangeForm key={block.id} block={block} />}
        {block.kind === 'work-list' && <WorkListForm key={block.id} block={block} />}
        {block.kind === 'char-list' && <CharListForm key={block.id} block={block} />}
        {block.kind === 'char-range' && <CharRangeForm key={block.id} block={block} />}
      </div>
    </Card>
  )
}
