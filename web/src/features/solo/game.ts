/**
 * 单人猜猜呗的对局状态（不存浏览器：进度在后端 data/solo_v2/，会话在后端内存里）。
 *
 * 流程：ensureSession(方案) → 建会话 → 自动开第一局 → guess / timeout / surrender → 结束块 →
 *   手动模式：confirmNext()（选的评级和后端记的不一样就先 regrade）→ 下一局
 *   自动模式：页面停 N 秒后调 startRound()；上一局的评级随时可以 regradeLast()
 * 后端重启后会话没了（404 session_not_found）：自动重建会话、重新开一局（进行中的那一局作废）。
 * 换方案 / 改新角色保底 = 会话身份变了，重建会话。
 */
import { create } from 'zustand'
import { errorText } from '@/lib/apiClient'
import { toast } from '@/components/ui/Toast'
import { useAvatarStore } from '@/features/candidates/avatar'
import type { SpecV2 } from '@/features/v2/types'
import {
  isAllParked,
  normalizeProgress,
  soloApi,
  soloErrorCode,
  type EndBlock,
  type Grade,
  type GuessVia,
  type Progress,
  type RoundStarted,
  type Row,
  type SessionResp,
  type Status,
} from './api'
import { needsRegrade, stepGrade } from './grades'
import { nameLines, timingLine } from './view'
import { buildStartBody, clampInt, LIMITS, sessionKeyOf, useSoloSettings } from './settings'

export type Phase = 'idle' | 'creating' | 'starting' | 'playing' | 'ended' | 'parked' | 'error'

export interface SessionSource {
  spec: SpecV2
  planName: string | null
  newEvery: number
  key: string
}

/** 最近结束的那一局（自动模式右上角「上一局」、改评级用） */
export interface LastRound {
  round_id: string
  name: string
  grade: Grade
  grade_auto: Grade
  next_gap: number | null
  /** 这局的计时，一行（「上一局」悬停说明里显示） */
  timing: string
  /** 正在改（请求还没回来） */
  saving: boolean
}

export interface GameState {
  phase: Phase
  error: unknown
  source: SessionSource | null
  session: SessionResp | null
  round: RoundStarted | null
  rows: Row[]
  status: Status | null
  end: EndBlock | null
  /** 结算时要记的评级（默认 = 自动评级）：手动模式 ←/→ 选的；自动模式里随「上一局」的改动同步 */
  chosen: Grade | null
  last: LastRound | null
  progress: Progress | null
  /** 开局或上一行的时间（Date.now()）：倒计时从这里算 */
  lastRowAt: number
  /** 猜测 / 超时 / 投降 / 开下一局 的请求正在进行 */
  busy: boolean
  parkedReason: string | null

  ensureSession: (spec: SpecV2, planName: string | null, newEvery: number) => Promise<void>
  /** 重建会话（出错后「再试一次」） */
  restartSession: () => Promise<void>
  startRound: () => Promise<void>
  /**
   * 同一个角色可以重复猜（不拦），照常加一行、计入次数。
   * via：从作品的角色列表里选的 = 'work'（分界多给秒数），其余 = 'name'
   */
  guess: (id: number, via?: GuessVia) => Promise<'ok' | 'ignored' | 'error'>
  timeout: () => Promise<void>
  surrender: () => Promise<void>
  choose: (g: Grade) => void
  stepChosen: (dir: -1 | 1) => void
  /** 手动模式：确认评级、开下一局 */
  confirmNext: (grade?: Grade) => Promise<void>
  /**
   * 改最近结束那一局的评级。串行：前一个请求在路上时只记住最新的目标，回来后和最新目标不一样再发一次
   * （连按 Alt+1、Alt+4 最多发 2 个请求，最后落在 Alt+4）。返回最终有没有改成。
   */
  regradeLast: (g: Grade) => Promise<boolean>
  /** 手动结算里用 ←/→ 选了评级还没确认就切到自动模式：先把选的评级提交 */
  commitChosen: () => Promise<boolean>
  /** 丢掉会话和这一局（不发请求）：测试用；页面点了「在新标签页打开」后也用它，免得这边的倒计时继续走 */
  reset: () => void
}

const INITIAL = {
  phase: 'idle' as Phase,
  error: null as unknown,
  source: null,
  session: null,
  round: null,
  rows: [] as Row[],
  status: null,
  end: null,
  chosen: null,
  last: null,
  progress: null,
  lastRowAt: 0,
  busy: false,
  parkedReason: null,
}

/** 每次换会话 +1：旧会话的请求回来时对不上就丢掉 */
let gen = 0

/** 正在进行的改评级（同一时间只有一个请求在路上）；target = 最新想改成的评级 */
interface RegradeJob {
  rid: string
  target: Grade
  done: Promise<boolean>
}
let regrading: RegradeJob | null = null

/**
 * 题库头像最多预取这么多个：头像缓存最多 3000 条（avatar.ts），题库太大时全排进去会把别处的缓存顶掉，
 * 而且按 2 次/秒要请求 Bangumi 很久。没预取到的，表格和搜索下拉显示时会插队请求。
 */
export const PREFETCH_AVATARS_MAX = 1500

/** 会话建好后把题库里还没缓存的头像排队补齐（avatar.ts 自己会跳过已缓存的、排队中的） */
export function prefetchAvatars(ids: readonly number[]): void {
  const req = useAvatarStore.getState().request
  let n = 0
  for (const id of ids) {
    if (n >= PREFETCH_AVATARS_MAX) break
    if (!Number.isInteger(id)) continue
    req(id)
    n++
  }
}

export const useSoloGame = create<GameState>()((set, get) => {
  const progressOr = (raw: unknown) => normalizeProgress(raw) ?? get().progress

  const createFor = async (src: SessionSource, my: number): Promise<boolean> => {
    try {
      const r = await soloApi.createSession({
        spec: src.spec,
        plan_name: src.planName,
        practice: 'work',
        new_every: clampInt(src.newEvery, LIMITS.newEvery.min, LIMITS.newEvery.max),
      })
      if (my !== gen) return false
      set({ session: r, progress: normalizeProgress(r.progress), last: null })
      prefetchAvatars(r.pool_ids ?? [])
      return true
    } catch (e) {
      if (my === gen) set({ phase: 'error', error: e, busy: false })
      return false
    }
  }

  /** 后端重启过（session_not_found）：同一个方案重建会话。成功 → true */
  const rebuild = async (): Promise<boolean> => {
    const src = get().source
    if (!src) return false
    const ok = await createFor(src, gen)
    if (ok) toast.info('后端重启过，已经重新连上', { description: '进行中的那一局作废了，重新出一题。进度存在后端，没有丢。', id: 'solo-rebuild' })
    return ok
  }

  const finish = (end: EndBlock) => {
    // 答案已经公布了：它的头像插到队首（结算卡片马上要用），不用等后台预取排完
    if (Number.isInteger(end.answer_id)) useAvatarStore.getState().request(end.answer_id, { front: true })
    set({
      phase: 'ended',
      end,
      chosen: end.grade,
      busy: false,
      progress: progressOr(end.progress),
      last: {
        round_id: end.round_id,
        name: nameLines({ name: end.answer_name, name_original: end.name_original, name_cn: end.name_cn }).main,
        grade: end.grade,
        grade_auto: end.grade_auto,
        next_gap: end.next_gap,
        timing: timingLine(end),
        saving: false,
      },
    })
  }

  /** 把 rid 那一局的「上一局」评级、结算时要记的评级显示成 g（只改界面） */
  const showGrade = (rid: string, g: Grade, saving: boolean) =>
    set((s) => ({
      last: s.last?.round_id === rid ? { ...s.last, grade: g, saving } : s.last,
      chosen: s.end?.round_id === rid ? g : s.chosen,
    }))

  /** 一个改评级任务：一直发到后端记的 = 最新目标，或者出错为止 */
  const runRegrade = async (sessionId: string, job: RegradeJob, before: Grade): Promise<boolean> => {
    const rid = job.rid
    let confirmed = before
    try {
      while (job.target !== confirmed) {
        const r = await soloApi.regrade(sessionId, rid, job.target)
        confirmed = r.grade
        const latest = job.target
        set((s) => ({
          last: s.last?.round_id === rid ? { ...s.last, grade: latest, grade_auto: r.grade_auto, next_gap: r.next_gap, saving: latest !== r.grade } : s.last,
          end: s.end?.round_id === rid ? { ...s.end, grade: r.grade, next_gap: r.next_gap } : s.end,
          progress: normalizeProgress(r.progress) ?? s.progress,
        }))
      }
      showGrade(rid, confirmed, false)
      return true
    } catch (e) {
      showGrade(rid, confirmed, false)
      const code = soloErrorCode(e)
      if (code === 'not_last_round') toast.warning('只能改刚结束的那一局', { id: 'solo-regrade' })
      else if (code === 'char_reappeared') toast.warning('这个角色之后又出过题，上一局的评级不能再改了', { id: 'solo-regrade' })
      else if (code === 'session_not_found') {
        set({ last: null })
        toast.warning('后端重启过，上一局的评级改不了了', { id: 'solo-regrade' })
      } else toast.error('评级没改成', { description: errorText(e), id: 'solo-regrade' })
      return false
    } finally {
      if (regrading === job) regrading = null
    }
  }

  /** 通用错误处理：会话丢了 → 重建 + 开新局；这一局在别处被作废 → 开新局。处理掉了返回 true */
  const recover = async (e: unknown): Promise<boolean> => {
    const code = soloErrorCode(e)
    if (code === 'session_not_found') {
      if (await rebuild()) await startRoundInner(true)
      return true
    }
    if (code === 'round_not_active') {
      toast.warning('这一局已经不能继续了', { description: '可能在别的页面开了新的一局。重新出一题。', id: 'solo-inactive' })
      await startRoundInner(false)
      return true
    }
    return false
  }

  const startRoundInner = async (retried: boolean): Promise<void> => {
    const session = get().session
    if (!session) return
    const my = gen
    set({ phase: 'starting', busy: true })
    try {
      const body = buildStartBody(useSoloSettings.getState(), session)
      const r = await soloApi.startRound(body)
      if (my !== gen) return
      if (isAllParked(r)) {
        set({ phase: 'parked', round: null, rows: [], status: null, end: null, chosen: null, busy: false, parkedReason: r.reason ?? null, progress: progressOr(r.progress) })
        return
      }
      set({
        phase: 'playing',
        round: r,
        rows: [],
        status: r.status,
        end: null,
        chosen: null,
        busy: false,
        parkedReason: null,
        lastRowAt: Date.now(),
        progress: progressOr(r.progress),
      })
    } catch (e) {
      if (my !== gen) return
      if (!retried && soloErrorCode(e) === 'session_not_found' && (await rebuild())) return startRoundInner(true)
      set({ phase: 'error', error: e, busy: false })
    }
  }

  return {
    ...INITIAL,

    ensureSession: async (spec, planName, newEvery) => {
      const key = sessionKeyOf(spec, planName, newEvery)
      const s = get()
      if (s.source?.key === key && s.phase !== 'idle') return
      const my = ++gen
      const src: SessionSource = { spec, planName, newEvery, key }
      set({ ...INITIAL, source: src, phase: 'creating' })
      if (await createFor(src, my)) await startRoundInner(false)
    },

    restartSession: async () => {
      const src = get().source
      if (!src) return
      const my = ++gen
      set({ ...INITIAL, source: src, phase: 'creating' })
      if (await createFor(src, my)) await startRoundInner(false)
    },

    startRound: () => startRoundInner(false),

    guess: async (id, via = 'name') => {
      const { session, round, phase, busy } = get()
      if (!session || !round || phase !== 'playing' || busy) return 'ignored'
      const my = gen
      set({ busy: true })
      try {
        const r = await soloApi.guess(session.session_id, round.round_id, id, via)
        if (my !== gen || get().round?.round_id !== round.round_id) return 'ignored'
        set((s) => ({ rows: [...s.rows, r.row], status: r.status, lastRowAt: Date.now(), busy: false }))
        if (r.end) finish(r.end)
        return 'ok'
      } catch (e) {
        if (my !== gen) return 'ignored'
        set({ busy: false })
        if (await recover(e)) return 'error'
        if (soloErrorCode(e) === 'not_found') toast.error('本地库里没有这个角色', { description: errorText(e), id: 'solo-guess' })
        else toast.error('没猜成', { description: errorText(e), id: 'solo-guess' })
        return 'error'
      }
    },

    timeout: async () => {
      const { session, round, phase, busy } = get()
      if (!session || !round || phase !== 'playing' || round.time_limit_sec == null) return
      if (busy) {
        // 正好有一次猜测在路上：等它回来再看（猜测成功会加一行、重新计时；失败了就补报超时）
        const rid = round.round_id
        setTimeout(() => {
          const s = get()
          if (s.round?.round_id !== rid || s.phase !== 'playing') return
          if (Date.now() >= s.lastRowAt + (round.time_limit_sec ?? 0) * 1000) void get().timeout()
        }, 500)
        return
      }
      const my = gen
      set({ busy: true })
      try {
        const r = await soloApi.timeout(session.session_id, round.round_id)
        if (my !== gen || get().round?.round_id !== round.round_id) return
        set((s) => ({ rows: [...s.rows, r.row], status: r.status, lastRowAt: Date.now(), busy: false }))
        if (r.end) finish(r.end)
      } catch (e) {
        if (my !== gen) return
        set({ busy: false })
        const code = soloErrorCode(e)
        if (code === 'too_early') {
          // 后端觉得还没到点（两边时钟差一点）：1 秒后再报一次
          const limitMs = (round.time_limit_sec ?? 0) * 1000
          set({ lastRowAt: Date.now() - Math.max(0, limitMs - 1000) })
          return
        }
        if (code === 'no_time_limit') return
        if (await recover(e)) return
        toast.error('超时没记上', { description: errorText(e), id: 'solo-timeout' })
      }
    },

    surrender: async () => {
      const { session, round, phase, busy } = get()
      if (!session || !round || phase !== 'playing' || busy) return
      const my = gen
      set({ busy: true })
      try {
        const r = await soloApi.surrender(session.session_id, round.round_id)
        if (my !== gen) return
        finish(r.end)
      } catch (e) {
        if (my !== gen) return
        set({ busy: false })
        if (await recover(e)) return
        toast.error('投降没成功', { description: errorText(e), id: 'solo-surrender' })
      }
    },

    choose: (g) => {
      if (get().phase === 'ended') set({ chosen: g })
    },
    stepChosen: (dir) => {
      const { phase, chosen, end } = get()
      if (phase !== 'ended' || !end) return
      set({ chosen: stepGrade(chosen ?? end.grade, dir) })
    },

    confirmNext: async (grade) => {
      const { phase, end, busy } = get()
      if (phase !== 'ended' || !end || busy) return
      const g = grade ?? get().chosen ?? end.grade
      set({ busy: true, chosen: g })
      if (needsRegrade(g, end.grade)) await get().regradeLast(g)
      await startRoundInner(false)
    },

    regradeLast: (g) => {
      const { session, last } = get()
      if (!session || !last) return Promise.resolve(false)
      const rid = last.round_id
      // 同一局的请求还在路上：只记住最新目标，等它回来再决定要不要再发
      if (regrading && regrading.rid === rid) {
        regrading.target = g
        showGrade(rid, g, true)
        return regrading.done
      }
      if (g === last.grade && !last.saving) return Promise.resolve(true)
      const before = last.grade
      const prev = regrading?.done // 上一局的改动还没收尾（很少见）：排在它后面
      const job: RegradeJob = { rid, target: g, done: Promise.resolve(false) }
      showGrade(rid, g, true)
      job.done = (prev ?? Promise.resolve(true)).then(() => runRegrade(session.session_id, job, before))
      regrading = job
      return job.done
    },

    commitChosen: async () => {
      const { phase, end, chosen } = get()
      if (phase !== 'ended' || !end || !chosen || !needsRegrade(chosen, end.grade)) return true
      return get().regradeLast(chosen)
    },


    reset: () => {
      gen++
      regrading = null
      set({ ...INITIAL })
    },
  }
})
