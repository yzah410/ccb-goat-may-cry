/**
 * 编辑一个清单：名字、备注、里面的项（一个一个加 / 粘贴一批）、被哪些方案用到、删除。
 * 改动先在本地攒着，点「保存」才写到后端（PUT /v2/lists/{id}）；后端保存时会按名字补 id，结果写在保存后的提示里。
 */
import { useEffect, useMemo, useState } from 'react'
import { useShellNav } from '@/app/shell/nav'
import { cn } from '@/lib/cn'
import { fmtInt } from '@/lib/format'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Input, Textarea } from '@/components/ui/Input'
import { confirm } from '@/components/ui/Confirm'
import { toast } from '@/components/ui/Toast'
import { TagChip } from '@/components/data-display/TagChip'
import { IconAlert, IconClipboardPaste, IconLoader, IconSave, IconSearch, IconTrash, IconX } from '@/lib/icons'
import { SuggestCombo } from '@/features/v2/components/SuggestCombo'
import { useDeleteList, useSaveList } from '@/features/v2/hooks'
import { LIST_KIND_LABEL } from '@/features/v2/labels'
import type { ListItemV2, ListV2, SuggestItem } from '@/features/v2/types'
import { mergeItems, parsePasted, resolvePasted, type ResolveOutcome } from '../resolve'

const itemKey = (it: ListItemV2) => (it.id != null ? `i:${it.id}` : `n:${it.name}`)

export interface ListUsage {
  plans: string[]
  inDraft: boolean
}

function PastePanel({ list, onAdd }: { list: ListV2; onAdd: (items: ListItemV2[]) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null)
  const [out, setOut] = useState<ResolveOutcome | null>(null)
  const run = async () => {
    const parsed = parsePasted(text, list.kind)
    if (!parsed.ids.length && !parsed.names.length) return
    setBusy({ done: 0, total: parsed.names.length })
    const r = await resolvePasted(list.kind, parsed, (done, total) => setBusy({ done, total }))
    setBusy(null)
    setOut(r)
    onAdd(r.added)
    setText('')
  }
  const addOne = (it: SuggestItem, name: string) => {
    onAdd([list.kind === 'tag' ? { name: it.value } : { id: it.id, name: it.value }])
    setOut((o) => (o ? { ...o, unresolved: o.unresolved.filter((u) => u.name !== name) } : o))
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-bg-elevated p-3">
      <span className="flex items-center gap-1.5 text-sm font-medium text-fg-1">
        <IconClipboardPaste className="size-4 text-fg-3" aria-hidden />
        粘贴一批
      </span>
      <Textarea
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={list.kind === 'tag' ? '一行一个标签（也可以用逗号、顿号隔开）' : '一行一个：名字，或者 Bangumi id（纯数字）'}
        aria-label="粘贴一批"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" loading={!!busy} disabled={!text.trim()} onClick={() => void run()}>
          解析并加进来
        </Button>
        {busy && (
          <span className="tabular flex items-center gap-1 text-xs text-fg-3">
            <IconLoader className="size-3.5 animate-spin" aria-hidden />
            正在对号 {busy.done} / {busy.total}
          </span>
        )}
      </div>
      {out && (
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-fg-2">
            加进来 <b className="tabular text-fg-1">{fmtInt(out.added.length)}</b> 项
            {out.added.some((i) => i.id != null && !i.name) && <span className="text-xs text-fg-3">（按 id 加的，名字在保存后由后端补上）</span>}
          </p>
          {out.ambiguous.length > 0 && (
            <div className="rounded-md bg-info-bg px-3 py-2 text-xs text-info-fg">
              <p className="font-medium">这些有同名的，先用了热度最高的那个：</p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {out.ambiguous.map((a) => (
                  <li key={a.name}>
                    「{a.name}」→ {a.picked.label}
                    <span className="ml-1 opacity-80">（还有：{a.candidates.slice(1, 4).map((c) => c.label).join('、')}）</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {out.unresolved.length > 0 && (
            <div className="rounded-md bg-warning-bg px-3 py-2 text-xs text-warning-fg">
              <p className="font-medium">这些在库里对不上，没加：</p>
              <ul className="mt-1 flex flex-col gap-1">
                {out.unresolved.map((u) => (
                  <li key={u.name} className="flex flex-wrap items-center gap-1.5">
                    <span>「{u.name}」</span>
                    {u.near.length > 0 ? (
                      <>
                        <span className="opacity-80">最接近：</span>
                        {u.near.map((n) => (
                          <button key={`${n.value}-${n.id ?? ''}`} type="button" onClick={() => addOne(n, u.name)} className="rounded-full px-1.5 py-0.5 ring-1 ring-inset ring-current hover:bg-surface-1">
                            + {n.label}
                          </button>
                        ))}
                      </>
                    ) : (
                      <span className="opacity-80">（一个相近的都没有）</span>
                    )}
                    {list.kind === 'tag' && (
                      <button type="button" onClick={() => addOne({ value: u.name, label: u.name, count: 0 }, u.name)} className="underline">
                        仍然按原样加
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ListEditor({ list, usage, onDirtyChange }: { list: ListV2; usage: ListUsage; onDirtyChange?: (dirty: boolean) => void }) {
  const nav = useShellNav()
  const save = useSaveList()
  const del = useDeleteList()
  const [name, setName] = useState(list.name)
  const [note, setNote] = useState(list.note ?? '')
  const [items, setItems] = useState<ListItemV2[]>(list.items)
  const [filter, setFilter] = useState('')
  const [report, setReport] = useState<ListV2['resolve_report']>(null)
  const dirty = name.trim() !== list.name || (note.trim() || '') !== (list.note ?? '') || JSON.stringify(items) !== JSON.stringify(list.items)
  // 告诉清单页「有没保存的改动」：切换清单 / 离开页面前要问一句
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  const shown = useMemo(() => {
    const k = filter.trim().toLowerCase()
    return k ? items.filter((i) => i.name.toLowerCase().includes(k) || String(i.id ?? '').includes(k)) : items
  }, [items, filter])

  const add = (incoming: ListItemV2[]) => {
    const r = mergeItems(items, incoming)
    setItems(r.items)
    if (r.added < incoming.length) toast.info(`有 ${incoming.length - r.added} 项本来就在清单里`, { id: 'list-dup' })
  }
  const onSave = () =>
    save.mutate(
      { id: list.id, body: { name: name.trim() || list.name, kind: list.kind, items, note: note.trim() || null } },
      {
        onSuccess: (saved) => {
          // 后端保存时会按名字补 id、按 id 补名字：用它返回的内容，和刷新后的列表对得上（不会误报「有改动」）
          if (saved?.items) setItems(saved.items)
          if (saved?.name) setName(saved.name)
          setNote(saved?.note ?? '')
          setReport(saved?.resolve_report ?? null)
        },
      },
    )
  const onDelete = async () => {
    const users = [...usage.plans, ...(usage.inDraft ? ['工作台现在的方案'] : [])]
    const ok = await confirm({
      title: `删除清单「${list.name}」？`,
      description: users.length ? `这些地方用到了它，删了之后它们会找不到这个清单：${users.join('、')}。` : '删了就找不回来了。',
      confirmLabel: '删除',
      tone: 'danger',
    })
    if (ok) del.mutate(list)
  }

  return (
    <Card className="@container p-5" data-slot="list-editor">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="清单名字" className="text-lg font-semibold" />
          </div>
          <Badge tone="neutral" className="mt-2">
            {LIST_KIND_LABEL[list.kind]}
          </Badge>
        </div>
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（可以不写）：这个清单是干什么用的" aria-label="备注" />

        <div className="flex flex-wrap items-center gap-2 text-xs text-fg-3">
          <span>
            被这些地方用到：
            {usage.plans.length || usage.inDraft ? (
              <span className="text-fg-2">
                {[...usage.plans.map((p) => `方案「${p}」`), ...(usage.inDraft ? ['工作台现在的方案'] : [])].join('、')}
              </span>
            ) : (
              <span>还没有</span>
            )}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-fg-1">
            里面有 <span className="tabular">{fmtInt(items.length)}</span> 项
          </span>
          {items.length > 12 && (
            <div className="ml-auto w-full max-w-56">
              <Input size="sm" leading={<IconSearch />} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="在清单里找…" aria-label="在清单里找" />
            </div>
          )}
        </div>

        {items.length === 0 ? (
          <p className="rounded-md border border-dashed border-border-strong px-4 py-6 text-center text-sm text-fg-3">还是空的：在下面一个一个加，或者粘贴一批。</p>
        ) : list.kind === 'tag' ? (
          <div className="flex flex-wrap gap-1.5">
            {shown.map((it) => (
              <TagChip key={itemKey(it)} kind="genre" label={it.name} size="md" emoji={null} onRemove={() => setItems(items.filter((x) => itemKey(x) !== itemKey(it)))} />
            ))}
          </div>
        ) : (
          <ul className="grid max-h-96 grid-cols-1 gap-1 overflow-y-auto scroll-thin @xl:grid-cols-2">
            {shown.map((it) => (
              <li key={itemKey(it)} className="flex items-center gap-2 rounded-md bg-surface-2 px-2.5 py-1.5 text-sm">
                <span className={cn('min-w-0 flex-1 truncate', it.name ? 'text-fg-1' : 'text-fg-3')}>{it.name || '（保存后补名字）'}</span>
                {it.id != null && <span className="shrink-0 font-mono text-xs text-fg-3">#{it.id}</span>}
                <button
                  type="button"
                  aria-label={`移除 ${it.name || it.id}`}
                  onClick={() => setItems(items.filter((x) => itemKey(x) !== itemKey(it)))}
                  className="grid size-6 shrink-0 place-items-center rounded-sm text-fg-3 hover:bg-surface-3 hover:text-fg-1"
                >
                  <IconX className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-fg-1">一个一个加</span>
          <SuggestCombo
            kind={list.kind === 'character' ? 'character' : list.kind === 'work' ? 'work' : 'game_tag'}
            allowFree={list.kind === 'tag'}
            exclude={list.kind === 'tag' ? items.map((i) => i.name) : []}
            size="md"
            placeholder={list.kind === 'character' ? '输入角色名（中文名、原名都行）' : list.kind === 'work' ? '输入作品名' : '输入标签'}
            onPick={(p) => add([list.kind === 'tag' ? { name: p.value } : { id: p.item?.id, name: p.value }])}
          />
        </div>

        <PastePanel list={list} onAdd={add} />

        {report && ((report.unresolved?.length ?? 0) > 0 || (report.ambiguous?.length ?? 0) > 0) && (
          <div className="flex items-start gap-2 rounded-md bg-warning-bg px-3 py-2 text-xs text-warning-fg">
            <IconAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>
              保存时后端按名字对号：
              {!!report.unresolved?.length && <>对不上 {report.unresolved.length} 个（{report.unresolved.slice(0, 5).join('、')}）；</>}
              {!!report.ambiguous?.length && <>有同名、先用了第一个的 {report.ambiguous.length} 个（{report.ambiguous.slice(0, 3).map((a) => a.name).join('、')}）</>}
            </span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Button variant="soft" icon={<IconSave />} loading={save.isPending} disabled={!dirty || !name.trim()} onClick={onSave}>
            保存
          </Button>
          {dirty ? <Badge tone="warning">有改动还没保存</Badge> : <span className="text-xs text-fg-3">已保存</span>}
          <Button variant="ghost" size="sm" onClick={() => nav.go('workbench')}>
            去工作台用它
          </Button>
          <Button variant="danger-ghost" size="sm" icon={<IconTrash />} className="ml-auto" loading={del.isPending} onClick={() => void onDelete()}>
            删除清单
          </Button>
        </div>
      </div>
    </Card>
  )
}
