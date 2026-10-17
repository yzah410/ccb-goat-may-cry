import { useState } from 'react'
import { cn } from '@/lib/cn'
import { parseIntStrict } from '@/lib/format'
import { SegmentedControl, Switch } from '@/components/ui/Controls'
import { Input } from '@/components/ui/Input'
import { Tooltip } from '@/components/ui/Overlay'
import { IconHelp, IconUser, IconFilm } from '@/lib/icons'
import { useDraft } from '../store'

function Help({ text }: { text: string }) {
  return (
    <Tooltip content={text}>
      <span tabIndex={0} className="text-fg-3 hover:text-fg-2">
        <IconHelp className="size-3.5" />
      </span>
    </Tooltip>
  )
}

/**
 * 全局设置：抽题方式 / 随机种子 / 额外作品标签。
 * - 种子：输入非数字时当场提示「只能填整数」，不合法的内容不会生效
 * - 额外作品标签：用开关表示
 */
export function GlobalSettings({ className }: { className?: string }) {
  const mode = useDraft((s) => s.mode)
  const seed = useDraft((s) => s.seed)
  const extra = useDraft((s) => s.includeExtraWorkTags)
  const setMode = useDraft((s) => s.setMode)
  const setSeed = useDraft((s) => s.setSeed)
  const setExtra = useDraft((s) => s.setIncludeExtraWorkTags)
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (seed === null ? '' : String(seed))
  const parsed = parseIntStrict(shown)
  const invalid = parsed !== null && Number.isNaN(parsed)

  return (
    <div
      className={cn('flex flex-wrap items-start gap-x-8 gap-y-4 rounded-lg border border-border bg-surface-1 px-5 py-4 shadow-1', className)}
      data-slot="global-settings"
    >
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center gap-1 text-sm font-medium text-fg-2">
          抽题方式
          <Help text="按角色权重：直接按每个角色的权重随机抽。按作品权重：先按作品的权重（它名下角色的最大权重）抽一部作品，再在这部作品里平均抽一个角色。只影响随机抽题和自动模式，不影响候选人数。" />
        </span>
        <SegmentedControl
          value={mode}
          onChange={setMode}
          aria-label="抽题方式"
          options={[
            { value: 'char-weight', label: '按角色权重', icon: <IconUser /> },
            { value: 'work-weight', label: '按作品权重', icon: <IconFilm /> },
          ]}
        />
      </div>

      <div className="flex w-52 flex-col gap-1.5">
        <label htmlFor="seed" className="flex items-center gap-1 text-sm font-medium text-fg-2">
          随机种子
          <Help text="填了整数，随机抽题每次结果都一样（方便复现）；留空就每次随机。自动模式会从这个数开始每轮加 1。不影响预览和候选列表。" />
        </label>
        <Input
          id="seed"
          size="md"
          inputMode="numeric"
          value={shown}
          invalid={invalid}
          placeholder="留空 = 每次随机"
          aria-describedby="seed-hint"
          className="tabular"
          onFocus={() => setDraft(seed === null ? '' : String(seed))}
          onChange={(e) => {
            setDraft(e.target.value)
            const v = parseIntStrict(e.target.value)
            if (v === null) setSeed(null)
            else if (!Number.isNaN(v)) setSeed(v)
          }}
          onBlur={() => setDraft(null)}
        />
        <p id="seed-hint" className={cn('text-xs', invalid ? 'text-danger-fg' : 'text-fg-3')}>
          {invalid ? `只能填整数；现在用的还是 ${seed === null ? '「不设种子」' : seed}` : seed === null ? '现在：每次随机' : `现在：固定为 ${seed}`}
        </p>
      </div>

      <div className="flex max-w-xs flex-col gap-1.5">
        <span className="flex items-center gap-1 text-sm font-medium text-fg-2">
          额外作品标签
          <Help text="打开后，角色数据里的 additional_work_tags 也算作品标签：影响「角色范围」的标签筛选、候选卡片上显示的标签、导图分组。" />
        </span>
        <label className="flex h-[var(--control-h-md)] cursor-pointer items-center gap-2.5 text-sm text-fg-1">
          <Switch checked={extra} onChange={setExtra} aria-label="把角色的额外作品标签也算进来" />
          {extra ? '算进来' : '不算'}
        </label>
      </div>
    </div>
  )
}
