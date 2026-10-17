/**
 * 联动消息协议：校验（parseMessage、isSpecV2Shape）、信封（stamp）、方案标识（planKeyOf、linkPlanKey）、频道（不支持时静默降级、坏消息被丢掉）。
 */
import { describe, expect, it, vi } from 'vitest'
import { DRAW_METHODS, MODE_IDS, defaultSpec, normalizeSpec } from '@/features/workbench2/spec'
import {
  browserChannelFactory,
  isSpecV2Shape,
  linkPlanKey,
  MAP_TYPES,
  MAPLINK_CHANNEL,
  newTabId,
  openLinkChannel,
  parseMessage,
  planKeyOf,
  SOLO_TYPES,
  SPEC_DRAW_METHODS,
  SPEC_MODES,
  stamp,
  type ChannelLike,
  type LinkMsg,
} from './protocol'

const env = { src: 'tab-a', at: 1_700_000_000_000 }
/** 一份完整合法的 SpecV2（含一个纳入范围、一个排除范围） */
const SPEC_OK = {
  version: 2,
  game: { mode: 'anime', tag_count: 6 },
  ranges: [
    {
      id: 'r_a1',
      enabled: true,
      label: null,
      share: null,
      source: { type: 'recent_years', years: 10 },
      pick: { top_works: 50, per_work: 6, roles: ['主角'], order: 'heat' },
      conditions: [],
    },
  ],
  excludes: [{ id: 'r_x1', enabled: false, source: { type: 'recent_years', years: 1 }, pick: { top_works: 1 }, conditions: [{ id: 'c1' }] }],
  draw: { method: 'per_character', seed: null },
  meta: { name: '方案A' },
}
const valid: Record<string, Record<string, unknown>> = {
  'solo:state': { type: 'solo:state', plan_key: 'plan:方案A', plan_name: '方案A', source: 'plan', spec: SPEC_OK, pool_total: 42 },
  'solo:round-start': { type: 'solo:round-start', round_id: 'r1' },
  'solo:round-end': {
    type: 'solo:round-end',
    round_id: 'r1',
    plan_key: 'workbench',
    answer_id: 9,
    answer_name: '答案',
    bound_work: { id: 101, name: '某番' },
    answer_work_ids: [101, 102],
    wrong_guesses: [{ char_id: 5, name: '角色五', work_ids: [102] }],
    grade: 'good',
    ended_by: 'exact',
  },
  'solo:grade': { type: 'solo:grade', round_id: 'r1', grade: 'again' },
  'solo:bye': { type: 'solo:bye' },
  'solo:ping': { type: 'solo:ping' },
  'map:hello': { type: 'map:hello' },
  'map:presence': { type: 'map:presence', following: true, show_dot: false },
  'map:bye': { type: 'map:bye' },
}
const msg = (type: string, patch: Record<string, unknown> = {}) => ({ ...valid[type], ...env, ...patch })

describe('parseMessage', () => {
  it('9 种消息的合法形状都通过，原样返回', () => {
    expect(Object.keys(valid).sort()).toEqual([...SOLO_TYPES, ...MAP_TYPES].sort())
    for (const type of Object.keys(valid)) expect(parseMessage(msg(type))).toEqual(msg(type))
  })

  it('不是对象 / 缺信封（type、src、at）/ 不认识的类型 → null', () => {
    for (const bad of [null, undefined, 3, 'solo:bye', [], [msg('solo:bye')]]) expect(parseMessage(bad)).toBeNull()
    expect(parseMessage({ ...valid['solo:bye'], at: env.at })).toBeNull() // 缺 src
    expect(parseMessage({ ...valid['solo:bye'], src: env.src })).toBeNull() // 缺 at
    expect(parseMessage(msg('solo:bye', { src: '' }))).toBeNull()
    expect(parseMessage(msg('solo:bye', { src: 7 }))).toBeNull()
    expect(parseMessage(msg('solo:bye', { at: '1' }))).toBeNull()
    expect(parseMessage(msg('solo:bye', { at: Number.NaN }))).toBeNull()
    expect(parseMessage(msg('solo:bye', { at: Infinity }))).toBeNull()
    expect(parseMessage({ ...env })).toBeNull() // 缺 type
    expect(parseMessage({ ...env, type: 'solo:unknown' })).toBeNull()
    expect(parseMessage({ ...env, type: 'map:state' })).toBeNull()
  })

  it('字段类型不对 → null', () => {
    const bad: [string, Record<string, unknown>][] = [
      ['solo:state', { plan_key: 1 }],
      ['solo:state', { plan_name: 5 }],
      ['solo:state', { source: 'file' }],
      ['solo:state', { spec: null }],
      ['solo:state', { spec: {} }],
      ['solo:state', { spec: { version: 2 } }],
      ['solo:state', { spec: { game: null } }],
      ['solo:state', { spec: { ...SPEC_OK, game: null } }],
      ['solo:state', { spec: [] }],
      ['solo:state', { spec: 'x' }],
      ['solo:state', { pool_total: -1 }],
      ['solo:state', { pool_total: 1.5 }],
      ['solo:round-start', { round_id: '' }],
      ['solo:round-start', { round_id: 3 }],
      ['solo:round-end', { answer_id: '9' }],
      ['solo:round-end', { answer_name: null }],
      ['solo:round-end', { bound_work: { id: '1', name: 'x' } }],
      ['solo:round-end', { bound_work: undefined }],
      ['solo:round-end', { answer_work_ids: [1, '2'] }],
      ['solo:round-end', { answer_work_ids: 'x' }],
      ['solo:round-end', { wrong_guesses: [{ char_id: 5, name: 'x' }] }],
      ['solo:round-end', { wrong_guesses: {} }],
      ['solo:round-end', { grade: 'ok' }],
      ['solo:round-end', { ended_by: 'timeout' }],
      ['solo:grade', { grade: 'ok' }],
      ['solo:grade', { round_id: null }],
      ['map:presence', { following: 'yes' }],
      ['map:presence', { show_dot: 1 }],
    ]
    for (const [type, patch] of bad) expect(parseMessage(msg(type, patch)), `${type} ${JSON.stringify(patch)}`).toBeNull()
  })

  it('solo:state 的 spec 要是完整的 SpecV2：缺 game / ranges / excludes / draw、version 不是 2、字段类型不对的整条丢弃', () => {
    const withSpec = (patch: Record<string, unknown>) => msg('solo:state', { spec: { ...SPEC_OK, ...patch } })
    for (const patch of [
      { game: null },
      { game: {} },
      { game: { mode: 'anime' } },
      { game: { tag_count: 6 } },
      { game: { mode: 5, tag_count: 6 } },
      { game: { mode: 'novel', tag_count: 6 } },
      { game: { mode: 'anime', tag_count: '6' } },
      { game: { mode: 'anime', tag_count: 6.5 } },
      { ranges: undefined },
      { ranges: null },
      { ranges: {} },
      { ranges: [null] },
      { ranges: [{ id: 'r1' }] },
      { ranges: [{ ...SPEC_OK.ranges[0], id: '' }] },
      { ranges: [{ ...SPEC_OK.ranges[0], enabled: 'yes' }] },
      { ranges: [{ ...SPEC_OK.ranges[0], source: null }] },
      { ranges: [{ ...SPEC_OK.ranges[0], pick: [] }] },
      { ranges: [{ ...SPEC_OK.ranges[0], conditions: {} }] },
      { excludes: undefined },
      { excludes: [5] },
      { draw: null },
      { draw: {} },
      { draw: { method: 'lottery' } },
      { draw: { method: 'per_work', seed: '7' } },
      { draw: { method: 'per_work', seed: 1.5 } },
      { meta: 'x' },
      { version: 1 },
      { version: '2' },
      { version: undefined },
    ]) {
      expect(parseMessage(withSpec(patch)), JSON.stringify(patch)).toBeNull()
    }
    // 合法的：meta 可以没有、seed 可以没有 / null / 整数、不认识的字段保留、空的 ranges 也行（后端会报「方案没有纳入范围」）
    for (const patch of [
      { meta: undefined },
      { draw: { method: 'range_share' } },
      { draw: { method: 'per_work', seed: 12345 } },
      { ranges: [] },
      { excludes: [] },
      { future: { x: 1 } },
    ]) {
      expect(parseMessage(withSpec(patch)), JSON.stringify(patch)).not.toBeNull()
    }
    expect(parseMessage(withSpec({ future: { x: 1 } }))).toMatchObject({ spec: { future: { x: 1 } } })
  })

  it('isSpecV2Shape：工作台真实产出的方案（默认方案、规整后的方案）都通过；模式、抽题方式的合法值和工作台的常量一致', () => {
    expect([...SPEC_MODES]).toEqual([...MODE_IDS])
    expect([...SPEC_DRAW_METHODS]).toEqual([...DRAW_METHODS])
    expect(isSpecV2Shape(defaultSpec(new Date('2026-10-15')))).toBe(true)
    expect(isSpecV2Shape(normalizeSpec({}).spec)).toBe(true)
    expect(isSpecV2Shape(normalizeSpec({ version: 2, game: { mode: 'game', tag_count: 3 }, draw: { method: 'range_share', seed: 7 } }).spec)).toBe(true)
    expect(isSpecV2Shape(SPEC_OK)).toBe(true)
    for (const bad of [null, undefined, 0, 'x', [], {}, { version: 2 }, { version: 2, game: null }]) expect(isSpecV2Shape(bad)).toBe(false)
  })

  it('solo:ping 只有信封：没有别的必填字段，多出来的字段保留；缺信封照样丢', () => {
    expect(parseMessage({ type: 'solo:ping', ...env })).toEqual({ type: 'solo:ping', ...env })
    expect(parseMessage({ type: 'solo:ping', ...env, extra: 1 })).toMatchObject({ extra: 1 })
    expect(parseMessage({ type: 'solo:ping', src: env.src })).toBeNull()
    expect(SOLO_TYPES).toContain('solo:ping')
    expect(MAP_TYPES).not.toContain('solo:ping')
  })

  it('bound_work 可以是 null（答案没有绑定作品）；多出来的字段保留', () => {
    expect(parseMessage(msg('solo:round-end', { bound_work: null }))).not.toBeNull()
    expect(parseMessage(msg('map:presence', { future_field: 1 }))).toMatchObject({ future_field: 1 })
  })
})

describe('stamp / planKeyOf / newTabId', () => {
  it('stamp 补上 src 和 at，不改原对象', () => {
    const body = { type: 'solo:bye' } as const
    expect(stamp(body, 't1', 123)).toEqual({ type: 'solo:bye', src: 't1', at: 123 })
    expect(body).toEqual({ type: 'solo:bye' })
  })

  it('planKeyOf：有方案名 plan:名字（去首尾空白），没有 = workbench', () => {
    expect(planKeyOf('方案A')).toBe('plan:方案A')
    expect(planKeyOf('  方案B ')).toBe('plan:方案B')
    expect(planKeyOf(null)).toBe('workbench')
    expect(planKeyOf(undefined)).toBe('workbench')
    expect(planKeyOf('')).toBe('workbench')
    expect(planKeyOf('   ')).toBe('workbench')
  })

  it('linkPlanKey：工作台固定 workbench（载入过方案 A 也一样）；已保存方案 plan:名字；已保存方案没有名字退回 workbench', () => {
    expect(linkPlanKey('workbench', null)).toBe('workbench')
    expect(linkPlanKey('workbench', '方案A')).toBe('workbench')
    expect(linkPlanKey('plan', '方案A')).toBe('plan:方案A')
    expect(linkPlanKey('plan', '  方案B ')).toBe('plan:方案B')
    expect(linkPlanKey('plan', null)).toBe('workbench')
    expect(linkPlanKey('plan', '')).toBe('workbench')
  })

  it('newTabId：非空、每次不同', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newTabId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id.length).toBeGreaterThan(8)
  })
})

/** 内存版 BroadcastChannel：记下发出的消息，能模拟收到消息 */
function fakeChannel() {
  const ch = {
    sent: [] as unknown[],
    closed: false,
    onmessage: null as ChannelLike['onmessage'],
    postMessage: vi.fn((d: unknown) => void ch.sent.push(d)),
    close: vi.fn(() => void (ch.closed = true)),
    deliver(data: unknown) {
      ch.onmessage?.({ data })
    },
  }
  return ch
}

describe('openLinkChannel', () => {
  it('频道名固定 outsetter.maplink.v1', () => {
    expect(MAPLINK_CHANNEL).toBe('outsetter.maplink.v1')
    const factory = vi.fn(() => fakeChannel())
    openLinkChannel(() => {}, factory)
    expect(factory).toHaveBeenCalledWith('outsetter.maplink.v1')
  })

  it('不支持 BroadcastChannel（工厂返回 null）→ null，不抛错', () => {
    expect(openLinkChannel(() => {}, () => null)).toBeNull()
  })

  it('默认工厂：全局没有 BroadcastChannel、或构造时抛错（被禁用）→ null；有就用它', () => {
    const g = globalThis as { BroadcastChannel?: unknown }
    const saved = g.BroadcastChannel
    try {
      g.BroadcastChannel = undefined
      expect(browserChannelFactory('x')).toBeNull()
      g.BroadcastChannel = class {
        constructor() {
          throw new Error('denied')
        }
      }
      expect(browserChannelFactory('x')).toBeNull()
      const made: string[] = []
      g.BroadcastChannel = class {
        constructor(name: string) {
          made.push(name)
        }
      }
      expect(browserChannelFactory('y')).not.toBeNull()
      expect(made).toEqual(['y'])
    } finally {
      g.BroadcastChannel = saved
    }
  })

  it('只把合法消息交给回调；坏消息、回调抛错都不会拖垮频道', () => {
    const ch = fakeChannel()
    const got: LinkMsg[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    openLinkChannel((m) => {
      got.push(m)
      if (m.type === 'map:bye') throw new Error('处理出错')
    }, () => ch)
    ch.deliver('垃圾')
    ch.deliver({ type: 'map:hello' })
    ch.deliver(msg('map:hello'))
    ch.deliver(msg('map:bye'))
    ch.deliver(msg('map:presence'))
    expect(got.map((m) => m.type)).toEqual(['map:hello', 'map:bye', 'map:presence'])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('post 发出去的就是传入的对象；发不出去（抛错）静默忽略；close 之后不再收发', () => {
    const ch = fakeChannel()
    const got: LinkMsg[] = []
    const link = openLinkChannel((m) => got.push(m), () => ch)!
    const m = stamp({ type: 'solo:bye' }, 't1', 1)
    link.post(m)
    expect(ch.sent).toEqual([m])
    ch.postMessage.mockImplementationOnce(() => {
      throw new Error('DataCloneError')
    })
    expect(() => link.post(m)).not.toThrow()
    link.close()
    link.close() // 重复关没事
    expect(ch.close).toHaveBeenCalledTimes(1)
    link.post(m)
    expect(ch.sent).toHaveLength(1)
    ch.deliver(msg('map:hello'))
    expect(got).toEqual([])
  })
})
