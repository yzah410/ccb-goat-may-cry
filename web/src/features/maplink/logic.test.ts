/**
 * 联动的纯逻辑：什么时候发什么消息、怎么去重（step / stopStep / buildRoundEnd），以及「导图已联动」小灯的状态机。
 */
import { describe, expect, it } from 'vitest'
import type { EndBlock } from '@/features/solo/api'
import type { SpecV2 } from '@/features/v2/types'
import {
  buildRoundEnd,
  buildState,
  initialMemory,
  LAMP_TIP,
  lampState,
  PRESENCE_INITIAL,
  PRESENCE_LOST_AFTER_MS,
  PRESENCE_PING_AFTER_MS,
  PRESENCE_PING_GAP_MS,
  PRESENCE_PING_WAIT_MS,
  presenceTick,
  presenceWake,
  presenceWantsDot,
  PRESENCE_MAX_MAPS,
  reducePresence,
  step,
  stopStep,
  type LinkInput,
  type LinkMemory,
  type PresenceState,
} from './logic'
import type { MapMsg, SoloBody } from './protocol'

const SPEC = { version: 2 } as unknown as SpecV2

const input = (p: Partial<LinkInput> = {}): LinkInput => ({
  away: false,
  kind: 'plan',
  sessionId: 's1',
  poolTotal: 42,
  spec: SPEC,
  planName: '方案A',
  phase: 'playing',
  roundId: 'r1',
  end: null,
  last: null,
  ...p,
})
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
    wrong_guesses: [{ char_id: 5, name: '角色五', work_ids: [102, 103] }],
    ...p,
  }) as unknown as EndBlock
const types = (out: SoloBody[]) => out.map((o) => o.type)

/** 依次喂状态，累计所有发出的消息 */
function run(inputs: LinkInput[], mem: LinkMemory = initialMemory()) {
  const all: SoloBody[] = []
  for (const i of inputs) {
    const r = step(mem, i)
    mem = r.mem
    all.push(...r.out)
  }
  return { out: all, mem }
}

describe('step：solo:state', () => {
  it('有会话就发一次；同一个会话不重复发；会话 id 变了（换方案 / 重建）再发', () => {
    const { out } = run([input({ roundId: null, phase: 'starting' }), input({ roundId: null, phase: 'starting' }), input({ sessionId: 's2', roundId: null, phase: 'starting' })])
    expect(types(out)).toEqual(['solo:state', 'solo:state'])
    expect(out[0]).toEqual({ type: 'solo:state', plan_key: 'plan:方案A', plan_name: '方案A', source: 'plan', spec: SPEC, pool_total: 42 })
  })

  it('plan_key 按来源定：工作台固定 workbench（哪怕它载入过方案 A 又改了条件，plan_name 仍照原样带 A）；已保存方案 = plan:名字', () => {
    expect(buildState(input({ kind: 'workbench', planName: null }))).toMatchObject({ plan_key: 'workbench', plan_name: null, source: 'workbench' })
    expect(buildState(input({ kind: 'workbench', planName: '方案A' }))).toMatchObject({ plan_key: 'workbench', plan_name: '方案A', source: 'workbench' })
    expect(buildState(input({ kind: 'plan', planName: '方案A' }))).toMatchObject({ plan_key: 'plan:方案A', plan_name: '方案A', source: 'plan' })
    expect(buildState(input({ kind: 'plan', planName: '  方案B ' }))).toMatchObject({ plan_key: 'plan:方案B' })
    // 选了已保存方案却没有名字（不会发生，但不能崩）：退回 workbench
    expect(buildState(input({ kind: 'plan', planName: null }))).toMatchObject({ plan_key: 'workbench' })
  })

  it('同一个会话里 plan_key 变了（设置里在「工作台」和同名已保存方案之间切换）：再发一次 solo:state；没变不重复发', () => {
    const wb = (o: Partial<LinkInput> = {}) => input({ kind: 'workbench', planName: '方案A', roundId: null, phase: 'starting', ...o })
    const pl = (o: Partial<LinkInput> = {}) => input({ kind: 'plan', planName: '方案A', roundId: null, phase: 'starting', ...o })
    const { out } = run([wb(), wb(), pl(), pl(), wb()])
    expect(out.map((o) => (o as { plan_key: string }).plan_key)).toEqual(['workbench', 'plan:方案A', 'workbench'])
    expect(types(out)).toEqual(['solo:state', 'solo:state', 'solo:state'])
  })

  it('没有会话（还在建 / 出错 / 被 reset）什么都不发', () => {
    const { out } = run([input({ sessionId: null, poolTotal: null, spec: null, roundId: null, phase: 'creating' })])
    expect(out).toEqual([])
    expect(buildState(input({ spec: null }))).toBeNull()
    expect(buildState(input({ poolTotal: null }))).toBeNull()
  })
})

describe('step：round-start', () => {
  it('每个 round_id 只发一次，且只在 playing 时发', () => {
    const { out } = run([
      input({ phase: 'starting', roundId: null }),
      input({ roundId: 'r1' }),
      input({ roundId: 'r1' }), // 猜了一行：状态变了但没新局
      input({ roundId: 'r1', phase: 'ended', end: end() }),
      input({ roundId: 'r1', phase: 'starting', end: null }), // 开下一局的请求在路上，round 还是旧的
      input({ roundId: 'r2' }),
    ])
    expect(out.filter((o) => o.type === 'solo:round-start')).toEqual([
      { type: 'solo:round-start', round_id: 'r1' },
      { type: 'solo:round-start', round_id: 'r2' },
    ])
  })
})

describe('step：round-end', () => {
  it('end.round_id 变了才发，每局一次；评级后续怎么变都不再发 round-end', () => {
    const e1 = end()
    const { out } = run([
      input(),
      input({ phase: 'ended', end: e1, last: { round_id: 'r1', grade: 'good', saving: false } }),
      input({ phase: 'ended', end: { ...e1, grade: 'again' }, last: { round_id: 'r1', grade: 'again', saving: false } }),
      input({ phase: 'ended', end: { ...e1, grade: 'again' }, last: { round_id: 'r1', grade: 'again', saving: false } }),
    ])
    expect(types(out)).toEqual(['solo:state', 'solo:round-start', 'solo:round-end', 'solo:grade'])
  })

  it('内容：答案、绑定作品、作品列表、猜错的角色、评级、结束方式', () => {
    const { out } = run([input(), input({ phase: 'ended', end: end({ ended_by: 'work', grade: 'hard' }) })])
    expect(out.find((o) => o.type === 'solo:round-end')).toEqual({
      type: 'solo:round-end',
      round_id: 'r1',
      plan_key: 'plan:方案A',
      answer_id: 9,
      answer_name: '答案',
      bound_work: { id: 101, name: '作品甲' },
      answer_work_ids: [101, 102],
      wrong_guesses: [{ char_id: 5, name: '角色五', work_ids: [102, 103] }],
      grade: 'hard',
      ended_by: 'work',
    })
  })

  it('结束块缺 answer_work_ids / bound_work_id / wrong_guesses：给空值，不报错；绑定作品可从卡片补上，补不上就是 null', () => {
    const old = end()
    delete (old as Partial<EndBlock>).answer_work_ids
    delete (old as Partial<EndBlock>).bound_work_id
    delete (old as Partial<EndBlock>).wrong_guesses
    expect(buildRoundEnd(old, 'workbench', null)).toMatchObject({ plan_key: 'workbench', answer_work_ids: [], wrong_guesses: [], bound_work: { id: 101, name: '作品甲' } })
    const bare = { ...old, card: {} } as unknown as EndBlock
    expect(buildRoundEnd(bare, 'workbench', null).bound_work).toBeNull()
    // 卡片里的作品和 bound_work_id 对不上：不拿别人的名字顶
    expect(buildRoundEnd(end({ bound_work_id: 555 }), 'workbench', null).bound_work).toEqual({ id: 555, name: '' })
  })

  it('round-end 的 plan_key 和 solo:state 同一条规则：工作台（哪怕载入过方案 A）= workbench，已保存方案 = plan:名字', () => {
    for (const [kind, planName, want] of [
      ['workbench', null, 'workbench'],
      ['workbench', '方案A', 'workbench'],
      ['plan', '方案A', 'plan:方案A'],
      ['plan', null, 'workbench'],
    ] as const) {
      expect(buildRoundEnd(end(), kind, planName).plan_key).toBe(want)
      expect((buildState(input({ kind, planName })) as { plan_key: string }).plan_key).toBe(want)
    }
    // 走 step 也一样：工作台载入方案 A 之后做题，state 和 round-end 都是 workbench，不会和 plan:A 的图组混在一起
    const { out } = run([input({ kind: 'workbench', planName: '方案A' }), input({ kind: 'workbench', planName: '方案A', phase: 'ended', end: end() })])
    expect(out.filter((o) => o.type === 'solo:state' || o.type === 'solo:round-end').map((o) => (o as { plan_key: string }).plan_key)).toEqual(['workbench', 'workbench'])
  })

  it('刚开始订阅时结算已经在了（从别的页面回到 /solo）：补发 round-end', () => {
    const { out } = run([input({ phase: 'ended', end: end() })])
    expect(types(out)).toEqual(['solo:state', 'solo:round-end'])
  })
})

describe('step：grade', () => {
  const base = [input(), input({ phase: 'ended', end: end(), last: { round_id: 'r1', grade: 'good', saving: false } })]

  it('改评级的请求在路上（saving）不发，回来后评级和导图那边不一样才发', () => {
    const { out } = run([
      ...base,
      input({ phase: 'ended', end: end(), last: { round_id: 'r1', grade: 'easy', saving: true } }),
      input({ phase: 'ended', end: end(), last: { round_id: 'r1', grade: 'easy', saving: false } }),
    ])
    expect(out.slice(-1)).toEqual([{ type: 'solo:grade', round_id: 'r1', grade: 'easy' }])
    expect(out.filter((o) => o.type === 'solo:grade')).toHaveLength(1)
  })

  it('改了又改回原来的：每次落定都发（导图那边始终和这边一致）', () => {
    const { out } = run([
      ...base,
      input({ phase: 'ended', end: end(), last: { round_id: 'r1', grade: 'again', saving: false } }),
      input({ phase: 'ended', end: end(), last: { round_id: 'r1', grade: 'good', saving: false } }),
    ])
    expect(out.filter((o) => o.type === 'solo:grade').map((o) => (o as { grade: string }).grade)).toEqual(['again', 'good'])
  })

  it('改评级失败 / 没改成（回到原来的评级）不发', () => {
    const { out } = run([
      ...base,
      input({ phase: 'ended', end: end(), last: { round_id: 'r1', grade: 'hard', saving: true } }),
      input({ phase: 'ended', end: end(), last: { round_id: 'r1', grade: 'good', saving: false } }),
    ])
    expect(types(out)).not.toContain('solo:grade')
  })

  it('上一局的 last 对不上已报告的那一局（比如下一局先结束了）不发', () => {
    const { out } = run([...base, input({ phase: 'ended', end: end(), last: { round_id: 'r0', grade: 'again', saving: false } })])
    expect(types(out)).not.toContain('solo:grade')
  })

  describe('自动模式：下一局开始之后才改上一局的评级', () => {
    const grades = (out: SoloBody[]) => out.filter((o) => o.type === 'solo:grade')
    const playingR2 = (last: LinkInput['last']) => input({ phase: 'playing', roundId: 'r2', end: null, last })

    it('下一局已经在进行（没有 end 了，last 还是上一局）：改评级落定后照样发 solo:grade，按 round_id 对上上一局', () => {
      const { out } = run([
        ...base,
        playingR2({ round_id: 'r1', grade: 'good', saving: false }),
        playingR2({ round_id: 'r1', grade: 'easy', saving: true }),
        playingR2({ round_id: 'r1', grade: 'easy', saving: false }),
      ])
      expect(grades(out)).toEqual([{ type: 'solo:grade', round_id: 'r1', grade: 'easy' }])
      expect(out.filter((o) => o.type === 'solo:round-start').map((o) => (o as { round_id: string }).round_id)).toEqual(['r1', 'r2'])
    })

    it('连续改（good → easy → hard），中间那次请求回来时目标已经变了（saving 还是真）：只发最后落定的那个', () => {
      const { out } = run([
        ...base,
        playingR2({ round_id: 'r1', grade: 'easy', saving: true }),
        playingR2({ round_id: 'r1', grade: 'hard', saving: true }), // easy 已经记下，但目标又变成 hard，请求继续
        playingR2({ round_id: 'r1', grade: 'hard', saving: false }),
      ])
      expect(grades(out)).toEqual([{ type: 'solo:grade', round_id: 'r1', grade: 'hard' }])
    })

    it('边角：改评级的请求还没回来，下一局先结束了 → 上一局最终评级发不出去（旧的评级留在导图那边），也不会错记到下一局头上', () => {
      // 前提：game.ts 只在 last 还是那一局时才把回来的结果写进 last（last 已经换成下一局，结果就没地方放了）。
      // 后端在下一局结束后本来就拒绝改上一局（not_last_round），这个窗口要「一次请求比整整一局还慢」才会出现，game.ts 不专门处理。
      const { out, mem } = run([
        ...base,
        playingR2({ round_id: 'r1', grade: 'easy', saving: true }),
        input({ phase: 'ended', roundId: 'r2', end: end({ round_id: 'r2', grade: 'good' }), last: { round_id: 'r2', grade: 'good', saving: false } }),
        input({ phase: 'ended', roundId: 'r2', end: end({ round_id: 'r2', grade: 'good' }), last: { round_id: 'r2', grade: 'good', saving: false } }),
      ])
      expect(grades(out)).toEqual([])
      expect(out.filter((o) => o.type === 'solo:round-end').map((o) => (o as { round_id: string }).round_id)).toEqual(['r1', 'r2'])
      expect(mem).toMatchObject({ roundEndId: 'r2', gradeSent: 'good' })
    })
  })
})

describe('step：away / stop', () => {
  it('away：不发任何东西；之前通知过导图就补一条 bye，只发一次', () => {
    const a = run([input(), input({ away: true }), input({ away: true, sessionId: null })])
    expect(types(a.out)).toEqual(['solo:state', 'solo:round-start', 'solo:bye'])
    const b = run([input({ away: true })])
    expect(b.out).toEqual([]) // 从来没通知过：不用 bye
  })

  it('away 时对局状态再怎么变也不发（这个标签页已经不是正在对局的那个）', () => {
    const { out } = run([input({ away: true }), input({ away: true, roundId: 'r2' }), input({ away: true, end: end({ round_id: 'r2' }) })])
    expect(out).toEqual([])
  })

  it('在这里继续玩：away 取消 + 新会话，重新发 state，不重复报已报过的结束局', () => {
    const { out } = run([
      input(),
      input({ phase: 'ended', end: end() }),
      input({ away: true }),
      input({ sessionId: null, poolTotal: null, spec: null, roundId: null, end: null, phase: 'idle' }),
      input({ sessionId: 's2', roundId: 'r5' }),
    ])
    expect(types(out)).toEqual(['solo:state', 'solo:round-start', 'solo:round-end', 'solo:bye', 'solo:state', 'solo:round-start'])
  })

  it('stopStep（卸载 / 关页面）：通知过就发 bye；之后重新开始会再发 state 和当前这局的 round-start，但不重复报结束', () => {
    const a = run([input(), input({ phase: 'ended', end: end() })])
    const s = stopStep(a.mem)
    expect(s.out).toEqual([{ type: 'solo:bye' }])
    expect(stopStep(s.mem).out).toEqual([]) // 只发一次
    const b = run([input({ phase: 'ended', end: end() })], s.mem)
    expect(types(b.out)).toEqual(['solo:state'])
    const c = run([input({ roundId: 'r2' })], s.mem)
    expect(types(c.out)).toEqual(['solo:state', 'solo:round-start'])
  })
})

describe('小灯状态机', () => {
  const presence = (p: Partial<Extract<MapMsg, { type: 'map:presence' }>> = {}): MapMsg => ({ type: 'map:presence', src: 'm', at: 0, following: true, show_dot: true, ...p })
  const bye: MapMsg = { type: 'map:bye', src: 'm', at: 0 }
  const hello: MapMsg = { type: 'map:hello', src: 'm', at: 0 }
  const beat = (s: PresenceState, t: number) => reducePresence(s, presence(), t)

  /** 模拟单人页每秒走一次定时器：从 from 到 to（含），返回新状态和每次 ping 的时刻 */
  function ticks(s: PresenceState, from: number, to: number, reply?: (t: number) => boolean) {
    const pings: number[] = []
    for (let t = from; t <= to; t += 1000) {
      const r = presenceTick(s, t)
      s = r.state
      if (r.ping) {
        pings.push(t)
        if (reply?.(t)) s = beat(s, t) // 导图立刻回一条 presence
      }
    }
    return { s, pings }
  }

  it('常量：6 秒开始 ping、每 2 秒最多一次、10 秒并且 ping 等了 2 秒才灰', () => {
    expect([PRESENCE_PING_AFTER_MS, PRESENCE_PING_GAP_MS, PRESENCE_LOST_AFTER_MS, PRESENCE_PING_WAIT_MS]).toEqual([6000, 2000, 10000, 2000])
  })

  it('从没连上：不显示，也不 ping', () => {
    expect(lampState(PRESENCE_INITIAL, 10_000)).toBe('hidden')
    expect(presenceTick(PRESENCE_INITIAL, 99_000)).toEqual({ state: PRESENCE_INITIAL, ping: false })
  })

  it('每 2 秒一条心跳：一直亮，不 ping', () => {
    let s = PRESENCE_INITIAL
    const pings: number[] = []
    for (let t = 0; t <= 20_000; t += 1000) {
      if (t % 2000 === 0) s = beat(s, t)
      const r = presenceTick(s, t)
      s = r.state
      if (r.ping) pings.push(t)
      expect(lampState(s, t)).toBe('on')
    }
    expect(pings).toEqual([])
  })

  it('上次心跳超过 6 秒才开始 ping（恰好 6 秒不 ping）', () => {
    const s = beat(PRESENCE_INITIAL, 1000)
    expect(presenceTick(s, 1000 + PRESENCE_PING_AFTER_MS).ping).toBe(false)
    const r = presenceTick(s, 1000 + PRESENCE_PING_AFTER_MS + 1)
    expect(r.ping).toBe(true)
    expect(r.state).toMatchObject({ lastPingAt: 7001, maps: { m: { pendingSince: 7001 } } })
  })

  it('ping 最多每 2 秒一次；导图一直不回时每次间隔都 >= 2 秒', () => {
    const { pings } = ticks(beat(PRESENCE_INITIAL, 0), 0, 30_000)
    expect(pings[0]).toBe(7000)
    expect(pings.length).toBeGreaterThan(5)
    for (let i = 1; i < pings.length; i++) expect(pings[i]! - pings[i - 1]!).toBeGreaterThanOrEqual(PRESENCE_PING_GAP_MS)
    // 更密的检查（每 100ms 一次）也一样
    let s = beat(PRESENCE_INITIAL, 0)
    const dense: number[] = []
    for (let t = 0; t <= 20_000; t += 100) {
      const r = presenceTick(s, t)
      s = r.state
      if (r.ping) dense.push(t)
    }
    for (let i = 1; i < dense.length; i++) expect(dense[i]! - dense[i - 1]!).toBeGreaterThanOrEqual(PRESENCE_PING_GAP_MS)
  })

  it('导图只是被浏览器节流（定时器每分钟才跑一次）但活着：ping 立刻有回应，小灯全程是亮的', () => {
    // 导图自己的心跳只剩每 60 秒一条；单人页的 ping 它每次都立刻回
    let s = beat(PRESENCE_INITIAL, 0)
    let greyed = false
    for (let t = 0; t <= 300_000; t += 1000) {
      if (t > 0 && t % 60_000 === 0) s = beat(s, t)
      const r = presenceTick(s, t)
      s = r.state
      if (r.ping) s = beat(s, t) // BroadcastChannel 不受节流，立刻回
      if (lampState(s, t) !== 'on') greyed = true
    }
    expect(greyed).toBe(false)
  })

  it('导图真的没了（不回应）：10 秒内不灰；超过 10 秒并且 ping 已发出 2 秒才灰', () => {
    const { s, pings } = ticks(beat(PRESENCE_INITIAL, 0), 0, 9000)
    expect(pings).toEqual([7000, 9000]) // 7 秒首次 ping；之后每 2 秒一次
    expect(s.maps.m!.pendingSince).toBe(7000) // 判灰看最早一条没回应的 ping
    expect(lampState(s, 9500)).toBe('on')
    expect(lampState(s, PRESENCE_LOST_AFTER_MS)).toBe('on') // 恰好 10 秒还不算超过
    expect(lampState(s, PRESENCE_LOST_AFTER_MS + 1)).toBe('off') // ping(7000) 已经等了 3 秒
    // 之后一直是灰，不会因为又发了新 ping 而闪回亮
    let t = 10_001
    let cur = s
    for (; t <= 40_000; t += 1000) {
      const r = presenceTick(cur, t)
      cur = r.state
      expect(lampState(cur, t)).toBe('off')
    }
  })

  it('两个条件缺一不可：心跳超过 10 秒但从没 ping 过（定时器没跑）→ 不灰；ping 刚发出不到 2 秒 → 不灰', () => {
    const s = beat(PRESENCE_INITIAL, 0)
    expect(lampState(s, 60_000)).toBe('on') // 没 ping 过：不能判灰
    // 心跳 0 秒，ping 在 9 秒才发出（比如页面刚回到前台）
    const late = presenceTick(s, 9000).state
    expect(lampState(late, 10_500)).toBe('on') // 超过 10 秒了，但 ping 才发出 1.5 秒
    expect(lampState(late, 10_999)).toBe('on')
    expect(lampState(late, 11_000)).toBe('off') // 满 2 秒
    // 发了 ping 但心跳还没超过 10 秒（ping 在 6.x 秒发出，此刻 9.9 秒）
    const early = presenceTick(s, 6500).state
    expect(lampState(early, 9900)).toBe('on')
  })

  it('灰了之后导图又回应（ping 的回应或新的心跳）→ 立刻亮，不用等', () => {
    const { s } = ticks(beat(PRESENCE_INITIAL, 0), 0, 15_000)
    expect(lampState(s, 15_000)).toBe('off')
    const back = beat(s, 15_300)
    expect(back.maps.m!.pendingSince).toBeNull()
    expect(lampState(back, 15_300)).toBe('on')
    expect(presenceTick(back, 16_000).ping).toBe(false) // 刚有心跳：又不用 ping 了
  })

  it('收到 map:bye → 任何时候立刻灰，并且不再 ping；之后再收到心跳又亮', () => {
    let s = beat(PRESENCE_INITIAL, 1000)
    s = reducePresence(s, bye, 2000)
    expect(lampState(s, 2000)).toBe('off')
    expect(presenceTick(s, 60_000).ping).toBe(false)
    s = beat(s, 3000)
    expect(lampState(s, 3000)).toBe('on')
  })

  it('show_dot 为假 / following 为假：不显示（亮过也收回去）也不 ping；没亮过时 bye 也不会冒出一个灰点', () => {
    const lit = beat(PRESENCE_INITIAL, 1000)
    expect(lampState(reducePresence(lit, presence({ show_dot: false }), 2000), 2000)).toBe('hidden')
    expect(lampState(reducePresence(lit, presence({ following: false }), 2000), 2000)).toBe('hidden')
    expect(lampState(reducePresence(PRESENCE_INITIAL, presence({ show_dot: false }), 1000), 1000)).toBe('hidden')
    expect(lampState(reducePresence(PRESENCE_INITIAL, bye, 1000), 1000)).toBe('hidden')
    // 收回之后再收到 bye 或很久没心跳，也不显示、不 ping
    const hid = reducePresence(lit, presence({ show_dot: false }), 2000)
    expect(lampState(reducePresence(hid, bye, 3000), 99_000)).toBe('hidden')
    expect(presenceTick(hid, 99_000).ping).toBe(false)
    // 之后又允许显示了：重新亮
    expect(lampState(beat(hid, 4000), 4000)).toBe('on')
  })

  it('hello 不影响小灯；提示文字', () => {
    const s = beat(PRESENCE_INITIAL, 1000)
    expect(reducePresence(s, hello, 2000)).toBe(s)
    expect(LAMP_TIP).toEqual({ on: '导图已联动', off: '导图联动已断开' })
  })

  describe('单人页自己从隐藏回到前台（presenceWake）', () => {
    // 导图 0 秒时发过最后一条心跳；单人页 7 秒时 ping 了一次，然后自己被冻结（8 秒是它最后一次正常运行）
    const frozen = presenceTick(beat(PRESENCE_INITIAL, 0), 7000).state
    const lastTickAt = 8000

    it('不唤醒直接按当前时间判：会因为旧的 ping 记录立刻判灰（这正是要避免的误判）', () => {
      expect(lampState(frozen, 600_000)).toBe('off')
    })

    it('隐藏之前是亮的：回到前台忘掉旧 ping 记录、马上重新 ping，只有新 ping 等满 2 秒没回才灰', () => {
      const r = presenceWake(frozen, 600_000, lastTickAt)
      expect(r.ping).toBe(true)
      expect(r.state).toMatchObject({ lastPingAt: 600_000, maps: { m: { pendingSince: 600_000 } } })
      expect(lampState(r.state, 600_000)).toBe('on')
      expect(lampState(r.state, 601_999)).toBe('on')
      expect(lampState(r.state, 602_000)).toBe('off')
      // 排队的回应在这 2 秒内处理了：保持亮
      const answered = beat(r.state, 600_300)
      expect(lampState(answered, 650_000)).toBe('on')
    })

    it('回到前台时心跳其实是新的：不 ping，旧的「没回应」记录照样忘掉（上次 ping 的时间保留，限频照常）', () => {
      const s = beat(frozen, 599_000)
      const r = presenceWake(s, 600_000, 598_000)
      expect(r.ping).toBe(false)
      expect(r.state).toMatchObject({ lastPingAt: 7000, maps: { m: { pendingSince: null } } })
      expect(lampState(r.state, 600_000)).toBe('on')
    })

    it('同一次恢复连着触发好几个事件（resume、visibilitychange、pageshow 间隔 1 毫秒）：只 ping 一次；回应等待从这条 ping 起完整算 2 秒', () => {
      const first = presenceWake(frozen, 600_000, lastTickAt)
      expect(first.ping).toBe(true)
      // 单人页每次处理完都把 lastTickAt 更新成当时的时间
      const second = presenceWake(first.state, 600_001, 600_000)
      expect(second.ping).toBe(false)
      const third = presenceWake(second.state, 600_002, 600_001)
      expect(third.ping).toBe(false)
      // 第一条 ping 的「没回应」记录没有被后面的唤醒冲掉，也没有重新记
      expect(third.state).toMatchObject({ lastPingAt: 600_000, maps: { m: { pendingSince: 600_000 } } })
      expect(lampState(third.state, 601_999)).toBe('on')
      expect(lampState(third.state, 602_000)).toBe('off') // 从第一条 ping 算满 2 秒，不会因为多唤醒了几次而拖后
      // 排队的回应在这 2 秒内处理了：保持亮
      expect(lampState(beat(third.state, 600_300), 650_000)).toBe('on')
    })

    it('唤醒也要遵守 2 秒限频：距上次 ping 不到 2 秒不 ping（等下一次定时检查）；之后照常', () => {
      const s = presenceWake(frozen, 7500, 7000) // 刚在 7 秒 ping 过，7.5 秒又回到前台
      expect(s.ping).toBe(false)
      expect(s.state.maps.m!.pendingSince).toBeNull() // 旧记录忘掉了，所以不会因为它判灰
      expect(lampState(s.state, 60_000)).toBe('on')
      expect(presenceTick(s.state, 8000).ping).toBe(false) // 距 7 秒只有 1 秒
      const t = presenceTick(s.state, 9000)
      expect(t.ping).toBe(true)
      expect(t.state.maps.m!.pendingSince).toBe(9000)
    })

    it('相隔 2 秒以上的两次回到前台是两次恢复：后一次重新忘记旧记录、重新 ping', () => {
      const first = presenceWake(frozen, 600_000, lastTickAt)
      expect(first.ping).toBe(true)
      const again = presenceWake(first.state, 602_000, 601_000)
      expect(again.ping).toBe(true) // 距上次 ping 恰好 2 秒：限频放行
      expect(again.state).toMatchObject({ lastPingAt: 602_000, lastWakeAt: 602_000, maps: { m: { pendingSince: 602_000 } } })
    })

    it('系统时间往回调过：不会因为「上次 ping 在未来」卡住不再 ping', () => {
      const s = presenceTick(beat(PRESENCE_INITIAL, 0), 50_000).state // 50 秒 ping 过
      expect(presenceTick(s, 20_000).ping).toBe(true) // 时间被调回 20 秒
      expect(presenceWake(s, 20_000, 19_000).ping).toBe(true)
    })

    it('隐藏之前就已经是灰的（导图早就没了）：保持灰，不闪一下亮；继续 ping（说不定它回来了）', () => {
      const dead = ticks(beat(PRESENCE_INITIAL, 0), 0, 20_000).s
      expect(lampState(dead, 20_000)).toBe('off')
      const r = presenceWake(dead, 900_000, 20_000)
      expect(r.ping).toBe(true)
      expect(lampState(r.state, 900_000)).toBe('off')
      expect(lampState(r.state, 900_500)).toBe('off')
      expect(lampState(beat(r.state, 900_100), 900_100)).toBe('on') // 它真的回来了
    })

    it('隐藏之前已经收到 bye / 小灯本来就不显示：保持原样，不 ping', () => {
      const byed = reducePresence(beat(PRESENCE_INITIAL, 0), bye, 1000)
      const r1 = presenceWake(byed, 900_000, 2000)
      expect(r1.ping).toBe(false)
      expect(lampState(r1.state, 900_000)).toBe('off')
      const r2 = presenceWake(PRESENCE_INITIAL, 900_000, 2000)
      expect(r2).toEqual({ state: PRESENCE_INITIAL, ping: false })
    })
  })

  describe('同时开着几个导图窗口（按消息的 src 分别记录，再汇总）', () => {
    const from = (src: string, p: Partial<Extract<MapMsg, { type: 'map:presence' }>> = {}): MapMsg => ({ type: 'map:presence', src, at: 0, following: true, show_dot: true, ...p })
    const byeOf = (src: string): MapMsg => ({ type: 'map:bye', src, at: 0 })
    const both = (t = 1000) => reducePresence(reducePresence(PRESENCE_INITIAL, from('A'), t), from('B'), t)

    it('A 在跟随时 B 发 bye：小灯仍亮', () => {
      const s = reducePresence(both(), byeOf('B'), 2000)
      expect(lampState(s, 2000)).toBe('on')
      expect(s.maps.B).toMatchObject({ bye: true })
      expect(s.maps.A).toMatchObject({ bye: false })
      expect(lampState(s, 60_000 - 1)).toBe('on') // 没 ping 过：不能判灰
    })

    it('A、B 都 bye 才灰；之后任何一个重新有心跳就亮', () => {
      let s = reducePresence(both(), byeOf('A'), 2000)
      expect(lampState(s, 2000)).toBe('on')
      s = reducePresence(s, byeOf('B'), 2500)
      expect(lampState(s, 2500)).toBe('off')
      expect(presenceTick(s, 60_000).ping).toBe(false) // 都 bye 了：不 ping
      s = reducePresence(s, from('B'), 3000)
      expect(lampState(s, 3000)).toBe('on')
    })

    it('B 发 show_dot:false（或 following:false）不影响 A：小灯照样显示；A 也不显示了才收起来', () => {
      let s = reducePresence(both(), from('B', { show_dot: false }), 2000)
      expect(lampState(s, 2000)).toBe('on')
      expect(presenceWantsDot(s)).toBe(true)
      s = reducePresence(s, from('B', { following: false }), 3000)
      expect(lampState(s, 3000)).toBe('on')
      s = reducePresence(s, from('A', { show_dot: false }), 4000)
      expect(lampState(s, 4000)).toBe('hidden')
      expect(presenceWantsDot(s)).toBe(false)
      // 只有 B 想显示、A 不想：显示
      s = reducePresence(s, from('B'), 5000)
      expect(lampState(s, 5000)).toBe('on')
    })

    it('不显示小灯的窗口 bye / 超时：不会冒出灰点，也不拖累别的窗口', () => {
      const s0 = reducePresence(reducePresence(PRESENCE_INITIAL, from('A'), 0), from('B', { show_dot: false }), 0)
      // A 的心跳一直在，B 早就没了：不 ping（B 不要求显示，不用管它）
      let s = s0
      for (let t = 0; t <= 20_000; t += 1000) {
        if (t % 2000 === 0) s = reducePresence(s, from('A'), t)
        const r = presenceTick(s, t)
        s = r.state
        expect(r.ping).toBe(false)
        expect(lampState(s, t)).toBe('on')
      }
      expect(lampState(reducePresence(s, byeOf('B'), 21_000), 21_000)).toBe('on')
    })

    it('A 超时（它的窗口没了，ping 没人回）但 B 活着：一直亮；B 也没了才灰', () => {
      let s = both(0)
      let greyAt: number | null = null
      for (let t = 0; t <= 40_000; t += 1000) {
        const r = presenceTick(s, t)
        s = r.state
        const bAlive = t <= 24_000 // B 的窗口到 24 秒还在，之后没了
        if (bAlive && t % 2000 === 0) s = reducePresence(s, from('B'), t)
        if (bAlive && r.ping) s = reducePresence(s, from('B'), t) // B 立刻回 ping；A 不回
        if (greyAt == null && lampState(s, t) === 'off') greyAt = t
        if (bAlive) expect(lampState(s, t)).toBe('on')
      }
      expect(s.maps.A!.pendingSince).toBe(7000) // A 从 7 秒起一直没回应
      expect(lampState(s, 34_000)).toBe('on') // B 最后一次心跳 24 秒；34 秒时恰好 10 秒，不算超过
      expect(greyAt).toBe(35_000)
    })

    it('A 一直不回、B 一直回：A 的「没回应」记录不会被 B 的回应冲掉；A 自己有心跳才清', () => {
      let s = both(0)
      for (let t = 0; t <= 15_000; t += 1000) {
        if (t % 2000 === 0) s = reducePresence(s, from('B'), t)
        const r = presenceTick(s, t)
        s = r.state
        if (r.ping) s = reducePresence(s, from('B'), t)
      }
      expect(lampState(s, 15_000)).toBe('on')
      expect(s.maps.A!.pendingSince).not.toBeNull()
      expect(s.maps.B!.pendingSince).toBeNull()
      s = reducePresence(s, from('A'), 15_500)
      expect(s.maps.A).toMatchObject({ pendingSince: null, bye: false })
    })

    it('ping 是广播，频率限制是全局的；只给心跳超过 6 秒的窗口记 pendingSince', () => {
      let s = reducePresence(reducePresence(PRESENCE_INITIAL, from('A'), 5000), from('B'), 0)
      const r = presenceTick(s, 7000) // B 7 秒没心跳，A 才 2 秒
      expect(r.ping).toBe(true)
      expect(r.state.maps.B!.pendingSince).toBe(7000)
      expect(r.state.maps.A!.pendingSince).toBeNull()
      s = r.state
      expect(presenceTick(s, 8000).ping).toBe(false) // 距上次 ping 不到 2 秒（全局）
      expect(presenceTick(s, 9000).ping).toBe(true)
    })

    it('没见过的 src 发 bye：忽略（状态不变）；hello 同样', () => {
      const s = both()
      expect(reducePresence(s, byeOf('C'), 2000)).toBe(s)
      expect(reducePresence(PRESENCE_INITIAL, byeOf('C'), 2000)).toBe(PRESENCE_INITIAL)
    })

    it('presenceWake：隐藏之前有效的窗口忘掉旧 ping 记录，早就失效的窗口保持原样', () => {
      // A：0 秒最后一次心跳，7 秒被 ping 过（单人页之后冻结，8 秒是最后一次正常运行）；B：早就 bye 了
      const s0 = reducePresence(both(0), byeOf('B'), 500)
      const frozen = presenceTick(s0, 7000).state
      expect(frozen.maps.A!.pendingSince).toBe(7000)
      const r = presenceWake(frozen, 600_000, 8000)
      expect(r.ping).toBe(true)
      expect(r.state.maps.A!.pendingSince).toBe(600_000)
      expect(r.state.maps.B).toMatchObject({ bye: true })
      expect(lampState(r.state, 600_000)).toBe('on')
      expect(lampState(r.state, 602_000)).toBe('off')
      // A 的回应排在队里：处理后保持亮
      expect(lampState(reducePresence(r.state, from('A'), 600_300), 650_000)).toBe('on')
    })

    it('窗口太多时丢最旧的已失效窗口，有效的不丢', () => {
      let s = reducePresence(PRESENCE_INITIAL, from('live'), 100_000)
      for (let i = 0; i < PRESENCE_MAX_MAPS + 5; i++) {
        s = reducePresence(s, from(`gone${i}`), 1000 + i)
        s = reducePresence(s, byeOf(`gone${i}`), 1000 + i)
      }
      expect(Object.keys(s.maps).length).toBeLessThanOrEqual(PRESENCE_MAX_MAPS)
      expect(s.maps.live).toBeDefined()
      expect(s.maps.gone0).toBeUndefined() // 最旧的先丢
      expect(lampState(s, 100_000)).toBe('on')
    })

    it('窗口全是有效的也有上限：连着 100 个不同的导图窗口发 presence，只留心跳最新的 16 个', () => {
      let s = PRESENCE_INITIAL
      for (let i = 0; i < 100; i++) {
        s = reducePresence(s, from(`tab${i}`), 1000 + i)
        expect(Object.keys(s.maps).length).toBeLessThanOrEqual(PRESENCE_MAX_MAPS)
      }
      expect(Object.keys(s.maps).sort()).toEqual(Array.from({ length: PRESENCE_MAX_MAPS }, (_, i) => `tab${100 - PRESENCE_MAX_MAPS + i}`).sort())
      expect(s.maps.tab0).toBeUndefined()
      expect(s.maps.tab99).toBeDefined()
      expect(lampState(s, 1100)).toBe('on')
    })

    it('超限时先淘汰已失效的（哪怕它的心跳比有效窗口新），没有失效的才淘汰心跳最旧的有效窗口；刚收到消息的窗口永远留下', () => {
      let s = PRESENCE_INITIAL
      for (let i = 0; i < PRESENCE_MAX_MAPS; i++) s = reducePresence(s, from(`tab${i}`), 1000 + i)
      s = reducePresence(s, byeOf('tab5'), 1500) // tab5 失效了，但它的心跳不是最旧的
      s = reducePresence(s, from('new1'), 2000)
      expect(Object.keys(s.maps)).toHaveLength(PRESENCE_MAX_MAPS)
      expect(s.maps.tab5).toBeUndefined() // 失效的先走
      expect(s.maps.tab0).toBeDefined()
      expect(s.maps.new1).toBeDefined()
      s = reducePresence(s, from('new2'), 2001) // 现在没有失效的了：淘汰心跳最旧的有效窗口 tab0
      expect(Object.keys(s.maps)).toHaveLength(PRESENCE_MAX_MAPS)
      expect(s.maps.tab0).toBeUndefined()
      expect(s.maps.tab1).toBeDefined()
      // 刚收到消息的窗口，即使它的接收时间比别人旧也不会被自己淘汰
      s = reducePresence(s, from('late'), 10)
      expect(Object.keys(s.maps)).toHaveLength(PRESENCE_MAX_MAPS)
      expect(s.maps.late).toBeDefined()
      expect(s.maps.tab1).toBeUndefined()
    })
  })
})
