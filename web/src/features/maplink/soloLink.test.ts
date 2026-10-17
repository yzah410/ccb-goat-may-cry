/**
 * 单人一侧的联动接线：用内存版 BroadcastChannel，一边是 startSoloLink，一边是模拟的“导图”。
 * 对局状态直接往 useSoloGame 里写（不走接口），检查导图收到的消息和单人页记下的 presence。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/Toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}))
vi.mock('@/features/candidates/avatar', () => ({
  useAvatarStore: { getState: () => ({ request: vi.fn() }) },
}))

import type { EndBlock, SessionResp } from '@/features/solo/api'
import { useSoloGame, type LastRound } from '@/features/solo/game'
import { useSoloHandoff } from '@/features/solo/handoff'
import type { SpecV2 } from '@/features/v2/types'
import { defaultSpec } from '@/features/workbench2/spec'
import { lampState, presenceWantsDot } from './logic'
import {
  openLinkChannel,
  stamp,
  type ChannelFactory,
  type ChannelLike,
  type LinkChannel,
  type LinkMsg,
  type LinkBody,
} from './protocol'
import { resetReported, setLinkKind, startSoloLink, useMapPresence } from './soloLink'

// ---------------------------------------------------------------- 内存频道：同名频道互相收到（不含自己）
function bus() {
  const all = new Set<ChannelLike>()
  const factory: ChannelFactory = () => {
    const ch: ChannelLike = {
      onmessage: null,
      postMessage: (data) => {
        for (const other of all) if (other !== ch) other.onmessage?.({ data: structuredClone(data) })
      },
      close: () => void all.delete(ch),
    }
    all.add(ch)
    return ch
  }
  return { factory, size: () => all.size }
}

/** 完整合法的 SpecV2：solo:state 会经过 parseMessage 的校验（spec 结构不完整的消息会被丢掉） */
const SPEC: SpecV2 = defaultSpec(new Date('2026-10-15T00:00:00'))
let T = 1_000
const now = () => T

/** 模拟导图标签页：收到什么记什么 */
function fakeMap(factory: ChannelFactory, srcName = 'map-tab') {
  const got: LinkMsg[] = []
  const link = openLinkChannel((m) => got.push(m), factory) as LinkChannel
  const send = (body: LinkBody) => link.post(stamp(body, srcName, T))
  return { got, send, types: () => got.map((m) => m.type), clear: () => (got.length = 0), link }
}

const session = (id = 's1', pool = 42): SessionResp => ({ session_id: id, pool_total: pool }) as unknown as SessionResp
const end = (p: Partial<EndBlock> = {}): EndBlock =>
  ({
    round_id: 'r1',
    answer_id: 9,
    answer_name: '答案',
    card: { bound_work: { id: 101, name: '作品甲', year: 2024 } },
    grade: 'good',
    grade_auto: 'good',
    ended_by: 'exact',
    answer_work_ids: [101, 102],
    bound_work_id: 101,
    wrong_guesses: [],
    ...p,
  }) as unknown as EndBlock
const last = (p: Partial<LastRound> = {}): LastRound =>
  ({ round_id: 'r1', name: '答案', grade: 'good', grade_auto: 'good', next_gap: 3, timing: '', saving: false, ...p }) as LastRound

const G = useSoloGame

/** 单人页：已建会话、第 1 局进行中 */
const playing = (roundId = 'r1', sessionId = 's1') =>
  G.setState({
    source: { spec: SPEC, planName: '方案A', newEvery: 4, key: 'k' },
    session: session(sessionId),
    phase: 'playing',
    round: { round_id: roundId } as never,
    end: null,
  })

beforeEach(() => {
  G.getState().reset()
  useSoloHandoff.setState({ away: false })
  useMapPresence.getState().reset()
  resetReported()
  setLinkKind('plan')
  T = 1_000
  vi.useFakeTimers() // 单人页每秒一次的 ping 定时器：只在测试里手动往前走
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('发消息', () => {
  it('订阅时对局已经在进行：先发 state，再发 round-start；信封带 src 和 at', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    playing()
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    expect(map.got).toEqual([
      { type: 'solo:state', plan_key: 'plan:方案A', plan_name: '方案A', source: 'plan', spec: SPEC, pool_total: 42, src: 'solo-1', at: 1000 },
      { type: 'solo:round-start', round_id: 'r1', src: 'solo-1', at: 1000 },
    ])
    stop()
  })

  it('一整局：建会话 → 开局 → 结束 → 改评级 → 下一局；round-end 每局只发一次', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    expect(map.got).toEqual([]) // 还没有会话

    G.setState({ source: { spec: SPEC, planName: null, newEvery: 4, key: 'k' }, session: session(), phase: 'starting' })
    expect(map.types()).toEqual(['solo:state'])
    expect(map.got[0]).toMatchObject({ plan_key: 'workbench', plan_name: null })
    G.setState({ phase: 'playing', round: { round_id: 'r1' } as never })
    G.setState({ rows: [{ seq: 1 } as never] }) // 猜了一行
    expect(map.types()).toEqual(['solo:state', 'solo:round-start'])

    G.setState({ phase: 'ended', end: end(), last: last() })
    G.setState({ busy: true }) // 别的状态变化
    G.setState({ busy: false })
    const ends = map.got.filter((m) => m.type === 'solo:round-end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ round_id: 'r1', plan_key: 'workbench', answer_id: 9, grade: 'good', ended_by: 'exact', bound_work: { id: 101, name: '作品甲' }, answer_work_ids: [101, 102] })

    // 自动模式里改上一局的评级：请求在路上不发，回来后发 solo:grade
    G.setState({ last: last({ grade: 'again', saving: true }) })
    expect(map.types()).not.toContain('solo:grade')
    G.setState({ last: last({ grade: 'again', saving: false }), end: end({ grade: 'again' }) })
    expect(map.got.filter((m) => m.type === 'solo:grade')).toEqual([{ type: 'solo:grade', round_id: 'r1', grade: 'again', src: 'solo-1', at: 1000 }])
    expect(map.got.filter((m) => m.type === 'solo:round-end')).toHaveLength(1)

    // 下一局
    G.setState({ phase: 'starting' })
    G.setState({ phase: 'playing', round: { round_id: 'r2' } as never, end: null })
    expect(map.got.at(-1)).toMatchObject({ type: 'solo:round-start', round_id: 'r2' })
    G.setState({ phase: 'ended', end: end({ round_id: 'r2', answer_id: 10, ended_by: 'surrender', grade: 'again' }), last: last({ round_id: 'r2', grade: 'again' }) })
    expect(map.got.filter((m) => m.type === 'solo:round-end').map((m) => (m as { round_id: string }).round_id)).toEqual(['r1', 'r2'])
    stop()
  })

  it('换方案 / 后端重启后重建会话：会话 id 变了就再发一次 state', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    playing('r1', 's1')
    G.setState({ session: session('s2', 77), source: { spec: SPEC, planName: '方案B', newEvery: 4, key: 'k2' } })
    const states = map.got.filter((m) => m.type === 'solo:state')
    expect(states).toHaveLength(2)
    expect(states[1]).toMatchObject({ plan_key: 'plan:方案B', pool_total: 77 })
    stop()
  })

  it('工作台方案 → source: workbench，plan_key 固定 workbench（哪怕工作台载入过方案「方案A」又改了条件，plan_name 仍照原样带上）', () => {
    setLinkKind('workbench')
    const b = bus()
    const map = fakeMap(b.factory)
    playing() // planName = 方案A
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    expect(map.got[0]).toMatchObject({ type: 'solo:state', source: 'workbench', plan_key: 'workbench', plan_name: '方案A' })
    G.setState({ phase: 'ended', end: end(), last: last() })
    expect(map.got.find((m) => m.type === 'solo:round-end')).toMatchObject({ plan_key: 'workbench' }) // 和 solo:state 同一个键
    // 导图来问（map:hello）：回的 state 同样是 workbench
    map.clear()
    map.send({ type: 'map:hello' })
    expect(map.got.find((m) => m.type === 'solo:state')).toMatchObject({ plan_key: 'workbench' })
    stop()
  })

  it('设置里选了已保存方案 → plan_key = plan:名字，state 和 round-end 一致', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    playing()
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    G.setState({ phase: 'ended', end: end(), last: last() })
    expect(map.got.filter((m) => m.type === 'solo:state' || m.type === 'solo:round-end').map((m) => (m as { plan_key: string }).plan_key)).toEqual(['plan:方案A', 'plan:方案A'])
    stop()
  })

  it('会话没变、只是来源变了（设置里在「工作台」和同名已保存方案之间切换）：按新的 plan_key 补发 solo:state；没变不重复发', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    playing() // plan:方案A
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    const keys = () => map.got.filter((m) => m.type === 'solo:state').map((m) => (m as { plan_key: string }).plan_key)
    expect(keys()).toEqual(['plan:方案A'])
    setLinkKind('plan') // 没变
    expect(keys()).toEqual(['plan:方案A'])
    setLinkKind('workbench')
    expect(keys()).toEqual(['plan:方案A', 'workbench'])
    setLinkKind('workbench')
    G.setState({ rows: [{ seq: 1 } as never] }) // 对局状态变了，plan_key 没变
    expect(keys()).toEqual(['plan:方案A', 'workbench'])
    setLinkKind('plan')
    expect(keys()).toEqual(['plan:方案A', 'workbench', 'plan:方案A'])
    stop()
    setLinkKind('workbench') // 停止之后改来源：不会再发
    expect(keys()).toHaveLength(3)
  })

  it('spec 结构不完整的 solo:state 不会交给导图（协议校验整条丢弃）', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    G.setState({ source: { spec: { game: null } as never, planName: null, newEvery: 4, key: 'k' }, session: session(), phase: 'starting' })
    expect(map.got).toEqual([])
    stop()
  })
})

describe('回应 map:hello', () => {
  it('有会话：回当前的 state（信封是单人页自己的）；没有会话：不回', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    map.send({ type: 'map:hello' })
    expect(map.got).toEqual([])

    playing()
    map.clear()
    T = 2_000
    map.send({ type: 'map:hello' })
    expect(map.got).toEqual([
      { type: 'solo:state', plan_key: 'plan:方案A', plan_name: '方案A', source: 'plan', spec: SPEC, pool_total: 42, src: 'solo-1', at: 2000 },
    ])
    stop()
  })

  it('已经 away（在新标签页开了）的页面不回', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    playing()
    useSoloHandoff.setState({ away: true })
    map.clear()
    map.send({ type: 'map:hello' })
    expect(map.got).toEqual([])
    stop()
  })

  it('自己的 src 发的消息忽略（同一标签页里多开一个频道对象也不会自己应答自己）', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    playing()
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    map.clear()
    const echo = openLinkChannel(() => {}, b.factory) as LinkChannel
    echo.post(stamp({ type: 'map:hello' }, 'solo-1', T))
    expect(map.types()).toEqual(['map:hello']) // 导图只收到这条 hello 本身，没有 solo:state 回应
    stop()
  })
})

describe('记录导图的 presence（小灯）', () => {
  it('收到 presence（show_dot）→ 亮；map:bye → 立刻灰；之后再收到 presence 又亮；show_dot 假 → 不显示', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    const lamp = () => lampState(useMapPresence.getState().state, T)

    expect(lamp()).toBe('hidden')
    T = 10_000
    map.send({ type: 'map:presence', following: true, show_dot: true })
    expect(lamp()).toBe('on')
    T = 12_000
    map.send({ type: 'map:presence', following: true, show_dot: true })
    expect(lamp()).toBe('on')
    map.send({ type: 'map:bye' })
    expect(lamp()).toBe('off')

    T = 20_000
    map.send({ type: 'map:presence', following: true, show_dot: true })
    expect(lamp()).toBe('on')
    T = 21_000
    map.send({ type: 'map:presence', following: true, show_dot: false })
    expect(lamp()).toBe('hidden')
    stop()
  })

  it('用本机收到的时间算心跳，不信消息里的 at', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    T = 50_000
    map.link.post(stamp({ type: 'map:presence', following: true, show_dot: true }, 'map-tab', 1)) // at 很旧
    expect(lampState(useMapPresence.getState().state, T)).toBe('on')
    stop()
  })
})

describe('几个导图窗口（src 不同）', () => {
  const lamp = () => lampState(useMapPresence.getState().state, T)
  const on = { type: 'map:presence', following: true, show_dot: true } as const
  const advance = (ms: number) => {
    for (let i = 0; i < ms / 1000; i++) {
      T += 1000
      vi.advanceTimersByTime(1000)
    }
  }
  /** 模拟导图窗口 srcName：收到 solo:ping 就立刻回一条 presence */
  const autoReplier = (factory: ChannelFactory, srcName: string) => {
    const link: LinkChannel = openLinkChannel((m) => {
      if (m.type === 'solo:ping') link.post(stamp({ type: 'map:presence', following: true, show_dot: true }, srcName, T))
    }, factory) as LinkChannel
    return link
  }

  it('A 在跟随时 B 发 bye：小灯仍亮；B 发 show_dot:false 不会藏起 A 的小灯；A、B 都不行了才灰', () => {
    const b = bus()
    const mapA = fakeMap(b.factory, 'map-A')
    const mapB = fakeMap(b.factory, 'map-B')
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    T = 10_000
    mapA.send(on)
    mapB.send(on)
    expect(lamp()).toBe('on')
    mapB.send({ type: 'map:bye' })
    expect(lamp()).toBe('on')
    mapB.send({ type: 'map:presence', following: true, show_dot: false })
    expect(lamp()).toBe('on')
    mapA.send({ type: 'map:bye' })
    expect(lamp()).toBe('off') // 只剩要求显示的 A，它 bye 了
    mapB.send(on)
    expect(lamp()).toBe('on')
    mapB.send({ type: 'map:presence', following: true, show_dot: false })
    mapA.send(on)
    mapA.send({ type: 'map:presence', following: false, show_dot: true })
    expect(lamp()).toBe('hidden') // 没有窗口要求显示
    stop()
  })

  it('A 的窗口没了（不回 ping）、B 活着（回 ping）：小灯一直亮，不会因为 A 超时变灰', () => {
    const b = bus()
    const mapA = fakeMap(b.factory, 'map-A')
    const mapB = fakeMap(b.factory, 'map-B')
    const replierB = autoReplier(b.factory, 'map-B')
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    T = 10_000
    mapA.send(on)
    mapB.send(on)
    let notOn = 0
    for (let i = 0; i < 120; i++) {
      advance(1000)
      if (lamp() !== 'on') notOn++
    }
    expect(notOn).toBe(0)
    replierB.close()
    stop()
  })
})

describe('掉线前先 ping', () => {
  const lamp = () => lampState(useMapPresence.getState().state, T)
  const beat = (map: ReturnType<typeof fakeMap>) => map.send({ type: 'map:presence', following: true, show_dot: true })
  const pingsOf = (map: ReturnType<typeof fakeMap>) => map.got.filter((m) => m.type === 'solo:ping')
  /** 往前走 ms 毫秒（每秒触发一次单人页的定时器，T 同步） */
  const advance = (ms: number) => {
    for (let i = 0; i < ms / 1000; i++) {
      T += 1000
      vi.advanceTimersByTime(1000)
    }
  }
  const fakeDocument = () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as 'visible' | 'hidden' })
    vi.stubGlobal('document', doc)
    return doc
  }
  const fire = (doc: EventTarget, type: string) => doc.dispatchEvent(new Event(type))
  /** 模拟导图一侧：收到 solo:ping 就立刻回一条 presence（按协议导图必须这么做） */
  const autoReplier = (factory: ChannelFactory, srcName = 'map-tab') => {
    const link: LinkChannel = openLinkChannel((m) => {
      if (m.type === 'solo:ping') link.post(stamp({ type: 'map:presence', following: true, show_dot: true }, srcName, T))
    }, factory) as LinkChannel
    return link
  }

  it('心跳每 2 秒一条：不发 ping，一直亮', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    T = 10_000
    beat(map)
    for (let i = 1; i <= 20; i++) {
      advance(1000)
      if (i % 2 === 0) beat(map)
      expect(lamp()).toBe('on')
    }
    expect(pingsOf(map)).toEqual([])
    stop()
  })

  it('心跳停了：超过 6 秒起每 2 秒一条 ping（信封是单人页自己的）', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    T = 10_000
    beat(map)
    advance(6000) // 恰好 6 秒：还不 ping
    expect(pingsOf(map)).toEqual([])
    advance(1000)
    expect(pingsOf(map)).toEqual([{ type: 'solo:ping', src: 'solo-1', at: 17_000 }])
    advance(1000)
    expect(pingsOf(map)).toHaveLength(1) // 最多每 2 秒一次
    advance(1000)
    expect(pingsOf(map).map((m) => m.at)).toEqual([17_000, 19_000])
    stop()
  })

  it('导图只是被浏览器节流（自己的心跳停了，但收到 ping 立刻回应）：5 分钟里小灯一直亮', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    const throttled = autoReplier(b.factory)
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    T = 10_000
    beat(map)
    let notOn = 0
    for (let i = 0; i < 300; i++) {
      advance(1000)
      if (lamp() !== 'on') notOn++
    }
    expect(notOn).toBe(0)
    expect(pingsOf(map).length).toBeGreaterThan(20) // 每次心跳迟到 6 秒就 ping 一次，每次都有回应
    throttled.close()
    stop()
  })

  it('导图没了（不回应、也没发 bye）：10 秒内亮；超过 10 秒并且 ping 发出满 2 秒后灰；之后它又回应就亮', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    T = 10_000
    beat(map)
    advance(10_000)
    expect(lamp()).toBe('on') // 恰好 10 秒
    advance(1000)
    expect(lamp()).toBe('off') // 11 秒；首个 ping 在 17_000 发出，已满 2 秒
    advance(15_000) // 一直发 ping 也不会闪回亮
    expect(lamp()).toBe('off')
    beat(map)
    expect(lamp()).toBe('on')
    stop()
  })

  it('收到 map:bye：立刻灰，之后不再 ping', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    T = 10_000
    beat(map)
    map.send({ type: 'map:bye' })
    expect(lamp()).toBe('off')
    advance(30_000)
    expect(pingsOf(map)).toEqual([])
    expect(lamp()).toBe('off')
    stop()
  })

  it('小灯没在显示（从没连上 / 导图不要小灯）：不 ping', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    advance(30_000) // 从没收到过 presence
    map.send({ type: 'map:presence', following: true, show_dot: false })
    advance(30_000)
    expect(pingsOf(map)).toEqual([])
    stop()
  })

  it('away（已在新标签页打开）的旧标签页不 ping', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    playing()
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    T = 10_000
    beat(map)
    useSoloHandoff.setState({ away: true })
    map.clear()
    advance(30_000)
    expect(map.types()).not.toContain('solo:ping')
    stop()
  })

  describe('单人页自己从隐藏 / 冻结回到前台', () => {
    /** 导图 10_000 发过最后一条心跳，单人页 17_000 ping 了一次，然后单人页被冻结，醒来时已是 600_000 */
    function frozenThenBack(withReplier: boolean) {
      const doc = fakeDocument()
      const b = bus()
      const map = fakeMap(b.factory)
      const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
      T = 10_000
      beat(map)
      advance(7000)
      expect(pingsOf(map)).toHaveLength(1)
      map.clear()
      // 冻结期间没有定时器、没有消息处理；导图（如果有回应的话）从这时起才会回应 ping
      const replier = withReplier ? autoReplier(b.factory) : null
      T = 600_000
      return { doc, map, replier, stop }
    }

    it('不唤醒直接判会判灰（旧的 ping 记录太老了）；回到前台先重新 ping，满 2 秒没回应才灰', () => {
      const { doc, map, stop } = frozenThenBack(false)
      expect(lamp()).toBe('off') // 这正是要避免的误判
      fire(doc, 'visibilitychange')
      expect(pingsOf(map)).toEqual([{ type: 'solo:ping', src: 'solo-1', at: 600_000 }])
      expect(lamp()).toBe('on')
      advance(1000)
      expect(lamp()).toBe('on')
      advance(1000)
      expect(lamp()).toBe('off')
      stop()
    })

    it('回到前台时导图回应了：一直亮', () => {
      const { doc, replier, stop } = frozenThenBack(true)
      fire(doc, 'visibilitychange')
      expect(lamp()).toBe('on')
      for (let i = 0; i < 30; i++) {
        advance(1000)
        expect(lamp()).toBe('on')
      }
      replier?.close()
      stop()
    })

    it('变成隐藏（不是回到前台）不算；Page Lifecycle 的 resume（解冻）算', () => {
      const { doc, map, stop } = frozenThenBack(false)
      doc.visibilityState = 'hidden'
      fire(doc, 'visibilitychange')
      expect(pingsOf(map)).toEqual([])
      fire(doc, 'resume')
      expect(pingsOf(map)).toHaveLength(1)
      expect(lamp()).toBe('on')
      stop()
    })

    it('同一次恢复连着触发 resume 和 visibilitychange（还有 pageshow）：只 ping 一次，满 2 秒没回应才灰，不会因为多唤醒几次而拖后', () => {
      const { doc, map, stop } = frozenThenBack(false)
      fire(doc, 'resume')
      T += 1
      fire(doc, 'visibilitychange')
      T += 1
      fire(doc, 'resume')
      expect(pingsOf(map)).toEqual([{ type: 'solo:ping', src: 'solo-1', at: 600_000 }])
      expect(lamp()).toBe('on')
      T = 601_999
      expect(lamp()).toBe('on')
      T = 602_000
      expect(lamp()).toBe('off') // 从第一条 ping（600_000）起算满 2 秒
      stop()
    })

    it('同一次恢复的多个事件里导图回应了：一直亮，也没有多余的 ping', () => {
      const { doc, map, replier, stop } = frozenThenBack(true)
      fire(doc, 'resume')
      T += 1
      fire(doc, 'visibilitychange')
      expect(pingsOf(map)).toHaveLength(1)
      for (let i = 0; i < 30; i++) {
        advance(1000)
        expect(lamp()).toBe('on')
      }
      replier?.close()
      stop()
    })

    it('停止之后：定时器和前台事件都不再起作用', () => {
      const { doc, map, stop } = frozenThenBack(false)
      stop()
      map.clear()
      fire(doc, 'visibilitychange')
      fire(doc, 'resume')
      advance(30_000)
      expect(map.got).toEqual([])
    })
  })
})

describe('away / 停止', () => {
  it('点了「在新标签页打开」（reset 再 away）→ 一条 bye，之后不再发任何东西', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    playing()
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    map.clear()
    G.getState().reset() // handOffToNewTab 先 reset 再 setAway
    useSoloHandoff.setState({ away: true })
    expect(map.got).toEqual([{ type: 'solo:bye', src: 'solo-1', at: 1000 }])
    playing('r9') // away 时即使对局状态又变了也不发
    G.setState({ phase: 'ended', end: end({ round_id: 'r9' }) })
    expect(map.got).toHaveLength(1)
    stop() // 已经 bye 过：不重复
    expect(map.got).toHaveLength(1)
  })

  it('停止（页面卸载）：发 bye、取消订阅、关频道、小灯状态清掉', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    playing()
    const stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    map.send({ type: 'map:presence', following: true, show_dot: true })
    expect(presenceWantsDot(useMapPresence.getState().state)).toBe(true)
    map.clear()
    stop()
    expect(map.got).toEqual([{ type: 'solo:bye', src: 'solo-1', at: 1000 }])
    expect(b.size()).toBe(1) // 只剩导图的频道
    expect(presenceWantsDot(useMapPresence.getState().state)).toBe(false)
    playing('r2')
    G.setState({ phase: 'ended', end: end({ round_id: 'r2' }) })
    map.send({ type: 'map:hello' })
    expect(map.got).toHaveLength(1)
  })

  it('停止后重新开始（回到 /solo）：重新通知 state 和进行中的这一局，已报过的结束局不重复报', () => {
    const b = bus()
    const map = fakeMap(b.factory)
    playing()
    let stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    G.setState({ phase: 'ended', end: end() })
    stop()
    map.clear()
    stop = startSoloLink({ channelFactory: b.factory, tabId: 'solo-1', now })
    expect(map.types()).toEqual(['solo:state']) // 停在结算：结束局已经报过
    G.setState({ phase: 'playing', round: { round_id: 'r2' } as never, end: null })
    G.setState({ phase: 'ended', end: end({ round_id: 'r2' }) })
    expect(map.types()).toEqual(['solo:state', 'solo:round-start', 'solo:round-end']) // 新的一局照常报
    stop()
  })
})

describe('降级', () => {
  it('不支持 BroadcastChannel：什么都不做，停止函数也能调；对局照常变化不报错', () => {
    const stop = startSoloLink({ channelFactory: () => null, tabId: 'solo-1', now })
    expect(() => {
      playing()
      G.setState({ phase: 'ended', end: end() })
      stop()
    }).not.toThrow()
    expect(lampState(useMapPresence.getState().state, T)).toBe('hidden')
  })
})
