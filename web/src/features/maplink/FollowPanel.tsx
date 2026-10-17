/**
 * 「跟随单人猜猜呗」的设置面板：锚在标签栏的链条按钮下面，约 340px 宽。画在工作区容器里（不走 portal），全屏时也看得见。
 * 只放在工作区此刻看得见的那块里（窗口矮、外层滚动区滚过时往上挪，见 ./follow.ts 的 panelBox）；
 * 头（连接状态）和尾（按钮）固定、中间滚动；矮到中间露不出几行时，整个面板一起滚、按钮那一条贴在底下。
 *
 * 从上到下（越往下越不常用）：
 * 1. 连到了谁：打开时发 map:hello、等 solo:state 约 1 秒。找到 →「单人猜猜呗 · 方案名 · 题库 N 人」；
 *    没找到 →「没找到正在玩的单人猜猜呗」+ 方案下拉（工作台当前方案 + 已保存的方案），先按方案把图组准备好
 * 2. 图组：这个方案记住的那组图（没记住过 = 预选结果）；勾选、组色点、图名、覆盖几人、最近编辑日期；
 *    顶上「覆盖 X / N 人」+ 细进度条（用预选结果里每张图的 covers 在本地重算）；「+ 加图」用标签栏「+」同款搜索；
 *    没覆盖的人折叠着（名字 + 绑定作品）；灰字「所有图里都没有：N 人」
 * 3. 高亮方式：停留 / 闪烁 / 返回，各一句说明；返回时「至少亮 N 秒」
 * 4. 更多设置（默认收起）：只在 Hard / Again 的题跳、标出猜错的作品、上一题字幕、单人页的「已联动」小灯
 * 底部：没在跟随 →「开始跟随」（同时把图组存到这个方案）；跟随中 →「停止跟随」和「保存」。
 * 设置（高亮方式和更多设置）改了马上生效；图组的改动点「开始跟随 / 保存」才生效。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/Button'
import { Checkbox, SegmentedControl, Select, Switch, type SelectOption } from '@/components/ui/Controls'
import { NumberField } from '@/components/ui/NumberField'
import { errorText } from '@/lib/apiClient'
import { fmtDate } from '@/lib/format'
import { IconChevronDown, IconChevronRight, IconLoader, IconPlus, IconX } from '@/lib/icons'
import { cn } from '@/lib/cn'
import { usePlansV2 } from '@/features/v2/hooks'
import { useSoloSettings } from '@/features/solo/settings'
import { useWb2 } from '@/features/workbench2/store'
import type { MapLabel } from '@/features/tagnote/workspace/labels'
import { QuickOpen } from '@/features/tagnote/workspace/QuickOpen'
import type { MapSummary } from '@/features/tagnote/types'
import { ThemeScopeContext, useThemeScope } from '@/themes/context'
import { maplinkApi, type PreselectBody, type PreselectMap, type PreselectResult } from './api'
import {
  RETURN_SEC_MAX,
  RETURN_SEC_MIN,
  coverageOf,
  initialGroup,
  panelBox,
  planLabel,
  planNameOfKey,
  sameGroup,
  uncoveredOf,
  visibleArea,
  clipTo,
  panelCompact,
  type Area,
  type ClipRect,
  type FollowSettings,
  type HighlightMode,
} from './follow'
import type { FollowController } from './followController'
import { useFollow, useFollowRuntime, type SoloInfo } from './followStore'
import { planKeyOf } from './protocol'

const MODE_OPTIONS: { value: HighlightMode; label: string }[] = [
  { value: 'stay', label: '停留' },
  { value: 'flash', label: '闪烁' },
  { value: 'return', label: '返回' },
]

const MODE_HINT: Record<HighlightMode, string> = {
  stay: '切到答案所在的图，作品卡一直亮着，直到下一题的答案出来。',
  flash: '切到答案所在的图，作品卡闪几下就不亮了，图停在那里。',
  return: '切到答案所在的图；下一题开始、而且亮够几秒以后，回到原来的图和位置。你自己动了图就不回去。',
}

const MORE: { key: keyof Pick<FollowSettings, 'hardOnly' | 'markWrong' | 'caption' | 'showDot'>; label: string; hint: string }[] = [
  { key: 'hardOnly', label: '只在 Hard / Again 的题跳', hint: '答得轻松的题不切图。之后改成 Hard / Again 会补跳' },
  { key: 'markWrong', label: '标出猜错的作品', hint: '答案图里猜错的角色的作品卡画虚线框' },
  { key: 'caption', label: '上一题字幕', hint: '图区左上角显示几秒「上一题：角色《作品》· 评级」' },
  { key: 'showDot', label: '单人猜猜呗页显示「已联动」小灯', hint: '单人页卡片右上角的小圆点' },
]

const SET_KEY = (planKey: string) => ['maplink', 'set', planKey] as const

/** 面板要做图组的那个方案 */
interface PlanTarget {
  planKey: string
  planName: string | null
  body: PreselectBody
}

const sameArea = (a: Area | null, b: Area) => !!a && a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1

/**
 * 容器在窗口里能露出来的范围：窗口，再减去外面各层裁剪（overflow 不是 visible 的祖先，比如页面的滚动区）。
 * 容器自己是 position:fixed（窗口内全屏）或者是全屏元素时，外面的裁剪管不到它，只算窗口。
 */
function clipOf(el: HTMLElement): ClipRect {
  let clip: ClipRect = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
  const stop = new Set<Element | null>([null, document.body, document.documentElement])
  let cur: HTMLElement = el
  while (cur !== document.fullscreenElement && getComputedStyle(cur).position !== 'fixed') {
    const p = cur.parentElement
    if (!p || stop.has(p)) break
    const cs = getComputedStyle(p)
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      const r = p.getBoundingClientRect()
      const left = r.left + p.clientLeft
      const top = r.top + p.clientTop
      clip = clipTo(clip, { left, top, right: left + p.clientWidth, bottom: top + p.clientHeight })
    }
    cur = p
  }
  return clip
}

/**
 * 工作区容器此刻看得见的部分（容器坐标）：窗口矮、外层滚动区往下滚了时，面板只放在看得见的那块里。
 * 窗口改尺寸、页面滚动时重新量；量不到（容器还没挂上）= null，面板按整个容器放。
 */
function useVisibleArea(container: HTMLElement | null, root: { w: number; h: number }): Area | null {
  const [area, setArea] = useState<Area | null>(null)
  useLayoutEffect(() => {
    if (!container || typeof window === 'undefined') return
    const measure = () => {
      const r = container.getBoundingClientRect()
      const next = visibleArea({ left: r.left + container.clientLeft, top: r.top + container.clientTop }, root, clipOf(container))
      setArea((prev) => (sameArea(prev, next) ? prev : next))
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [container, root])
  return area
}

export interface FollowPanelProps {
  controller: FollowController
  paneId: string
  /** 链条按钮在工作区容器里的右边和下边 */
  anchor: { right: number; bottom: number }
  root: { w: number; h: number }
  /** 下拉菜单挂在哪（工作区容器：全屏时也看得见） */
  portalContainer: HTMLElement | null
  items: MapSummary[]
  labels: Map<string, MapLabel>
  onClose: () => void
}

export function FollowPanel({ controller, paneId, anchor, root, portalContainer, items, labels, onClose }: FollowPanelProps) {
  const scope = useThemeScope()
  const scoped = useMemo(() => ({ ...scope, portalContainer }), [scope, portalContainer])
  const area = useVisibleArea(portalContainer, root)
  const box = panelBox(anchor, root, area ?? undefined)
  const ref = useRef<HTMLDivElement>(null)
  // 头、尾固定时中间露不出 PANEL_MIDDLE_MIN_H：整个面板一起滚，按钮那一条贴在底下
  const headRef = useRef<HTMLDivElement>(null)
  const footRef = useRef<HTMLDivElement>(null)
  const [hf, setHf] = useState({ head: 0, foot: 0 })
  useLayoutEffect(() => {
    const head = headRef.current
    const foot = footRef.current
    if (!head || !foot) return
    const measure = () =>
      setHf((p) => (p.head === head.offsetHeight && p.foot === foot.offsetHeight ? p : { head: head.offsetHeight, foot: foot.offsetHeight }))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(head)
    ro.observe(foot)
    return () => ro.disconnect()
  }, [])
  const compact = panelCompact(box.maxHeight, hf.head, hf.foot)

  const followPane = useFollow((s) => s.pane)
  const followPlanKey = useFollow((s) => s.planKey)
  const followIds = useFollow((s) => s.mapIds)
  const settings = useFollow((s) => s.settings)
  const followingHere = followPane === paneId

  // ---------------------------------------------------------------- 1. 连到了谁
  const [probe, setProbe] = useState<'pending' | SoloInfo | null>('pending')
  useEffect(() => {
    let alive = true
    void controller.probe().then((s) => {
      if (alive) setProbe(s)
    })
    return () => {
      alive = false
    }
  }, [controller])
  // 面板开着时单人猜猜呗才开局：也算找到
  const liveSolo = useFollowRuntime((s) => (s.link === 'live' ? s.solo : null))
  const solo = probe === 'pending' ? null : (liveSolo ?? probe)

  const [pick, setPick] = useState<string>(
    () => followPlanKey ?? useFollowRuntime.getState().pick ?? planKeyOf(useSoloSettings.getState().planName),
  )
  const wbSpec = useWb2((s) => s.spec)
  const plans = usePlansV2(probe !== 'pending' && !solo)

  const target: PlanTarget | null = useMemo(() => {
    if (probe === 'pending') return null
    if (solo) return { planKey: solo.plan_key, planName: solo.plan_name, body: { spec: solo.spec } }
    const name = planNameOfKey(pick)
    return name ? { planKey: pick, planName: name, body: { plan_name: name } } : { planKey: 'workbench', planName: null, body: { spec: wbSpec } }
  }, [probe, solo, pick, wbSpec])

  const planOptions: SelectOption[] = useMemo(() => {
    const names = (plans.data ?? []).map((p) => p.name)
    const cur = planNameOfKey(pick)
    if (cur && !names.includes(cur)) names.unshift(cur)
    return [{ value: 'workbench', label: '工作台当前方案' }, ...names.map((n) => ({ value: `plan:${n}`, label: n }))]
  }, [plans.data, pick])

  // ---------------------------------------------------------------- 2. 图组
  const planKey = target?.planKey ?? null
  const setQ = useQuery({
    queryKey: SET_KEY(planKey ?? ''),
    queryFn: ({ signal }) => maplinkApi.getSet(planKey!, signal),
    enabled: !!planKey,
    retry: false,
    staleTime: 0,
  })
  const bodyKey = target ? JSON.stringify(target.body) : ''
  const preQ = useQuery({
    queryKey: ['maplink', 'preselect', planKey ?? '', bodyKey],
    queryFn: ({ signal }) => maplinkApi.preselect(target!.body, signal),
    enabled: !!target,
    retry: false,
    staleTime: 30_000,
  })

  const [group, setGroup] = useState<{ key: string; rows: string[]; on: Set<string> } | null>(null)
  const ready = !!planKey && !setQ.isPending && preQ.isSuccess
  if (ready && group?.key !== planKey) {
    const init = initialGroup({
      followingHere,
      followPlanKey,
      followIds,
      planKey,
      remembered: setQ.data ?? null,
      picked: preQ.data.picked,
    })
    // 预选出来、但现在不在组里的图也列出来（不勾），勾一下就能加回去
    const extra = preQ.data.picked.filter((id) => !init.includes(id))
    setGroup({ key: planKey, rows: [...init, ...extra], on: new Set(init) })
  }
  const live = group && group.key === planKey ? group : null
  const exists = useCallback((id: string) => !items.length || labels.has(id), [items.length, labels])
  const rows = useMemo(() => (live ? live.rows.filter(exists) : []), [live, exists])
  const checked = useMemo(() => (live ? rows.filter((id) => live.on.has(id)) : []), [live, rows])

  const toggle = (id: string, on: boolean) =>
    setGroup((g) => {
      if (!g) return g
      const next = new Set(g.on)
      if (on) next.add(id)
      else next.delete(id)
      return { ...g, on: next }
    })
  const addMap = (id: string) =>
    setGroup((g) => (g ? { ...g, rows: g.rows.includes(id) ? g.rows : [...g.rows, id], on: new Set(g.on).add(id) } : g))

  const [adding, setAdding] = useState(false)

  // ---------------------------------------------------------------- 底部
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const dirty = followingHere && (!!planKey && (planKey !== followPlanKey || !sameGroup(checked, followIds)))

  const commit = async (kind: 'start' | 'save') => {
    if (!target || !checked.length) return
    setBusy(true)
    setErr(null)
    try {
      const saved = await maplinkApi.putSet(target.planKey, checked)
      qc.setQueryData(SET_KEY(target.planKey), saved)
    } catch (e) {
      setErr(`图组没存上：${errorText(e)}`)
      setBusy(false)
      return
    }
    const f = useFollow.getState()
    const p = { planKey: target.planKey, planName: target.planName, mapIds: checked }
    if (kind === 'start') f.start({ pane: paneId, ...p })
    else {
      f.setGroup(p)
      if (f.declinedPlanKey === target.planKey) f.setDeclined(null)
    }
    setBusy(false)
    onClose()
  }

  const stop = () => {
    useFollow.getState().stop()
    onClose()
  }

  // 打开时焦点进面板（Esc 能关）
  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])

  return (
    <ThemeScopeContext.Provider value={scoped}>
      <div
        className="absolute inset-0 z-30"
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
        data-follow-backdrop=""
      >
        <div
          ref={ref}
          role="dialog"
          aria-label="跟随单人猜猜呗"
          tabIndex={-1}
          className={cn(
            'absolute flex flex-col rounded-lg border border-border bg-surface-1 text-fg-1 shadow-3 outline-none',
            'animate-[pop-in_var(--motion-duration)_var(--motion-ease)]',
            compact && 'scroll-thin overflow-y-auto',
          )}
          style={{ left: box.left, top: box.top, width: box.width, maxHeight: box.maxHeight }}
          onKeyDown={(e) => {
            // 下拉菜单（挂在别处、事件按组件树冒上来）里的 Esc 只关下拉菜单
            if (e.key !== 'Escape' || !e.currentTarget.contains(e.target as Node)) return
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }}
          data-follow-panel=""
          data-follow-compact={compact ? '' : undefined}
        >
          {/* 1. 连到了谁 */}
          <div ref={headRef} className="shrink-0 border-b border-border px-3 pb-2.5 pt-2">
            <div className="flex items-center gap-2">
              <h2 className="min-w-0 flex-1 text-sm font-medium text-fg-1">跟随单人猜猜呗</h2>
              <button
                type="button"
                aria-label="关闭"
                onClick={onClose}
                className="-mr-1 grid size-6 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg-1 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <IconX className="size-3.5" />
              </button>
            </div>
            <LinkLine probe={probe} solo={solo} />
            {probe !== 'pending' && !solo && (
              <div className="mt-2">
                <Select
                  size="sm"
                  aria-label="按哪个方案准备图组"
                  value={pick}
                  onChange={(v) => {
                    setPick(v)
                    useFollowRuntime.setState({ pick: v })
                  }}
                  options={planOptions}
                />
              </div>
            )}
          </div>

          <div className={compact ? 'flex-none' : 'scroll-thin min-h-0 flex-1 overflow-y-auto'}>
            {/* 2. 图组 */}
            <section className="border-b border-border px-3 py-2.5" aria-label="图组" data-follow-group="">
              {!target || (!ready && !preQ.isError) ? (
                <p className="flex items-center gap-2 py-2 text-xs text-fg-3">
                  <IconLoader className="size-3.5 animate-spin" />
                  {target ? '正在算这个方案该开哪几张图…' : '等单人猜猜呗回话…'}
                </p>
              ) : preQ.isError ? (
                <div className="py-1">
                  <p className="text-sm text-danger">没算出图组：{errorText(preQ.error)}</p>
                  <Button variant="link" size="sm" className="mt-1" onClick={() => void preQ.refetch()}>
                    重试
                  </Button>
                </div>
              ) : (
                <GroupEditor
                  pre={preQ.data!}
                  rows={rows}
                  on={live?.on ?? new Set()}
                  labels={labels}
                  items={items}
                  onToggle={toggle}
                  onAdd={() => setAdding(true)}
                />
              )}
            </section>

            {/* 3. 高亮方式 */}
            <section className="border-b border-border px-3 py-2.5" aria-label="高亮方式">
              <h3 className="mb-1.5 text-xs font-medium text-fg-3">高亮方式</h3>
              <SegmentedControl
                size="sm"
                fullWidth
                aria-label="高亮方式"
                value={settings.mode}
                onChange={(mode) => useFollow.getState().setSettings({ mode })}
                options={MODE_OPTIONS}
              />
              <p className="mt-1.5 text-xs leading-body text-fg-3" data-follow-mode-hint="">
                {MODE_HINT[settings.mode]}
              </p>
              {settings.mode === 'return' && (
                <label className="mt-2 flex items-center gap-2 text-sm text-fg-2">
                  至少亮
                  <NumberField
                    size="sm"
                    integer
                    min={RETURN_SEC_MIN}
                    max={RETURN_SEC_MAX}
                    value={settings.returnSec}
                    onCommit={(v) => useFollow.getState().setSettings({ returnSec: v ?? settings.returnSec })}
                    className="w-16"
                    aria-label="返回前至少亮几秒"
                  />
                  秒
                </label>
              )}
            </section>

            {/* 4. 更多设置 */}
            <MoreSettings settings={settings} />
          </div>

          {/* 底部 */}
          <div ref={footRef} className={cn('shrink-0 border-t border-border px-3 py-2', compact && 'sticky bottom-0 rounded-b-lg bg-surface-1')}>
            {err && (
              <p role="alert" className="mb-1.5 text-xs text-danger">
                {err}
              </p>
            )}
            <div className="flex items-center gap-2">
              {followingHere ? (
                <>
                  <Button variant="ghost" size="sm" onClick={stop} data-follow-stop="">
                    停止跟随
                  </Button>
                  <span className="flex-1" />
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!dirty || !checked.length || busy}
                    loading={busy}
                    onClick={() => void commit('save')}
                    title={!dirty ? '图组没有改动（高亮方式和更多设置已经即时生效）' : undefined}
                    data-follow-save=""
                  >
                    保存
                  </Button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-xs text-fg-3">
                    {ready && !checked.length ? '至少勾一张图' : ''}
                  </span>
                  <Button variant="ghost" size="sm" onClick={onClose}>
                    取消
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!ready || !checked.length || busy}
                    loading={busy}
                    onClick={() => void commit('start')}
                    data-follow-start=""
                  >
                    开始跟随
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {adding && live && (
        <QuickOpen
          items={items}
          openHere={new Set(rows)}
          title="加一张图到联动"
          openLabel="已在图组里"
          footer="↑↓ 选择 · Enter 加进图组 · Esc 关闭"
          onPick={(id) => {
            setAdding(false)
            addMap(id)
            ref.current?.focus({ preventScroll: true })
          }}
          onClose={() => {
            setAdding(false)
            ref.current?.focus({ preventScroll: true })
          }}
        />
      )}
    </ThemeScopeContext.Provider>
  )
}

function LinkLine({ probe, solo }: { probe: 'pending' | SoloInfo | null; solo: SoloInfo | null }) {
  if (probe === 'pending')
    return (
      <p className="mt-1 flex items-center gap-2 text-xs text-fg-3" data-follow-link="pending">
        <IconLoader className="size-3.5 animate-spin" />
        正在找单人猜猜呗…
      </p>
    )
  if (solo)
    return (
      <p className="mt-1 flex min-w-0 items-center gap-2 text-sm text-fg-2" data-follow-link="found">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-success" />
        <span className="min-w-0 truncate">
          单人猜猜呗 · {planLabel(solo.plan_name)} · 题库 {solo.pool_total} 人
        </span>
      </p>
    )
  return (
    <div className="mt-1" data-follow-link="none">
      <p className="flex items-center gap-2 text-sm text-fg-2">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-border-strong" />
        没找到正在玩的单人猜猜呗
      </p>
      <p className="mt-0.5 text-xs leading-body text-fg-3">可以先按方案把图组准备好，单人猜猜呗开局后自动连上。</p>
    </div>
  )
}

interface GroupEditorProps {
  pre: PreselectResult
  rows: string[]
  on: Set<string>
  labels: Map<string, MapLabel>
  items: MapSummary[]
  onToggle: (id: string, on: boolean) => void
  onAdd: () => void
}

function GroupEditor({ pre, rows, on, labels, items, onToggle, onAdd }: GroupEditorProps) {
  const [showMissing, setShowMissing] = useState(false)
  const byId = useMemo(() => new Map<string, PreselectMap>(pre.maps.map((m) => [m.id, m])), [pre.maps])
  const itemById = useMemo(() => new Map(items.map((m) => [m.id, m])), [items])
  const checked = rows.filter((id) => on.has(id))
  const cov = coverageOf(pre.maps, checked, pre.pool_total)
  const missing = uncoveredOf(pre.pool, cov, pre.no_map_ids)
  const nMissing = Math.max(0, cov.total - cov.covered)

  return (
    <>
      <div className="flex items-baseline gap-2">
        <h3 className="flex-1 text-xs font-medium text-fg-3">图组</h3>
        <span className="text-xs text-fg-2" data-follow-coverage={`${cov.covered}/${cov.total}`}>
          覆盖 <span className="font-mono text-fg-1">{cov.covered}</span> / {cov.total} 人
        </span>
      </div>
      <div
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3"
        role="progressbar"
        aria-label="图组覆盖了题库的多少人"
        aria-valuemin={0}
        aria-valuemax={cov.total}
        aria-valuenow={cov.covered}
      >
        <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${Math.round(cov.ratio * 1000) / 10}%` }} />
      </div>
      {pre.errors.length > 0 && <p className="mt-2 text-xs text-danger">{pre.errors.map((e) => e.message).join('；')}</p>}

      <ul className="-mx-1 mt-1.5" aria-label="联动的图">
        {rows.map((id) => {
          const m = byId.get(id)
          const label = labels.get(id)
          const item = itemById.get(id)
          const isOn = on.has(id)
          const title = label?.title ?? m?.title ?? id
          const date = m?.edited_at ?? item?.edited_at ?? item?.generated_at ?? item?.updated_at ?? null
          return (
            <li key={id}>
              <label
                className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1.5 transition-colors hover:bg-surface-2"
                data-follow-map={id}
                data-checked={isOn ? '' : undefined}
              >
                <span className="pt-0.5">
                  <Checkbox checked={isOn} onChange={(v) => onToggle(id, v)} aria-label={`联动「${title}」`} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('flex min-w-0 items-center gap-1.5 text-sm', isOn ? 'text-fg-1' : 'text-fg-3')}>
                    <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', label?.dot ?? 'bg-fg-3', !isOn && 'opacity-60')} />
                    <span className="min-w-0 truncate">{title}</span>
                  </span>
                  <span className="mt-0.5 block pl-3 text-xs text-fg-3">
                    覆盖 {m?.covers.length ?? 0} 人 · {fmtDate(date)}
                  </span>
                </span>
              </label>
            </li>
          )
        })}
        {!rows.length && (
          <li className="px-1 py-1.5 text-xs leading-body text-fg-3">
            {pre.maps.length ? '图组是空的。用「加图」挑几张。' : '没有哪张图里有这个方案题库里的人。可以用「加图」手动挑。'}
          </li>
        )}
      </ul>

      <Button variant="ghost" size="sm" className="-ml-1 mt-0.5 text-fg-2" icon={<IconPlus />} onClick={onAdd} data-follow-add="">
        加图
      </Button>

      {nMissing > 0 && (
        <div className="mt-1.5">
          <button
            type="button"
            aria-expanded={showMissing}
            onClick={() => setShowMissing((v) => !v)}
            className="-ml-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg-1 focus-visible:outline-2 focus-visible:outline-ring"
            data-follow-missing-toggle=""
          >
            {showMissing ? <IconChevronDown className="size-3.5" /> : <IconChevronRight className="size-3.5" />}
            没覆盖的 {nMissing} 人
          </button>
          {showMissing && (
            <ul className="mt-1 max-h-40 overflow-y-auto pl-5 scroll-thin" data-follow-missing="">
              {missing.list.map((c) => (
                <li key={c.char_id} className="flex items-baseline gap-2 py-0.5 text-xs">
                  <span className="min-w-0 flex-1 truncate text-fg-2">
                    {c.name}
                    {c.bound_work_name && <span className="text-fg-3">《{c.bound_work_name}》</span>}
                  </span>
                  {c.noMap && <span className="shrink-0 text-fg-3">没有图</span>}
                </li>
              ))}

            </ul>
          )}
        </div>
      )}
      {pre.no_map > 0 && (
        <p className="mt-1 text-xs text-fg-3" data-follow-nomap="">
          所有图里都没有：{pre.no_map} 人
        </p>
      )}
    </>
  )
}

function MoreSettings({ settings }: { settings: FollowSettings }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="px-3 py-2" aria-label="更多设置">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="-ml-1 flex w-[calc(100%+0.5rem)] items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg-1 focus-visible:outline-2 focus-visible:outline-ring"
        data-follow-more=""
      >
        {open ? <IconChevronDown className="size-3.5" /> : <IconChevronRight className="size-3.5" />}
        更多设置
      </button>
      {open && (
        <div className="mt-1 flex flex-col">
          {MORE.map((m) => (
            <label key={m.key} className="flex cursor-pointer items-center gap-3 rounded-md py-1.5" data-follow-setting={m.key}>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-fg-1">{m.label}</span>
                <span className="block text-xs leading-snug text-fg-3">{m.hint}</span>
              </span>
              <Switch size="sm" checked={settings[m.key]} onChange={(v) => useFollow.getState().setSettings({ [m.key]: v })} aria-label={m.label} />
            </label>
          ))}
        </div>
      )}
    </section>
  )
}
