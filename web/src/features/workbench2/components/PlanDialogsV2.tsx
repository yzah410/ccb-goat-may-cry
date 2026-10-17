/**
 * 工作台的方案对话框（和经典工作台的方案分开存：data/plans_v2/）：
 * - 另存为：默认名「月日-时分」；同名提示会覆盖
 * - 打开：搜索、↑↓ 选、回车 / 双击打开、删除选中
 * 在 RootLayout 里挂一次，工作台、方案页、命令面板都能打开。
 */
import { useMemo, useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/cn'
import { fmtDateTime, relativeTime } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Dialog, DialogContent } from '@/components/ui/Overlay'
import { Field, Input } from '@/components/ui/Input'
import { EmptyState, ErrorState, Loading } from '@/components/data-display/Misc'
import { IconFolderOpen, IconSave, IconSearch, IconTrash } from '@/lib/icons'
import { suggestPlanName, validatePlanName } from '@/features/plans/api'
import { usePlansV2 } from '@/features/v2/hooks'
import { useWb2 } from '../store'
import { useDeletePlanV2, useLoadPlanV2, useSavePlanV2 } from '../hooks'
import { usePlanDialogsV2 } from '../planDialogs'

function SaveAsBody({ onDone }: { onDone: () => void }) {
  const planName = useWb2((s) => s.planName)
  const [name, setName] = useState(() => suggestPlanName())
  const list = usePlansV2()
  const save = useSavePlanV2()
  const error = validatePlanName(name)
  const exists = !!list.data?.some((p) => p.name === name.trim())
  const submit = () => {
    if (error || save.isPending) return
    save.mutate(name.trim(), { onSuccess: onDone })
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      className="flex flex-col gap-4"
    >
      <Field
        label="方案名"
        error={name.trim() ? error : undefined}
        hint={
          exists ? (
            <span className="text-warning-fg">已经有叫「{name.trim()}」的方案了，保存会直接覆盖它。</span>
          ) : planName ? (
            `现在打开的是「${planName}」；换个名字就是另存一份`
          ) : (
            '默认用「月日-时分」起名'
          )
        }
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={name}
            onChange={(e) => setName(e.target.value)}
            invalid={!!name.trim() && !!error}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            placeholder="例如 0101-1200"
          />
        )}
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>
          取消
        </Button>
        <Button type="submit" variant={exists ? 'danger' : 'primary'} icon={<IconSave />} loading={save.isPending} disabled={!!error}>
          {exists ? '覆盖保存' : '保存'}
        </Button>
      </div>
    </form>
  )
}

function OpenBody({ onDone }: { onDone: () => void }) {
  const list = usePlansV2()
  const load = useLoadPlanV2()
  const del = useDeletePlanV2()
  const current = useWb2((s) => s.planName)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const plans = useMemo(
    () => [...(list.data ?? [])].sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')) || a.name.localeCompare(b.name)),
    [list.data],
  )
  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase()
    return k ? plans.filter((p) => p.name.toLowerCase().includes(k) || (p.note ?? '').toLowerCase().includes(k)) : plans
  }, [plans, q])
  const selected = sel && filtered.some((p) => p.name === sel) ? sel : (filtered[0]?.name ?? null)

  const doLoad = async (name: string | null) => {
    if (!name || busy) return
    setBusy(true)
    const ok = await load(name)
    setBusy(false)
    if (ok) onDone()
  }
  const onKey = (e: KeyboardEvent) => {
    const i = Math.max(0, filtered.findIndex((p) => p.name === selected))
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel(filtered[Math.min(filtered.length - 1, i + 1)]?.name ?? null)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel(filtered[Math.max(0, i - 1)]?.name ?? null)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void doLoad(selected)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Input autoFocus leading={<IconSearch />} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="搜索方案名…" aria-label="搜索方案名" />
      <p className="text-xs text-fg-3">
        {q.trim() ? `匹配 ${filtered.length} / ${plans.length} 个` : `共 ${plans.length} 个方案`} · ↑↓ 选择，回车打开，双击也能打开
      </p>
      <div role="listbox" aria-label="方案列表" tabIndex={0} onKeyDown={onKey} className="h-72 overflow-y-auto rounded-md border border-border bg-surface-1 p-1 scroll-thin">
        {list.isPending ? (
          <Loading label="正在读方案列表…" />
        ) : list.isError ? (
          <ErrorState error={list.error} size="sm" onRetry={() => void list.refetch()} />
        ) : filtered.length === 0 ? (
          <EmptyState
            kind={plans.length ? 'search-empty' : 'no-plans'}
            size="sm"
            title={plans.length ? `没有名字里带「${q.trim()}」的方案` : '还没保存过方案'}
            description={plans.length ? undefined : '在工作台调好之后点「保存」'}
          />
        ) : (
          filtered.map((p) => {
            const active = p.name === selected
            return (
              <div
                key={p.name}
                role="option"
                aria-selected={active}
                onClick={() => setSel(p.name)}
                onDoubleClick={() => void doLoad(p.name)}
                className={cn('flex cursor-pointer items-center gap-3 rounded-sm px-3 py-2 text-sm', active ? 'bg-primary-100 text-primary-900' : 'text-fg-1 hover:bg-surface-2')}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium">{p.name}</span>
                    {p.name === current && (
                      <Badge tone="primary" size="sm">
                        正在编辑
                      </Badge>
                    )}
                  </span>
                  {p.note && <span className="block truncate text-xs text-fg-3">{p.note}</span>}
                </span>
                <span className="tabular w-20 shrink-0 text-right text-xs text-fg-3" title={p.updated ? fmtDateTime(p.updated) : undefined}>
                  {p.updated ? relativeTime(p.updated) : ''}
                </span>
              </div>
            )
          })
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="danger-ghost" icon={<IconTrash />} disabled={!selected} onClick={() => selected && void del(selected)}>
          删除选中
        </Button>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={onDone}>
            取消
          </Button>
          <Button variant="primary" icon={<IconFolderOpen />} disabled={!selected} loading={busy} onClick={() => void doLoad(selected)}>
            打开
          </Button>
        </div>
      </div>
    </div>
  )
}

export function PlanDialogsV2() {
  const s = usePlanDialogsV2()
  return (
    <>
      <Dialog open={s.saveAsOpen} onOpenChange={(o) => !o && s.close()}>
        {s.saveAsOpen && (
          <DialogContent title="另存为方案" description="存到后端 data/plans_v2/。" size="sm">
            <SaveAsBody onDone={s.close} />
          </DialogContent>
        )}
      </Dialog>
      <Dialog open={s.openOpen} onOpenChange={(o) => !o && s.close()}>
        {s.openOpen && (
          <DialogContent title="打开方案" description="打开后会换掉现在的方案（可以用「撤销」找回来）。">
            <OpenBody onDone={s.close} />
          </DialogContent>
        )}
      </Dialog>
    </>
  )
}
