/**
 * 联动的纯逻辑（不碰浏览器、不碰 store，好测）：
 * - step：单人一侧「现在的状态」对照「已经发过什么」，算出这次该发哪些消息（发什么、什么时候发、怎么去重）
 * - reducePresence / lampState / presenceTick / presenceWake：「导图已联动」小灯的状态机（含掉线前先 ping 一下；按导图窗口分别记录再汇总）
 * 副作用（订阅 store、发 BroadcastChannel）在 ./soloLink.ts。
 */
import type { EndBlock, Grade } from '@/features/solo/api'
import type { Phase } from '@/features/solo/game'
import type { SpecV2 } from '@/features/v2/types'
import { linkPlanKey, type Body, type LinkSource, type MapMsg, type SoloBody, type SoloRoundEndMsg, type SoloStateMsg } from './protocol'

// ---------------------------------------------------------------- 单人 → 导图：该发什么
/** step 需要看的那一小部分状态（从 useSoloGame / useSoloHandoff 里摘出来） */
export interface LinkInput {
  /** 已经在新标签页打开（这一页不开局）：不发消息 */
  away: boolean
  kind: LinkSource
  sessionId: string | null
  poolTotal: number | null
  spec: SpecV2 | null
  planName: string | null
  phase: Phase
  roundId: string | null
  end: EndBlock | null
  last: { round_id: string; grade: Grade; saving: boolean } | null
}

/** 已经发过什么（去重用） */
export interface LinkMemory {
  /** 已经通知过导图「我在开局」（再发 bye 才有意义） */
  active: boolean
  /** 已发 solo:state 的会话 */
  stateSession: string | null
  /** 已发 solo:state 的 plan_key（同一个会话里 plan_key 变了，例如设置里在「工作台」和同名已保存方案之间切换，要再发一次） */
  statePlanKey: string | null
  /** 已发 solo:round-start 的那一局 */
  roundStartId: string | null
  /** 已发 solo:round-end 的那一局（只在 round_id 变了才发，每局一次） */
  roundEndId: string | null
  /** 导图那边现在认为这局(roundEndId)的评级 */
  gradeSent: Grade | null
}

export const initialMemory = (): LinkMemory => ({
  active: false,
  stateSession: null,
  statePlanKey: null,
  roundStartId: null,
  roundEndId: null,
  gradeSent: null,
})

/** 当前能发的 solo:state；没有会话（或不在开局）= null。plan_key 的规则见 protocol.ts 的 linkPlanKey（来自工作台一律 workbench） */
export function buildState(i: LinkInput): Body<SoloStateMsg> | null {
  if (i.away || !i.sessionId || !i.spec || i.poolTotal == null) return null
  return {
    type: 'solo:state',
    plan_key: linkPlanKey(i.kind, i.planName),
    plan_name: i.planName,
    source: i.kind,
    spec: i.spec,
    pool_total: i.poolTotal,
  }
}

/** 结束块 → solo:round-end 的内容（结束块里缺的字段给空值，不报错）。plan_key 和 solo:state 用同一条规则（linkPlanKey） */
export function buildRoundEnd(end: EndBlock, kind: LinkSource, planName: string | null): Omit<SoloRoundEndMsg, 'src' | 'at'> {
  const bw = end.card?.bound_work ?? null
  const boundId = end.bound_work_id ?? bw?.id ?? null
  return {
    type: 'solo:round-end',
    round_id: end.round_id,
    plan_key: linkPlanKey(kind, planName),
    answer_id: end.answer_id,
    answer_name: end.answer_name,
    // 名字来自结算卡片的 bound_work（和 bound_work_id 是同一个作品；对不上就留空，不拿别的作品的名字顶）
    bound_work: boundId == null ? null : { id: boundId, name: bw && bw.id === boundId ? bw.name : '' },
    answer_work_ids: end.answer_work_ids ?? [],
    wrong_guesses: end.wrong_guesses ?? [],
    grade: end.grade,
    ended_by: end.ended_by,
  }
}

export interface StepResult {
  mem: LinkMemory
  out: SoloBody[]
}

/**
 * 状态变了（或刚开始订阅）时调用：返回这次该发的消息和新的“已发”记录。
 * 顺序固定：state → round-start → round-end → grade（先让导图知道方案，再知道一局的开始、结束、改评级）。
 *
 * - away（点了「在新标签页打开」）：不发任何东西；之前通知过导图就补发一条 bye，只发一次
 * - state：会话 id 或 plan_key 变了才发（建会话、换方案、后端重启后重建；设置里在工作台和已保存方案之间切换时 plan_key 会变）
 * - round-start：只在 phase 为 playing 时、round_id 变了才发
 * - round-end：end.round_id 变了才发（每局一次；之后改评级不会再发 round-end）
 * - grade：这局的评级改了，并且改评级的请求已经回来（saving 为 false）、和导图那边认为的不一样才发
 */
export function step(prev: LinkMemory, i: LinkInput): StepResult {
  if (i.away) {
    return { mem: { ...initialMemory(), roundEndId: prev.roundEndId, gradeSent: prev.gradeSent }, out: prev.active ? [{ type: 'solo:bye' }] : [] }
  }
  const mem = { ...prev }
  const out: SoloBody[] = []

  const st = buildState(i)
  if (st && (i.sessionId !== mem.stateSession || st.plan_key !== mem.statePlanKey)) {
    out.push(st)
    mem.stateSession = i.sessionId
    mem.statePlanKey = st.plan_key
    mem.active = true
  }
  if (!mem.active) return { mem, out }

  if (i.phase === 'playing' && i.roundId && i.roundId !== mem.roundStartId) {
    out.push({ type: 'solo:round-start', round_id: i.roundId })
    mem.roundStartId = i.roundId
  }
  if (i.end && i.end.round_id !== mem.roundEndId) {
    out.push(buildRoundEnd(i.end, i.kind, i.planName))
    mem.roundEndId = i.end.round_id
    mem.gradeSent = i.end.grade
  }
  if (i.last && i.last.round_id === mem.roundEndId && !i.last.saving && i.last.grade !== mem.gradeSent) {
    out.push({ type: 'solo:grade', round_id: i.last.round_id, grade: i.last.grade })
    mem.gradeSent = i.last.grade
  }
  return { mem, out }
}

/** 这个标签页不再开局（卸载 / 页面关闭）：之前通知过导图就发一条 bye，并忘掉会话和当局（再开始时重新通知）；已报告的结束局记录保留，不重复报 */
export function stopStep(prev: LinkMemory): StepResult {
  return { mem: { ...initialMemory(), roundEndId: prev.roundEndId, gradeSent: prev.gradeSent }, out: prev.active ? [{ type: 'solo:bye' }] : [] }
}

// ---------------------------------------------------------------- 「导图已联动」小灯
/*
 * 不能只看「几秒没有心跳」就判灰：导图窗口被遮住 / 最小化时浏览器会节流它的定时器
 * （隐藏超过 5 分钟后每分钟才跑一次），2 秒一次的 map:presence 会迟到；但 BroadcastChannel 的消息处理不受节流影响。
 * 所以单人页在心跳迟到时先发 solo:ping，导图收到就立刻回一条 map:presence；ping 也没人应答才算断开。
 *
 *   上次心跳        0 ───────── 6 秒 ───────── 10 秒 ─────────▶
 *   亮              ✔            ✔               ✔（还没 ping 过 / ping 发出不到 2 秒 / ping 已有回应）
 *   发 ping                      ▲ 超过 6 秒，每 2 秒最多一次
 *   灰                                           ▲ 超过 10 秒，并且 ping 发出至少 2 秒还没回
 *   map:bye                      任何时候立刻灰
 *
 * 可能同时开着好几个导图窗口（不同标签页，消息的 src 不同）。上面这套规则对每个导图窗口分别算一遍，再汇总：
 * - 小灯显示与否：任何一个导图窗口要求显示（following 且 show_dot）就显示；某个窗口 show_dot:false 只影响它自己
 * - 亮 / 灰：要求显示的窗口里至少有一个「有效」（没 bye、没判丢）就亮；全都失效才灰
 * - 某个窗口 bye 或超时，只让它自己失效，不影响别的窗口
 *
 * 全部是纯函数：时间由调用方传进来（Date.now()），本文件不碰计时器。定时器和发消息在 ./soloLink.ts。
 */
/** 上次心跳超过这么久：开始发 solo:ping */
export const PRESENCE_PING_AFTER_MS = 6000
/** 两次 solo:ping 之间至少隔这么久 */
export const PRESENCE_PING_GAP_MS = 2000
/** 上次心跳超过这么久，并且 ping 无人应答：灰 */
export const PRESENCE_LOST_AFTER_MS = 10000
/** ping 发出这么久还没有回应：才算「无人应答」 */
export const PRESENCE_PING_WAIT_MS = 2000
/** 最多同时记着几个导图窗口（每个标签页一个 src，开关很多次才会堆起来）；超过时先丢已失效的（最旧的先走），还超就丢心跳最旧的（哪怕它还有效） */
export const PRESENCE_MAX_MAPS = 16

/** 一个导图窗口（按消息的 src 区分）的状态 */
export interface MapBeat {
  /** 它最近一条 presence 说要显示小灯（following 且 show_dot） */
  showDot: boolean
  /** 它最近一条 presence 到达的时间（本机 Date.now()，不信对方的 at：对方标签页的计时器可能被浏览器放慢） */
  lastBeatAt: number
  /** 发给它的最早一条还没被回应的 ping 的发出时间（它的下一条心跳到达就清掉）。判灰看这个，不看最近一次 ping：导图一直不回时每 2 秒又发一条 ping，不能每次都把计时重新算起 */
  pendingSince: number | null
  /** 它发过 map:bye，之后没有新的 presence */
  bye: boolean
}

export interface PresenceState {
  /** 导图窗口 src -> 它的状态 */
  maps: Record<string, MapBeat>
  /** 最近一次发 solo:ping 的时间（本机 Date.now()）；ping 是广播，所以频率限制是全局的。从没发过 = null */
  lastPingAt: number | null
  /** 最近一次「回到前台」的处理时间（本机 Date.now()）。同一次恢复常常连着触发 resume / visibilitychange / pageshow 好几个事件，靠它合并成一次。从没处理过 = null */
  lastWakeAt: number | null
}
export const PRESENCE_INITIAL: PresenceState = { maps: {}, lastPingAt: null, lastWakeAt: null }

export type LampState = 'hidden' | 'on' | 'off'
export const LAMP_TIP: Record<Exclude<LampState, 'hidden'>, string> = { on: '导图已联动', off: '导图联动已断开' }

/** 这个导图窗口现在算「有效」：要求显示、没 bye、没被判丢（心跳超过 10 秒，并且 ping 发出至少 2 秒还没回） */
function beatValid(m: MapBeat, now: number): boolean {
  if (!m.showDot || m.bye) return false
  const lost = now - m.lastBeatAt > PRESENCE_LOST_AFTER_MS && m.pendingSince != null && now - m.pendingSince >= PRESENCE_PING_WAIT_MS
  return !lost
}

/**
 * 窗口超过上限（PRESENCE_MAX_MAPS）时淘汰多出来的：先淘汰已失效的（最旧的先走），还超就淘汰心跳最旧的有效窗口。
 * 超过 16 个导图页本来就不是正常使用，所以宁可丢掉一个最久没动静的有效窗口，也不让记录无限增长。
 * keep = 刚收到消息的那个窗口，永远不淘汰。
 */
function pruneMaps(maps: Record<string, MapBeat>, now: number, keep: string): Record<string, MapBeat> {
  const keys = Object.keys(maps)
  const excess = keys.length - PRESENCE_MAX_MAPS
  if (excess <= 0) return maps
  const byAge = (a: string, b: string) => maps[a].lastBeatAt - maps[b].lastBeatAt
  const others = keys.filter((k) => k !== keep)
  const invalid = others.filter((k) => !beatValid(maps[k], now)).sort(byAge)
  const valid = others.filter((k) => beatValid(maps[k], now)).sort(byAge)
  const out = { ...maps }
  for (const k of [...invalid, ...valid].slice(0, excess)) delete out[k]
  return out
}

/**
 * 收到导图一侧的 presence / bye：按消息的 src 更新对应那个导图窗口（hello 不影响小灯）。
 * presence 到达 = 这个窗口之前的 ping 有回应了（pendingSince 清掉）；bye 只让发它的那个窗口失效，没见过的 src 的 bye 忽略。
 */
export function reducePresence(s: PresenceState, msg: MapMsg, receivedAt: number): PresenceState {
  if (msg.type === 'map:presence') {
    const beat: MapBeat = { showDot: msg.following && msg.show_dot, lastBeatAt: receivedAt, pendingSince: null, bye: false }
    return { ...s, maps: pruneMaps({ ...s.maps, [msg.src]: beat }, receivedAt, msg.src) }
  }
  if (msg.type === 'map:bye') {
    const cur = s.maps[msg.src]
    return cur ? { ...s, maps: { ...s.maps, [msg.src]: { ...cur, bye: true } } } : s
  }
  return s
}

/** 有没有任何一个导图窗口要求显示小灯（小灯组件据此决定要不要开计时） */
export function presenceWantsDot(s: PresenceState): boolean {
  return Object.values(s.maps).some((m) => m.showDot)
}

/**
 * 小灯现在的样子（汇总所有导图窗口）：
 * - 没有任何窗口要求显示 → hidden（不显示）
 * - 要求显示的窗口里至少有一个有效（见 beatValid）→ on（包括：心跳迟到但还没 ping / ping 刚发出 / 导图只是被浏览器节流）
 * - 要求显示的窗口全部失效（bye、或心跳超过 10 秒且 ping 发出至少 2 秒没回）→ off（灰）
 */
export function lampState(s: PresenceState, now: number): LampState {
  const wanted = Object.values(s.maps).filter((m) => m.showDot)
  if (!wanted.length) return 'hidden'
  return wanted.some((m) => beatValid(m, now)) ? 'on' : 'off'
}

export interface PresenceTick {
  state: PresenceState
  /** 这次该发一条 solo:ping（调用方发出去；状态里已经记下了发出时间） */
  ping: boolean
}

/**
 * 定时检查（单人页的定时器每秒调一次）：有要求显示、没 bye 的导图窗口上次心跳超过 6 秒，就该 ping，最多每 2 秒一次。
 * ping 发出时，给每个心跳超过 6 秒的窗口记下 pendingSince（它们要是不回，才会被判丢）。
 * 没有这样的窗口（没连上 / 都不显示 / 都已收到 bye / 心跳都很新）时不 ping。
 */
export function presenceTick(s: PresenceState, now: number): PresenceTick {
  const stale = Object.keys(s.maps).filter((k) => {
    const m = s.maps[k]
    return m.showDot && !m.bye && now - m.lastBeatAt > PRESENCE_PING_AFTER_MS
  })
  if (!stale.length) return { state: s, ping: false }
  // 全局限频；系统时间往回调过（距上次 ping 是负数）时不卡住，当作隔了足够久
  if (s.lastPingAt != null && now - s.lastPingAt >= 0 && now - s.lastPingAt < PRESENCE_PING_GAP_MS) return { state: s, ping: false }
  const maps = { ...s.maps }
  for (const k of stale) maps[k] = { ...maps[k], pendingSince: maps[k].pendingSince ?? now }
  return { state: { ...s, maps, lastPingAt: now }, ping: true }
}

/**
 * 单人页自己从隐藏 / 冻结回到前台：先按当前时间重新判断一次，必要时 ping。
 * 单人页自己的定时器和消息处理也可能被浏览器暂停过，此刻手里的「上次心跳 / 上次 ping」不一定是最新的
 * （导图的回应可能已经在排队、还没处理），所以不能拿旧的 ping 记录直接判灰：
 * - 隐藏之前（lastTickAt，页面最后一次正常运行的时间）有效的窗口 → 忘掉它旧的「没回应」记录（pendingSince），
 *   灰只能由「现在发出、至少 2 秒没回」的 ping 判出来
 * - 隐藏之前就已经失效的窗口 → 保持，不在回到前台时闪一下「亮」
 * - ping 照样受全局限频（距上次 ping 不到 2 秒就等下一次定时检查，最多晚 1 秒），不因为回到前台就绕过去
 *
 * 同一次恢复常常连着触发好几个事件（resume、visibilitychange、pageshow，间隔可能只有 1 毫秒），所以：
 * 距上一次「回到前台」处理不到 2 秒的，算同一次恢复，只当普通的定时检查（presenceTick），
 * 上一次唤醒刚发出的 ping 会记着、也不会多发，回应等待时间从那条 ping 发出的时刻起完整计算。
 */
export function presenceWake(s: PresenceState, now: number, lastTickAt: number): PresenceTick {
  // 没有任何「要求显示、没 bye」的窗口：没有可唤醒的，也没有可 ping 的
  if (!Object.values(s.maps).some((m) => m.showDot && !m.bye)) return { state: s, ping: false }
  const sinceWake = s.lastWakeAt == null ? null : now - s.lastWakeAt
  if (sinceWake != null && sinceWake >= 0 && sinceWake < PRESENCE_PING_GAP_MS) return presenceTick(s, now)
  const maps: Record<string, MapBeat> = {}
  for (const k of Object.keys(s.maps)) {
    const m = s.maps[k]
    maps[k] = beatValid(m, lastTickAt) ? { ...m, pendingSince: null } : m
  }
  return presenceTick({ ...s, maps, lastWakeAt: now }, now)
}
