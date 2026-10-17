/**
 * 单人猜猜呗这一侧的联动：订阅对局状态，按协议（./protocol.ts）往 BroadcastChannel 发消息；
 * 回应导图的 map:hello；记录导图最近一次 map:presence（给「导图已联动」小灯用）。
 *
 * 用法：SoloPage 里调一次 useSoloMapLink(kind)。页面卸载 = 发 solo:bye；
 * 只有正在开局的标签页发消息（点了「在新标签页打开」之后的那个旧标签页是 away，不发）。
 * 发什么、什么时候发都在 ./logic.ts 的纯函数里，这里只负责接线。
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { useSoloGame } from '@/features/solo/game'
import { useSoloHandoff } from '@/features/solo/handoff'
import {
  buildState,
  initialMemory,
  PRESENCE_INITIAL,
  presenceTick,
  presenceWake,
  reducePresence,
  step,
  stopStep,
  type LinkInput,
  type LinkMemory,
  type PresenceState,
} from './logic'
import {
  browserChannelFactory,
  newTabId,
  openLinkChannel,
  stamp,
  type ChannelFactory,
  type LinkMsg,
  type LinkSource,
  type SoloBody,
} from './protocol'

// ---------------------------------------------------------------- 导图的 presence（小灯用）
interface PresenceStore {
  state: PresenceState
  /** 收到导图一侧的 map:presence / map:bye */
  receive: (msg: LinkMsg, at: number) => void
  /** 定时检查：心跳迟到了就记下 ping 的发出时间。返回 true = 调用方现在要发一条 solo:ping */
  tick: (now: number) => boolean
  /** 单人页自己从隐藏 / 冻结回到前台。返回 true = 要发 solo:ping */
  wake: (now: number, lastTickAt: number) => boolean
  reset: () => void
}
export const useMapPresence = create<PresenceStore>()((set, get) => ({
  state: PRESENCE_INITIAL,
  receive: (msg, at) => {
    if (msg.type !== 'map:presence' && msg.type !== 'map:bye') return
    set((s) => ({ state: reducePresence(s.state, msg, at) }))
  },
  tick: (now) => {
    const r = presenceTick(get().state, now)
    if (r.state !== get().state) set({ state: r.state })
    return r.ping
  },
  wake: (now, lastTickAt) => {
    const r = presenceWake(get().state, now, lastTickAt)
    if (r.state !== get().state) set({ state: r.state })
    return r.ping
  },
  reset: () => set({ state: PRESENCE_INITIAL }),
}))

// ---------------------------------------------------------------- 接线
let currentKind: LinkSource = 'workbench'
/** 正在联动的那一份的「按当前状态补发」（startSoloLink 登记；没有在联动 = null） */
let activeSync: (() => void) | null = null
/**
 * SoloPage 告诉联动：现在的方案来自设置里选的已保存方案（plan）还是工作台（workbench）。
 * plan_key 由它决定（工作台固定 workbench），所以变了要立刻按新的 plan_key 补发一次 solo:state
 * （会话本身没变时，对局状态不会触发发送）。
 */
export function setLinkKind(kind: LinkSource): void {
  if (kind === currentKind) return
  currentKind = kind
  activeSync?.()
}

/** 已经向导图报告过的结束局（模块级：同一个浏览器标签页里跨多次进出 /solo 保留） */
let reported: Pick<LinkMemory, 'roundEndId' | 'gradeSent'> = { roundEndId: null, gradeSent: null }
/** 测试用：忘掉已报告的结束局 */
export function resetReported(): void {
  reported = { roundEndId: null, gradeSent: null }
}

export interface StartOptions {
  /** 测试用：换成内存频道 */
  channelFactory?: ChannelFactory
  tabId?: string
  now?: () => number
}

/** 从 store 里摘出 step 需要的状态 */
export function readInput(kind: LinkSource): LinkInput {
  const g = useSoloGame.getState()
  return {
    away: useSoloHandoff.getState().away,
    kind,
    sessionId: g.session?.session_id ?? null,
    poolTotal: g.session?.pool_total ?? null,
    spec: g.source?.spec ?? null,
    planName: g.source?.planName ?? null,
    phase: g.phase,
    roundId: g.round?.round_id ?? null,
    end: g.end,
    last: g.last ? { round_id: g.last.round_id, grade: g.last.grade, saving: g.last.saving } : null,
  }
}

/**
 * 开始联动。返回停止函数（发 solo:bye、取消订阅、关频道）。
 * 不支持 BroadcastChannel 时什么都不做（返回的停止函数也是空的）；小灯永远不会亮。
 */
export function startSoloLink(opts: StartOptions = {}): () => void {
  const now = opts.now ?? Date.now
  const tab = opts.tabId ?? newTabId()
  // 已报过的结束局（round_id 是 uuid，跨会话不会重复）跨 startSoloLink 保留：离开 /solo 再回来，停在结算画面时不会把同一局再报一次
  let mem = { ...initialMemory(), ...reported }

  const post = (body: SoloBody) => channel?.post(stamp(body, tab, now()))
  const flush = (r: { mem: typeof mem; out: SoloBody[] }) => {
    mem = r.mem
    reported = { roundEndId: mem.roundEndId, gradeSent: mem.gradeSent }
    for (const b of r.out) post(b)
  }
  const sync = () => flush(step(mem, readInput(currentKind)))

  const channel = openLinkChannel((msg) => {
    if (msg.src === tab) return
    if (msg.type === 'map:hello') {
      // 导图刚开始跟随：回一次当前的方案（没有会话 / 在别的标签页开局时没有可回的）
      const st = buildState(readInput(currentKind))
      if (st) post(st)
    } else if (msg.type === 'map:presence' || msg.type === 'map:bye') {
      useMapPresence.getState().receive(msg, now())
    }
  }, opts.channelFactory ?? browserChannelFactory)
  if (!channel) return () => {}

  activeSync = sync
  const unsubGame = useSoloGame.subscribe(sync)
  const unsubAway = useSoloHandoff.subscribe(sync)
  // 页面关闭 / 刷新：补一条 bye，导图一侧不用等心跳超时才知道
  const onHide = () => flush(stopStep(mem))
  // 掉线前先 ping：导图的心跳迟到了（它的窗口被遮住 / 最小化，定时器被浏览器压慢）不等于断开，先问一声，没人应答才灰。
  // 判断逻辑在 logic.ts 的 presenceTick / presenceWake；这里只管每秒问一次、回到前台时再问一次、把 ping 发出去。
  // away（已在新标签页打开）的旧标签页不发。
  let lastTickAt = now()
  const pingIf = (check: (t: number) => boolean) => {
    const t = now()
    const need = useSoloHandoff.getState().away ? false : check(t)
    lastTickAt = t
    if (need) post({ type: 'solo:ping' })
  }
  const onTimer = () => pingIf((t) => useMapPresence.getState().tick(t))
  // 自己从隐藏 / 冻结回到前台：先按当前时间重新判断（不拿隐藏前的旧 ping 记录直接判灰），需要就 ping
  const onWake = () => pingIf((t) => useMapPresence.getState().wake(t, lastTickAt))
  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') onWake()
  }
  const onShow = (e: Event) => {
    if ((e as PageTransitionEvent).persisted) {
      sync() // 从后退缓存里回来：重新通知一遍
      onWake()
    }
  }
  const timer = setInterval(onTimer, 1000)
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onHide)
    window.addEventListener('pageshow', onShow)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
    document.addEventListener('resume', onWake) // Page Lifecycle：被冻结的页面解冻
  }
  sync() // 订阅之前对局可能已经在进行（从别的页面回到 /solo）

  return () => {
    if (activeSync === sync) activeSync = null
    unsubGame()
    unsubAway()
    clearInterval(timer)
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('pageshow', onShow)
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility)
      document.removeEventListener('resume', onWake)
    }
    flush(stopStep(mem))
    channel.close()
    useMapPresence.getState().reset() // 离开单人页：小灯的状态不保留（回来时由导图的下一条 presence 重新点亮）
  }
}

/** SoloPage 用：挂上联动。kind = src.kind（设置里选了已保存方案 → 'plan'，否则 'workbench'） */
export function useSoloMapLink(kind: LinkSource): void {
  useEffect(() => {
    setLinkKind(kind)
  }, [kind])
  useEffect(() => startSoloLink(), [])
}
