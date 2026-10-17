import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { copyText } from '@/lib/clipboard'
import { fmtMs, relativeTime } from '@/lib/format'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { SegmentedControl, Switch } from '@/components/ui/Controls'
import { toast } from '@/components/ui/Toast'
import { EmptyState, ErrorState, KeyValue, LogLineView } from '@/components/data-display/Misc'
import {
  IconActivity,
  IconBot,
  IconCircleCheck,
  IconCircleX,
  IconCopy,
  IconLoader,
  IconPause,
  IconPlay,
  IconPlug,
  IconRefresh,
  IconStop,
  IconTerminal,
  IconX,
} from '@/lib/icons'
import { useWb2 } from '@/features/workbench2/store'
import { useDraft } from '@/features/blocks/store'
import { useConfigPayload } from '@/features/candidates/hooks'
import { useClassicAvailable } from '@/features/classic/api'
import { clickerApi } from '../api'
import { useAutoControl, useClickerStatus, useProbe } from '../hooks'
import { EVIDENCE, ROLE_LABEL, STATE_LABEL, STATE_TONE, STEPS, type ClickerView, type LocateResult, type LogLine, type StateTone } from '../normalize'
import { errorText } from '@/lib/apiClient'

/** 转圈图标的颜色（按状态的语气） */
const SPIN_TONE: Record<StateTone, string> = {
  progress: 'text-primary',
  warning: 'text-warning',
  danger: 'text-danger',
  success: 'text-success',
  neutral: 'text-fg-3',
}

/** GET /autoclick/probe 的 error_code → 人话（backend/clicker/API.md） */
const PROBE_REASON: Record<string, string> = {
  refused: '端口没人听：Chrome 没有用调试端口启动（或者已经关了）',
  timeout: '端口在，但 Chrome 没回应：多半有标签页弹着提示框没点掉，或者 Chrome 卡住了',
  error: '端口上连到的不是能用的 Chrome（或者别的错误，见下面的原文）',
}

function Dot({ ok }: { ok: boolean | null }) {
  return (
    <span
      className={cn('inline-block size-2.5 shrink-0 rounded-full', ok === null ? 'bg-fg-3' : ok ? 'bg-success' : 'bg-danger')}
      aria-hidden
    />
  )
}

// ---------------------------------------------------------------- 连接状态
export function ConnectionCard({ view, className }: { view: ClickerView | undefined; className?: string }) {
  const status = useClickerStatus()
  const probe = useProbe(!!view)
  const p = probe.data
  const [refreshing, setRefreshing] = useState(false)
  // 上一个任务是「只定位不点击」：后端 state 也停在 done，但其实没输入、没点击，不能画成全绿
  const dryDone = !!view && !view.busy && view.state === 'done' && view.lastResult?.dry_run === true
  // 「现在」一行的颜色：取消中 = 警告色、取消卡住 = 危险色、后端已关闭 = 灰，其余进行中 = 主色
  const nowTone: StateTone = view?.autoRunning ? 'progress' : (STATE_TONE[view?.state ?? ''] ?? 'progress')
  const cancelInFlight = view?.state === 'cancelling' || view?.state === 'stuck'

  return (
    <Card className={className}>
      <CardHeader
        icon={<IconPlug />}
        title="连接状态"
        description="Chrome 要用调试端口打开猜猜呗房间页，后端才能替你点。"
        actions={
          // 只在「你点了刷新」时转圈；后台每隔几秒的自动轮询不转（否则按钮一直一闪一闪）
          <Button
            size="sm"
            variant="ghost"
            icon={<IconRefresh />}
            loading={refreshing}
            onClick={async () => {
              setRefreshing(true)
              try {
                await Promise.all([status.refetch(), probe.refetch()])
              } finally {
                setRefreshing(false)
              }
            }}
          >
            刷新
          </Button>
        }
      />
      <CardBody>
        {status.isError ? (
          <ErrorState error={status.error} size="sm" onRetry={() => void status.refetch()} />
        ) : !view ? (
          <p className="text-sm text-fg-3">正在读状态…</p>
        ) : (
          <div className="flex flex-col gap-4">
            <KeyValue
              items={[
                {
                  label: 'Chrome 调试端口',
                  value: (
                    <span className="inline-flex items-center gap-2">
                      <Dot ok={view.browserOk} />
                      {view.browserOk ? `能连上（${view.cdpPort ?? 9223}）` : `连不上（${view.cdpPort ?? 9223}）`}
                    </span>
                  ),
                },
                {
                  label: '后端已接管',
                  value: (
                    <span className="inline-flex items-center gap-2">
                      <Dot ok={view.connected} />
                      {view.connected ? '已接上浏览器' : '还没接（第一次发送时会自动接）'}
                    </span>
                  ),
                },
                {
                  label: '猜猜呗页面',
                  value: view.pageUrl ? (
                    <span className="break-all font-mono text-xs">
                      {view.pageUrl}
                      {view.pageRole && <Badge size="sm" className="ml-2">{ROLE_LABEL[view.pageRole] ?? view.pageRole}</Badge>}
                    </span>
                  ) : (
                    <span className="text-fg-3">还没找到</span>
                  ),
                },
                {
                  label: '现在',
                  value: (
                    <span className="flex flex-col gap-1">
                      <span
                        className={cn(
                          'inline-flex items-center gap-2',
                          view.busy && nowTone === 'warning' && 'text-warning-fg',
                          view.busy && nowTone === 'danger' && 'text-danger-fg',
                        )}
                      >
                        {view.busy || view.autoRunning ? (
                          <IconLoader className={cn('size-4 shrink-0 animate-spin', SPIN_TONE[nowTone])} />
                        ) : (
                          <Dot ok={view.state === 'closed' ? null : view.lastError ? false : true} />
                        )}
                        {view.autoRunning
                          ? '自动模式运行中'
                          : view.busy
                            ? (STATE_LABEL[view.state ?? ''] ?? '执行中')
                            : dryDone
                              ? '只定位完成（没有点击）'
                              : view.state
                                ? (STATE_LABEL[view.state] ?? view.state)
                                : '空闲'}
                      </span>
                      {view.lastError && !view.busy && <span className="text-sm text-danger-fg">{view.lastError}</span>}
                    </span>
                  ),
                },
              ]}
            />
            {(view.busy || view.state === 'done' || view.state === 'error') && (
              <StepBar state={view.state} busy={view.busy} target={view.target} dry={dryDone ? view.lastResult : null} />
            )}
            {p && (
              <div className="rounded-md bg-surface-2 p-3 text-sm">
                <p className="mb-1.5 font-medium text-fg-1">
                  {p.ok ? `Chrome 里找到 ${p.matched_pages?.length ?? 0} 个猜猜呗标签页` : 'Chrome 调试端口连不上'}
                </p>
                {p.ok ? (
                  <ul className="flex flex-col gap-1">
                    {(p.matched_pages ?? []).slice(0, 5).map((pg, i) => (
                      <li key={i} className="truncate font-mono text-xs text-fg-2" title={pg.url}>
                        {pg.title ? `${pg.title} — ` : ''}
                        {pg.url}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-fg-3">
                    {p.error_code && PROBE_REASON[p.error_code] && (
                      <span className="mb-1 block text-sm text-danger-fg">{PROBE_REASON[p.error_code]}</span>
                    )}
                    {p.error_code === 'timeout' ? (
                      '切到那个 Chrome 窗口，点掉弹着的提示框，或者关掉没响应的标签页，再点右上角「刷新」。'
                    ) : (
                      <>
                        先运行 <code className="rounded-sm bg-surface-3 px-1">scripts\launch-guessr-chrome.bat &lt;房间网址&gt;</code>
                        （macOS / Linux：<code className="rounded-sm bg-surface-3 px-1">bash scripts/launch-guessr-chrome.sh &lt;房间网址&gt;</code>），用调试端口打开 Chrome 并进房间。
                      </>
                    )}
                    {p.error && <span className="mt-1 block break-all font-mono">{p.error}</span>}
                  </p>
                )}
              </div>
            )}
            {view.busy && (
              <Button
                size="sm"
                variant="danger-ghost"
                icon={<IconX />}
                onClick={async () => {
                  try {
                    // 接口最多等 2 秒看任务停没停，四种结果各说各的（backend/clicker/API.md「POST /autoclick/cancel」）
                    const r = await clickerApi.cancel()
                    if (r.result === 'cancelled') toast.success('已取消当前任务', { id: 'clicker-cancel' })
                    else if (r.result === 'cancelling')
                      toast.info('正在取消…', { id: 'clicker-cancel', description: '已经发出取消，等这一步真正停下（通常不到 1 秒），状态会自己更新' })
                    else if (r.result === 'stuck')
                      toast.warning('取消卡住了', {
                        id: 'clicker-cancel',
                        description: '后端已经自动重置浏览器连接，一般马上就停；还不停可以再点一次取消（会再重置一次），再不行就重启后端',
                      })
                    else if (r.result === 'no_task') toast.info('没有正在跑的任务', { id: 'clicker-cancel', description: '可能刚好已经自己跑完了' })
                    else toast.info('已发送取消', { id: 'clicker-cancel', description: r.result ? `后端返回：${r.result}` : undefined })
                  } catch (e) {
                    toast.error('取消失败', { description: errorText(e) })
                  } finally {
                    void status.refetch()
                  }
                }}
              >
                {cancelInFlight ? '正在取消…（可以再点一次）' : '取消当前任务'}
              </Button>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

// ---------------------------------------------------------------- 步骤条
function StepBar({
  state,
  busy,
  target,
  dry,
}: {
  state: string | null
  busy: boolean
  target: ClickerView['target']
  /** 上一个任务是「只定位不点击」时传它的结果：不画步骤条（没输入、没点击），只说定位结论 */
  dry: LocateResult | null
}) {
  const idx = STEPS.findIndex((s) => s.key === state)
  // stuck（取消后卡住）按失败画；cancelling（取消中）不点亮任何一步，下面另写一句说明
  const failed = state === 'error' || state === 'stuck'
  if (dry) {
    const ev = dry.evidence ? EVIDENCE[dry.evidence] : undefined
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
        {target && (target.name_cn || target.name) && (
          <p className="text-fg-2">
            上一次只定位、没点击：<span className="font-semibold text-fg-1">{target.name_cn ?? target.name}</span>
            {target.name && target.name !== target.name_cn && <span className="ml-1 text-xs text-fg-3">{target.name}</span>}
            {target.char_id != null && <span className="tabular ml-2 font-mono text-xs text-fg-3">id {target.char_id}</span>}
          </p>
        )}
        <p className="text-fg-1">{dry.summary ?? (dry.ok ? '找到了' : (dry.error ?? '没找到'))}</p>
        {ev && !(dry.summary ?? '').includes('依据') && (
          <Badge size="sm" tone={ev.tone === 'success' ? 'success' : ev.tone === 'warning' ? 'warning' : 'neutral'} className="self-start">
            依据：{ev.label}
          </Badge>
        )}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      {target && (target.name_cn || target.name) && (
        <p className="text-sm text-fg-2">
          {busy ? '正在处理' : '上一个任务'}：<span className="font-semibold text-fg-1">{target.name_cn ?? target.name}</span>
          {target.name && target.name !== target.name_cn && <span className="ml-1 text-xs text-fg-3">{target.name}</span>}
          {target.char_id != null && <span className="tabular ml-2 font-mono text-xs text-fg-3">id {target.char_id}</span>}
        </p>
      )}
      <ol className="flex items-center gap-1" aria-label="点击进度">
        {STEPS.map((st, i) => {
          const doneStep = !failed && (idx > i || state === 'done')
          const current = !failed && idx === i && state !== 'done'
          return (
            <li key={st.key} className="flex flex-1 items-center gap-1">
              <span
                className={cn(
                  'h-1.5 flex-1 rounded-full',
                  failed ? 'bg-danger-bg' : doneStep ? 'bg-success' : current ? 'animate-pulse-soft bg-primary' : 'bg-surface-3',
                )}
              />
              <span className={cn('shrink-0 text-xs', current ? 'font-medium text-fg-1' : 'text-fg-3')}>{st.label}</span>
            </li>
          )
        })}
      </ol>
      {state === 'cancelling' && <p className="text-xs text-warning-fg">已经发出取消，正在等这一步真正停下（通常不到 1 秒）。</p>}
      {state === 'stuck' && <p className="text-xs text-danger-fg">取消后卡住了：后端正在重置浏览器连接，停下后这里会变成「出错了（已取消）」。</p>}
      {state === 'error' && <p className="text-xs text-danger-fg">这一步失败了，原因见上面「现在」一行和日志。</p>}
    </div>
  )
}

// ---------------------------------------------------------------- 自动模式
export function AutoModeCard({ view, className }: { view: ClickerView | undefined; className?: string }) {
  const { start, stop } = useAutoControl()
  const { payload } = useConfigPayload()
  // 默认按工作台的方案抽题；装了经典工作台数据时也可以换成经典工作台的组块
  const classicAvailable = useClassicAvailable()
  const [picked, setSource] = useState<'v2' | 'classic'>('v2')
  const source = classicAvailable ? picked : 'v2'
  const v2Name = useWb2((s) => s.planName)
  const classicName = useDraft((s) => s.planName)
  const running = !!view?.autoRunning
  const a = view?.auto

  return (
    <Card className={className}>
      <CardHeader
        icon={<IconBot />}
        title="自动模式（后端常驻）"
        description="把工作台现在的方案交给后端；每一轮后端按方案随机抽一个，立刻出题。"
      />
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-sm text-fg-2">
          {classicAvailable ? (
            <>
              按哪个工作台的方案抽题（房主出题）
              <SegmentedControl
                size="sm"
                value={source}
                onChange={setSource}
                aria-label="按哪个工作台的方案抽题"
                options={[
                  { value: 'v2', label: '工作台' },
                  { value: 'classic', label: '经典工作台' },
                ]}
              />
            </>
          ) : (
            '按工作台的方案抽题（房主出题）'
          )}
          <span className="text-xs text-fg-3">
            现在是「{(source === 'v2' ? v2Name : classicName) ?? '未命名（没保存也能用）'}」
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            icon={<IconPlay />}
            loading={start.isPending}
            disabled={running}
            onClick={() => start.mutate(source === 'v2' ? { mode: 'host', spec: useWb2.getState().spec } : { mode: 'host', config: payload })}
          >
            {running ? '已在运行' : '开始自动'}
          </Button>
          <Button variant="danger-ghost" icon={<IconStop />} loading={stop.isPending} disabled={!running} onClick={() => stop.mutate()}>
            停止
          </Button>
        </div>
        <div
          className={cn(
            'flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md px-3 py-2 text-sm',
            running ? 'bg-primary-50 text-primary-900' : 'bg-surface-2 text-fg-2',
          )}
          role="status"
        >
          {running ? (
            <>
              <span className="inline-flex items-center gap-2 font-medium">
                <IconActivity className="size-4 animate-pulse-soft" />
                运行中{a?.mode ? '（出题）' : ''}
              </span>
              {a?.round != null && <span>完成 {a.round} 轮</span>}
              {a?.failed != null && a.failed > 0 && <span className="text-danger-fg">失败 {a.failed} 次</span>}
              {a?.lastCharName && <span>上一题：{a.lastCharName}</span>}
              {a?.waitingFor && <span>在等：{a.waitingFor}</span>}
              {a?.startedAt && <span className="text-xs opacity-80">{relativeTime(a.startedAt * 1000)}开始</span>}
            </>
          ) : (
            <span>
              没在跑{a?.stopReason ? `（上次停下的原因：${a.stopReason}）` : ''}
            </span>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

// ---------------------------------------------------------------- 日志
export function LogPanel({ view, className }: { view: ClickerView | undefined; className?: string }) {
  const [onlyProblems, setOnlyProblems] = useState<'normal' | 'all' | 'problems'>('normal')
  const [autoScroll, setAutoScroll] = useState(true)
  const [frozen, setFrozen] = useState<LogLine[] | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const live = view?.logs ?? []
  const logs = (frozen ?? live).filter((l) =>
    onlyProblems === 'all' ? true : onlyProblems === 'normal' ? l.level !== 'debug' : l.level === 'error' || l.level === 'warn',
  )
  const lastKey = logs.length ? `${logs.length}:${logs[logs.length - 1]!.msg}` : ''

  useEffect(() => {
    if (!autoScroll || !ref.current) return
    ref.current.scrollTop = ref.current.scrollHeight
  }, [lastKey, autoScroll])

  return (
    <Card className={className}>
      <CardHeader
        icon={<IconTerminal />}
        title="日志"
        description="后端最近 200 条。单次发送和自动模式共用这一份日志。"
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon={<IconCopy />}
            onClick={async () => {
              const text = logs.map((l) => `${l.ts ? new Date(l.ts).toLocaleTimeString() : ''} [${l.level}] ${l.msg}`).join('\n')
              if (await copyText(text)) toast.success(`复制了 ${logs.length} 行日志`, { id: 'copy' })
            }}
          >
            复制
          </Button>
        }
      />
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <SegmentedControl
            size="sm"
            value={onlyProblems}
            onChange={setOnlyProblems}
            aria-label="日志筛选"
            options={[
              { value: 'normal', label: '常规' },
              { value: 'all', label: '含调试' },
              { value: 'problems', label: '只看出问题的' },
            ]}
          />
          <label className="flex cursor-pointer items-center gap-2 text-sm text-fg-2">
            <Switch size="sm" checked={autoScroll} onChange={setAutoScroll} aria-label="自动滚到最新" />
            自动滚到最新
          </label>
          <Button
            size="sm"
            variant={frozen ? 'soft' : 'ghost'}
            icon={frozen ? <IconPlay /> : <IconPause />}
            onClick={() => setFrozen(frozen ? null : live)}
          >
            {frozen ? '继续刷新' : '暂停刷新'}
          </Button>
          <span className="ml-auto text-xs text-fg-3">
            {logs.length} 行{frozen ? '（已暂停）' : ''}
          </span>
        </div>
        <div
          ref={ref}
          className="h-80 overflow-y-auto rounded-md border border-border bg-bg p-2 scroll-thin"
          role="log"
          aria-live={frozen ? 'off' : 'polite'}
          aria-label="点击器日志"
        >
          {logs.length ? (
            <div className="flex flex-col gap-0.5">
              {logs.map((l, i) => (
                <LogLineView key={i} line={l} />
              ))}
            </div>
          ) : (
            <EmptyState kind="no-logs" size="sm" title="还没有日志" description="发一次题或开自动模式，这里会实时显示进度" />
          )}
        </div>
      </CardBody>
    </Card>
  )
}

// ---------------------------------------------------------------- 只定位不点击的结果
export function LocateResultView({ r, className }: { r: LocateResult; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3 rounded-md border border-border bg-surface-1 p-4', className)}>
      <p className={cn('flex items-center gap-2 font-medium', r.ok ? 'text-success-fg' : 'text-danger-fg')}>
        {r.ok ? <IconCircleCheck className="size-5" /> : <IconCircleX className="size-5" />}
        {r.ok ? (r.summary ?? '找到了') : (r.error ?? '没找到')}
      </p>
      <KeyValue
        items={[
          ...(r.keyword ? [{ label: '搜的关键词', value: <code className="font-mono">{r.keyword}</code>, hint: r.keyword_label ?? undefined }] : []),
          ...(r.nth != null ? [{ label: '在结果里', value: `第 ${r.nth} 项${r.more_clicks ? `（要点 ${r.more_clicks} 次「更多」）` : ''}` }] : []),
          ...(r.path ? [{ label: '路径', value: r.path === 'subject' ? `先搜作品「${r.subject_name ?? ''}」，再在作品角色里找` : '直接搜角色' }] : []),
          ...(r.evidence
            ? [
                {
                  label: '凭什么认定',
                  value: (
                    <span className="flex flex-col items-start gap-1">
                      <Badge size="sm" tone={EVIDENCE[r.evidence]?.tone === 'success' ? 'success' : EVIDENCE[r.evidence]?.tone === 'warning' ? 'warning' : 'neutral'}>
                        {EVIDENCE[r.evidence]?.label ?? r.evidence}
                      </Badge>
                      {r.evidence_detail && <span className="text-xs text-fg-3">{r.evidence_detail}</span>}
                    </span>
                  ),
                },
              ]
            : []),
          ...(r.plan && r.plan[0]
            ? [
                {
                  label: '首选路径',
                  value: `${r.plan[0].path === 'subject' ? `先搜作品「${r.plan[0].subject_name ?? ''}」` : '直接搜角色'}，关键词「${r.plan[0].keyword}」${r.plan[0].index != null ? `，第 ${r.plan[0].index + 1} 项` : ''}`,
                  hint: r.plan.length > 1 ? `另有 ${r.plan.length - 1} 条备选` : undefined,
                },
              ]
            : []),
          ...(r.source ? [{ label: '来源', value: r.source === 'page' ? '真实页面里找到的' : r.source === 'api' ? '离线预测（页面上没有可用搜索框）' : '—' }] : []),
          ...(r.elapsed_ms != null ? [{ label: '用时', value: fmtMs(r.elapsed_ms) }] : []),
        ]}
      />
      {r.warnings && r.warnings.length > 0 && (
        <ul className="list-disc pl-5 text-sm text-warning-fg">
          {r.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
