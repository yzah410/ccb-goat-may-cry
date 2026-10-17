/**
 * 单人猜猜呗的对局状态（接口全部 mock）：建会话 / 重建、猜测 / 重复、超时、结算后改评级（串行）、选不出题、过期响应丢弃、头像预取。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SoloApiModule from './api'

vi.mock('@/components/ui/Toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}))
const avatarRequest = vi.hoisted(() => vi.fn())
vi.mock('@/features/candidates/avatar', () => ({
  useAvatarStore: { getState: () => ({ request: avatarRequest }) },
}))
vi.mock('./api', async (importOriginal) => {
  const real = await importOriginal<typeof SoloApiModule>()
  return {
    ...real,
    soloApi: {
      createSession: vi.fn(),
      startRound: vi.fn(),
      guess: vi.fn(),
      timeout: vi.fn(),
      surrender: vi.fn(),
      regrade: vi.fn(),
      bgmSearch: vi.fn(),
      workCharacters: vi.fn(),
    },
  }
})

import { ApiError } from '@/lib/apiClient'
import { toast } from '@/components/ui/Toast'
import { defaultSpec } from '@/features/workbench2/spec'
import { soloApi, type EndBlock, type GuessRow, type Progress, type RoundStarted, type SessionResp, type Status } from './api'
import { PREFETCH_AVATARS_MAX, prefetchAvatars, useSoloGame } from './game'
import { pendingChanges, SOLO_DEFAULTS, useSoloSettings } from './settings'
import { handOffToNewTab, useSoloHandoff } from './handoff'

const api = vi.mocked(soloApi)
const spec = defaultSpec(new Date(2026, 9, 13))

const PROGRESS: Progress = { total: 10, segments: [], parts: [], stable_gap: null, saturated: false, events: [], session_delta: 0 }
const status = (p: Partial<Status> = {}): Status => ({ rows: 0, misses: 0, forgiven: 0, counted: 0, again_locked: false, limit: 3, ...p })
const session = (id = 's1'): SessionResp => ({
  session_id: id,
  mode: 'anime',
  practice: 'work',
  plan_name: null,
  pool_total: 3,
  pool_ids: [1, 2, 3],
  default_subject_tag_num: 6,
  new_every: 4,
  errors: [],
  warnings: [],
  progress: PROGRESS,
})
const round = (id = 'r1', p: Partial<RoundStarted> = {}): RoundStarted => ({
  round_id: id,
  round_no: 1,
  subject_tag_num: 6,
  character_tag_num: 0,
  good_sec: 10,
  time_limit_sec: null,
  status: status(),
  progress: PROGRESS,
  ...p,
})
const row = (id: number, p: Partial<GuessRow> = {}): GuessRow => ({
  seq: 1,
  kind: 'guess',
  t_offset: 1,
  guess_id: id,
  name: `角色${id}`,
  feedback: {} as GuessRow['feedback'],
  hit: false,
  exact: false,
  forgiven: false,
  ...p,
})
const end = (p: Partial<EndBlock> = {}): EndBlock => ({
  round_id: 'r1',
  answer_id: 9,
  answer_name: '答案',
  card: {} as EndBlock['card'],
  grade_auto: 'good',
  grade: 'good',
  ended_by: 'exact',
  again_locked: false,
  hit_seq: 1,
  rows: 1,
  misses: 0,
  forgiven: 0,
  timing: { intervals: [], avg_sec: null, good_sec: 10 },
  why: 'new',
  why_label: '新角色',
  gap_rounds: null,
  gap_sec: null,
  prev_grade: null,
  next_gap: 3,
  progress: PROGRESS,
  ...p,
})
const httpErr = (status: number, code: string) =>
  new ApiError({ kind: 'http', status, path: '/v2/solo/x', message: code, detail: { ok: false, error: code, message: code } })

const G = () => useSoloGame.getState()

/** 建会话 + 开第一局 */
async function begin(r: RoundStarted = round()) {
  api.createSession.mockResolvedValueOnce(session())
  api.startRound.mockResolvedValueOnce(r)
  await G().ensureSession(spec, null, 4)
}

/** 第一局猜中结束（自动评级 grade） */
async function finishRound(grade: EndBlock['grade'] = 'good') {
  api.guess.mockResolvedValueOnce({ row: row(9, { hit: true, exact: true }), status: status({ rows: 1 }), end: end({ grade, grade_auto: grade }) })
  await G().guess(9)
}

beforeEach(() => {
  vi.clearAllMocks()
  G().reset()
  useSoloSettings.setState({ ...SOLO_DEFAULTS })
})

describe('会话', () => {
  it('建会话（带 new_every）后自动开第一局；同一个方案不重建；改保底就重建', async () => {
    await begin()
    expect(api.createSession).toHaveBeenCalledTimes(1)
    expect(api.createSession.mock.calls[0]![0]).toMatchObject({ spec, plan_name: null, practice: 'work', new_every: 4 })
    expect(api.startRound.mock.calls[0]![0]).toMatchObject({ session_id: 's1', subject_tag_num: 6, time_limit_sec: null })
    expect(G().phase).toBe('playing')
    expect(G().round?.round_id).toBe('r1')

    await G().ensureSession(spec, null, 4)
    expect(api.createSession).toHaveBeenCalledTimes(1)

    api.createSession.mockResolvedValueOnce(session('s2'))
    api.startRound.mockResolvedValueOnce(round('r2'))
    await G().ensureSession(spec, null, 99)
    expect(api.createSession).toHaveBeenCalledTimes(2)
    expect(api.createSession.mock.calls[1]![0].new_every).toBe(10)
    expect(G().session?.session_id).toBe('s2')
  })

  it('建会话失败（题库空）：停在错误态，没有会话', async () => {
    api.createSession.mockRejectedValueOnce(httpErr(400, 'empty_pool'))
    await G().ensureSession(spec, null, 4)
    expect(G().phase).toBe('error')
    expect(G().session).toBeNull()
    expect(api.startRound).not.toHaveBeenCalled()
  })

  it('换方案时旧会话的响应晚到：丢掉，不覆盖新的', async () => {
    let resolveOld!: (s: SessionResp) => void
    api.createSession.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)))
    const old = G().ensureSession(spec, 'old', 4)
    api.createSession.mockResolvedValueOnce(session('new'))
    api.startRound.mockResolvedValueOnce(round('r-new'))
    await G().ensureSession(spec, 'new', 4)
    resolveOld(session('old'))
    await old
    expect(G().session?.session_id).toBe('new')
    expect(G().round?.round_id).toBe('r-new')
    expect(api.startRound).toHaveBeenCalledTimes(1)
  })

  it('后端重启过（session_not_found）：重建会话再开局，提示一句', async () => {
    await begin()
    api.startRound.mockRejectedValueOnce(httpErr(404, 'session_not_found')).mockResolvedValueOnce(round('r2'))
    api.createSession.mockResolvedValueOnce(session('s2'))
    await G().startRound()
    expect(api.createSession).toHaveBeenCalledTimes(2)
    expect(G().session?.session_id).toBe('s2')
    expect(G().phase).toBe('playing')
    expect(G().round?.round_id).toBe('r2')
    expect(toast.info).toHaveBeenCalled()
  })

  it('猜的时候发现会话没了：同样重建 + 开新局', async () => {
    await begin()
    api.guess.mockRejectedValueOnce(httpErr(404, 'session_not_found'))
    api.createSession.mockResolvedValueOnce(session('s2'))
    api.startRound.mockResolvedValueOnce(round('r2'))
    expect(await G().guess(5)).toBe('error')
    expect(G().session?.session_id).toBe('s2')
    expect(G().round?.round_id).toBe('r2')
    expect(G().rows).toEqual([])
  })

  it('选不出题（round_id = null）：进 parked，带上原因', async () => {
    api.createSession.mockResolvedValueOnce(session())
    api.startRound.mockResolvedValueOnce({ round_id: null, reason: '都练过了', progress: PROGRESS })
    await G().ensureSession(spec, null, 4)
    expect(G().phase).toBe('parked')
    expect(G().parkedReason).toBe('都练过了')
    expect(G().round).toBeNull()
  })
})

describe('猜测', () => {
  it('同一个角色可以重复猜：照常发请求、加一行、计入次数', async () => {
    await begin()
    api.guess.mockResolvedValueOnce({ row: row(5), status: status({ rows: 1, misses: 1, counted: 1 }), end: null })
    expect(await G().guess(5)).toBe('ok')
    expect(G().rows).toHaveLength(1)
    expect(G().status?.misses).toBe(1)

    api.guess.mockResolvedValueOnce({ row: row(5, { seq: 2 }), status: status({ rows: 2, misses: 2, counted: 2 }), end: null })
    expect(await G().guess(5)).toBe('ok')
    expect(api.guess).toHaveBeenCalledTimes(2)
    expect(G().rows).toHaveLength(2)
    expect(G().status?.misses).toBe(2)
    expect(G().busy).toBe(false)
  })

  it('猜中：进结算，默认选中自动评级，记下「上一局」（带计时）；结算后再猜不发请求', async () => {
    await begin()
    await finishRound('hard')
    expect(G().phase).toBe('ended')
    expect(G().chosen).toBe('hard')
    expect(G().last).toMatchObject({ round_id: 'r1', name: '答案', grade: 'hard', grade_auto: 'hard', timing: '第 1 次就猜中，不计时' })
    expect(await G().guess(10)).toBe('ignored')
    expect(api.guess).toHaveBeenCalledTimes(1)
  })

  it('结束块到手：答案的头像插到队首（答案已公布，不算泄露）', async () => {
    await begin()
    avatarRequest.mockClear()
    await finishRound('good')
    expect(avatarRequest).toHaveBeenCalledWith(9, { front: true })
  })
})

describe('超时', () => {
  it('不限时的局不发请求', async () => {
    await begin()
    await G().timeout()
    expect(api.timeout).not.toHaveBeenCalled()
  })

  it('到点：表格加一行「超时」，重新计时', async () => {
    await begin(round('r1', { time_limit_sec: 20 }))
    const before = G().lastRowAt
    api.timeout.mockResolvedValueOnce({ row: { seq: 1, kind: 'timeout', t_offset: 20, hit: false, forgiven: false }, status: status({ rows: 1, misses: 1, counted: 1 }), end: null })
    await G().timeout()
    expect(G().rows.map((r) => r.kind)).toEqual(['timeout'])
    expect(G().lastRowAt).toBeGreaterThanOrEqual(before)
  })

  it('后端说还没到点（too_early）：不加行，大约 1 秒后再报', async () => {
    await begin(round('r1', { time_limit_sec: 20 }))
    api.timeout.mockRejectedValueOnce(httpErr(409, 'too_early'))
    await G().timeout()
    expect(G().rows).toEqual([])
    const left = G().lastRowAt + 20_000 - Date.now()
    expect(left).toBeGreaterThan(0)
    expect(left).toBeLessThanOrEqual(1000)
  })
})

describe('结算后的评级', () => {
  it('手动结算：←/→ 到头停住', async () => {
    await begin()
    await finishRound('good')
    G().stepChosen(-1)
    G().stepChosen(-1)
    expect(G().chosen).toBe('easy')
    for (let i = 0; i < 5; i++) G().stepChosen(1)
    expect(G().chosen).toBe('again')
  })

  it('选的和自动评级不一样：先 regrade 再开下一局；一样就不 regrade', async () => {
    await begin()
    await finishRound('good')
    G().choose('easy')
    api.regrade.mockResolvedValueOnce({ round_id: 'r1', grade: 'easy', grade_auto: 'good', next_gap: 8, progress: PROGRESS })
    api.startRound.mockResolvedValueOnce(round('r2', { round_no: 2 }))
    await G().confirmNext()
    expect(api.regrade).toHaveBeenCalledWith('s1', 'r1', 'easy')
    expect(api.regrade.mock.invocationCallOrder[0]!).toBeLessThan(api.startRound.mock.invocationCallOrder[1]!)
    expect(G().phase).toBe('playing')
    expect(G().round?.round_id).toBe('r2')
    expect(G().last).toMatchObject({ round_id: 'r1', grade: 'easy', next_gap: 8, saving: false })

    api.guess.mockResolvedValueOnce({ row: row(9, { hit: true }), status: status({ rows: 1 }), end: end({ round_id: 'r2' }) })
    await G().guess(9)
    api.startRound.mockResolvedValueOnce(round('r3'))
    await G().confirmNext()
    expect(api.regrade).toHaveBeenCalledTimes(1)
    expect(G().round?.round_id).toBe('r3')
  })

  it('点评级按钮 = 选这个评级并开下一局', async () => {
    await begin()
    await finishRound('good')
    api.regrade.mockResolvedValueOnce({ round_id: 'r1', grade: 'again', grade_auto: 'good', next_gap: 1, progress: PROGRESS })
    api.startRound.mockResolvedValueOnce(round('r2'))
    await G().confirmNext('again')
    expect(api.regrade).toHaveBeenCalledWith('s1', 'r1', 'again')
    expect(G().round?.round_id).toBe('r2')
  })

  it('改上一局失败（not_last_round）：评级退回原样，提示一句', async () => {
    await begin()
    await finishRound('good')
    api.regrade.mockRejectedValueOnce(httpErr(409, 'not_last_round'))
    expect(await G().regradeLast('hard')).toBe(false)
    expect(G().last).toMatchObject({ grade: 'good', saving: false })
    expect(toast.warning).toHaveBeenCalled()
  })

  it('改上一局成功：同时更新结算卡片上的评级', async () => {
    await begin()
    await finishRound('good')
    api.regrade.mockResolvedValueOnce({ round_id: 'r1', grade: 'hard', grade_auto: 'good', next_gap: 2, progress: PROGRESS })
    expect(await G().regradeLast('hard')).toBe(true)
    expect(G().last).toMatchObject({ grade: 'hard', next_gap: 2, saving: false })
    expect(G().end).toMatchObject({ grade: 'hard', next_gap: 2 })
  })
})

describe('改上一局评级：串行', () => {
  const regradeResp = (grade: EndBlock['grade'], next_gap = 3) => ({ round_id: 'r1', grade, grade_auto: 'good' as const, next_gap, progress: PROGRESS })

  it('连按（Alt+1 → Alt+3 → Alt+4）：在途时只记最新目标，回来后不一样再发一次，一共 2 个请求', async () => {
    await begin()
    await finishRound('good')
    let first!: (v: ReturnType<typeof regradeResp>) => void
    api.regrade.mockImplementationOnce(() => new Promise((res) => (first = res)))
    api.regrade.mockResolvedValueOnce(regradeResp('again', 1))
    const p1 = G().regradeLast('easy')
    await vi.waitFor(() => expect(api.regrade).toHaveBeenCalledTimes(1))
    const p2 = G().regradeLast('hard')
    const p3 = G().regradeLast('again')
    expect(api.regrade).toHaveBeenCalledTimes(1) // 第一个还没回来，不并发
    expect(G().last).toMatchObject({ grade: 'again', saving: true })
    first(regradeResp('easy', 9))
    expect(await p3).toBe(true)
    expect(await p1).toBe(true)
    expect(await p2).toBe(true)
    expect(api.regrade.mock.calls.map((c) => c[2])).toEqual(['easy', 'again'])
    expect(G().last).toMatchObject({ grade: 'again', next_gap: 1, saving: false })
    expect(G().end).toMatchObject({ grade: 'again', next_gap: 1 })
    expect(G().chosen).toBe('again')
  })

  it('连按后又按回原来那个：第一个回来后照样再发一次，最后落在原来的评级', async () => {
    await begin()
    await finishRound('good')
    let first!: (v: ReturnType<typeof regradeResp>) => void
    api.regrade.mockImplementationOnce(() => new Promise((res) => (first = res)))
    api.regrade.mockResolvedValueOnce(regradeResp('good', 3))
    const p = G().regradeLast('hard')
    await vi.waitFor(() => expect(api.regrade).toHaveBeenCalledTimes(1))
    void G().regradeLast('good')
    first(regradeResp('hard', 2))
    expect(await p).toBe(true)
    expect(api.regrade.mock.calls.map((c) => c[2])).toEqual(['hard', 'good'])
    expect(G().last).toMatchObject({ grade: 'good', saving: false })
  })

  it('后一个请求失败：退回后端最后记下的评级', async () => {
    await begin()
    await finishRound('good')
    let first!: (v: ReturnType<typeof regradeResp>) => void
    api.regrade.mockImplementationOnce(() => new Promise((res) => (first = res)))
    api.regrade.mockRejectedValueOnce(httpErr(500, 'internal'))
    const p = G().regradeLast('easy')
    await vi.waitFor(() => expect(api.regrade).toHaveBeenCalledTimes(1))
    void G().regradeLast('again')
    first(regradeResp('easy', 9))
    expect(await p).toBe(false)
    expect(G().last).toMatchObject({ grade: 'easy', saving: false })
    expect(G().end).toMatchObject({ grade: 'easy' })
    expect(toast.error).toHaveBeenCalled()
  })

  it('自动模式：改上一局的请求还在路上时到点开下一局 → 等它回来再开局，不重复发', async () => {
    await begin()
    await finishRound('again')
    let first!: (v: ReturnType<typeof regradeResp>) => void
    api.regrade.mockImplementationOnce(() => new Promise((res) => (first = res)))
    void G().regradeLast('good')
    await vi.waitFor(() => expect(api.regrade).toHaveBeenCalledTimes(1))
    expect(G().chosen).toBe('good')
    api.startRound.mockResolvedValueOnce(round('r2'))
    const next = G().confirmNext()
    await Promise.resolve()
    expect(api.startRound).toHaveBeenCalledTimes(1) // 只有第一局那次
    first(regradeResp('good'))
    await next
    expect(api.regrade).toHaveBeenCalledTimes(1)
    expect(api.startRound).toHaveBeenCalledTimes(2)
    expect(api.regrade.mock.invocationCallOrder[0]!).toBeLessThan(api.startRound.mock.invocationCallOrder[1]!)
    expect(G().round?.round_id).toBe('r2')
  })

  it('手动结算里 ←/→ 改了评级、没按 Enter 就切到自动：commitChosen 先提交，之后开局不再重复 regrade', async () => {
    await begin()
    await finishRound('good')
    G().stepChosen(1) // Good → Hard
    api.regrade.mockResolvedValueOnce(regradeResp('hard', 2))
    expect(await G().commitChosen()).toBe(true)
    expect(api.regrade).toHaveBeenCalledWith('s1', 'r1', 'hard')
    expect(G().last).toMatchObject({ grade: 'hard', saving: false })
    api.startRound.mockResolvedValueOnce(round('r2'))
    await G().confirmNext()
    expect(api.regrade).toHaveBeenCalledTimes(1)
    expect(G().round?.round_id).toBe('r2')
  })

  it('没改评级时 commitChosen 什么都不发', async () => {
    await begin()
    await finishRound('good')
    expect(await G().commitChosen()).toBe(true)
    expect(api.regrade).not.toHaveBeenCalled()
  })
})

describe('从作品里选（via）和加时', () => {
  it('猜测带上 via：从作品的角色列表里选的发 work，默认 name', async () => {
    await begin()
    api.guess.mockResolvedValueOnce({ row: row(5, { via: 'work' }), status: status({ rows: 1, misses: 1, counted: 1 }), end: null })
    expect(await G().guess(5, 'work')).toBe('ok')
    expect(api.guess).toHaveBeenLastCalledWith('s1', 'r1', 5, 'work')
    expect(G().rows[0]).toMatchObject({ guess_id: 5, via: 'work' })

    api.guess.mockResolvedValueOnce({ row: row(6, { seq: 2, via: 'name' }), status: status({ rows: 2, misses: 2, counted: 2 }), end: null })
    expect(await G().guess(6)).toBe('ok')
    expect(api.guess).toHaveBeenLastCalledWith('s1', 'r1', 6, 'name')
    expect(G().rows[1]).toMatchObject({ guess_id: 6, via: 'name' })
  })

  it('开局带上 work_bonus_sec（设置里的值）；「下一局生效」的提示拿后端回显的值比', async () => {
    useSoloSettings.setState({ workBonusSec: 3.5 })
    await begin(round('r1', { work_bonus_sec: 3.5 }))
    expect(api.startRound.mock.calls[0]![0]).toMatchObject({ session_id: 's1', work_bonus_sec: 3.5 })
    expect(G().round?.work_bonus_sec).toBe(3.5)
    expect(pendingChanges(useSoloSettings.getState(), G().round, 6)).toEqual([])
    useSoloSettings.setState({ workBonusSec: 5 })
    expect(pendingChanges(useSoloSettings.getState(), G().round, 6)).toEqual(['从作品里选的加时'])
  })
})

describe('在新标签页打开', () => {
  beforeEach(() => useSoloHandoff.getState().setAway(false))

  it('点了之后：这一页丢掉会话和这一局、换成提示卡片；手动结算里选了还没确认的评级照样交上去', async () => {
    await begin()
    await finishRound('good')
    G().stepChosen(1) // Good → Hard，还没按 Enter
    api.regrade.mockResolvedValueOnce({ round_id: 'r1', grade: 'hard', grade_auto: 'good', next_gap: 2, progress: PROGRESS })
    handOffToNewTab()
    expect(useSoloHandoff.getState().away).toBe(true)
    expect(G().phase).toBe('idle')
    expect(G().session).toBeNull()
    expect(G().round).toBeNull()
    await vi.waitFor(() => expect(api.regrade).toHaveBeenCalledWith('s1', 'r1', 'hard'))
  })

  it('没有要交的评级：不发 regrade；之后「在这里继续玩」= 重新建会话、出新的一题', async () => {
    await begin()
    handOffToNewTab()
    await Promise.resolve()
    expect(api.regrade).not.toHaveBeenCalled()
    expect(G().phase).toBe('idle')

    useSoloHandoff.getState().setAway(false)
    api.createSession.mockResolvedValueOnce(session('s2'))
    api.startRound.mockResolvedValueOnce(round('r2'))
    await G().ensureSession(spec, null, 4)
    expect(api.createSession).toHaveBeenCalledTimes(2)
    expect(G().round?.round_id).toBe('r2')
  })
})

describe('题库头像预取', () => {
  it(`最多预取 ${PREFETCH_AVATARS_MAX} 个，跳过不是整数的 id`, () => {
    avatarRequest.mockClear()
    const ids = [Number.NaN, 1.5, ...Array.from({ length: 2000 }, (_, i) => i + 1)]
    prefetchAvatars(ids)
    expect(PREFETCH_AVATARS_MAX).toBe(1500)
    expect(avatarRequest).toHaveBeenCalledTimes(1500)
    expect(avatarRequest.mock.calls[0]![0]).toBe(1)
    expect(avatarRequest.mock.calls[1499]![0]).toBe(1500)
  })
})
