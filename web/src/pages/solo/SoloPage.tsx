/**
 * 单人猜猜呗（/solo）：题目从方案里出，在出题器里直接猜；把题目发到网页版猜猜呗的是 /clicker。
 * 布局和猜猜呗游戏一样：搜索框在上、反馈表在下；样子跟随当前主题。
 * 注意力中心是输入框和表格：设置收在右上角弹出面板里，进度、状态是小字。整页只有一个 primary 按钮（手动结算时选中的评级）。
 * 状态和接口：features/solo/（game.ts 对局状态、settings.ts 设置、api.ts 契约类型）。
 *
 * 两个功能：
 * - 界面大小（设置里，默认 125%）：页头下面的内容区整体 CSS zoom；左侧栏、页头不变。
 *   区域里的断点按 @container/solo（放大后的实际可用宽度）算；Tooltip 通过 OverlayZoomContext 一起放大。
 * - 在新标签页打开：独立页面 /solo/full（SoloFullPage，没有侧栏）也用这个组件（standalone）。
 *   普通 /solo 页头有「在新标签页打开」；点了之后这一页换成提示卡片、不再开局（features/solo/handoff.ts）。
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { PageHeader } from '@/app/shell/PageHeader'
import { useShellNav } from '@/app/shell/nav'
import { errorText } from '@/lib/apiClient'
import { Button } from '@/components/ui/Button'
import { EmptyState, ErrorState, Loading } from '@/components/data-display/Misc'
import { IconBrain, IconClock, IconExternal, IconRefresh } from '@/lib/icons'
import { OverlayZoomContext } from '@/components/ui/overlayZoom'
import { SOLO_FULL_PATH } from '@/app/routes'
import { isV2Missing, useDebounced } from '@/features/v2/hooks'
import { soloErrorCode, type Grade } from '@/features/solo/api'
import { useSoloGame } from '@/features/solo/game'
import { useCountdown, useSoloSource } from '@/features/solo/hooks'
import { globalKeyAction, targetInfo } from '@/features/solo/keyboard'
import { clampUiScale, pendingChanges, useSoloSettings } from '@/features/solo/settings'
import { handOffToNewTab, useSoloHandoff } from '@/features/solo/handoff'
import type { SearchView } from '@/features/solo/search'
import { attemptsView } from '@/features/solo/view'
import { SoloProgress } from '@/features/solo/components/SoloProgress'
import { SearchBox, SearchHints } from '@/features/solo/components/SearchBox'
import { GuessTable } from '@/features/solo/components/GuessTable'
import { AutoEndCard, EndPanel } from '@/features/solo/components/EndPanel'
import { LastGrade } from '@/features/solo/components/LastGrade'
import { SoloSettingsButton } from '@/features/solo/components/SoloSettings'
import { PlanPicker } from '@/features/solo/components/PlanPicker'
import { MapLinkLamp } from '@/features/maplink/MapLinkLamp'
import { useSoloMapLink } from '@/features/maplink/soloLink'
import { cn } from '@/lib/cn'

/** 倒计时小药丸：只在限时的时候出现 */
function CountdownPill({ remainingMs, limitSec }: { remainingMs: number; limitSec: number }) {
  const sec = Math.min(limitSec, Math.ceil(remainingMs / 1000))
  const low = sec <= 5
  return (
    <span
      className={cn(
        'inline-flex h-12 shrink-0 items-center gap-1.5 rounded-full px-4 tabular text-base ring-1 ring-inset',
        low ? 'bg-warning-bg text-warning-fg ring-warning' : 'bg-surface-2 text-fg-2 ring-border',
      )}
      aria-label={`还剩 ${sec} 秒`}
      role="timer"
    >
      <IconClock className="size-4" aria-hidden />
      {sec} 秒
    </span>
  )
}

/** 「在新标签页打开」：普通点击、Ctrl+点击、中键都会开新标签页，这一页随之停下（右键菜单里的「在新标签页打开」管不到） */
function OpenInNewTab() {
  const onAux = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button === 1) handOffToNewTab()
  }
  return (
    <Button variant="ghost" icon={<IconExternal />} asChild>
      <a href={SOLO_FULL_PATH} target="_blank" rel="noopener" onClick={handOffToNewTab} onAuxClick={onAux} data-solo-open-tab>
        在新标签页打开
      </a>
    </Button>
  )
}

/** standalone：独立页面（/solo/full，没有侧栏），页头不放「在新标签页打开」 */
export default function SoloPage({ standalone = false }: { standalone?: boolean }) {
  const nav = useShellNav()
  const src = useSoloSource()
  const newEvery = useSoloSettings((s) => s.newEvery)
  const playMode = useSoloSettings((s) => s.playMode)
  const autoStaySec = useSoloSettings((s) => s.autoStaySec)
  const settings = useSoloSettings()
  const uiScale = clampUiScale(settings.uiScale)
  const away = useSoloHandoff((s) => s.away)
  // 导图联动（features/maplink/）：把对局状态广播给同一浏览器里的导图标签页；写在会话 effect 之前，方案种类先登记
  useSoloMapLink(src.kind)

  const g = useSoloGame()
  const inputRef = useRef<HTMLInputElement>(null)
  const lastRef = useRef<HTMLDivElement>(null)

  // ---- 会话：方案 / 新角色保底变了就重建（保底的输入框每敲一个字都会提交，等停下来再建）
  const newEveryStable = useDebounced(newEvery, 800)
  const spec = src.spec
  const planName = src.planName
  // 已经在新标签页打开了：这一页不建会话、不开局，等点「在这里继续玩」
  useEffect(() => {
    if (!spec || away) return
    void useSoloGame.getState().ensureSession(spec, planName, newEveryStable)
  }, [spec, planName, newEveryStable, away])

  // ---- 自动模式：结算卡片停几秒后开下一局（confirmNext：要记的评级和后端记的不一样就先 regrade，再开局）
  const endId = g.end?.round_id ?? null
  useEffect(() => {
    if (g.phase !== 'ended' || playMode !== 'auto') return
    const t = window.setTimeout(() => void useSoloGame.getState().confirmNext(), autoStaySec * 1000)
    return () => window.clearTimeout(t)
  }, [g.phase, playMode, autoStaySec, endId])

  // ---- 手动结算里 ←/→ 改了评级、还没按 Enter 就切到自动模式：马上把改的评级提交，不丢
  useEffect(() => {
    if (playMode === 'auto') void useSoloGame.getState().commitChosen()
  }, [playMode])

  // ---- 新的一局开始：焦点回到输入框（设置面板开着时不抢）
  const roundId = g.round?.round_id ?? null
  // ---- 搜索框的搜索状态（搜角色 / 搜作品）：猜完一次后保持当前这种；新开一局回到搜角色
  const [searchView, setSearchView] = useState<SearchView>('char')
  const [viewRound, setViewRound] = useState(roundId)
  if (viewRound !== roundId) {
    setViewRound(roundId)
    setSearchView('char')
  }
  useEffect(() => {
    if (g.phase !== 'playing' || !roundId) return
    const t = targetInfo(document.activeElement)
    if (!t.inOverlay) inputRef.current?.focus()
  }, [roundId, g.phase])

  // ---- 全局按键：空格回到输入框；手动结算时 ←/→ 换评级、Enter 开下一局
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useSoloGame.getState()
      const manualEnd = useSoloSettings.getState().playMode === 'manual'
      const a = globalKeyAction(e, { phase: st.phase, manualEnd, target: targetInfo(e.target) })
      if (!a) return
      e.preventDefault()
      if (a.type === 'focus-search') inputRef.current?.focus()
      else if (a.type === 'grade-step') st.stepChosen(a.dir)
      else void st.confirmNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---- 倒计时（前端跑，到 0 调 /round/timeout）
  const limitSec = g.phase === 'playing' ? (g.round?.time_limit_sec ?? null) : null
  const deadline = limitSec != null ? g.lastRowAt + limitSec * 1000 : null
  const remaining = useCountdown(deadline, () => void useSoloGame.getState().timeout())

  const onRegrade = useCallback((grade: Grade) => void useSoloGame.getState().regradeLast(grade), [])
  const focusLast = useCallback(() => lastRef.current?.focus(), [])
  const backToInput = useCallback(() => inputRef.current?.focus(), [])

  const auto = playMode === 'auto'
  const manualEnded = !auto && g.phase === 'ended' && g.end != null
  const canRegrade = auto && g.last != null
  const att = attemptsView(g.status)
  // 右上角小字「本局已记 Again」：进行中看是否错满；结束后看要记的评级
  const recordedAgain =
    g.phase === 'playing' ? !!g.status?.again_locked : g.phase === 'ended' && g.end != null && (g.chosen ?? g.end.grade) === 'again'
  const pending = g.phase === 'playing' ? pendingChanges(settings, g.round, g.session?.default_subject_tag_num) : []
  const mode = g.session?.mode ?? spec?.game.mode ?? null

  // ---------------------------------------------------------------- 主体
  let body: ReactNode
  if (away) {
    body = (
      <EmptyState
        kind="generic"
        title="单人猜猜呗已在新标签页打开"
        description="这一页先停着，不开局，免得两个标签页同时计时。想回到这一页玩，点下面的按钮（会重新出一题）。"
        action={
          <Button variant="primary" onClick={() => useSoloHandoff.getState().setAway(false)}>
            在这里继续玩
          </Button>
        }
      />
    )
  } else if (src.kind === 'plan' && src.error) {
    body = (
      <EmptyState
        kind="error"
        title={`读不到方案「${src.planName}」`}
        description={errorText(src.error)}
        action={
          <Button variant="secondary" onClick={() => useSoloSettings.getState().set({ planName: null })}>
            改用工作台当前方案
          </Button>
        }
      />
    )
  } else if (src.loading) {
    body = <Loading label="正在读方案…" className="py-16" />
  } else if (!spec || g.phase === 'idle' || g.phase === 'creating') {
    body = <Loading label="正在准备题库…（第一次用某个模式要等一会儿）" className="py-16" />
  } else if (g.phase === 'error' && !g.session) {
    const code = soloErrorCode(g.error)
    body =
      code === 'empty_pool' ? (
        <EmptyState
          kind="no-result"
          title="这个方案圈到的题库是空的"
          description="回工作台放宽一下范围或条件，或者在上面换一个方案。"
          action={
            <Button variant="primary" onClick={() => nav.go('workbench')}>
              去工作台
            </Button>
          }
        />
      ) : isV2Missing(g.error) && code == null ? (
        <EmptyState kind="offline" title="后端没有单人猜猜呗的接口" description="后端没有 /v2/solo/session 接口，可能是更新代码之前启动的。关掉后端和前端窗口，重新运行启动脚本（Windows：start-all.bat；macOS / Linux：start-all.sh）后再打开这一页。" />
      ) : (
        <ErrorState error={g.error} title="没能开始" onRetry={() => void useSoloGame.getState().restartSession()} />
      )
  } else {
    body = (
      <section className="relative flex flex-col gap-4 rounded-xl bg-surface-1 p-4 shadow-1 ring-1 ring-inset ring-border @3xl/solo:p-6">
        {/* 导图联动小灯：卡片右上角的内边距里，不挡进度条 / 计时 / 评级（导图一侧开着跟随时才出现） */}
        <MapLinkLamp className="absolute right-0 top-0" />
        {/* 顶行：左上进度条（纯色）；右上「本局已记 Again」、上一局评级（自动模式） */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <SoloProgress progress={g.progress} />
          <div className="flex flex-wrap items-center justify-end gap-3">
            {recordedAgain && <span className="text-xs text-danger-fg">本局已记 Again</span>}
            {auto && g.last && <LastGrade key={g.last.round_id} ref={lastRef} last={g.last} onRegrade={onRegrade} onBack={backToInput} />}
          </div>
        </div>

        {manualEnded && g.end ? (
          <EndPanel
            end={g.end}
            chosen={g.chosen ?? g.end.grade}
            busy={g.busy}
            onChoose={(x) => useSoloGame.getState().choose(x)}
            onConfirm={(x) => void useSoloGame.getState().confirmNext(x)}
          />
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
            <div className="flex items-center gap-2">
              <SearchBox
                mode={mode ?? 'anime'}
                enabled={!!g.session}
                canGuess={g.phase === 'playing' && !g.busy}
                canRegrade={canRegrade}
                view={searchView}
                onViewChange={setSearchView}
                onGuess={(id, via) => useSoloGame.getState().guess(id, via)}
                onRegrade={onRegrade}
                onFocusLast={focusLast}
                inputRef={inputRef}
              />
              {remaining != null && limitSec != null && <CountdownPill remainingMs={remaining} limitSec={limitSec} />}
            </div>
            {/* 状态行：已错几次、投降 */}
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {g.phase === 'playing' && (
                  <span className={cn('tabular', att.full ? 'text-danger-fg' : 'text-fg-1')} title="错满上限记 Again；猜中这部作品的任何一个角色都算猜对">
                    {att.text}
                  </span>
                )}
                {g.phase === 'starting' && <span className="text-fg-3">正在出题…</span>}
                {g.phase === 'parked' && (
                  <span className="flex items-center gap-2 text-fg-2">
                    这组暂时没有该练的角色了{g.parkedReason ? `（${g.parkedReason}）` : ''}，可以休息或换一组。
                    <Button size="sm" variant="secondary" icon={<IconRefresh />} onClick={() => void useSoloGame.getState().startRound()}>
                      再试一次
                    </Button>
                  </span>
                )}
                {g.phase === 'error' && g.session && (
                  <span className="flex items-center gap-2 text-danger-fg">
                    没能出题：{errorText(g.error)}
                    <Button size="sm" variant="secondary" icon={<IconRefresh />} onClick={() => void useSoloGame.getState().startRound()}>
                      再试一次
                    </Button>
                  </span>
                )}
                {g.round && g.phase === 'playing' && <span className="text-xs text-fg-3">第 {g.round.round_no} 局</span>}
                {pending.length > 0 && <span className="text-xs text-fg-3">改了{pending.join('、')}，下一局生效</span>}
              </div>
              {g.phase === 'playing' && (
                <Button variant="danger-ghost" size="sm" disabled={g.busy} onClick={() => void useSoloGame.getState().surrender()}>
                  投降
                </Button>
              )}
            </div>
            {auto && g.phase === 'ended' && g.end && <AutoEndCard end={g.end} grade={g.chosen ?? g.end.grade} staySec={autoStaySec} />}
          </div>
        )}

        <GuessTable rows={g.rows} follow={!manualEnded} />
        {!manualEnded && <SearchHints canRegrade={canRegrade} view={searchView} />}
      </section>
    )
  }

  return (
    <div className="flex flex-col pb-10">
      <PageHeader
        route="solo"
        title="单人猜猜呗"
        icon={<IconBrain />}
        description="题目从方案里出，在这里直接猜。猜中答案所在作品的任何一个角色就算猜对。"
        actions={
          <>
            {!standalone && <OpenInNewTab />}
            <SoloSettingsButton sessionDefaultTagNum={g.session?.default_subject_tag_num ?? spec?.game.tag_count ?? null} />
          </>
        }
      >
        <PlanPicker session={g.session} mode={mode} />
      </PageHeader>
      {/* 界面大小：只放大页头下面这一块（CSS zoom）；里面的断点看 @container/solo，Portal 出去的 Tooltip 读 OverlayZoomContext */}
      <OverlayZoomContext.Provider value={uiScale}>
        <div data-solo-zoom={uiScale} style={uiScale !== 1 ? { zoom: uiScale } : undefined}>
          <div className="@container/solo">{body}</div>
        </div>
      </OverlayZoomContext.Provider>
    </div>
  )
}
