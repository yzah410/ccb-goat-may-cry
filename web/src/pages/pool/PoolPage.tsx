/**
 * 候选池（/pool）：工作台现在的方案（草稿，没保存的改动也算）圈到的全部角色。
 * 卡片 / 列表两种视图、每页几个、排序、搜索、「显示角色标签」、分页、
 * 设为当前 / 复制名字；「角色」和「统计」两个标签页切换。卡片是 features/workbench2/components/CharacterCardV2.tsx。
 * 数据：POST /v2/candidates、POST /v2/stats（统计页打开时才请求）、POST /v2/evaluate（页头的题库人数，和工作台共用缓存）。
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { PageHeader } from '@/app/shell/PageHeader'
import { useShellNav } from '@/app/shell/nav'
import { cn } from '@/lib/cn'
import { fmtInt } from '@/lib/format'
import { errorText } from '@/lib/apiClient'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { SegmentedControl, Select, Switch, Tabs, TabsContent, TabsList } from '@/components/ui/Controls'
import { NumberField } from '@/components/ui/NumberField'
import { CardSkeleton, EmptyState, ErrorState } from '@/components/data-display/Misc'
import { IconAlert, IconArrowLeft, IconCanvas, IconChart, IconGrid, IconRefresh, IconRows, IconSearch, IconShuffle, IconUserSearch, IconUsers } from '@/lib/icons'
import { useCanvasSource } from '@/features/canvas/store'
import { useSendToGuessr } from '@/features/clicker/hooks'
import { useSetPick } from '@/features/candidates/hooks'
import { useCandidateView, usePick } from '@/features/candidates/store'
import { pageSpan, totalPagesOf } from '@/features/candidates/pagination'
import { Pagination } from '@/features/candidates/components/Pagination'
import { isV2Missing, useDebounced } from '@/features/v2/hooks'
import type { CandidateSort, CandidateV2 } from '@/features/v2/types'
import { enabledRangeCount, MODE_BY_ID, poolKey, rangeTitle } from '@/features/workbench2/spec'
import { useIsDirtyV2, useWb2 } from '@/features/workbench2/store'
import { useCandidatesV2, useDebouncedSpec, useEvaluate, useStatsV2, type EvaluateView } from '@/features/workbench2/hooks'
import { POOL_SORTS, usePoolView } from '@/features/workbench2/poolView'
import { CharacterCardV2 } from '@/features/workbench2/components/CharacterCardV2'
import { CandidateRowV2 } from '@/features/workbench2/components/CandidateRowV2'
import { PoolStatsView } from '@/features/workbench2/components/PoolStatsV2'

/** 后端没有 /v2 接口时的提示：多半是后端在更新代码之前启动的，重启就好 */
const RESTART_HINT = '后端可能是更新代码之前启动的。关掉后端和前端窗口，重新运行启动脚本（Windows：start-all.bat；macOS / Linux：start-all.sh）。'

/** 页头下面一行：方案名、有没有没保存的改动、对局模式、题库人数 */
function PlanLine({ ev }: { ev: EvaluateView }) {
  const planName = useWb2((s) => s.planName)
  const game = useWb2((s) => s.spec.game)
  const dirty = useIsDirtyV2()
  const total = ev.data?.total
  const errors = ev.data?.errors ?? []
  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="text-fg-3">方案</span>
        <span className="font-medium text-fg-1">{planName ?? '未命名（还没保存过）'}</span>
        {dirty && (
          <Badge tone="warning" title="候选池按工作台上现在的样子算，包括还没保存的改动">
            <span className="size-1.5 rounded-full bg-warning" />
            有改动还没保存（按改动后的算）
          </Badge>
        )}
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <span className="text-fg-3">
          {MODE_BY_ID.get(game.mode)?.label ?? game.mode}模式 · 作品标签数 {game.tag_count}
        </span>
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <span className="text-fg-3">题库</span>
        <span className={cn('tabular text-base font-semibold text-fg-1', ev.stale && 'opacity-50')}>{total == null ? '…' : fmtInt(total)}</span>
        <span className="text-fg-3">人</span>
      </div>
      {errors.length > 0 && (
        <p className="flex items-start gap-1.5 rounded-md bg-danger-bg px-3 py-2 text-xs text-danger-fg">
          <IconAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          方案里有没生效的部分（{errors.map((e) => e.message).join('；')}）：回工作台看看。
        </p>
      )}
    </div>
  )
}

/** 「角色」标签页：工具条（吸顶）+ 分页 + 卡片 / 列表 */
function CharactersTab({ ev }: { ev: EvaluateView }) {
  const nav = useShellNav()
  const view = useCandidateView()
  const sort = usePoolView((s) => s.sort)
  const setSort = usePoolView((s) => s.setSort)
  const spec = useWb2((s) => s.spec)
  const { dSpec } = useDebouncedSpec()
  const pick = usePick((s) => s.pick)
  const setPick = useSetPick()
  const { send, isPending: sending } = useSendToGuessr()
  const [seed, setSeed] = useState(1)
  const [q, setQ] = useState('')
  const dq = useDebounced(q.trim(), 300)

  // 页码 / 展开：方案、排序、搜索、每页几个一变就回到第 1 页、全部收起
  const stateKey = `${poolKey(dSpec)}|${sort}|${dq}|${sort === 'random' ? seed : ''}|${view.pageSize}`
  const [st, setSt] = useState({ key: stateKey, page: 1, open: {} as Record<number, boolean> })
  const cur = st.key === stateKey ? st : { key: stateKey, page: 1, open: {} as Record<number, boolean> }
  const setPage = (p: number) => setSt({ key: stateKey, page: p, open: {} })
  const setOpen = (id: number, v: boolean) => setSt({ ...cur, open: { ...cur.open, [id]: v } })

  const list = useCandidatesV2({ page: cur.page, pageSize: view.pageSize, sort, q: dq, seed })
  const total = list.data?.total ?? null
  const totalPages = totalPagesOf(total ?? 0, view.pageSize)
  const [from, to] = pageSpan(cur.page, view.pageSize, total ?? 0)
  const items = list.data?.items ?? []
  const loadingFirst = list.isPending
  // 启用了 2 个以上纳入范围时，卡片上写「所在范围」（只有一个范围时每张卡都一样，不写）
  const multiRange = enabledRangeCount(spec) >= 2
  const rangeNames = (it: CandidateV2) => (multiRange ? it.ranges.map((id) => rangeTitle(spec, id)).filter((t) => !t.startsWith('（')) : null)
  const setCurrent = (it: CandidateV2) => setPick({ ...it, appear_count: it.grid?.n_app }, 'candidates')

  return (
    <div className="flex flex-col gap-4">
      {/* 工具条：吸顶 */}
      <div className="glass sticky top-[var(--shell-sticky-top,0px)] z-20 -mx-2 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border px-3 py-2 shadow-1">
        <SegmentedControl
          size="sm"
          value={view.displayMode}
          onChange={view.setDisplayMode}
          aria-label="展示方式"
          options={[
            { value: 'card', label: '卡片', icon: <IconGrid /> },
            { value: 'row', label: '列表', icon: <IconRows /> },
          ]}
        />
        <label className="flex items-center gap-2 text-sm text-fg-2">
          每页
          <NumberField
            value={view.pageSize}
            onCommit={(v) => v !== null && view.setPageSize(Math.min(20, Math.max(1, v)))}
            integer
            fallback={view.pageSize}
            size="sm"
            className="w-16"
            aria-label="每页显示几个（1–20）"
          />
          个
        </label>
        <div className="flex items-center gap-1.5">
          <div className="w-48">
            <Select<CandidateSort> size="sm" value={sort} onChange={setSort} options={POOL_SORTS} aria-label="排序方式" />
          </div>
          {sort === 'random' && (
            <Button size="sm" variant="ghost" icon={<IconShuffle />} onClick={() => setSeed(Math.floor(Math.random() * 1e9))}>
              再打乱一次
            </Button>
          )}
        </div>
        <div className="w-full max-w-56">
          <Input size="sm" leading={<IconSearch />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜名字 / 作品名…" aria-label="在候选池里搜角色名或作品名" />
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-fg-2">
          <Switch size="sm" checked={view.showCharTags} onChange={view.setShowCharTags} aria-label="显示角色标签" />
          显示角色标签
        </label>
        <span className="tabular ml-auto text-sm text-fg-3">
          {total == null ? '…' : total === 0 ? '0 个' : `第 ${fmtInt(from)}–${fmtInt(to)} 个，共 ${fmtInt(total)} 个`}
          {dq && total != null ? `（名字里有「${dq}」）` : ''}
        </span>
      </div>

      <Pagination page={cur.page} totalPages={totalPages} onPage={setPage} disabled={list.isFetching} />

      {loadingFirst ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg-3">正在让后端算候选（第一次用某个模式时要几秒）…</p>
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
      ) : list.isError && !list.data ? (
        isV2Missing(list.error) ? (
          <EmptyState kind="offline" title="后端没有出题器接口（/v2）" description={RESTART_HINT} />
        ) : (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        )
      ) : total === 0 && dq ? (
        <EmptyState
          kind="search-empty"
          title={`候选池里没有名字带「${dq}」的人`}
          description="搜的是角色名（中文名 / 原名）和取到 ta 的作品名"
          action={
            <Button variant="secondary" onClick={() => setQ('')}>
              清空搜索
            </Button>
          }
        />
      ) : total === 0 ? (
        <EmptyState
          kind="no-candidates"
          size="lg"
          title="这个方案一个人都没圈到"
          description={ev.data?.total === 0 ? '检查一下：范围是不是都停用了？条件是不是太严？排除项是不是把人全去掉了？' : undefined}
          action={
            <Button variant="primary" icon={<IconArrowLeft />} onClick={() => nav.go('workbench')}>
              回工作台调整
            </Button>
          }
        />
      ) : (
        <div
          className={cn('grid gap-3 transition-opacity', view.displayMode === 'card' && '@5xl/main:grid-cols-2', list.isPlaceholderData && 'pointer-events-none opacity-50')}
          aria-busy={list.isFetching}
        >
          {items.map((it, i) => {
            const rank = (cur.page - 1) * view.pageSize + i + 1
            const isCurrent = pick?.item.char_id === it.char_id
            if (view.displayMode === 'row' && !cur.open[it.char_id])
              return (
                <CandidateRowV2
                  key={it.char_id}
                  item={it}
                  rank={rank}
                  isCurrent={isCurrent}
                  onSetCurrent={() => setCurrent(it)}
                  onExpand={() => setOpen(it.char_id, true)}
                />
              )
            return (
              <CharacterCardV2
                key={it.char_id}
                item={it}
                rank={rank}
                showCharTags={view.showCharTags}
                isCurrent={isCurrent}
                onSetCurrent={() => setCurrent(it)}
                onSend={isCurrent ? () => send(it) : undefined}
                sending={sending}
                rangeNames={rangeNames(it)}
                onCollapse={view.displayMode === 'row' ? () => setOpen(it.char_id, false) : undefined}
              />
            )
          })}
        </div>
      )}

      {!loadingFirst && !!total && <Pagination page={cur.page} totalPages={totalPages} onPage={setPage} disabled={list.isFetching} />}
    </div>
  )
}

/** 「统计」标签页：打开时才请求 /v2/stats */
function StatsTab({ ev, active }: { ev: EvaluateView; active: boolean }) {
  const { dSpec } = useDebouncedSpec()
  const stats = useStatsV2(active)
  return (
    <PoolStatsView
      total={ev.data?.total ?? stats.data?.total ?? null}
      stats={stats.data}
      mode={dSpec.game.mode}
      loading={stats.isPending}
      fetching={stats.isFetching}
      error={stats.isError ? stats.error : null}
      onRetry={() => void stats.refetch()}
    />
  )
}

export default function PoolPage() {
  const nav = useShellNav()
  const qc = useQueryClient()
  const ev = useEvaluate()
  const [tab, setTab] = useState<'chars' | 'stats'>('chars')
  const total = ev.data?.total

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['v2', 'candidates'] })
    void qc.invalidateQueries({ queryKey: ['v2', 'stats'] })
    void qc.invalidateQueries({ queryKey: ['v2', 'evaluate'] })
  }

  return (
    <>
      <PageHeader
        route="pool"
        title="候选池"
        icon={<IconUserSearch />}
        description="工作台现在的方案圈到的全部角色（没保存的改动也算）。看中谁就「设为当前」。"
        actions={
          <>
            <Button variant="secondary" icon={<IconCanvas />} onClick={() => { useCanvasSource.getState().setSource('v2'); nav.go('canvas') }}>
              导出思维导图
            </Button>
            <Button variant="ghost" icon={<IconArrowLeft />} onClick={() => nav.go('workbench')}>
              回工作台改设置
            </Button>
            <Button variant="secondary" icon={<IconRefresh />} loading={ev.fetching && !!ev.data} onClick={refresh}>
              刷新
            </Button>
          </>
        }
      >
        <PlanLine ev={ev} />
      </PageHeader>

      {!!ev.error && !ev.data && (
        <p className="mb-4 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger-fg">
          {isV2Missing(ev.error) ? `后端没有出题器接口（/v2）。${RESTART_HINT}` : `题库人数没算出来：${errorText(ev.error)}`}
        </p>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'chars' | 'stats')} className="flex flex-col gap-4">
        <TabsList
          items={[
            { value: 'chars', label: `角色${total != null ? `（${fmtInt(total)}）` : ''}`, icon: <IconUsers /> },
            { value: 'stats', label: '统计', icon: <IconChart /> },
          ]}
        />
        <TabsContent value="chars">
          <CharactersTab ev={ev} />
        </TabsContent>
        <TabsContent value="stats">
          <StatsTab ev={ev} active={tab === 'stats'} />
        </TabsContent>
      </Tabs>
    </>
  )
}
