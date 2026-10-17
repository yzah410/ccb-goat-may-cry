/**
 * 导图 × 单人猜猜呗联动的消息协议（浏览器 BroadcastChannel，同源的标签页之间直接通信，不经过后端）。
 *
 * 频道名 `outsetter.maplink.v1`。每条消息都带：
 * - type：消息类型（下面 9 种）
 * - src：发消息的标签页的随机 id（收到自己发的就忽略；导图一侧可以据此区分是哪个单人标签页）
 * - at：发出时的毫秒时间戳（Date.now()）
 *
 * 单人 → 导图
 *   solo:state        会话建立 / 换方案时发；收到 map:hello 也回一次。{ plan_key, plan_name, source, spec, pool_total }
 *                     plan_key 由 source 决定（linkPlanKey）：workbench → 固定 `workbench`；plan → `plan:<方案名>`。
 *                     plan_name 只是显示用的名字（工作台里载入过方案 A 时仍是 A），不能用来推出 plan_key。
 *                     spec 必须是完整的 SpecV2 结构（见 isSpecV2Shape），格式不对的 solo:state 整条丢弃。
 *   solo:round-start  新的一局开始。{ round_id }
 *   solo:round-end    一局结束。{ round_id, plan_key, answer_id, answer_name, bound_work, answer_work_ids, wrong_guesses, grade, ended_by }
 *   solo:grade        手动改了刚结束那一局的评级。{ round_id, grade }
 *   solo:bye          这个标签页不再开局（页面关闭、离开、点了「在新标签页打开」）。
 *   solo:ping         只有信封。单人页发现好一阵没收到 map:presence 时发，问导图「你还在吗」。
 *                     导图一侧收到 solo:ping 要立刻回一条 map:presence（内容和平时的心跳一样），
 *                     不要等下一次 2 秒定时器：导图窗口被遮住 / 最小化时，浏览器会把它的定时器压慢
 *                     （隐藏超过 5 分钟后每分钟才跑一次），心跳会迟到；但 BroadcastChannel 的消息处理不受这种节流影响，
 *                     所以靠 ping 的即时应答，单人页才不会把「只是被节流」误判成断开。
 * 导图 → 单人
 *   map:hello         开启「跟随」时发，请求单人标签页回一条 solo:state。
 *   map:presence      跟随开着时每 2 秒一条，另外收到 solo:ping 时立刻回一条。{ following: true, show_dot }；
 *                     单人一侧据此亮「导图已联动」小灯：上次心跳超过 6 秒就 ping（最多每 2 秒一次），
 *                     心跳超过 10 秒、并且 ping 发出至少 2 秒还没回，才变灰；收到 map:bye 立刻变灰。
 *   map:bye           导图一侧关闭 / 关掉跟随。
 *
 * 只有正在开局的单人标签页发消息（solo:ping 也一样：away 的旧标签页不发）；不支持 BroadcastChannel 的浏览器静默降级（什么都不发、什么都收不到）。
 * 后端接口（预选、图组存储）见 ./api.ts，和这个协议互不依赖。
 */
import type { EndedBy, Grade, WrongGuess } from '@/features/solo/api'
import type { DrawMethod, ModeId, SpecV2 } from '@/features/v2/types'

export const MAPLINK_CHANNEL = 'outsetter.maplink.v1'

/** 方案来自哪里：设置里选的已保存方案 / 工作台当前方案 */
export type LinkSource = 'plan' | 'workbench'

export const GRADE_VALUES: readonly Grade[] = ['easy', 'good', 'hard', 'again']
export const ENDED_BY_VALUES: readonly EndedBy[] = ['exact', 'work', 'surrender']

/** 联动图组存储 / 导图用的方案标识：保存过的方案 `plan:<方案名>`，没有方案名 `workbench` */
export function planKeyOf(planName: string | null | undefined): string {
  const name = typeof planName === 'string' ? planName.trim() : ''
  return name ? `plan:${name}` : 'workbench'
}

/**
 * 单人页发给导图的 plan_key（solo:state 和 solo:round-end 共用这一条规则）：
 * - 来自工作台（kind === 'workbench'）：固定 `workbench`。工作台可以载入方案 A 再改条件，改完的就不是已保存的方案 A 了，
 *   不能和 `plan:A` 共用一个图组；
 * - 来自设置里选的已保存方案（kind === 'plan'）：`plan:<方案名>`（planKeyOf）。
 * 导图一侧直接用收到的 plan_key，不从 plan_name 推。
 */
export function linkPlanKey(kind: LinkSource, planName: string | null | undefined): string {
  return kind === 'workbench' ? 'workbench' : planKeyOf(planName)
}

// ---------------------------------------------------------------- 消息类型
export interface Envelope {
  /** 发消息的标签页 id */
  src: string
  /** 发出时间（毫秒） */
  at: number
}

export interface SoloStateMsg extends Envelope {
  type: 'solo:state'
  plan_key: string
  plan_name: string | null
  source: LinkSource
  spec: SpecV2
  pool_total: number
}
export interface SoloRoundStartMsg extends Envelope {
  type: 'solo:round-start'
  round_id: string
}
export interface SoloRoundEndMsg extends Envelope {
  type: 'solo:round-end'
  round_id: string
  plan_key: string
  answer_id: number
  answer_name: string
  /** 答案的绑定作品；没有 = null */
  bound_work: { id: number; name: string } | null
  /** 绑定作品在前，再加当前模式下全部登场作品（subject_id，去重） */
  answer_work_ids: number[]
  /** 这局猜过但没猜中的角色（不含超时行，按角色去重；work_ids 最多 50 个） */
  wrong_guesses: WrongGuess[]
  grade: Grade
  ended_by: EndedBy
}
export interface SoloGradeMsg extends Envelope {
  type: 'solo:grade'
  round_id: string
  grade: Grade
}
export interface SoloByeMsg extends Envelope {
  type: 'solo:bye'
}
/** 单人页问导图「你还在吗」：导图收到要立刻回一条 map:presence（见文件头注释） */
export interface SoloPingMsg extends Envelope {
  type: 'solo:ping'
}

export interface MapHelloMsg extends Envelope {
  type: 'map:hello'
}
export interface MapPresenceMsg extends Envelope {
  type: 'map:presence'
  following: boolean
  /** 单人页要不要亮「导图已联动」小灯 */
  show_dot: boolean
}
export interface MapByeMsg extends Envelope {
  type: 'map:bye'
}

export type SoloMsg = SoloStateMsg | SoloRoundStartMsg | SoloRoundEndMsg | SoloGradeMsg | SoloByeMsg | SoloPingMsg
export type MapMsg = MapHelloMsg | MapPresenceMsg | MapByeMsg
export type LinkMsg = SoloMsg | MapMsg
export type LinkMsgType = LinkMsg['type']

/** 去掉信封的内容部分（构造消息时只写这些，src / at 由 stamp 补） */
export type Body<M extends LinkMsg> = Omit<M, 'src' | 'at'>
export type SoloBody = { [K in SoloMsg['type']]: Body<Extract<SoloMsg, { type: K }>> }[SoloMsg['type']]
export type MapBody = { [K in MapMsg['type']]: Body<Extract<MapMsg, { type: K }>> }[MapMsg['type']]
export type LinkBody = SoloBody | MapBody

export const SOLO_TYPES: readonly SoloMsg['type'][] = ['solo:state', 'solo:round-start', 'solo:round-end', 'solo:grade', 'solo:bye', 'solo:ping']
export const MAP_TYPES: readonly MapMsg['type'][] = ['map:hello', 'map:presence', 'map:bye']

/** 给消息内容补上信封 */
export function stamp<B extends LinkBody>(body: B, src: string, at: number): B & Envelope {
  return { ...body, src, at }
}

// ---------------------------------------------------------------- 标签页 id
/** 随机 id（够区分同一个浏览器里的几个标签页就行，不是安全用途） */
export function newTabId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) {
    try {
      return c.randomUUID()
    } catch {
      /* 非安全环境可能不给：用下面的 */
    }
  }
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

// ---------------------------------------------------------------- 校验
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const isIntArr = (v: unknown): v is number[] => Array.isArray(v) && v.every(isInt)
const isGrade = (v: unknown): v is Grade => typeof v === 'string' && (GRADE_VALUES as readonly string[]).includes(v)
const isEndedBy = (v: unknown): v is EndedBy => typeof v === 'string' && (ENDED_BY_VALUES as readonly string[]).includes(v)
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function isWrongGuess(v: unknown): v is WrongGuess {
  return isRec(v) && isInt(v.char_id) && isStr(v.name) && isIntArr(v.work_ids)
}
function isBoundWork(v: unknown): v is { id: number; name: string } | null {
  return v === null || (isRec(v) && isInt(v.id) && isStr(v.name))
}

/** 模式、抽题方式的合法取值（和 workbench2/spec.ts 的 MODE_IDS / DRAW_METHODS 一致，protocol.test.ts 核对）；这个文件不引入运行时依赖，所以单独列 */
export const SPEC_MODES: readonly ModeId[] = ['anime', 'game', 'book', 'real', 'all']
export const SPEC_DRAW_METHODS: readonly DrawMethod[] = ['per_character', 'per_work', 'range_share']

/** 一个纳入 / 排除范围的必需结构（RangeV2 里不带 ? 的字段）；条件、来源的内部细节交给后端校验 */
function isRangeShape(v: unknown): boolean {
  return isRec(v) && isNonEmptyStr(v.id) && typeof v.enabled === 'boolean' && isRec(v.source) && isRec(v.pick) && Array.isArray(v.conditions)
}

/**
 * solo:state 里的 spec 是不是一个结构完整的 SpecV2（前端类型里不带 ? 的部分）：
 * version 是 2；game 有合法的 mode 和整数 tag_count；ranges、excludes 是范围数组；draw 有合法的 method（seed 可选，整数或 null）；meta 可选。
 * 只查「形状」，不查数值范围（tag_count 在不在 0–10 之类交给后端 parse_spec，错了它会返回 bad_spec）。
 * 多出来的字段不管（方案里允许有不认识的字段）。
 */
export function isSpecV2Shape(v: unknown): v is SpecV2 {
  if (!isRec(v) || v.version !== 2) return false
  const g = v.game
  if (!isRec(g) || !(SPEC_MODES as readonly unknown[]).includes(g.mode) || !isInt(g.tag_count)) return false
  if (!Array.isArray(v.ranges) || !v.ranges.every(isRangeShape)) return false
  if (!Array.isArray(v.excludes) || !v.excludes.every(isRangeShape)) return false
  const d = v.draw
  if (!isRec(d) || !(SPEC_DRAW_METHODS as readonly unknown[]).includes(d.method)) return false
  if (!(d.seed === undefined || d.seed === null || isInt(d.seed))) return false
  return v.meta === undefined || isRec(v.meta)
}

/**
 * 从频道里收到的任意数据 → 合法的消息，或 null（格式不对 / 不认识的类型 / 别的版本的协议）。
 * 只检查协议里写明的字段；多出来的字段保留（以后加字段不会让老版本丢消息）。
 */
export function parseMessage(data: unknown): LinkMsg | null {
  if (!isRec(data)) return null
  if (!isNonEmptyStr(data.src) || !isNum(data.at) || !isStr(data.type)) return null
  switch (data.type) {
    case 'solo:state':
      if (!isStr(data.plan_key) || !(data.plan_name === null || isStr(data.plan_name))) return null
      if (data.source !== 'plan' && data.source !== 'workbench') return null
      if (!isSpecV2Shape(data.spec) || !isInt(data.pool_total) || data.pool_total < 0) return null
      return data as unknown as SoloStateMsg
    case 'solo:round-start':
      return isNonEmptyStr(data.round_id) ? (data as unknown as SoloRoundStartMsg) : null
    case 'solo:round-end':
      if (!isNonEmptyStr(data.round_id) || !isStr(data.plan_key) || !isInt(data.answer_id) || !isStr(data.answer_name)) return null
      if (!isBoundWork(data.bound_work) || !isIntArr(data.answer_work_ids)) return null
      if (!Array.isArray(data.wrong_guesses) || !data.wrong_guesses.every(isWrongGuess)) return null
      if (!isGrade(data.grade) || !isEndedBy(data.ended_by)) return null
      return data as unknown as SoloRoundEndMsg
    case 'solo:grade':
      return isNonEmptyStr(data.round_id) && isGrade(data.grade) ? (data as unknown as SoloGradeMsg) : null
    case 'solo:bye':
    case 'solo:ping':
    case 'map:hello':
    case 'map:bye':
      return data as unknown as SoloByeMsg | SoloPingMsg | MapHelloMsg | MapByeMsg
    case 'map:presence':
      return typeof data.following === 'boolean' && typeof data.show_dot === 'boolean' ? (data as unknown as MapPresenceMsg) : null
    default:
      return null
  }
}

// ---------------------------------------------------------------- 频道
/** BroadcastChannel 里用到的那一小部分（测试里用内存版代替） */
export interface ChannelLike {
  postMessage(data: unknown): void
  close(): void
  onmessage: ((ev: { data: unknown }) => void) | null
}
export type ChannelFactory = (name: string) => ChannelLike | null

/** 默认工厂：浏览器的 BroadcastChannel；不支持（或被禁用）= null */
export const browserChannelFactory: ChannelFactory = (name) => {
  const BC = (globalThis as { BroadcastChannel?: new (n: string) => ChannelLike }).BroadcastChannel
  if (typeof BC !== 'function') return null
  try {
    return new BC(name)
  } catch {
    return null
  }
}

export interface LinkChannel {
  /** 发一条消息；发不出去（频道关了、数据不能克隆）静默忽略 */
  post(msg: LinkMsg): void
  close(): void
}

/**
 * 打开联动频道。onMessage 只收到格式合法的消息（parseMessage 通过的）；
 * 不支持 BroadcastChannel 时返回 null——调用方什么都不用做，联动就是不存在。
 */
export function openLinkChannel(onMessage: (msg: LinkMsg) => void, factory: ChannelFactory = browserChannelFactory): LinkChannel | null {
  const ch = factory(MAPLINK_CHANNEL)
  if (!ch) return null
  let closed = false
  ch.onmessage = (ev) => {
    if (closed) return
    const msg = parseMessage(ev.data)
    if (!msg) return
    try {
      onMessage(msg)
    } catch (e) {
      // 一条消息处理出错不能拖垮频道
      console.warn('[maplink] 处理消息出错', e)
    }
  }
  return {
    post: (msg) => {
      if (closed) return
      try {
        ch.postMessage(msg)
      } catch {
        /* 数据不能克隆 / 频道已被浏览器关掉：联动是锦上添花，不影响玩 */
      }
    },
    close: () => {
      if (closed) return
      closed = true
      ch.onmessage = null
      try {
        ch.close()
      } catch {
        /* 已经关了 */
      }
    },
  }
}
