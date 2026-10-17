/**
 * 跟随控制器的异步跳转 / 返回 / 换方案 / 重挂恢复：操作编号作废以后，等回来的旧操作不能再动导图。
 * 消息直接交给控制器（不走频道校验），引擎用登记到 engines.ts 的假实例，记下收到的每个命令。
 * 用户接管只由引擎的 onFocusTakeover 回调驱动：和 PaneEngine 一样经 TagNoteBinding + focusTakeoverFor 接到假引擎上，测试替引擎调回调。
 */
import type { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTagNoteLocal } from '@/features/tagnote/store'
import { TagNoteBinding, type EngineLike } from '@/features/tagnote/binding'
import { emitViewportEvent, focusTakeoverFor, registerEngine, type EngineHandle } from '@/features/tagnote/workspace/engines'
import type { SplitNode, Workspace } from '@/features/tagnote/workspace/types'
import type { FocusOptions, FocusResult, MountOptions, TagNoteData, TagNoteInstance } from '@/vendor/tagnote/tagnote.esm.js'
import { maplinkApi, type MapSet, type PreselectResult } from './api'
import { DEFAULT_FOLLOW_SETTINGS, FLASH_MS, type ReturnPlan, type Expectation } from './follow'
import { FollowController } from './followController'
import { useFollow, useFollowRuntime } from './followStore'
import type { LinkMsg } from './protocol'

/** 测试要碰的私有成员（名字要和 followController.ts 里的私有字段一致） */
interface Priv {
  onMessage(m: LinkMsg): void
  roundActive: boolean
  ret: ReturnPlan | null
  expect: Expectation | null
  doReturn(): Promise<void>
}

interface Call {
  op: string
  tabId: string
  ids?: string[]
  opts?: FocusOptions
  value?: string
  roundActive?: boolean
  pane?: string | null
}

const WS: Workspace = {
  tabs: {
    t1: { id: 't1', mapId: 'O', view: 'score', viewports: {} },
    t2: { id: 't2', mapId: 'M', view: 'canvas', viewports: {} },
    t3: { id: 't3', mapId: 'O2', view: 'canvas', viewports: {} },
  },
  root: {
    type: 'split',
    id: 's4',
    dir: 'row',
    sizes: [0.5, 0.5],
    children: [
      { type: 'pane', id: 'p1', tabs: ['t1', 't2'], active: 't1' },
      { type: 'pane', id: 'p2', tabs: ['t3'], active: 't3' },
    ],
  },
  activePane: 'p1',
  seq: 4,
  opened: true,
}

let c: FollowController
let priv: Priv
let calls: Call[]
let offs: (() => void)[]

const flush = () => vi.advanceTimersByTimeAsync(0)
const focuses = () => calls.filter((x) => x.op === 'focusWorks')
const activeOf = (pane: string) => {
  const root = useTagNoteLocal.getState().workspace.root as SplitNode
  return root.children.find((p) => p.type === 'pane' && p.id === pane)
}
/** 像用户点标签那样切换某一格的当前标签 */
function setActive(pane: string, tab: string) {
  const ws = useTagNoteLocal.getState().workspace
  const root = ws.root as SplitNode
  useTagNoteLocal.setState({ workspace: { ...ws, root: { ...root, children: root.children.map((p) => (p.type === 'pane' && p.id === pane ? { ...p, active: tab } : p)) } } })
}
const mapSet = (planKey: string, mapIds: string[]): MapSet => ({ plan_key: planKey, map_ids: mapIds, updated_at: null })

function engine(tabId = 't2', o: { mapId?: string; view?: string; result?: FocusResult; drawn?: () => string[] | null } = {}): EngineHandle {
  let view = o.view ?? 'canvas'
  const rec = (x: Omit<Call, 'roundActive' | 'pane'>) => calls.push({ ...x, roundActive: priv.roundActive, pane: useFollow.getState().pane })
  return {
    tabId,
    mapId: o.mapId ?? 'M',
    get view() {
      return view
    },
    setView: (v) => {
      rec({ op: 'setView', tabId, value: v })
      view = v
    },
    getViewport: () => ({ zoom: 1, cx: 0, cy: 0, home: true }),
    setViewport: () => rec({ op: 'setViewport', tabId }),
    focusWorks: (ids, opts) => {
      rec({ op: 'focusWorks', tabId, ids, opts })
      return o.result ?? { found: ids, secondaryFound: [], queued: false }
    },
    clearFocus: () => rec({ op: 'clearFocus', tabId }),
    drawnWorkIds: () => (o.drawn ? o.drawn() : ['answer-card']),
    boardRect: () => null,
  }
}

/** 像 PaneEngine 那样挂一个引擎（binding 带 onFocusTakeover: focusTakeoverFor(tabId)），返回引擎收到的挂载参数 */
function mountOpts(tabId: string): MountOptions {
  let opts: MountOptions = {}
  const fake: EngineLike = {
    mount: (_el, _data, o) => {
      opts = o ?? {}
      return { destroy: () => {}, getPrefs: () => ({}), setPrefs: () => {} } as unknown as TagNoteInstance
    },
  }
  new TagNoteBinding(fake, {} as HTMLElement, { data: {} as TagNoteData, theme: 'light', layout: 'pane', fullscreen: 'host', onFocusTakeover: focusTakeoverFor(tabId, () => true) })
  return opts
}

function register(h: EngineHandle) {
  const off = registerEngine(h)
  offs.push(off)
  return off
}

const end = (p: Record<string, unknown> = {}) =>
  ({
    type: 'solo:round-end',
    src: 'soloA',
    at: Date.now(),
    round_id: 'r1',
    answer_id: 1,
    answer_name: '答案',
    answer_work_ids: [10],
    bound_work: { id: 10, name: '作品' },
    wrong_guesses: [],
    grade: 'again',
    ...p,
  }) as unknown as LinkMsg
const start = (round = 'r2') => ({ type: 'solo:round-start', src: 'soloA', at: Date.now(), round_id: round }) as unknown as LinkMsg
const state = (plan: string, src = 'soloA') =>
  ({ type: 'solo:state', src, at: Date.now(), plan_key: `plan:${plan}`, plan_name: plan, source: 'plan', spec: {}, pool_total: 5 }) as unknown as LinkMsg

beforeEach(() => {
  vi.useFakeTimers()
  calls = []
  offs = []
  useTagNoteLocal.setState({ workspace: structuredClone(WS) })
  useFollow.setState({ pane: null, planKey: null, planName: null, mapIds: [], declinedPlanKey: null, settings: { ...DEFAULT_FOLLOW_SETTINGS } })
  useFollowRuntime.setState({ link: 'none', solo: null, caption: null, notice: null, pick: null })
  const queryClient = {
    prefetchQuery: async () => {},
    fetchQuery: async () => ({ works: [{ id: 'answer-card', subject_id: 10 }] }),
  } as unknown as QueryClient
  c = new FollowController({ queryClient, mapExists: () => true, channelFactory: () => ({ onmessage: null, postMessage() {}, close() {} }) })
  priv = c as unknown as Priv
  c.start()
  useFollow.getState().start({ pane: 'p1', planKey: 'plan:A', planName: 'A', mapIds: ['M'] })
})

afterEach(() => {
  for (const off of offs) off()
  c.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('跳转作废：等回来的旧跳转不动导图', () => {
  it('等实例挂上时下一题开始了：不聚焦、不 reveal', async () => {
    priv.onMessage(end())
    await flush()
    expect(priv.expect?.tabId).toBe('t2')
    expect(calls).toEqual([])
    priv.onMessage(start())
    register(engine())
    await flush()
    expect(focuses()).toEqual([])
  })

  it('聚焦排着（实例没画完）时下一题开始了：排着的撤掉（clearFocus），不再切画布', async () => {
    let drawn: string[] | null = null
    register(engine('t2', { view: 'score', result: { found: ['answer-card'], secondaryFound: [], queued: true }, drawn: () => drawn }))
    priv.onMessage(end())
    await flush()
    expect(focuses()).toHaveLength(1)
    priv.onMessage(start())
    expect(calls.at(-1)).toMatchObject({ op: 'clearFocus', tabId: 't2' })
    drawn = []
    await vi.advanceTimersByTimeAsync(500)
    expect(calls.filter((x) => x.op === 'setView')).toEqual([])
    expect(focuses()).toHaveLength(1)
  })

  it('等实例时跟随移到了别的格子：旧格子不聚焦', async () => {
    priv.onMessage(end())
    await flush()
    useFollow.getState().moveTo('p2')
    register(engine())
    await flush()
    expect(focuses()).toEqual([])
  })

  it('等实例时用户切走了标签（接管）：不聚焦', async () => {
    priv.onMessage(end())
    await flush()
    expect(activeOf('p1')).toMatchObject({ active: 't2' })
    setActive('p1', 't1')
    register(engine())
    await flush()
    expect(focuses()).toEqual([])
  })

  it('等实例时停止跟随：不聚焦', async () => {
    priv.onMessage(end())
    await flush()
    useFollow.getState().stop()
    register(engine())
    await flush()
    expect(focuses()).toEqual([])
  })

  it('新的答案又来了：上一次还没做完的跳转作废，只聚焦一次', async () => {
    priv.onMessage(end())
    await flush()
    priv.onMessage(end({ round_id: 'r2' }))
    await flush()
    register(engine())
    await flush()
    expect(focuses()).toHaveLength(1)
  })

  it('正常情况：聚焦带 reveal（对照）', async () => {
    register(engine())
    priv.onMessage(end())
    await flush()
    expect(focuses()).toHaveLength(1)
    expect(focuses()[0]).toMatchObject({ tabId: 't2', ids: ['answer-card'], opts: { mode: 'stay', reveal: true }, roundActive: false })
  })
})

describe('返回作废', () => {
  function pendingReturn() {
    setActive('p1', 't2')
    priv.ret = { origin: { tabId: 't1', view: 'score', vp: { zoom: 1, cx: 10, cy: 20, home: true } }, targetTab: 't2', focusedAt: 0, nextStarted: true }
    priv.expect = { tabId: 't2', view: 'canvas' }
    const p = priv.doReturn()
    // 同步切回原标签
    expect(priv.ret).toBeNull()
    expect(activeOf('p1')).toMatchObject({ active: 't1' })
    return p
  }

  it('切回原标签、等实例时停止跟随：不 setView / setViewport', async () => {
    const p = pendingReturn()
    useFollow.getState().stop()
    register(engine('t1', { mapId: 'O', view: 'canvas' }))
    await p
    expect(calls.filter((x) => x.op === 'setView' || x.op === 'setViewport')).toEqual([])
  })

  it('等实例时跟随移格：不还原视区', async () => {
    const p = pendingReturn()
    useFollow.getState().moveTo('p2')
    register(engine('t1', { mapId: 'O', view: 'canvas' }))
    await p
    expect(calls.filter((x) => x.op === 'setView' || x.op === 'setViewport')).toEqual([])
  })

  it('等实例时新的答案来了：不还原视区', async () => {
    useFollow.getState().setSettings({ hardOnly: true })
    const p = pendingReturn()
    priv.onMessage(end({ round_id: 'r9', grade: 'easy' }))
    register(engine('t1', { mapId: 'O', view: 'canvas' }))
    await p
    expect(calls.filter((x) => x.op === 'setViewport')).toEqual([])
  })

  it('等实例时用户动了原来那张图：不还原视区', async () => {
    const p = pendingReturn()
    emitViewportEvent({ tabId: 't1', view: 'score', vp: { zoom: 2, cx: 0, cy: 0 }, by: 'user' })
    register(engine('t1', { mapId: 'O', view: 'canvas' }))
    await p
    expect(calls.filter((x) => x.op === 'setView' || x.op === 'setViewport')).toEqual([])
  })

  it('正常情况：切回原视图、还原视区（对照）', async () => {
    const p = pendingReturn()
    register(engine('t1', { mapId: 'O', view: 'canvas' }))
    await p
    expect(calls.map((x) => x.op)).toEqual(['setView', 'setViewport'])
  })
})

describe('换方案：最新的 solo:state 说了算', () => {
  it('A → 请求 B 还没回来 → 又收到 A：B 不写入、不提示', async () => {
    let resolve: (v: MapSet | null) => void = () => {}
    const getSet = vi.spyOn(maplinkApi, 'getSet').mockImplementation(
      () =>
        new Promise<MapSet | null>((r) => {
          resolve = r
        }),
    )
    priv.onMessage(state('B'))
    expect(getSet).toHaveBeenCalledWith('plan:B')
    priv.onMessage(state('A'))
    resolve(mapSet('plan:B', ['B-map']))
    await flush()
    expect(useFollow.getState().planKey).toBe('plan:A')
    expect(useFollow.getState().mapIds).toEqual(['M'])
    expect(useFollowRuntime.getState().notice).toBeNull()
  })

  it('A → B → C：B 回来时不写入，C 回来才写', async () => {
    const pending: ((v: MapSet | null) => void)[] = []
    vi.spyOn(maplinkApi, 'getSet').mockImplementation(
      () =>
        new Promise<MapSet | null>((r) => {
          pending.push(r)
        }),
    )
    priv.onMessage(state('B'))
    priv.onMessage(state('C'))
    pending[0](mapSet('plan:B', ['B-map']))
    await flush()
    expect(useFollow.getState().planKey).toBe('plan:A')
    pending[1](mapSet('plan:C', ['C-map']))
    await flush()
    expect(useFollow.getState().planKey).toBe('plan:C')
    expect(useFollow.getState().mapIds).toEqual(['C-map'])
  })

  it('换方案作废进行中的跳转', async () => {
    vi.spyOn(maplinkApi, 'getSet').mockResolvedValue(mapSet('plan:B', ['M']))
    priv.onMessage(end())
    await flush()
    priv.onMessage(state('B'))
    await flush()
    register(engine())
    await flush()
    expect(focuses()).toEqual([])
  })

  const pre = (p: Partial<PreselectResult>) => ({ pool_total: 5, picked: [], covered: 0, maps: [], pool: [], no_map: 0, no_map_ids: [], skipped: [], errors: [], warnings: [], ...p }) as PreselectResult

  it('新方案没有图组：提示「还没有联动图组」，带「选图组」和「撤销」', async () => {
    vi.spyOn(maplinkApi, 'getSet').mockResolvedValue(null)
    vi.spyOn(maplinkApi, 'preselect').mockResolvedValue(pre({ no_map: 2 }))
    priv.onMessage(state('B'))
    await flush()
    expect(useFollowRuntime.getState().notice).toMatchObject({ text: '单人猜猜呗换了方案：方案『B』还没有联动图组', undo: true, panel: true })
  })

  it('预选说明题库里的人哪张图里都没有：才用「哪张图里都没有」这句提示', async () => {
    vi.spyOn(maplinkApi, 'getSet').mockResolvedValue(null)
    vi.spyOn(maplinkApi, 'preselect').mockResolvedValue(pre({ no_map: 5 }))
    priv.onMessage(state('B'))
    await flush()
    expect(useFollowRuntime.getState().notice?.text).toBe('单人猜猜呗换了方案『B』；它题库里的人哪张图里都没有，图组先空着')
  })

  it('新方案有图组：不带「选图组」', async () => {
    vi.spyOn(maplinkApi, 'getSet').mockResolvedValue(mapSet('plan:B', ['B-map']))
    priv.onMessage(state('B'))
    await flush()
    expect(useFollowRuntime.getState().notice).toMatchObject({ text: '单人猜猜呗换了方案『B』，已换用它的图组', undo: true, panel: false })
  })
})

describe('实例重挂（保活淘汰）后恢复当前有效的聚焦', () => {
  async function focusThenEvict(mode: 'stay' | 'flash', afterMs: number) {
    useFollow.getState().setSettings({ mode })
    const off = register(engine())
    priv.onMessage(end())
    await flush()
    expect(focuses()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(afterMs)
    off()
    calls.length = 0
    register(engine())
    return calls
  }

  it('停留：过了很久也恢复，reveal:false 不移动视区', async () => {
    const got = await focusThenEvict('stay', 10_000)
    expect(got).toEqual([expect.objectContaining({ op: 'focusWorks', ids: ['answer-card'], opts: { mode: 'stay', reveal: false, secondary: [] } })])
  })

  it('停留、下一题已经开始：照样恢复高亮，不移动视区', async () => {
    useFollow.getState().setSettings({ mode: 'stay' })
    const off = register(engine())
    priv.onMessage(end())
    await flush()
    priv.onMessage(start())
    off()
    calls.length = 0
    register(engine())
    expect(focuses()).toEqual([expect.objectContaining({ opts: expect.objectContaining({ mode: 'stay', reveal: false }), roundActive: true })])
  })

  it('闪烁闪完了（1.7 秒）重挂：不重放', async () => {
    const got = await focusThenEvict('flash', 1700)
    expect(got.filter((x) => x.op === 'focusWorks')).toEqual([])
  })

  it('闪烁没闪完重挂：按剩下的时间亮着，到点清掉，不从头重闪', async () => {
    const got = await focusThenEvict('flash', 500)
    expect(got).toEqual([expect.objectContaining({ op: 'focusWorks', opts: expect.objectContaining({ mode: 'stay', reveal: false }) })])
    await vi.advanceTimersByTimeAsync(FLASH_MS - 500 - 10)
    expect(calls.filter((x) => x.op === 'clearFocus')).toEqual([])
    await vi.advanceTimersByTimeAsync(20)
    expect(calls.filter((x) => x.op === 'clearFocus')).toHaveLength(1)
  })

  it('下一题的答案出来了（这次不跳）：上一题的高亮清掉，之后重挂不恢复', async () => {
    useFollow.getState().setSettings({ mode: 'stay', hardOnly: true })
    const off = register(engine())
    priv.onMessage(end())
    await flush()
    calls.length = 0
    priv.onMessage(end({ round_id: 'r2', grade: 'easy' }))
    expect(calls).toEqual([expect.objectContaining({ op: 'clearFocus', tabId: 't2' })])
    off()
    calls.length = 0
    register(engine())
    expect(focuses()).toEqual([])
  })

  it('停止跟随以后重挂：不恢复', async () => {
    const off = register(engine())
    priv.onMessage(end())
    await flush()
    useFollow.getState().stop()
    off()
    calls.length = 0
    register(engine())
    expect(focuses()).toEqual([])
  })

  it('别的标签的实例挂上：不碰', async () => {
    register(engine())
    priv.onMessage(end())
    await flush()
    calls.length = 0
    register(engine('t1', { mapId: 'O' }))
    expect(calls).toEqual([])
  })
})

describe('用户接管：只认引擎的 onFocusTakeover 回调', () => {
  /** 停留方式聚焦到 t2，返回 t2 的挂载参数（替引擎调回调用） */
  async function focusStay() {
    useFollow.getState().setSettings({ mode: 'stay' })
    const opts = mountOpts('t2')
    const off = register(engine())
    priv.onMessage(end())
    await flush()
    expect(focuses()).toHaveLength(1)
    return { opts, off }
  }
  function remount(off: () => void) {
    off()
    calls.length = 0
    register(engine())
    return focuses()
  }

  for (const reason of ['pin', 'esc'] as const) {
    it(`引擎回调 '${reason}'（点击固定了高亮 / 按 Esc，清掉了程序聚焦）：之后重挂不恢复`, async () => {
      const { opts, off } = await focusStay()
      opts.onFocusTakeover?.(reason)
      expect(remount(off)).toEqual([])
    })
  }

  it('焦点在 A、鼠标在 B 时按 Esc：引擎只给 B 回调，A 淘汰后重挂照样恢复', async () => {
    const { off } = await focusStay()
    register(engine('t3', { mapId: 'O2' }))
    mountOpts('t3').onFocusTakeover?.('esc')
    expect(remount(off)).toEqual([expect.objectContaining({ tabId: 't2', ids: ['answer-card'], opts: expect.objectContaining({ mode: 'stay', reveal: false }) })])
  })

  it('空格抓手模式下点标签：引擎吞掉点击、不回调，重挂照样恢复（宿主不在 DOM 上猜）', async () => {
    const { off } = await focusStay()
    // 什么回调都没有
    expect(remount(off)).toHaveLength(1)
  })

  it("返回方式：跳过去以后用户点击固定了高亮（'pin'）= 接管，下一题开始不再切回去", async () => {
    useFollow.getState().setSettings({ mode: 'return' })
    const opts = mountOpts('t2')
    register(engine())
    register(engine('t1', { mapId: 'O', view: 'score' }))
    priv.onMessage(end())
    await flush()
    expect(activeOf('p1')).toMatchObject({ active: 't2' })
    expect(priv.ret).not.toBeNull()
    opts.onFocusTakeover?.('pin')
    expect(priv.ret).toBeNull()
    priv.onMessage(start())
    await vi.advanceTimersByTimeAsync(30_000)
    expect(activeOf('p1')).toMatchObject({ active: 't2' })
    expect(calls.filter((x) => x.op === 'setViewport')).toEqual([])
  })
})
