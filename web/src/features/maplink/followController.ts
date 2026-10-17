/**
 * 导图一侧「跟随」的副作用：联动频道、心跳、收到单人猜猜呗的消息以后切图 / 聚焦 / 字幕 / 提示、「返回」的计时。
 * 纯逻辑在 ./follow.ts，状态在 ./followStore.ts。一个工作区一个控制器：Workspace 挂载时 start()，卸载时 dispose()。
 *
 * 收到的消息（只认最近一次发 solo:state / solo:round-* 的单人标签页，见 acceptFrom）：
 * - solo:state：记下连到了谁；跟随中方案变了 → 换用新方案的图组（记住的 / 预选的），角落提示带「撤销」
 * - solo:round-start：题目进行中，联动不移动导图；「返回」在这之后、亮够秒数才回去
 * - solo:round-end：（只在 Hard / Again 跳时看评级）找目标图 → 跟随格切过去 → focusWorks；字幕
 * - solo:grade：更新字幕的评级；改成 Hard / Again 而当时没跳、下一题没开始 → 补跳
 * - solo:bye：标签栏按钮旁小字「单人猜猜呗已断开」，跟随状态保留
 * - solo:ping：立刻回一条 map:presence
 * 发出去的：跟随开着时每 2 秒 map:presence；开始跟随、刷新后还原时 map:hello；停止、格子关掉、页面关闭 map:bye。
 *
 * 跳转、返回、换方案都要等（取图数据、等实例挂上 / 画完、等接口），等回来时情况可能已经变了。所以：
 * - 每次跳转、每次返回各发一个操作编号；下面这些事一发生，旧编号就作废，每个 await 之后先核对编号：
 *   跳转：round-start、新的 round-end、跟随移到别的格子、停止跟随（含格子被关掉）、用户接管、换方案；
 *   返回：同上，只是 round-start 不算（「返回」本来就在下一题开始以后做）。
 *   跳转还要核对题目不在进行中、跟随格没变。作废时引擎里已经排着的聚焦（含 reveal）用 clearFocus 撤掉。
 * - 换方案的请求：收到更新的 solo:state 就作废；写入前核对最新 state 还是这个来源的这个方案。
 * - 当前有效的聚焦（标签、作品、猜错的作品、方式、闪烁结束时刻）记下来：目标标签的实例重挂（保活淘汰、StrictMode）
 *   时照着恢复（follow.ts 的 restoreFocus）。有效到下一题答案出来、用户清掉 / 接管、停止跟随、跟随移格为止。
 */
import type { QueryClient } from '@tanstack/react-query'
import { errorText } from '@/lib/apiClient'
import { tagnoteApi } from '@/features/tagnote/api'
import { MAP_KEYS } from '@/features/tagnote/hooks'
import { useTagNoteLocal } from '@/features/tagnote/store'
import type { MapDetail } from '@/features/tagnote/types'
import { updateWorkspace } from '@/features/tagnote/workspace/actions'
import {
  engineOf,
  onEngineMount,
  onUserFocus,
  onViewportEvent,
  waitEngine,
  type EngineHandle,
  type ViewportEvent,
} from '@/features/tagnote/workspace/engines'
import * as T from '@/features/tagnote/workspace/tree'
import type { PaneNode, ViewKey, Workspace } from '@/features/tagnote/workspace/types'
import type { FocusOptions } from '@/vendor/tagnote/tagnote.esm.js'
import { maplinkApi } from './api'
import {
  FLASH_MS,
  acceptFrom,
  allMissingOf,
  captionText,
  findTarget,
  groupForPlan,
  isPlanSwitch,
  needsCatchUp,
  notInGroupText,
  pickSecondary,
  planReturn,
  planSwitchText,
  restoreFocus,
  returnWait,
  shouldJump,
  takenOver,
  type Expectation,
  type FocusRecord,
  type LastEnd,
  type ReturnOrigin,
  type ReturnPlan,
  type WorkLite,
} from './follow'
import { useFollow, useFollowRuntime, type FollowState, type SoloInfo } from './followStore'
import {
  newTabId,
  openLinkChannel,
  stamp,
  type ChannelFactory,
  type LinkChannel,
  type LinkMsg,
  type MapBody,
  type SoloGradeMsg,
  type SoloRoundEndMsg,
  type SoloStateMsg,
} from './protocol'

/** 跟随开着时多久发一次 map:presence */
export const HEARTBEAT_MS = 2000
/** 打开面板时等 solo:state 多久 */
export const PROBE_MS = 1000
/** 字幕显示多久 */
export const CAPTION_MS = 4000
/** 角落提示显示多久（带「撤销」的久一点） */
export const NOTICE_MS = 4500
export const UNDO_NOTICE_MS = 9000
/** 切到目标标签后，等它的引擎实例挂上最多多久 */
const ENGINE_WAIT_MS = 8000
/** 聚焦排队了（实例还没画完）：等它画完最多多久 */
const DRAWN_WAIT_MS = 4000

/** 等实例把当前视图画完，返回画出来的作品 id；等不到、或者 alive() 变假（这次操作作废了）= null */
async function waitDrawn(h: EngineHandle, timeoutMs: number, alive: () => boolean): Promise<Set<string> | null> {
  const t0 = Date.now()
  for (;;) {
    if (!alive()) return null
    const ids = h.drawnWorkIds()
    if (ids) return new Set(ids)
    if (Date.now() - t0 >= timeoutMs) return null
    await new Promise((r) => setTimeout(r, 80))
  }
}

/** 当前有效的聚焦：在哪个标签的哪张图上、亮哪些作品卡（含猜错的），以及记到了哪一步 */
interface LiveFocus extends FocusRecord {
  tabId: string
  mapId: string
  ids: string[]
  secondary: string[]
}

export interface FollowDeps {
  queryClient: QueryClient
  /** 方案库里还有这张图吗（删掉了的图不开标签、不当目标） */
  mapExists: (mapId: string) => boolean
  /** 测试时换成内存频道 */
  channelFactory?: ChannelFactory
}

const ws = (): Workspace => useTagNoteLocal.getState().workspace

const lastView = (): ViewKey | null => {
  const v = useTagNoteLocal.getState().prefs.view
  return T.isViewKey(v) ? v : null
}

export class FollowController {
  /** 这个导图标签页在频道里的 id */
  readonly id = newTabId()
  private deps: FollowDeps
  private ch: LinkChannel | null = null
  private running = false
  private offs: (() => void)[] = []
  private beat: ReturnType<typeof setInterval> | null = null

  private activeSrc: string | null = null
  private roundActive = false
  private lastEnd: (LastEnd & { msg: SoloRoundEndMsg }) | null = null

  private ret: ReturnPlan | null = null
  private retTimer: ReturnType<typeof setTimeout> | null = null
  /** 跳过去（或返回途中）跟随格「应该是这样」：判断用户接管了没有 */
  private expect: Expectation | null = null
  /** 当前有效的聚焦（重挂时照着恢复）；也是下一次跳到别的标签时要清掉的那个高亮 */
  private live: LiveFocus | null = null
  /** 闪烁按剩下的时间恢复以后，到点清掉 */
  private liveTimer: ReturnType<typeof setTimeout> | null = null
  /** 操作编号（见文件头）：跳转、返回各一套；作废 = 加一 */
  private jumpOp = 0
  private retOp = 0
  /** 进行中的跳转在引擎里排着的聚焦（实例还没画完，含 reveal）：跳转作废时撤掉 */
  private queued: { op: number; tabId: string; mapId: string } | null = null
  private switchSeq = 0
  private undo: { planKey: string | null; planName: string | null; mapIds: string[]; declined: string } | null = null

  private captionTimer: ReturnType<typeof setTimeout> | null = null
  private noticeTimer: ReturnType<typeof setTimeout> | null = null
  private seq = 0
  private probeWaiters = new Set<(s: SoloInfo | null) => void>()

  constructor(deps: FollowDeps) {
    this.deps = deps
  }

  updateDeps(patch: Partial<FollowDeps>) {
    this.deps = { ...this.deps, ...patch }
  }

  // ---------------------------------------------------------------- 生命周期
  start() {
    if (this.running) return
    this.running = true
    this.ch = openLinkChannel((m) => this.onMessage(m), this.deps.channelFactory)
    this.offs.push(useFollow.subscribe((s, prev) => this.onFollowChange(s, prev)))
    this.offs.push(
      useTagNoteLocal.subscribe((s, prev) => {
        if (s.workspace !== prev.workspace) this.onWorkspaceChange()
      }),
    )
    this.offs.push(onViewportEvent((e) => this.onViewport(e)))
    this.offs.push(onEngineMount((h) => this.onEngineMount(h)))
    this.offs.push(onUserFocus((tabId) => this.onUserFocus(tabId)))
    if (typeof window !== 'undefined') {
      const hide = () => {
        if (useFollow.getState().pane) this.post({ type: 'map:bye' })
      }
      const show = (e: PageTransitionEvent) => {
        if (e.persisted && useFollow.getState().pane) this.greet()
      }
      window.addEventListener('pagehide', hide)
      window.addEventListener('pageshow', show)
      this.offs.push(() => {
        window.removeEventListener('pagehide', hide)
        window.removeEventListener('pageshow', show)
      })
    }
    // 存下来的跟随格已经不在了（工作区被整理过）= 跟随结束
    const f = useFollow.getState()
    if (f.pane && !T.findPane(ws(), f.pane)) f.stop()
    else if (f.pane) this.beginFollowing()
  }

  dispose() {
    if (!this.running) return
    if (useFollow.getState().pane) this.post({ type: 'map:bye' })
    this.running = false
    this.stopBeat()
    this.cancelReturn()
    this.dropOps()
    this.switchSeq++
    this.setLive(null)
    for (const off of this.offs.splice(0)) off()
    for (const fn of [...this.probeWaiters]) fn(null)
    if (this.captionTimer) clearTimeout(this.captionTimer)
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    useFollowRuntime.setState({ caption: null, notice: null })
    this.ch?.close()
    this.ch = null
  }

  get available(): boolean {
    return this.ch !== null
  }

  // ---------------------------------------------------------------- 给界面用
  /**
   * 打开面板时问一下「有没有正在玩的单人猜猜呗」：发 map:hello，等 solo:state 最多 PROBE_MS。
   * 已经连着的直接给（同时也发 hello，让它把最新的方案报上来）。
   */
  probe(timeoutMs = PROBE_MS): Promise<SoloInfo | null> {
    if (!this.ch) return Promise.resolve(null)
    this.post({ type: 'map:hello' })
    const rt = useFollowRuntime.getState()
    if (rt.solo && rt.link === 'live') return Promise.resolve(rt.solo)
    return new Promise((resolve) => {
      const done = (s: SoloInfo | null) => {
        clearTimeout(timer)
        this.probeWaiters.delete(done)
        resolve(s)
      }
      const timer = setTimeout(() => done(null), timeoutMs)
      this.probeWaiters.add(done)
    })
  }

  /** 角落提示里的「撤销」：换回换方案之前的图组；单人猜猜呗还在用这个方案时不自动换 */
  undoSwitch() {
    const u = this.undo
    this.undo = null
    this.clearNotice()
    if (!u) return
    this.dropOps()
    const f = useFollow.getState()
    if (u.planKey) f.setGroup({ planKey: u.planKey, planName: u.planName, mapIds: u.mapIds })
    f.setDeclined(u.declined)
  }

  dismissNotice() {
    this.clearNotice()
  }

  // ---------------------------------------------------------------- 发消息
  private post(body: MapBody) {
    this.ch?.post(stamp(body, this.id, Date.now()) as LinkMsg)
  }

  private sendPresence() {
    const f = useFollow.getState()
    if (!f.pane) return
    this.post({ type: 'map:presence', following: true, show_dot: f.settings.showDot })
  }

  private greet() {
    this.post({ type: 'map:hello' })
    this.sendPresence()
  }

  private startBeat() {
    if (this.beat) return
    this.beat = setInterval(() => this.sendPresence(), HEARTBEAT_MS)
  }

  private stopBeat() {
    if (this.beat) clearInterval(this.beat)
    this.beat = null
  }

  // ---------------------------------------------------------------- 跟随开 / 关 / 移
  private beginFollowing() {
    this.openGroupTabs()
    this.prefetch()
    this.greet()
    this.startBeat()
  }

  private endFollowing() {
    this.post({ type: 'map:bye' })
    this.stopBeat()
    this.cancelReturn()
    this.dropOps()
    this.switchSeq++
    this.clearOldFocus(null)
    this.lastEnd = null
    this.undo = null
    if (this.captionTimer) clearTimeout(this.captionTimer)
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    useFollowRuntime.setState({ caption: null, notice: null })
  }

  private onFollowChange(s: FollowState, prev: FollowState) {
    if (!this.running) return
    if (s.pane !== prev.pane) {
      if (s.pane && !prev.pane) {
        this.beginFollowing()
        return
      }
      if (!s.pane) {
        this.endFollowing()
        return
      }
      // 移到了另一格：进行中的跳转、返回作废，旧格子上的高亮清掉；组里的图在新格子里开成标签
      this.cancelReturn()
      this.dropOps()
      this.clearOldFocus(null)
      this.openGroupTabs()
    }
    if (!s.pane) return
    if (s.mapIds !== prev.mapIds) {
      this.openGroupTabs()
      this.prefetch()
    }
    if (s.settings.showDot !== prev.settings.showDot) this.sendPresence()
    if (s.settings.mode !== prev.settings.mode && s.settings.mode !== 'return') this.cancelReturn()
    if (s.settings.returnSec !== prev.settings.returnSec) this.scheduleReturn()
  }

  private groupIds(): string[] {
    return useFollow.getState().mapIds.filter((id) => this.deps.mapExists(id))
  }

  /** 组里的图在跟随格里开成标签（已经开着的不重复开，当前标签不变） */
  private openGroupTabs() {
    const pane = useFollow.getState().pane
    if (!pane) return
    const ids = this.groupIds()
    updateWorkspace((w) => T.ensureTabs(w, pane, ids, lastView()), { capture: false })
  }

  private detailQuery(id: string) {
    return {
      queryKey: MAP_KEYS.detail(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => tagnoteApi.get(id, signal),
      staleTime: 5 * 60_000,
    }
  }

  /** 组里的图先取下来（和 useMapDetail 同一个缓存：切过去时引擎马上能画） */
  private prefetch() {
    for (const id of this.groupIds()) void this.deps.queryClient.prefetchQuery(this.detailQuery(id))
  }

  private async worksOf(id: string): Promise<WorkLite[] | null> {
    try {
      const d: MapDetail = await this.deps.queryClient.fetchQuery(this.detailQuery(id))
      return d.works
    } catch {
      return null
    }
  }

  private onWorkspaceChange() {
    const f = useFollow.getState()
    if (!this.running || !f.pane) return
    const pane = T.findPane(ws(), f.pane)
    if (!pane) {
      // 格子被关掉 = 跟随结束
      f.stop()
      return
    }
    this.checkTakeover(pane)
  }

  // ---------------------------------------------------------------- 操作编号
  /** 作废进行中的跳转：引擎里已经排着的聚焦（含 reveal）撤掉 */
  private dropJump() {
    this.jumpOp++
    const q = this.queued
    this.queued = null
    if (!q) return
    engineOf(q.tabId, q.mapId)?.clearFocus()
    if (this.live?.tabId === q.tabId) this.setLive(null)
  }

  private dropOps() {
    this.dropJump()
    this.retOp++
  }

  /** 这次跳转还作数吗：编号没作废、还在跟随同一格、题目不在进行中 */
  private jumpOk(op: number, pane: string): boolean {
    return op === this.jumpOp && this.running && useFollow.getState().pane === pane && !this.roundActive
  }

  /** 这次返回还作数吗：编号没作废、还在跟随同一格 */
  private retOk(op: number, pane: string): boolean {
    return op === this.retOp && this.running && useFollow.getState().pane === pane
  }

  // ---------------------------------------------------------------- 收消息
  private onMessage(msg: LinkMsg) {
    if (!this.running) return
    const a = acceptFrom(this.activeSrc, msg)
    if (!a.accept) return
    this.activeSrc = a.src
    switch (msg.type) {
      case 'solo:state':
        this.onState(msg)
        break
      case 'solo:round-start':
        this.setLinkLive()
        this.roundActive = true
        // 题目进行中联动不移动导图：还没做完的跳转作废
        this.dropJump()
        if (this.lastEnd) this.lastEnd.nextStarted = true
        if (this.ret) {
          this.ret.nextStarted = true
          this.scheduleReturn()
        }
        break
      case 'solo:round-end':
        this.setLinkLive()
        this.roundActive = false
        this.onRoundEnd(msg)
        break
      case 'solo:grade':
        this.onGrade(msg)
        break
      case 'solo:bye':
        this.roundActive = false
        useFollowRuntime.setState({ link: 'bye' })
        break
      case 'solo:ping':
        this.sendPresence()
        break
    }
  }

  private setLinkLive() {
    if (useFollowRuntime.getState().link !== 'live') useFollowRuntime.setState({ link: 'live' })
  }

  private onState(msg: SoloStateMsg) {
    const info: SoloInfo = {
      src: msg.src,
      plan_key: msg.plan_key,
      plan_name: msg.plan_name,
      source: msg.source,
      spec: msg.spec,
      pool_total: msg.pool_total,
      at: Date.now(),
    }
    useFollowRuntime.setState({ solo: info, link: 'live' })
    for (const fn of [...this.probeWaiters]) fn(info)
    // 最新的 solo:state 说了算：还没回来的换方案请求作废
    const seq = ++this.switchSeq
    const f = useFollow.getState()
    if (f.pane && isPlanSwitch(f.planKey, msg.plan_key, f.declinedPlanKey)) {
      this.dropOps()
      void this.switchPlan(msg, seq)
    }
  }

  /** 换方案的请求还作数吗：没有更新的 solo:state、最新的还是这个来源的这个方案、还在跟随 */
  private switchStill(seq: number, msg: SoloStateMsg): boolean {
    const solo = useFollowRuntime.getState().solo
    return seq === this.switchSeq && this.running && !!useFollow.getState().pane && solo?.src === msg.src && solo.plan_key === msg.plan_key
  }

  /** 单人猜猜呗换了方案：换用它的图组（记住的；没有就预选，先不保存） */
  private async switchPlan(msg: SoloStateMsg, seq: number) {
    const from = useFollow.getState().planKey
    let mapIds: string[]
    let allMissing = false
    try {
      const remembered = await maplinkApi.getSet(msg.plan_key)
      let picked: string[] = []
      if (!remembered && this.switchStill(seq, msg)) {
        const pre = await maplinkApi.preselect({ spec: msg.spec })
        picked = pre.picked
        allMissing = allMissingOf(pre)
      }
      mapIds = groupForPlan(remembered, picked).mapIds
    } catch (e) {
      if (this.switchStill(seq, msg)) this.notice(`单人猜猜呗换了方案，但没取到它的图组：${errorText(e)}`)
      return
    }
    const f = useFollow.getState()
    // 写入前核对：请求没作废、来源和方案没变、图组还是请求时那个方案的（用户没在面板里另存别的）
    if (!this.switchStill(seq, msg) || f.planKey !== from) return
    this.dropOps()
    this.undo = { planKey: f.planKey, planName: f.planName, mapIds: f.mapIds, declined: msg.plan_key }
    f.setGroup({ planKey: msg.plan_key, planName: msg.plan_name, mapIds })
    const size = mapIds.filter((id) => this.deps.mapExists(id)).length
    this.notice(planSwitchText(msg.plan_name, size, allMissing), { undo: true, panel: size === 0 })
  }

  private onRoundEnd(msg: SoloRoundEndMsg) {
    // 新的答案出来了：上一次还没做完的跳转、返回作废
    this.dropOps()
    this.lastEnd = { roundId: msg.round_id, grade: msg.grade, handled: false, nextStarted: false, msg }
    const f = useFollow.getState()
    if (!f.pane) return
    if (f.settings.caption) this.showCaption(msg.round_id, captionText(msg, msg.grade))
    // 上一题的聚焦只作数到这一题的答案出来：不恢复；不跳就马上清掉，跳的话等跳完（同一个标签上直接换掉，不闪一下）
    if (shouldJump(msg.grade, f.settings)) {
      const old = this.live
      this.setLive(null)
      void this.jump(msg, old)
    } else this.clearOldFocus(null)
  }

  private onGrade(msg: SoloGradeMsg) {
    const last = this.lastEnd
    if (!last || last.roundId !== msg.round_id) return
    const f = useFollow.getState()
    const catchUp = !!f.pane && needsCatchUp(last, msg.round_id, msg.grade, f.settings)
    last.grade = msg.grade
    const cap = useFollowRuntime.getState().caption
    const text = captionText(last.msg, msg.grade)
    if (cap && cap.roundId === msg.round_id) useFollowRuntime.setState({ caption: { ...cap, text } })
    else if (catchUp && f.settings.caption) this.showCaption(msg.round_id, text)
    if (catchUp) void this.jump(last.msg)
  }

  // ---------------------------------------------------------------- 跳
  private captureOrigin(w: Workspace, pane: PaneNode): ReturnOrigin {
    const tabId = pane.active
    if (!tabId) return { tabId: null, view: null, vp: null }
    const tab = w.tabs[tabId]
    const h = engineOf(tabId, tab?.mapId)
    const v = h?.view ?? tab?.view ?? null
    const view = T.isViewKey(v) ? v : null
    const vp = view ? (h?.getViewport(view) ?? tab?.viewports[view] ?? null) : null
    return { tabId, view, vp }
  }

  private setLive(rec: LiveFocus | null) {
    if (this.liveTimer) clearTimeout(this.liveTimer)
    this.liveTimer = null
    this.live = rec
  }

  /** 清掉当前有效的聚焦（引擎里的高亮和记录）；keepTab 上的不动（马上要在它上面重新聚焦） */
  private clearOldFocus(keepTab: string | null) {
    const lf = this.live
    if (!lf || lf.tabId === keepTab) return
    engineOf(lf.tabId, lf.mapId)?.clearFocus()
    this.setLive(null)
  }

  /** 目标标签换了实例（保活淘汰后重挂、StrictMode 挂两次）：在新实例上照着当前有效的聚焦恢复 */
  private onEngineMount(h: EngineHandle) {
    const lf = this.live
    if (!lf || !this.running || !useFollow.getState().pane || h.tabId !== lf.tabId || h.mapId !== lf.mapId) return
    const how = restoreFocus(lf, Date.now(), this.roundActive)
    if (!how) {
      this.setLive(null)
      return
    }
    h.focusWorks(lf.ids, { mode: how.mode, reveal: how.reveal, secondary: lf.secondary })
    if (how.clearAfter === null) return
    // 闪烁还没闪完：按剩下的时间亮着，到点清掉
    if (this.liveTimer) clearTimeout(this.liveTimer)
    this.liveTimer = setTimeout(() => {
      this.liveTimer = null
      if (this.live !== lf) return
      engineOf(lf.tabId, lf.mapId)?.clearFocus()
      this.live = null
    }, how.clearAfter)
  }

  /** 引擎报（onFocusTakeover）：用户在这个标签的实例上点击固定了高亮 / 按了 Esc，程序聚焦被清掉了 → 不恢复；是跳过去的那张图 = 接管 */
  private onUserFocus(tabId: string) {
    if (this.live?.tabId === tabId) this.setLive(null)
    if (this.expect?.tabId === tabId) {
      this.dropOps()
      this.cancelReturn()
    }
  }

  /** 聚焦真的显示出来了：reveal 做过了，闪烁从现在开始算 */
  private markShown(rec: LiveFocus) {
    rec.revealed = true
    if (rec.mode === 'flash') rec.flashEnd = Date.now() + FLASH_MS
  }

  /**
   * 在实例上聚焦。实例还没画完（排队了）：记下排着的（跳转作废时撤掉），等画完再按画出来的算 found。
   * 返回 found；等的时候这次跳转作废了 = null。
   */
  private async focusOn(h: EngineHandle, rec: LiveFocus, opts: FocusOptions, op: number, pane: string): Promise<string[] | null> {
    const r = h.focusWorks(rec.ids, opts)
    if (!r.queued) {
      this.markShown(rec)
      return r.found
    }
    this.queued = { op, tabId: rec.tabId, mapId: rec.mapId }
    const drawn = await waitDrawn(h, DRAWN_WAIT_MS, () => this.jumpOk(op, pane))
    if (!this.jumpOk(op, pane)) {
      if (this.queued?.op === op) this.dropJump()
      return null
    }
    if (this.queued?.op === op) this.queued = null
    this.markShown(rec)
    // 排队时引擎按数据判断 found（这个视图画不画这些作品还不知道）：画完了按画出来的算
    return drawn ? rec.ids.filter((id) => drawn.has(id)) : r.found
  }

  /** old = 上一题留下的聚焦（已经不作数）：跳完以后，新的聚焦没有盖在它那个标签上，就把它清掉（跳转作废了也清） */
  private async jump(end: SoloRoundEndMsg, old: LiveFocus | null = null) {
    try {
      await this.jumpTo(end)
    } finally {
      const now = this.live
      if (old && !(now && now !== old && now.tabId === old.tabId && now.mapId === old.mapId)) engineOf(old.tabId, old.mapId)?.clearFocus()
    }
  }

  private async jumpTo(end: SoloRoundEndMsg) {
    this.dropJump()
    const op = this.jumpOp
    if (this.lastEnd?.roundId === end.round_id) this.lastEnd.handled = true
    const pane0 = useFollow.getState().pane
    if (!pane0) return
    const group = this.groupIds()
    const works = new Map<string, WorkLite[] | null>()
    await Promise.all(group.map(async (id) => works.set(id, await this.worksOf(id))))
    // 取数据的时候下一题开始了、跟随移走了、又来了新的答案……：作废
    if (!this.jumpOk(op, pane0)) return
    const f = useFollow.getState()
    const w0 = ws()
    const pane = T.findPane(w0, pane0)
    if (!pane) return
    const shown = pane.active ? (w0.tabs[pane.active]?.mapId ?? null) : null
    const target = findTarget(group, (id) => works.get(id), shown, end.answer_id, end.answer_work_ids)
    if (!target) {
      this.clearOldFocus(null)
      this.notice(notInGroupText(end))
      return
    }
    const secondary = f.settings.markWrong ? pickSecondary(works.get(target.mapId) ?? [], end.wrong_guesses, target.ids) : []
    const mode = f.settings.mode
    const view = lastView()
    const pre = T.showMap(w0, pane0, target.mapId, view)
    if (!pre.tabId) return
    const tabId = pre.tabId
    if (mode === 'return') {
      // 先记原处再动（上一次的返回还没完成 → 沿用最早的原处）
      this.ret = planReturn(this.ret, this.captureOrigin(w0, pane), tabId, Date.now())
      if (this.retTimer) clearTimeout(this.retTimer)
      this.retTimer = null
    } else this.cancelReturn()
    this.expect = { tabId, view: null }
    updateWorkspace((w) => T.showMap(w, pane0, target.mapId, view).ws)

    const h = await waitEngine(tabId, target.mapId, ENGINE_WAIT_MS)
    if (!h || !this.jumpOk(op, pane0)) return
    this.clearOldFocus(tabId)
    const opts: FocusOptions = { mode: mode === 'flash' ? 'flash' : 'stay', reveal: true, secondary }
    const rec: LiveFocus = { tabId, mapId: target.mapId, ids: target.ids, secondary, mode: opts.mode, revealed: false, flashEnd: null }
    this.setLive(rec)
    const found = await this.focusOn(h, rec, opts, op, pane0)
    if (found === null) return
    if (!found.length && h.view !== 'canvas') {
      // 这个视图里没画出这些作品：换到分支画布再试一次
      if (this.expect?.tabId === tabId) this.expect.view = 'canvas'
      h.setView('canvas')
      rec.revealed = false
      rec.flashEnd = null
      if ((await this.focusOn(h, rec, opts, op, pane0)) === null) return
    }
    if (this.expect?.tabId === tabId) this.expect.view = h.view
    if (this.ret && mode === 'return') {
      this.ret.targetTab = tabId
      this.ret.focusedAt = Date.now()
      this.scheduleReturn()
    }
  }

  // ---------------------------------------------------------------- 返回
  /** 取消返回：计划和计时器都清掉，进行中的返回作废 */
  private cancelReturn() {
    if (this.retTimer) clearTimeout(this.retTimer)
    this.retTimer = null
    this.ret = null
    this.expect = null
    this.retOp++
  }

  private scheduleReturn() {
    if (this.retTimer) clearTimeout(this.retTimer)
    this.retTimer = null
    const p = this.ret
    if (!p) return
    const wait = returnWait(p, Date.now(), useFollow.getState().settings.returnSec)
    if (wait === null) return
    this.retTimer = setTimeout(() => void this.doReturn(), wait)
  }

  /** 用户切了标签 / 切了视图 = 接管：进行中的跳转、返回作废，之后不返回 */
  private checkTakeover(pane: PaneNode) {
    const e = this.expect
    if (!e) return
    const h = engineOf(e.tabId)
    if (!takenOver(e, { activeTab: pane.active, view: h?.view ?? null })) return
    this.dropOps()
    this.cancelReturn()
  }

  private onViewport(e: ViewportEvent) {
    // 用户自己平移 / 缩放了跳过去（或正在返回）的那张图 = 接管
    if (!this.expect || e.tabId !== this.expect.tabId || e.by !== 'user') return
    this.dropOps()
    this.cancelReturn()
  }

  private async doReturn() {
    const p = this.ret
    this.ret = null
    this.expect = null
    this.retTimer = null
    const pane0 = useFollow.getState().pane
    if (!p || !pane0 || !this.running) return
    const op = ++this.retOp
    if (this.live?.tabId === p.targetTab) this.clearOldFocus(null)
    else engineOf(p.targetTab)?.clearFocus()
    const o = p.origin
    if (!o.tabId) return
    const w0 = ws()
    const tab = w0.tabs[o.tabId]
    if (!tab || !T.findPane(w0, pane0)?.tabs.includes(o.tabId)) return
    const originTab = o.tabId
    // 返回途中用户切走了 / 动了原来那张图 = 接管
    this.expect = { tabId: originTab, view: null }
    updateWorkspace((w) => T.showTab(w, originTab))
    const h = await waitEngine(originTab, tab.mapId, ENGINE_WAIT_MS)
    if (!h || !this.retOk(op, pane0)) return
    this.expect = null
    if (o.view && h.view !== o.view) h.setView(o.view)
    if (o.view && o.vp) h.setViewport(o.vp, o.view)
  }

  // ---------------------------------------------------------------- 字幕和提示
  private showCaption(roundId: string, text: string) {
    if (this.captionTimer) clearTimeout(this.captionTimer)
    const key = ++this.seq
    useFollowRuntime.setState({ caption: { key, roundId, text } })
    this.captionTimer = setTimeout(() => {
      if (useFollowRuntime.getState().caption?.key === key) useFollowRuntime.setState({ caption: null })
    }, CAPTION_MS)
  }

  /** 角落提示；undo = 带「撤销」，panel = 带「选图组」（打开设置面板） */
  private notice(text: string, opts: { undo?: boolean; panel?: boolean } = {}) {
    const undo = !!opts.undo
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    if (!undo) this.undo = null
    const key = ++this.seq
    useFollowRuntime.setState({ notice: { key, text, undo, panel: !!opts.panel } })
    this.noticeTimer = setTimeout(
      () => {
        if (useFollowRuntime.getState().notice?.key !== key) return
        useFollowRuntime.setState({ notice: null })
        if (undo) this.undo = null
      },
      undo || opts.panel ? UNDO_NOTICE_MS : NOTICE_MS,
    )
  }

  private clearNotice() {
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.noticeTimer = null
    useFollowRuntime.setState({ notice: null })
  }
}
