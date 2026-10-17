/**
 * 经典工作台的全局方案对话框（在 RootLayout 里挂一次，任何地方都能打开）：
 * - 另存为：起名字（默认「月日-时分」）→ 保存；同名会提示「会覆盖」
 * - 打开方案：「打开经典工作台方案」弹窗（搜索、计数、键盘上下选、回车加载、双击加载、删除选中）
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { create } from 'zustand'
import { cn } from '@/lib/cn'
import { fmtDateTime, relativeTime } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Dialog, DialogContent } from '@/components/ui/Overlay'
import { Field, Input } from '@/components/ui/Input'
import { EmptyState, ErrorState, Loading } from '@/components/data-display/Misc'
import { IconFolderOpen, IconSave, IconSearch, IconTrash } from '@/lib/icons'
import { useDraft } from '@/features/blocks/store'
import { MODE_LABEL, type DrawMode } from '@/features/blocks/schema'
import { suggestPlanName, validatePlanName, type PlanSummary } from '../api'
import { useDeletePlan, useLoadPlan, usePlansList, useSavePlan } from '../hooks'

interface PlanDialogsState {
  saveAsOpen: boolean
  loadOpen: boolean
  openSaveAs: () => void
  openLoad: () => void
  close: () => void
}

export const usePlanDialogs = create<PlanDialogsState>((set) => ({
  saveAsOpen: false,
  loadOpen: false,
  openSaveAs: () => set({ saveAsOpen: true, loadOpen: false }),
  openLoad: () => set({ loadOpen: true, saveAsOpen: false }),
  close: () => set({ saveAsOpen: false, loadOpen: false }),
}))

/** 「保存」：有方案名就直接覆盖保存，没有就弹「另存为」 */
export function useQuickSave() {
  const save = useSavePlan()
  const openSaveAs = usePlanDialogs((s) => s.openSaveAs)
  return {
    save: () => {
      const name = useDraft.getState().planName
      if (name) save.mutate(name)
      else openSaveAs()
    },
    isPending: save.isPending,
  }
}

export function planBlocksText(p: PlanSummary): string | null {
  if (!p.blocks) return p.block_count != null ? `${p.block_count} 个组块` : null
  const red = p.blocks.filter((b) => b.color === 'red').length
  const blue = p.blocks.length - red
  const off = p.blocks.filter((b) => !b.enabled).length
  return `${p.blocks.length} 个组块 · 纳入 ${red} · 排除 ${blue}${off ? ` · 停用 ${off}` : ''}`
}

// ---------------------------------------------------------------- 另存为
function SaveAsBody({ onDone }: { onDone: () => void }) {
  const planName = useDraft((s) => s.planName)
  const [name, setName] = useState(() => suggestPlanName())
  const list = usePlansList()
  const save = useSavePlan()
  const error = validatePlanName(name)
  const exists = !!list.data?.plans.some((p) => p.name === name.trim())
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
            `当前方案是「${planName}」；换个名字就是另存一份`
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

// ---------------------------------------------------------------- 打开方案
function LoadBody({ onDone }: { onDone: () => void }) {
  const list = usePlansList()
  const load = useLoadPlan()
  const del = useDeletePlan()
  const current = useDraft((s) => s.planName)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const plans = useMemo(() => list.data?.plans ?? [], [list.data])
  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase()
    return k ? plans.filter((p) => p.name.toLowerCase().includes(k)) : plans
  }, [plans, q])

  // 选中项被过滤掉时自动选第一条
  const selected = sel && filtered.some((p) => p.name === sel) ? sel : (filtered[0]?.name ?? null)

  useEffect(() => {
    if (!selected) return
    listRef.current?.querySelector(`[data-plan="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const doLoad = async (name: string | null) => {
    if (!name || busy) return
    setBusy(true)
    const ok = await load(name)
    setBusy(false)
    if (ok) onDone()
  }

  const move = (delta: number) => {
    if (!filtered.length) return
    const i = Math.max(0, filtered.findIndex((p) => p.name === selected))
    const j = Math.min(filtered.length - 1, Math.max(0, i + delta))
    setSel(filtered[j]!.name)
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void doLoad(selected)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Input
        autoFocus
        leading={<IconSearch />}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKey}
        placeholder="搜索方案名…"
        aria-label="搜索方案名"
        aria-controls="plan-listbox"
      />
      <p className="text-xs text-fg-3">
        {q.trim() ? `匹配 ${filtered.length} / ${plans.length} 个方案` : `共 ${plans.length} 个方案`}
        {' · '}↑↓ 选择，回车加载，双击也能加载
      </p>
      <div
        ref={listRef}
        id="plan-listbox"
        role="listbox"
        aria-label="方案列表"
        tabIndex={0}
        onKeyDown={onKey}
        className="h-80 overflow-y-auto rounded-md border border-border bg-surface-1 p-1 scroll-thin focus-visible:outline-2 focus-visible:outline-ring"
      >
        {list.isPending ? (
          <Loading label="正在读方案列表…" />
        ) : list.isError ? (
          <ErrorState error={list.error} size="sm" onRetry={() => void list.refetch()} />
        ) : filtered.length === 0 ? (
          <EmptyState
            kind={plans.length ? 'search-empty' : 'no-plans'}
            size="sm"
            title={plans.length ? `没有名字里带「${q.trim()}」的方案` : '还没有保存过方案'}
          />
        ) : (
          filtered.map((p) => {
            const active = p.name === selected
            return (
              <div
                key={p.name}
                role="option"
                aria-selected={active}
                data-plan={p.name}
                onClick={() => setSel(p.name)}
                onDoubleClick={() => void doLoad(p.name)}
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-sm px-3 py-2 text-sm',
                  active ? 'bg-primary-100 text-primary-900' : 'text-fg-1 hover:bg-surface-2',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium">{p.name}</span>
                    {p.name === current && <Badge tone="primary" size="sm">正在编辑</Badge>}
                  </span>
                  {planBlocksText(p) && <span className="block truncate text-xs text-fg-3">{planBlocksText(p)}</span>}
                </span>
                <Badge size="sm" tone="neutral">
                  {MODE_LABEL[p.mode as DrawMode] ?? p.mode}
                </Badge>
                <span className="tabular w-20 shrink-0 text-right text-xs text-fg-3" title={fmtDateTime(p.updated_at)}>
                  {relativeTime(p.updated_at)}
                </span>
              </div>
            )
          })
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="danger-ghost"
          icon={<IconTrash />}
          disabled={!selected}
          onClick={() => selected && void del(selected)}
        >
          删除选中
        </Button>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={onDone}>
            取消
          </Button>
          <Button variant="primary" icon={<IconFolderOpen />} disabled={!selected} loading={busy} onClick={() => void doLoad(selected)}>
            加载
          </Button>
        </div>
      </div>
    </div>
  )
}

export function PlanDialogs() {
  const s = usePlanDialogs()
  return (
    <>
      <Dialog open={s.saveAsOpen} onOpenChange={(o) => !o && s.close()}>
        {s.saveAsOpen && (
          <DialogContent title="另存为经典工作台方案" description="把当前的组块、抽题方式、种子、额外标签开关存到后端（data/plans/）。" size="sm">
            <SaveAsBody onDone={s.close} />
          </DialogContent>
        )}
      </Dialog>
      <Dialog open={s.loadOpen} onOpenChange={(o) => !o && s.close()}>
        {s.loadOpen && (
          <DialogContent title="打开经典工作台方案" description="加载后会整体替换当前的组块和设置。">
            <LoadBody onDone={s.close} />
          </DialogContent>
        )}
      </Dialog>
    </>
  )
}
