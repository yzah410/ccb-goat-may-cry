/**
 * 条件编辑器：每种条件一张小表单。
 * - 已有的条件：点 chip 弹出来，改了立刻生效（能马上看到「筛掉 N 人」变化）；底部有 取反 / 停用 / 删除
 * - 新条件：「+ 条件」选了类型之后弹出来，填完整了才能点「加上这个条件」（空条件不进方案）
 */
import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { PopoverClose } from '@/components/ui/Overlay'
import { useShellNav } from '@/app/shell/nav'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Controls'
import { Textarea, Input } from '@/components/ui/Input'
import { IconArrowRight, IconCheck, IconTrash } from '@/lib/icons'
import { ListPicker, MinMax, ToggleChips, ValuesField } from '@/features/v2/components/Fields'
import type { AppearanceRole, Condition, GenderValue, ModeId, TagFilter } from '@/features/v2/types'
import { APPEARANCE_ROLES, APPEARANCE_SUBJECT_TYPES, GENDERS, MODE_BY_ID, SOURCE_TAG_VALUES, SUBJECT_TYPE_LABEL, conditionComplete, emptyTagFilter } from '../spec'
import { TWO_KINDS_OF_WORK_TAGS, condMeta, COND_GROUPS } from '../summary'
import { TagFilterEditor } from './TagFilterEditor'

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-fg-2">{label}</span>
      {children}
      {hint && <span className="text-xs text-fg-3">{hint}</span>}
    </div>
  )
}

/** 按类型画表单 */
export function ConditionForm({
  c,
  onChange,
  mode,
  tagCount,
  autoFocus,
}: {
  c: Condition
  onChange: (c: Condition) => void
  mode: ModeId
  tagCount: number
  autoFocus?: boolean
}) {
  const nav = useShellNav()
  switch (c.type) {
    case 'gender':
      return (
        <Row label="性别是（多选 = 任一）">
          <ToggleChips<GenderValue>
            ariaLabel="性别"
            values={c.values}
            onChange={(values) => onChange({ ...c, values })}
            options={GENDERS.map((g) => ({ value: g, label: g }))}
          />
        </Row>
      )
    case 'char_heat':
      return (
        <Row label="角色热度（收藏这个角色的人数）在这个范围里" hint="最热门的角色大约 4,000；1,000 以上的只有几十个，几百就算热门">
          <MinMax min={c.min} max={c.max} onChange={(min, max) => onChange({ ...c, min, max })} lo={0} width="w-28" />
        </Row>
      )
    case 'n_app':
      return (
        <Row label="登场数（游戏格子里的作品数）">
          <MinMax min={c.min} max={c.max} onChange={(min, max) => onChange({ ...c, min, max })} lo={0} unit="部" />
        </Row>
      )
    case 'earliest_year':
    case 'latest_year':
      return (
        <Row label={c.type === 'earliest_year' ? '最早登场年（游戏格子里的）' : '最晚登场年（游戏格子里的）'} hint="没有年份的角色（游戏里显示问号）不满足">
          <MinMax min={c.min} max={c.max} onChange={(min, max) => onChange({ ...c, min, max })} unit="年" lo={1900} hi={2100} />
        </Row>
      )
    case 'rating':
      return (
        <Row label="最高评分（登场作品里最高的 Bangumi 评分）" hint="0–10，可以有小数">
          <MinMax min={c.min} max={c.max} onChange={(min, max) => onChange({ ...c, min, max })} integer={false} step={0.1} lo={0} hi={10} unit="分" />
        </Row>
      )
    case 'game_tags':
      return (
        <div className="flex flex-col gap-3">
          <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-fg-2">
            按现在的对局设置算：{MODE_BY_ID.get(mode)?.label ?? mode}模式 · 作品标签数 {tagCount}
          </p>
          <TagFilterEditor value={c} onChange={(f) => onChange({ ...c, ...f })} kind="game_tag" mode={mode} tagCount={tagCount} autoFocus={autoFocus} />
        </div>
      )
    case 'char_tags':
      return <TagFilterEditor value={c} onChange={(f) => onChange({ ...c, ...f })} kind="char_tag" autoFocus={autoFocus} />
    case 'va':
      return (
        <Row label="声优（有其中任何一个就算）">
          <ValuesField kind="va" values={c.names} onChange={(names) => onChange({ ...c, names })} placeholder="输入声优名字" autoFocus={autoFocus} />
        </Row>
      )
    case 'source_tag':
      return (
        <Row label="来源是（多选 = 任一）" hint="按对局设置的模式算，和游戏格子里的一样">
          <ToggleChips
            ariaLabel="来源"
            values={c.values}
            onChange={(values) => onChange({ ...c, values })}
            options={SOURCE_TAG_VALUES.map((v) => ({ value: v, label: v }))}
          />
        </Row>
      )
    case 'appearance': {
      const wt: TagFilter | null = c.work_tags ?? null
      return (
        <div className="flex flex-col gap-3">
          <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-fg-2">
            至少有<strong className="font-medium text-fg-1">一部</strong>登场作品同时满足下面填了的所有项（没填的不管）。
          </p>
          <Row label="作品类型">
            <ToggleChips
              ariaLabel="作品类型"
              values={(c.subject_types ?? []).map(String)}
              onChange={(v) => onChange({ ...c, subject_types: v.length ? v.map(Number) : null })}
              options={APPEARANCE_SUBJECT_TYPES.map((t) => ({ value: String(t), label: SUBJECT_TYPE_LABEL[t] }))}
            />
          </Row>
          <Row label="作品年份">
            <MinMax
              min={c.year_from}
              max={c.year_to}
              onChange={(year_from, year_to) => onChange({ ...c, year_from, year_to })}
              unit="年"
              lo={1900}
              hi={2100}
              labels={['从', '到']}
            />
          </Row>
          <Row label="在这部作品里是">
            <ToggleChips<AppearanceRole>
              ariaLabel="在作品里的身份"
              values={c.roles ?? []}
              onChange={(v) => onChange({ ...c, roles: v.length ? v : null })}
              options={APPEARANCE_ROLES.map((r) => ({ value: r, label: r }))}
            />
          </Row>
          <Row label="作品本身的标签" hint={wt ? undefined : '例：这部作品本身带「百合」标签'}>
            {wt ? (
              <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                <TagFilterEditor value={wt} onChange={(f) => onChange({ ...c, work_tags: f })} kind="work_tag" showTagMode />
                <Button size="sm" variant="ghost" className="self-start" onClick={() => onChange({ ...c, work_tags: null })}>
                  不按作品标签筛
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="secondary" className="self-start" onClick={() => onChange({ ...c, work_tags: emptyTagFilter(true) })}>
                按作品本身的标签筛…
              </Button>
            )}
          </Row>
          <Row label="属于作品清单">
            <ListPicker kind="work" value={c.work_list_id} onChange={(id) => onChange({ ...c, work_list_id: id })} allowNone />
          </Row>
        </div>
      )
    }
    case 'char_list':
      return (
        <Row label="在这个角色清单里" hint="想要「不在清单里」：打开下面的「取反」">
          <ListPicker kind="character" value={c.list_id || null} onChange={(id) => onChange({ ...c, list_id: id ?? '' })} />
        </Row>
      )
    case 'sql':
      return (
        <div className="flex flex-col gap-3">
          <Row label="查询（只读 SQL）" hint="第一列必须是角色 id（character_id）；查询结果里的人才算满足。数据更新后自动重算。">
            <Textarea
              value={c.sql}
              onChange={(e) => onChange({ ...c, sql: e.target.value })}
              rows={5}
              spellCheck={false}
              className="font-mono text-sm"
              placeholder={'SELECT character_id FROM game_tag_n6 WHERE tag = \'百合\''}
              autoFocus={autoFocus}
            />
          </Row>
          <Row label="起个名字（chip 上显示它）">
            <Input size="sm" value={c.label ?? ''} onChange={(e) => onChange({ ...c, label: e.target.value || null })} placeholder="例：3 部以上百合作品" />
          </Row>
          <button type="button" onClick={() => nav.go('ask')} className="inline-flex items-center gap-1 self-start text-sm text-link hover:underline">
            不会写？去「问数据」让 AI 写，再存成条件 <IconArrowRight className="size-3.5" />
          </button>
        </div>
      )
    default:
      return <p className="text-sm text-fg-3">这是一个认不出的条件（{(c as { type: string }).type}），只能删掉或停用。</p>
  }
}

/** 弹层里的标题：分组 + 条件名 + 一句说明 */
export function ConditionHead({ c }: { c: Condition }) {
  const m = condMeta(c.type)
  const g = COND_GROUPS.find((x) => x.id === m.group)
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-fg-3">{g?.label}</span>
      <span className="text-base font-semibold text-fg-1">{m.label}</span>
      {c.type === 'game_tags' && <p className="text-xs leading-body text-fg-3">{TWO_KINDS_OF_WORK_TAGS}</p>}
    </div>
  )
}

/** 已有条件：改了立刻生效 */
/** 「取反」在纳入范围和排除区里的意思相反，文案分开写 */
function negateHint(zone: 'ranges' | 'excludes'): string {
  return zone === 'excludes' ? '排除的是「不满足」这一条的人' : '只留下「不满足」这一条的人'
}

export function ExistingConditionPanel({
  c,
  onChange,
  onRemove,
  mode,
  tagCount,
  zone = 'ranges',
}: {
  c: Condition
  onChange: (c: Condition) => void
  onRemove: () => void
  mode: ModeId
  tagCount: number
  zone?: 'ranges' | 'excludes'
}) {
  const complete = conditionComplete(c)
  return (
    <PanelFrame
      footer={
        <>
          <Button size="sm" variant="danger-ghost" icon={<IconTrash />} onClick={onRemove}>
            删掉这个条件
          </Button>
          <PopoverClose asChild>
            <Button size="sm" variant="soft" icon={<IconCheck />} className="ml-auto">
              好了
            </Button>
          </PopoverClose>
        </>
      }
    >
      <ConditionHead c={c} />
      <ConditionForm c={c} onChange={onChange} mode={mode} tagCount={tagCount} />
      {!complete && <p className="rounded-md bg-warning-bg px-3 py-2 text-xs text-warning-fg">这个条件现在是空的：填上内容，或者停用 / 删掉它。</p>}
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <label className="flex items-center justify-between gap-3 text-sm text-fg-1">
          <span>
            取反
            <span className="ml-1.5 text-xs text-fg-3">{negateHint(zone)}</span>
          </span>
          <Switch checked={c.negate} onChange={(negate) => onChange({ ...c, negate })} size="sm" aria-label="取反" />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm text-fg-1">
          <span>
            启用
            <span className="ml-1.5 text-xs text-fg-3">关掉 = 先不算这一条，但留着</span>
          </span>
          <Switch checked={c.enabled} onChange={(enabled) => onChange({ ...c, enabled })} size="sm" aria-label="启用" />
        </label>
      </div>
      <p className="text-xs text-fg-3">这里改了立刻生效，不用另外保存。</p>
    </PanelFrame>
  )
}

/** 新条件：填完整了才能加 */
export function NewConditionPanel({
  c,
  onChange,
  onConfirm,
  onCancel,
  mode,
  tagCount,
  confirmLabel = '加上这个条件',
  zone = 'ranges',
}: {
  c: Condition
  onChange: (c: Condition) => void
  onConfirm: () => void
  onCancel: () => void
  mode: ModeId
  tagCount: number
  confirmLabel?: string
  zone?: 'ranges' | 'excludes'
}) {
  const complete = conditionComplete(c)
  const ref = useRef<HTMLDivElement>(null)
  // 有文字输入框的条件由输入框自己抢焦点；没有的（性别、数字区间……）把焦点放到第一个能操作的控件上，键盘用户不会掉到页面最外层
  useEffect(() => {
    const root = ref.current
    if (!root || root.contains(document.activeElement)) return
    root.querySelector<HTMLElement>('input, button:not([disabled]), [role="radio"], [tabindex]:not([tabindex="-1"])')?.focus()
  }, [])
  return (
    <PanelFrame
      bodyRef={ref}
      footer={
        <>
          {!complete && <span className="mr-auto text-xs text-fg-3">先把上面填完整</span>}
          <Button size="sm" variant="ghost" className={complete ? 'ml-auto' : undefined} onClick={onCancel}>
            不加了
          </Button>
          <Button size="sm" variant="soft" icon={<IconCheck />} disabled={!complete} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <ConditionHead c={c} />
      <ConditionForm c={c} onChange={onChange} mode={mode} tagCount={tagCount} autoFocus />
      <label className="flex items-center justify-between gap-3 text-sm text-fg-1">
        <span>
          取反
          <span className="ml-1.5 text-xs text-fg-3">{negateHint(zone)}</span>
        </span>
        <Switch checked={c.negate} onChange={(negate) => onChange({ ...c, negate })} size="sm" aria-label="取反" />
      </label>
    </PanelFrame>
  )
}

/**
 * 弹层的骨架：中间一段自己滚动，底下一排按钮永远看得见（弹层比屏幕剩下的空间高时，按钮不会跑到看不见的地方，
 * 点下去也不会点到弹层外面、把没加上的条件丢掉）。弹层本身（POPOVER_CLS）是 flex 一列、最高 = 屏幕剩下的高度、不滚动。
 */
function PanelFrame({ children, footer, bodyRef }: { children: ReactNode; footer: ReactNode; bodyRef?: RefObject<HTMLDivElement | null> }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-slot="condition-panel">
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 scroll-thin">
        {children}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-surface-1 px-4 py-3" data-slot="condition-panel-footer">
        {footer}
      </div>
    </div>
  )
}
