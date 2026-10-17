/**
 * 「问数据」的结果回到工作台的两条路：
 * - 存为清单：选清单种类、id 列、名字列 → POST /v2/lists（结果是固定的一批东西，数据更新后不会变）
 * - 存为条件：把 SQL 本身存成某个范围 / 排除项的「自定义查询」条件（数据更新后自动重算）
 */
import { useMemo, useState } from 'react'
import { useShellNav } from '@/app/shell/nav'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Controls'
import { Dialog, DialogContent } from '@/components/ui/Overlay'
import { Field, Input } from '@/components/ui/Input'
import { toast } from '@/components/ui/Toast'
import { IconAlert, IconListPlus, IconPlus } from '@/lib/icons'
import { fmtInt } from '@/lib/format'
import { useSaveList } from '@/features/v2/hooks'
import { LIST_KIND_LABEL } from '@/features/v2/labels'
import type { ListItemV2, ListKind } from '@/features/v2/types'
import { newCondition, newId, rangeTitle, takenIds } from '@/features/workbench2/spec'
import { useWb2 } from '@/features/workbench2/store'
import type { AskTable } from '../store'

const ID_RE = /(^|_)id$/i
const NAME_RE = /(^|_)(name|display_name|name_cn|tag|名字|名称|标签)$/i

function guessId(cols: string[], hint?: string | null): string | null {
  if (hint && cols.includes(hint)) return hint
  return cols.find((c) => /^character_id$/i.test(c)) ?? cols.find((c) => ID_RE.test(c)) ?? null
}
function guessName(cols: string[]): string | null {
  return cols.find((c) => /^display_name$/i.test(c)) ?? cols.find((c) => NAME_RE.test(c)) ?? cols.find((c) => !ID_RE.test(c)) ?? null
}

export function SaveListDialog({
  open,
  onClose,
  table,
  question,
  hint,
}: {
  open: boolean
  onClose: () => void
  table: AskTable
  question: string
  hint?: { kind: ListKind; id_column: string } | null
}) {
  const nav = useShellNav()
  const save = useSaveList()
  const cols = table.columns
  const [kind, setKind] = useState<ListKind>(hint?.kind ?? (cols.some((c) => /character/i.test(c)) ? 'character' : cols.some((c) => /subject|work/i.test(c)) ? 'work' : 'tag'))
  const [idCol, setIdCol] = useState<string | null>(() => guessId(cols, hint?.id_column))
  const [nameCol, setNameCol] = useState<string | null>(() => guessName(cols))
  const [name, setName] = useState(() => (question.length > 24 ? `${question.slice(0, 24)}…` : question) || '问数据的结果')

  const items = useMemo<ListItemV2[]>(() => {
    const ii = idCol ? cols.indexOf(idCol) : -1
    const ni = nameCol ? cols.indexOf(nameCol) : -1
    const seen = new Set<string>()
    const out: ListItemV2[] = []
    for (const r of table.rows) {
      const rawId = ii >= 0 ? r[ii] : null
      const id = kind !== 'tag' && typeof rawId === 'number' && Number.isInteger(rawId) ? rawId : kind !== 'tag' && typeof rawId === 'string' && /^\d+$/.test(rawId) ? Number(rawId) : undefined
      const nm = ni >= 0 && r[ni] != null ? String(r[ni]) : id != null ? String(id) : ''
      if (!nm && id == null) continue
      const key = kind === 'tag' ? nm : String(id ?? nm)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(kind === 'tag' ? { name: nm } : id != null ? { id, name: nm } : { name: nm })
    }
    return out
  }, [table.rows, cols, idCol, nameCol, kind])

  const needsId = kind !== 'tag'
  const missingIds = needsId ? items.filter((i) => i.id == null).length : 0
  const colOptions = (allowNone: boolean) => [...(allowNone ? [{ value: '__none__', label: '（不用）' }] : []), ...cols.map((c) => ({ value: c, label: c }))]

  const submit = () => {
    if (!name.trim() || !items.length) return
    save.mutate(
      { id: null, body: { name: name.trim(), kind, items, note: `来自「问数据」：${question}` } },
      {
        onSuccess: () => {
          toast.success(`存成了${LIST_KIND_LABEL[kind]}「${name.trim()}」（${fmtInt(items.length)} 项）`, {
            id: 'ask-save-list',
            action: { label: '去清单页', onClick: () => nav.go('lists') },
          })
          onClose()
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {open && (
        <DialogContent title="把结果存成清单" description="清单是一批固定的东西：以后数据更新了它也不会变（想要自动跟着数据变，用「存为条件」）。" size="md">
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <Field label="清单名字">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
            </Field>
            <div className="flex flex-wrap gap-3 [&>*]:min-w-40 [&>*]:flex-1">
              <Field label="清单种类">
                {({ id }) => (
                  <Select<ListKind>
                    id={id}
                    value={kind}
                    onChange={setKind}
                    options={(['character', 'work', 'tag'] as ListKind[]).map((k) => ({ value: k, label: LIST_KIND_LABEL[k] }))}
                  />
                )}
              </Field>
              {needsId && (
                <Field label="哪一列是 id">
                  {({ id }) => <Select id={id} value={idCol ?? '__none__'} onChange={(v) => setIdCol(v === '__none__' ? null : v)} options={colOptions(true)} />}
                </Field>
              )}
              <Field label={kind === 'tag' ? '哪一列是标签' : '哪一列是名字'}>
                {({ id }) => <Select id={id} value={nameCol ?? '__none__'} onChange={(v) => setNameCol(v === '__none__' ? null : v)} options={colOptions(kind !== 'tag')} />}
              </Field>
            </div>
            <div className="rounded-md bg-surface-2 px-3 py-2 text-sm text-fg-2">
              会存 <b className="tabular text-fg-1">{fmtInt(items.length)}</b> 项（去掉了重复的）
              {items.length > 0 && (
                <span className="mt-1 block truncate text-xs text-fg-3">
                  {items
                    .slice(0, 6)
                    .map((i) => (i.id != null ? `${i.name}（#${i.id}）` : i.name))
                    .join('、')}
                  {items.length > 6 ? ' …' : ''}
                </span>
              )}
            </div>
            {missingIds > 0 && (
              <p className="flex items-start gap-1.5 text-xs text-warning-fg">
                <IconAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                有 {fmtInt(missingIds)} 项没有 id，后端会按名字去库里对号（对不上的会在保存结果里列出来）。
              </p>
            )}
            {table.truncated && <p className="text-xs text-warning-fg">结果被截断了（只有前 2,000 行），清单里也只有这些。</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                取消
              </Button>
              <Button type="submit" variant="primary" icon={<IconListPlus />} loading={save.isPending} disabled={!name.trim() || !items.length}>
                存成清单
              </Button>
            </div>
          </form>
        </DialogContent>
      )}
    </Dialog>
  )
}

export function SaveConditionDialog({
  open,
  onClose,
  sql,
  question,
  firstColumn,
  hintKind,
}: {
  open: boolean
  onClose: () => void
  sql: string
  question: string
  firstColumn: string | null
  hintKind?: ListKind | null
}) {
  const nav = useShellNav()
  const spec = useWb2((s) => s.spec)
  const edit = useWb2((s) => s.edit)
  const targets = [...spec.ranges, ...spec.excludes].map((r) => ({
    value: r.id,
    label: `${spec.ranges.includes(r) ? '纳入' : '排除'}：${rangeTitle(spec, r.id)}`,
  }))
  const [target, setTarget] = useState<string | null>(() => spec.ranges[0]?.id ?? targets[0]?.value ?? null)
  const [label, setLabel] = useState(() => (question.length > 20 ? `${question.slice(0, 20)}…` : question))
  const looksLikeChar = !!firstColumn && /(^|_)(character_)?id$/i.test(firstColumn)
  const warn = hintKind && hintKind !== 'character' ? `AI 说这个结果是${LIST_KIND_LABEL[hintKind]}，不是角色` : !looksLikeChar ? `第一列叫「${firstColumn ?? '？'}」，看起来不是角色 id` : null

  const submit = () => {
    if (!target) return
    edit('从「问数据」加条件', (s) => {
      const c = { ...newCondition('sql', newId('c', takenIds(s))), sql, label: label.trim() || null }
      const add = (list: typeof s.ranges) => list.map((r) => (r.id === target ? { ...r, conditions: [...r.conditions, c] } : r))
      return { ...s, ranges: add(s.ranges), excludes: add(s.excludes) }
    })
    toast.success(`加到了「${targets.find((t) => t.value === target)?.label ?? ''}」`, {
      id: 'ask-save-cond',
      description: '条件存的是这段 SQL 本身，数据更新后自动重算',
      action: { label: '去工作台看看', onClick: () => nav.go('workbench') },
    })
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {open && (
        <DialogContent title="把这段 SQL 存成工作台的条件" description="存的是查询本身（不是这次的结果）：查询结果里的角色才算满足；数据更新后自动重算。" size="md">
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            {targets.length === 0 ? (
              <p className="text-sm text-fg-2">工作台里还没有范围。先去工作台加一个范围。</p>
            ) : (
              <Field label="加到哪个范围 / 排除项" hint="加到排除项里 = 查询结果里的人会从题库里去掉">
                {({ id }) => <Select id={id} value={target ?? undefined} onChange={setTarget} options={targets} />}
              </Field>
            )}
            <Field label="条件的名字（chip 上显示）">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例：3 部以上百合作品" />}
            </Field>
            {warn && (
              <p className="flex items-start gap-1.5 rounded-md bg-warning-bg px-3 py-2 text-xs text-warning-fg">
                <IconAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                {warn}。条件要求查询的第一列是角色 id（character_id），不然筛不出人。
              </p>
            )}
            <pre className="max-h-40 overflow-auto rounded-md bg-surface-2 px-3 py-2 font-mono text-xs text-fg-2 scroll-thin">{sql}</pre>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                取消
              </Button>
              <Button type="submit" variant="primary" icon={<IconPlus />} disabled={!target}>
                加成条件
              </Button>
            </div>
          </form>
        </DialogContent>
      )}
    </Dialog>
  )
}
