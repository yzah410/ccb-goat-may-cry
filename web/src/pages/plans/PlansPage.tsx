import { useMemo, useState } from 'react'
import { PageHeader } from '@/app/shell/PageHeader'
import { useShellNav } from '@/app/shell/nav'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { Dialog, DialogContent, Tooltip } from '@/components/ui/Overlay'
import { Field, Input } from '@/components/ui/Input'
import { EmptyState, ErrorState, Skeleton } from '@/components/data-display/Misc'
import { IconCopyPlus, IconDownload, IconFolderOpen, IconLayers, IconSave, IconSearch, IconTrash, IconWorkbench } from '@/lib/icons'
import { fmtDate, fmtDateTime, fmtInt, relativeTime } from '@/lib/format'
import { cn } from '@/lib/cn'
import { useDraft, useIsDirty } from '@/features/blocks/store'
import { KIND_LABEL, MODE_LABEL, type BlockKind, type DrawMode } from '@/features/blocks/schema'
import { KIND_ICON } from '@/features/blocks/components/BlockList'
import { validatePlanName, type PlanSummary } from '@/features/plans/api'
import { useDeletePlan, useDuplicatePlan, useLoadPlan, usePlansList } from '@/features/plans/hooks'
import { usePlanDialogs, useQuickSave } from '@/features/plans/components/PlanDialogs'
import { Tabs, TabsContent, TabsList } from '@/components/ui/Controls'
import { toast } from '@/components/ui/Toast'
import { errorText } from '@/lib/apiClient'
import { v2Api } from '@/features/v2/api'
import { useInvalidatePlansV2, usePlansV2, usePlansV2WithSpecs } from '@/features/v2/hooks'
import { normalizeSpec } from '@/features/workbench2/spec'
import { specBrief } from '@/features/workbench2/summary'
import { useIsDirtyV2, useWb2 } from '@/features/workbench2/store'
import { useDeletePlanV2, useLoadPlanV2 } from '@/features/workbench2/hooks'
import { usePlanDialogsV2, useQuickSaveV2 } from '@/features/workbench2/planDialogs'
import { useClassicAvailable, useClassicStatus, useLoadSamples } from '@/features/classic/api'

const PAGE = 30

function BlockSummary({ p }: { p: PlanSummary }) {
  if (!p.blocks) return p.block_count != null ? <span className="text-sm text-fg-3">{p.block_count} 个组块</span> : null
  const byKind = new Map<BlockKind, number>()
  for (const b of p.blocks) byKind.set(b.kind, (byKind.get(b.kind) ?? 0) + 1)
  const red = p.blocks.filter((b) => b.color === 'red').length
  const blue = p.blocks.length - red
  const off = p.blocks.filter((b) => !b.enabled).length
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-2">
      {[...byKind.entries()].map(([k, n]) => {
        const Icon = KIND_ICON[k]
        return (
          <span key={k} className="inline-flex items-center gap-1">
            <Icon className="size-3.5 text-fg-3" aria-hidden />
            {KIND_LABEL[k]} ×{n}
          </span>
        )
      })}
      <span className="text-fg-3">
        纳入 {red} · 排除 {blue}
        {off ? ` · 停用 ${off}` : ''}
      </span>
    </span>
  )
}

function DuplicateDialog({ from, onClose }: { from: string | null; onClose: () => void }) {
  const dup = useDuplicatePlan()
  const list = usePlansList()
  const [name, setName] = useState(() => (from ? `${from}-副本` : ''))
  const err = validatePlanName(name)
  const exists = !!list.data?.plans.some((p) => p.name === name.trim())
  return (
    <Dialog open={!!from} onOpenChange={(o) => !o && onClose()}>
      {from && (
        <DialogContent title={`复制「${from}」`} description="把这个方案原样存一份到新名字（不影响正在编辑的方案）。" size="sm">
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (err) return
              dup.mutate({ from, to: name.trim() }, { onSuccess: onClose })
            }}
          >
            <Field label="新名字" error={name.trim() ? err : undefined} hint={exists ? '已经有这个名字了，会覆盖它' : undefined}>
              {({ id, describedBy }) => (
                <Input id={id} aria-describedby={describedBy} value={name} onChange={(e) => setName(e.target.value)} autoFocus invalid={!!err && !!name.trim()} />
              )}
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                取消
              </Button>
              <Button type="submit" variant={exists ? 'danger' : 'primary'} icon={<IconCopyPlus />} loading={dup.isPending} disabled={!!err}>
                {exists ? '覆盖复制' : '复制'}
              </Button>
            </div>
          </form>
        </DialogContent>
      )}
    </Dialog>
  )
}

/** 经典方案（data/plans/，经典工作台用）；加载后回经典工作台 */
function ClassicPlansSection() {
  const nav = useShellNav()
  const list = usePlansList()
  const load = useLoadPlan()
  const del = useDeletePlan()
  const samples = useLoadSamples()
  const samplePlans = useClassicStatus().data?.sample_plans ?? 0
  const current = useDraft((s) => s.planName)
  const dirty = useIsDirty()
  const [q, setQ] = useState('')
  const [shown, setShown] = useState(PAGE)
  const [dupFrom, setDupFrom] = useState<string | null>(null)
  const [loading, setLoading] = useState<string | null>(null)

  const plans = useMemo(() => list.data?.plans ?? [], [list.data])
  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase()
    return k ? plans.filter((p) => p.name.toLowerCase().includes(k)) : plans
  }, [plans, q])
  const visible = filtered.slice(0, shown)

  const doLoad = async (name: string) => {
    setLoading(name)
    const ok = await load(name)
    setLoading(null)
    if (ok) nav.go('classic')
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-3">
          经典工作台正在编辑：<span className="font-medium text-fg-1">{current ?? '未命名'}</span>
          {dirty && <span className="ml-2 text-warning-fg">（有改动还没保存）</span>}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-full max-w-sm">
            <Input
              leading={<IconSearch />}
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setShown(PAGE)
              }}
              placeholder="搜索方案名…"
              aria-label="搜索方案名"
            />
          </div>
          <span className="text-sm text-fg-3">
            {q.trim() ? `匹配 ${fmtInt(filtered.length)} / ${fmtInt(plans.length)} 个方案` : `共 ${fmtInt(plans.length)} 个方案`}
          </span>
          {samplePlans > 0 && (
            <Tooltip content={`把仓库附带的 ${fmtInt(samplePlans)} 个样例方案放进方案库；已有同名方案的不会被覆盖`}>
              <Button size="sm" variant="secondary" icon={<IconDownload />} loading={samples.isPending} onClick={() => samples.mutate()}>
                载入样例方案
              </Button>
            </Tooltip>
          )}
        </div>

        {list.isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : filtered.length === 0 ? (
          <EmptyState
            kind={plans.length ? 'search-empty' : 'no-plans'}
            size="lg"
            title={plans.length ? `没有名字里带「${q.trim()}」的方案` : '还没有保存过方案'}
            description={plans.length ? '换个关键词试试' : `在经典工作台调好组块后点「保存」${samplePlans > 0 ? '，或者点上面的「载入样例方案」' : ''}`}
            action={
              !plans.length && (
                <Button variant="secondary" onClick={() => nav.go('classic')}>
                  去经典工作台
                </Button>
              )
            }
          />
        ) : (
          <Card className="divide-y divide-border">
            {visible.map((p) => {
              const isCurrent = p.name === current
              return (
                <div
                  key={p.name}
                  data-plan={p.name}
                  className={cn(
                    'grid items-center gap-x-4 gap-y-2 px-4 py-3 @3xl/main:grid-cols-[minmax(0,1fr)_auto]',
                    isCurrent && 'bg-selected',
                  )}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void doLoad(p.name)}
                        className="truncate text-left text-base font-semibold text-fg-1 hover:underline"
                        title="加载这个方案"
                      >
                        {p.name}
                      </button>
                      {isCurrent && <Badge tone="primary" size="sm">正在编辑</Badge>}
                      <Badge size="sm">{MODE_LABEL[p.mode as DrawMode] ?? (p.mode || '—')}</Badge>
                      {p.seed != null && <Badge size="sm" tone="outline">种子 {p.seed}</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
                      <BlockSummary p={p} />
                      <Tooltip content={`最后修改：${fmtDateTime(p.updated_at)}${p.created_at ? `；创建：${fmtDateTime(p.created_at)}` : ''}`}>
                        <span className="tabular text-xs text-fg-3">
                          改于 {relativeTime(p.updated_at)}
                          {p.created_at ? ` · 建于 ${fmtDate(p.created_at)}` : ''}
                        </span>
                      </Tooltip>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="soft" icon={<IconFolderOpen />} loading={loading === p.name} onClick={() => void doLoad(p.name)}>
                      加载
                    </Button>
                    <Button size="sm" variant="ghost" icon={<IconCopyPlus />} onClick={() => setDupFrom(p.name)}>
                      复制一份
                    </Button>
                    <Tooltip content="删除（会先问你）">
                      <Button size="icon-sm" variant="danger-ghost" aria-label={`删除 ${p.name}`} onClick={() => void del(p.name)}>
                        <IconTrash />
                      </Button>
                    </Tooltip>
                  </div>
                </div>
              )
            })}
          </Card>
        )}

        {filtered.length > shown && (
          <div className="flex flex-col items-center gap-2">
            <p className="text-sm text-fg-3">
              显示了 {fmtInt(shown)} / {fmtInt(filtered.length)} 个
            </p>
            <Button variant="secondary" onClick={() => setShown((n) => n + PAGE)}>
              再显示 {Math.min(PAGE, filtered.length - shown)} 个
            </Button>
          </div>
        )}
      </div>
      <DuplicateDialog key={dupFrom ?? ''} from={dupFrom} onClose={() => setDupFrom(null)} />
    </>
  )
}

// ---------------------------------------------------------------- 工作台方案（data/plans_v2/）
function V2DuplicateDialog({ from, onClose }: { from: string | null; onClose: () => void }) {
  const list = usePlansV2()
  const invalidate = useInvalidatePlansV2()
  const [name, setName] = useState(() => (from ? `${from}-副本` : ''))
  const [busy, setBusy] = useState(false)
  const err = validatePlanName(name)
  const exists = !!list.data?.some((p) => p.name === name.trim())
  const submit = async () => {
    if (!from || err || busy) return
    setBusy(true)
    try {
      const { spec } = normalizeSpec(await v2Api.plan(from))
      const now = new Date().toISOString()
      await v2Api.savePlan(name.trim(), { ...spec, meta: { ...(spec.meta ?? {}), name: name.trim(), created: now, updated: now } })
      invalidate()
      toast.success(`复制成了「${name.trim()}」`)
      onClose()
    } catch (e) {
      toast.error('复制失败', { description: errorText(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!from} onOpenChange={(o) => !o && onClose()}>
      {from && (
        <DialogContent title={`复制「${from}」`} description="把这个方案原样存一份到新名字（不影响正在编辑的方案）。" size="sm">
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <Field label="新名字" error={name.trim() ? err : undefined} hint={exists ? '已经有这个名字了，会覆盖它' : undefined}>
              {({ id, describedBy }) => (
                <Input id={id} aria-describedby={describedBy} value={name} onChange={(e) => setName(e.target.value)} autoFocus invalid={!!err && !!name.trim()} />
              )}
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                取消
              </Button>
              <Button type="submit" variant={exists ? 'danger' : 'primary'} icon={<IconCopyPlus />} loading={busy} disabled={!!err}>
                {exists ? '覆盖复制' : '复制'}
              </Button>
            </div>
          </form>
        </DialogContent>
      )}
    </Dialog>
  )
}

function V2PlansSection() {
  const nav = useShellNav()
  const { list, specs, specsPending } = usePlansV2WithSpecs()
  const load = useLoadPlanV2()
  const del = useDeletePlanV2()
  const current = useWb2((s) => s.planName)
  const dirty = useIsDirtyV2()
  const [q, setQ] = useState('')
  const [dupFrom, setDupFrom] = useState<string | null>(null)
  const [loading, setLoading] = useState<string | null>(null)

  const plans = useMemo(
    () => [...(list.data ?? [])].sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')) || a.name.localeCompare(b.name)),
    [list.data],
  )
  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase()
    return k ? plans.filter((p) => p.name.toLowerCase().includes(k) || (p.note ?? '').toLowerCase().includes(k)) : plans
  }, [plans, q])

  const doLoad = async (name: string) => {
    setLoading(name)
    const ok = await load(name)
    setLoading(null)
    if (ok) nav.go('workbench')
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-fg-3">
        工作台正在编辑：<span className="font-medium text-fg-1">{current ?? '未命名'}</span>
        {dirty && <span className="ml-2 text-warning-fg">（有改动还没保存）</span>}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-full max-w-sm">
          <Input leading={<IconSearch />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索方案名…" aria-label="搜索方案" />
        </div>
        <span className="text-sm text-fg-3">
          {q.trim() ? `匹配 ${fmtInt(filtered.length)} / ${fmtInt(plans.length)} 个方案` : `共 ${fmtInt(plans.length)} 个方案`}
        </span>
      </div>
      {list.isPending ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : filtered.length === 0 ? (
        <EmptyState
          kind={plans.length ? 'search-empty' : 'no-plans'}
          size="lg"
          title={plans.length ? `没有名字里带「${q.trim()}」的方案` : '还没有保存过方案'}
          description={plans.length ? '换个关键词试试' : '在工作台调好之后点「保存」'}
          action={
            !plans.length && (
              <Button variant="secondary" onClick={() => nav.go('workbench')}>
                去工作台
              </Button>
            )
          }
        />
      ) : (
        <Card className="divide-y divide-border">
          {filtered.map((p) => {
            const isCurrent = p.name === current
            const spec = specs.get(p.name)
            const note = p.note || spec?.meta?.note
            return (
              <div
                key={p.name}
                data-plan={p.name}
                className={cn('grid items-center gap-x-4 gap-y-2 px-4 py-3 @3xl/main:grid-cols-[minmax(0,1fr)_auto]', isCurrent && 'bg-selected')}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" onClick={() => void doLoad(p.name)} className="truncate text-left text-base font-semibold text-fg-1 hover:underline" title="打开这个方案">
                      {p.name}
                    </button>
                    {isCurrent && (
                      <Badge tone="primary" size="sm">
                        正在编辑
                      </Badge>
                    )}
                    {spec?.draw.seed != null && (
                      <Badge size="sm" tone="outline">
                        种子 {spec.draw.seed}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                    <span className="text-fg-2">{spec ? specBrief(spec) : specsPending ? '…' : ''}</span>
                    {note && <span className="text-fg-3">{note}</span>}
                    {p.updated && (
                      <Tooltip content={`最后修改：${fmtDateTime(p.updated)}${p.created ? `；创建：${fmtDateTime(p.created)}` : ''}`}>
                        <span className="tabular text-fg-3">改于 {relativeTime(p.updated)}</span>
                      </Tooltip>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="soft" icon={<IconFolderOpen />} loading={loading === p.name} onClick={() => void doLoad(p.name)}>
                    打开
                  </Button>
                  <Button size="sm" variant="ghost" icon={<IconCopyPlus />} onClick={() => setDupFrom(p.name)}>
                    复制一份
                  </Button>
                  <Tooltip content="删除（会先问你）">
                    <Button size="icon-sm" variant="danger-ghost" aria-label={`删除 ${p.name}`} onClick={() => void del(p.name)}>
                      <IconTrash />
                    </Button>
                  </Tooltip>
                </div>
              </div>
            )
          })}
        </Card>
      )}
      <V2DuplicateDialog key={dupFrom ?? ''} from={dupFrom} onClose={() => setDupFrom(null)} />
    </div>
  )
}

// ---------------------------------------------------------------- 页面：装了经典工作台数据时多一个「经典方案」标签页
export default function PlansPage() {
  const classicAvailable = useClassicAvailable()
  const [picked, setTab] = useState<'v2' | 'classic'>('v2')
  const tab = classicAvailable ? picked : 'v2'
  const classicList = usePlansList(classicAvailable)
  const v2List = usePlansV2()
  const openSaveAs = usePlanDialogs((s) => s.openSaveAs)
  const quick = useQuickSave()
  const openSaveAsV2 = usePlanDialogsV2((s) => s.openSaveAs)
  const quickV2 = useQuickSaveV2()
  const n = (x: number | undefined) => (x == null ? '' : `（${fmtInt(x)}）`)
  return (
    <>
      <PageHeader
        route="plans"
        title="方案库"
        icon={<IconFolderOpen />}
        description={
          classicAvailable
            ? '工作台的方案存在 data/plans_v2/，经典工作台的在 data/plans/，两边分开。打开会整体换掉那边正在编辑的方案。'
            : '工作台的方案存在 data/plans_v2/。打开会整体换掉工作台正在编辑的方案。'
        }
        actions={
          tab === 'v2' ? (
            <>
              <Button variant="secondary" onClick={openSaveAsV2}>
                把工作台当前方案另存为…
              </Button>
              <Button variant="primary" icon={<IconSave />} loading={quickV2.isPending} onClick={quickV2.save}>
                保存工作台当前方案
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={openSaveAs}>
                把经典工作台当前方案另存为…
              </Button>
              <Button variant="primary" icon={<IconSave />} loading={quick.isPending} onClick={quick.save}>
                保存经典工作台当前方案
              </Button>
            </>
          )
        }
      />
      {classicAvailable ? (
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'v2' | 'classic')}>
          <TabsList
            className="mb-4 w-full"
            items={[
              { value: 'v2', label: `工作台方案${n(v2List.data?.length)}`, icon: <IconWorkbench /> },
              { value: 'classic', label: `经典方案${n(classicList.data?.plans.length)}`, icon: <IconLayers /> },
            ]}
          />
          <TabsContent value="v2">
            <V2PlansSection />
          </TabsContent>
          <TabsContent value="classic">
            <ClassicPlansSection />
          </TabsContent>
        </Tabs>
      ) : (
        <V2PlansSection />
      )}
    </>
  )
}
