/**
 * 标签筛选（TagFilter）编辑器：量词（含任一 / 含全部 / 至少含 k 个 / 都不含）+ 标签（带补全）+ 可选的标签清单。
 * 三个地方用：角色的作品标签（游戏格子）、角色标签（外观）、作品本身的标签（从哪来 / 登场作品）。
 * 作品本身的标签多一个「口径」：主要标签（默认）/ 有人打过就算 / 公共标签（Galgame 这类，游戏的 Galgame 模式按它筛）。
 */
import { SegmentedControl } from '@/components/ui/Controls'
import { NumberField } from '@/components/ui/NumberField'
import { ListPicker, ValuesField } from '@/features/v2/components/Fields'
import type { ModeId, Quant, TagFilter } from '@/features/v2/types'

const QUANT_OPTIONS: { value: Quant; label: string; title: string }[] = [
  { value: 'any', label: '含任一', title: '有其中任何一个就算（或）' },
  { value: 'all', label: '含全部', title: '每一个都要有（且）' },
  { value: 'at_least', label: '至少含 k 个', title: '数个数：至少有其中 k 个' },
  { value: 'none', label: '都不含', title: '一个都不能有（不）' },
]

type TagMode = NonNullable<TagFilter['tag_mode']>

export function TagFilterEditor({
  value,
  onChange,
  kind,
  mode,
  tagCount,
  showTagMode,
  autoFocus,
}: {
  value: TagFilter
  onChange: (f: TagFilter) => void
  kind: 'game_tag' | 'work_tag' | 'char_tag'
  mode?: ModeId
  /** 作品标签数：game_tag 的补全数字按它算 */
  tagCount?: number
  /** 作品本身的标签才有「口径」 */
  showTagMode?: boolean
  autoFocus?: boolean
}) {
  const total = value.tags.length
  const tm: TagMode = value.tag_mode ?? 'main'
  const suggestKind = kind === 'work_tag' && tm === 'meta' ? 'meta_tag' : kind
  return (
    <div className="flex flex-col gap-3">
      {showTagMode && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg-3">作品什么时候算「带这个标签」</span>
          <SegmentedControl<TagMode>
            size="sm"
            value={tm}
            onChange={(m) => onChange({ ...value, tag_mode: m })}
            aria-label="作品什么时候算带这个标签"
            options={[
              { value: 'main', label: '主要标签', title: '默认：这个标签的标注数 ≥ 这部作品最高那个标签的 10%' },
              { value: 'any', label: '有人打过就算', title: '只要有人给这部作品打过这个标签' },
              { value: 'meta', label: '公共标签', title: 'Bangumi 条目页上的公共标签（Galgame、日本动画这类）；游戏的 Galgame 模式按它筛' },
            ]}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          size="sm"
          value={value.quant}
          onChange={(q) => onChange({ ...value, quant: q, k: q === 'at_least' ? (value.k ?? Math.min(2, Math.max(1, total))) : value.k })}
          options={QUANT_OPTIONS}
          aria-label="怎么算满足"
        />
        {value.quant === 'at_least' && (
          <label className="flex items-center gap-1.5 text-sm text-fg-2">
            k =
            <NumberField
              value={value.k ?? null}
              onCommit={(k) => onChange({ ...value, k })}
              integer
              min={1}
              max={30}
              allowEmpty
              size="sm"
              className="w-16"
              aria-label="至少含几个"
            />
          </label>
        )}
      </div>
      <ValuesField
        kind={suggestKind}
        mode={mode}
        n={tagCount}
        values={value.tags}
        onChange={(tags) => onChange({ ...value, tags })}
        autoFocus={autoFocus}
        placeholder={kind === 'char_tag' ? '输入角色标签，例：黑发' : suggestKind === 'meta_tag' ? '输入公共标签，例：Galgame' : '输入标签，例：百合'}
      />
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg-3">也可以加一个标签清单（和上面的标签合在一起算）</span>
        <ListPicker kind="tag" value={value.tag_list_id} onChange={(id) => onChange({ ...value, tag_list_id: id })} allowNone />
      </div>
    </div>
  )
}
