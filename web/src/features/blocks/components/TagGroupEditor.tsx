import { Button } from '@/components/ui/Button'
import { TagChip } from '@/components/data-display/TagChip'
import { IconInfo, IconPlus, IconTrash } from '@/lib/icons'
import { cn } from '@/lib/cn'
import { isAllExcludeGroup } from '../summary'
import { TAG_KIND_LABEL, type TagGroups, type TagItem } from '../schema'
import { TagInput } from './TagInput'

const CHIP_KIND = { work: 'genre', char: 'char', va: 'va', source: 'source' } as const

/**
 * 标签组编辑器。规则（后端 blocks.py / data_loader.py）：
 * - 组和组之间是「或」：满足任意一组就算通过
 * - 组内：纳入的标签「都要有」，排除的标签「一个都不能有」
 * - 只有排除项的组是合法的，编辑器只显示一条提示，不阻止保存
 * - 空组会被后端忽略
 */
export function TagGroupEditor({
  value,
  onChange,
  mode,
}: {
  value: TagGroups
  onChange: (v: TagGroups) => void
  mode: 'work-only' | 'mixed'
}) {
  const groups = value ?? []
  const setGroup = (gi: number, items: TagItem[]) => onChange(groups.map((g, i) => (i === gi ? items : g)))
  const removeGroup = (gi: number) => onChange(groups.filter((_, i) => i !== gi))
  const addGroup = () => onChange([...groups, []])

  return (
    <div className="flex flex-col gap-3" data-slot="tag-group-editor">
      {groups.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed border-border-strong px-4 py-3">
          <p className="text-sm text-fg-3">没有标签条件 = 不按标签筛</p>
          <Button size="sm" variant="secondary" icon={<IconPlus />} onClick={addGroup}>
            加一组标签
          </Button>
        </div>
      ) : (
        groups.map((g, gi) => {
          const allExclude = isAllExcludeGroup(g)
          const ignoredKinds = mode === 'work-only' ? g.filter((t) => t.kind !== 'work') : []
          return (
            <div key={gi} className="flex flex-col gap-3">
              {gi > 0 && (
                <div className="flex items-center gap-3 text-xs font-medium text-fg-3" aria-hidden>
                  <span className="h-px flex-1 bg-border" />或<span className="h-px flex-1 bg-border" />
                </div>
              )}
              <div className={cn('flex flex-col gap-3 rounded-md border border-border bg-surface-2 p-3')}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-fg-2">第 {gi + 1} 组</span>
                  <Button size="sm" variant="danger-ghost" icon={<IconTrash />} onClick={() => removeGroup(gi)}>
                    删除这组
                  </Button>
                </div>
                {g.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {g.map((t, ti) => (
                      <TagChip
                        key={`${t.kind}:${t.name}:${ti}`}
                        label={t.name}
                        kind={CHIP_KIND[t.kind]}
                        tone={t.color === 'red' ? 'include' : 'exclude'}
                        emoji={null}
                        title={`${t.color === 'red' ? '纳入（必须有）' : '排除（不能有）'} · ${TAG_KIND_LABEL[t.kind]}`}
                        suffix={mode === 'mixed' && t.kind !== 'work' ? <span className="opacity-70">· {TAG_KIND_LABEL[t.kind]}</span> : undefined}
                        onRemove={() => setGroup(gi, g.filter((_, i) => i !== ti))}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-fg-3">空组：后端会忽略它。加一个标签试试。</p>
                )}
                <TagInput mode={mode} existing={g} onAdd={(item) => setGroup(gi, [...g, item])} />
                {allExclude && (
                  <p className="flex items-start gap-1.5 rounded-sm bg-info-bg px-2 py-1.5 text-xs text-info-fg">
                    <IconInfo className="mt-0.5 size-3.5 shrink-0" />
                    这一组只有排除项：表示在这个组块的范围里，去掉带这些标签的{mode === 'work-only' ? '作品' : '角色'}。
                  </p>
                )}
                {ignoredKinds.length > 0 && (
                  <p className="text-xs text-warning-fg">
                    「作品范围」只看作品标签，这些会被后端忽略：{ignoredKinds.map((t) => t.name).join('、')}
                  </p>
                )}
              </div>
            </div>
          )
        })
      )}
      {groups.length > 0 && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-fg-3">组内：纳入的都要有，排除的都不能有；组和组之间满足一个就行。</p>
          <Button size="sm" variant="ghost" icon={<IconPlus />} onClick={addGroup}>
            再加一组（或）
          </Button>
        </div>
      )}
    </div>
  )
}
