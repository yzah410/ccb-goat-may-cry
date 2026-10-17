/**
 * 清单（/lists）：角色清单 / 作品清单 / 标签清单的增删改。
 * 工作台里：范围的「从哪来」可以是作品清单 / 角色清单；条件可以是「在角色清单里」；标签条件可以加一个标签清单；
 * 排除区可以「排除一个清单」。出题器不预设任何清单内容，清单都由用户自己建。
 */
import { useEffect, useMemo, useState } from 'react'
import { useBlocker } from 'react-router'
import { confirm } from '@/components/ui/Confirm'
import { PageHeader } from '@/app/shell/PageHeader'
import { cn } from '@/lib/cn'
import { fmtInt, relativeTime } from '@/lib/format'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { SegmentedControl } from '@/components/ui/Controls'
import { Dialog, DialogContent } from '@/components/ui/Overlay'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { EmptyState, ErrorState, Skeleton } from '@/components/data-display/Misc'
import { IconFilm, IconListChecks, IconPlus, IconTags, IconUser } from '@/lib/icons'
import { useListsV2, usePlansV2WithSpecs, useSaveList } from '@/features/v2/hooks'
import { LIST_KIND_LABEL } from '@/features/v2/labels'
import type { ListKind, ListV2 } from '@/features/v2/types'
import { listIdsInSpec } from '@/features/workbench2/summary'
import { useWb2 } from '@/features/workbench2/store'
import { ListEditor, type ListUsage } from '@/features/lists/components/ListEditor'

const KINDS: ListKind[] = ['character', 'work', 'tag']
const KIND_ICON = { character: IconUser, work: IconFilm, tag: IconTags } as const
const KIND_HINT: Record<ListKind, string> = {
  character: '例：已经记住的角色（排除它）、某个系列的角色（只从它出题）',
  work: '例：某个系列 / 某家公司的作品（从这些作品里取角色）',
  tag: '例：一组你最关心的作品标签（配合标签条件里的「至少含 N 个」用）',
}

function NewListDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (l: ListV2) => void }) {
  const save = useSaveList()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<ListKind>('character')
  const [note, setNote] = useState('')
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {open && (
        <DialogContent title="新建清单" description="先起名字、选种类，建好之后再往里加东西。" size="sm">
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (!name.trim()) return
              save.mutate(
                { id: null, body: { name: name.trim(), kind, items: [], note: note.trim() || null } },
                {
                  onSuccess: (l) => {
                    onCreated(l)
                    onClose()
                  },
                },
              )
            }}
          >
            <Field label="种类" hint={KIND_HINT[kind]}>
              {() => (
                <SegmentedControl<ListKind>
                  value={kind}
                  onChange={setKind}
                  fullWidth
                  aria-label="清单种类"
                  options={KINDS.map((k) => ({ value: k, label: LIST_KIND_LABEL[k] }))}
                />
              )}
            </Field>
            <Field label="名字">
              {({ id, describedBy }) => (
                <Input id={id} aria-describedby={describedBy} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="例：已经记住的角色" maxLength={80} />
              )}
            </Field>
            <Field label="备注（可以不写）">
              {({ id }) => <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                取消
              </Button>
              <Button type="submit" variant="primary" icon={<IconPlus />} loading={save.isPending} disabled={!name.trim()}>
                建好
              </Button>
            </div>
          </form>
        </DialogContent>
      )}
    </Dialog>
  )
}

/** 清单有没保存的改动时：切到别的页面先问一句；关掉 / 刷新浏览器页签时浏览器自己会问 */
function useGuardUnsaved(dirty: boolean) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname)
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    let alive = true
    void confirm({
      title: '清单有改动还没保存',
      description: '离开这一页会丢掉这些改动。',
      confirmLabel: '丢掉改动，离开',
      tone: 'danger',
    }).then((ok) => {
      if (!alive) return
      if (ok) blocker.proceed()
      else blocker.reset()
    })
    return () => {
      alive = false
    }
  }, [blocker])
  useEffect(() => {
    if (!dirty) return
    const onBefore = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBefore)
    return () => window.removeEventListener('beforeunload', onBefore)
  }, [dirty])
}

export default function ListsPage() {
  const q = useListsV2()
  const { specs } = usePlansV2WithSpecs()
  const draft = useWb2((s) => s.spec)
  const [sel, setSel] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [editorDirty, setEditorDirty] = useState(false)
  useGuardUnsaved(editorDirty)
  const lists = useMemo(() => q.data ?? [], [q.data])
  const selected = lists.find((l) => l.id === sel) ?? lists[0] ?? null

  // 每个清单被哪些方案用到（后端方案 + 工作台现在的草稿）
  const usage = useMemo(() => {
    const m = new Map<string, ListUsage>()
    const get = (id: string) => m.get(id) ?? (m.set(id, { plans: [], inDraft: false }), m.get(id)!)
    for (const [name, spec] of specs) for (const id of listIdsInSpec(spec)) get(id).plans.push(name)
    for (const id of listIdsInSpec(draft)) get(id).inDraft = true
    return m
  }, [specs, draft])
  const usageOf = (id: string): ListUsage => usage.get(id) ?? { plans: [], inDraft: false }
  const select = async (id: string) => {
    if (id === selected?.id) return
    if (editorDirty) {
      const ok = await confirm({
        title: '这个清单有改动还没保存',
        description: '切到别的清单会丢掉这些改动（要留着就先点「保存」）。',
        confirmLabel: '丢掉改动，切换',
        tone: 'danger',
      })
      if (!ok) return
    }
    setEditorDirty(false)
    setSel(id)
  }

  return (
    <>
      <PageHeader
        route="lists"
        title="清单"
        icon={<IconListChecks />}
        description="你自己建的一批角色、作品或标签。工作台里可以从清单里出题、排除一个清单，或者把标签清单当成一组标签用。"
        actions={
          <Button variant="primary" icon={<IconPlus />} onClick={() => setNewOpen(true)}>
            新建清单
          </Button>
        }
      />
      {q.isPending ? (
        <div className="grid gap-5 @4xl/main:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : lists.length === 0 ? (
        <EmptyState
          kind="no-plans"
          size="lg"
          title="还没有清单"
          description="建一个：例如「已经记住的角色」清单，在工作台的排除区里排除它"
          action={
            <Button variant="secondary" icon={<IconPlus />} onClick={() => setNewOpen(true)}>
              新建清单
            </Button>
          }
        />
      ) : (
        <div className="grid items-start gap-5 @4xl/main:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
          <nav aria-label="清单列表" className="flex flex-col gap-4">
            {KINDS.map((k) => {
              const ofKind = lists.filter((l) => l.kind === k)
              const Icon = KIND_ICON[k]
              return (
                <div key={k} className="flex flex-col gap-1">
                  <span className="flex items-center gap-1.5 px-1 text-xs font-medium text-fg-3">
                    <Icon className="size-3.5" aria-hidden />
                    {LIST_KIND_LABEL[k]}（{ofKind.length}）
                  </span>
                  {ofKind.length === 0 ? (
                    <p className="px-1 text-xs text-fg-3">还没有</p>
                  ) : (
                    ofKind.map((l) => {
                      const u = usageOf(l.id)
                      const n = u.plans.length + (u.inDraft ? 1 : 0)
                      const active = selected?.id === l.id
                      return (
                        <button
                          key={l.id}
                          type="button"
                          onClick={() => void select(l.id)}
                          aria-current={active || undefined}
                          className={cn(
                            'flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors',
                            active ? 'border-primary-400 bg-selected' : 'border-border bg-surface-1 hover:border-border-strong',
                          )}
                        >
                          <span className="w-full truncate text-sm font-medium text-fg-1">{l.name}</span>
                          <span className="text-xs text-fg-3">
                            {fmtInt(l.items.length)} 项{n ? ` · ${n} 处在用` : ''}
                            {l.updated ? ` · ${relativeTime(l.updated)}` : ''}
                          </span>
                        </button>
                      )
                    })
                  )}
                </div>
              )
            })}
          </nav>
          {selected ? (
            <ListEditor key={selected.id} list={selected} usage={usageOf(selected.id)} onDirtyChange={setEditorDirty} />
          ) : (
            <Card>
              <EmptyState kind="generic" size="sm" title="选一个清单" />
            </Card>
          )}
        </div>
      )}
      <NewListDialog key={String(newOpen)} open={newOpen} onClose={() => setNewOpen(false)} onCreated={(l) => void select(l.id)} />
    </>
  )
}
