/**
 * 「用一句话填工作台」的状态。放在模块级 store 里，不跟着组件走：换页再回来，结果照样会填进工作台、结果卡还在。
 *
 * 行为：AI 不追问，直接把它理解的方案填进工作台（进撤销历史）；结果卡摆出「你说的 / 我改了 / 沿用默认」，
 * 按钮：采用（关掉卡片）/ 在此基础上再改（关掉卡片、光标回到输入框）/ 撤销（换回 AI 之前的方案）；
 * 后端给了「另一种理解」时多一个按钮，可以来回切。
 *
 * 流式与预热：
 * - 走流式接口 POST /v2/ai/fill/stream（features/v2/aiStream.ts）：进行中能看到「AI 在想 / 在写（已写 N 字）/ 后端在核对」。
 * - 用 Claude 命令行时，打开工作台就预热（warm）：后端提前开好 claude 进程，省掉每次启动进程的几秒钟；API 不用预热。
 * - 取消 = 断开连接 + 告诉后端停掉这次请求（断开 API 连接或杀掉进程）。
 * - 标签名库里没有：后端能确定的已经自动换好（tag_replaced），拿不准的（tag_fixes）在结果卡上给替换按钮（applyNameFix）。
 */
import { create } from 'zustand'
import { errorText, isApiError } from '@/lib/apiClient'
import { toast } from '@/components/ui/Toast'
import { v2Api } from '@/features/v2/api'
import { cancelAiJob, fillStream, newClientId, warmAi } from '@/features/v2/aiStream'
import type { AiEngineId, AiFillResult, AiNameStyle, Condition, SpecV2, TagFilter } from '@/features/v2/types'
import { normalizeSpec, specFingerprint } from './spec'
import { useWb2 } from './store'

export interface AiFillResultState {
  text: string
  resp: AiFillResult
  /** 填进去之前的方案（「撤销」换回它） */
  before: SpecV2
  /** 现在用的是哪种理解 */
  using: 'main' | 'alt'
  /** 填进去的方案的指纹：之后工作台又被手动改过 → 卡片收起成一行 */
  appliedFp: string
  at: number
  /** 结果卡上点过的名字替换：nameKey(style, 最初的名字) → 现在换成了什么 */
  fixed: Record<string, string>
  /** 点过替换之后重新算的人数（没点过就用后端给的）；null = 重新算失败 */
  totals: { main?: number | null; alt?: number | null }
  /** 点了替换、正在重新算人数 */
  recounting: boolean
}

export interface AiFillPending {
  text: string
  startedAt: number
  engine: AiEngineId | null
  clientId: string
  /** 后端的进度：start / queue / thinking / writing / checking / restart */
  stage: string
  message: string
  /** AI 已经写了多少字（给「在写」一个看得见的进度） */
  chars: number
  /** 用的是不是提前开好的 AI 进程（start 事件之后才知道） */
  warm: boolean | null
}

interface AiFillState {
  pending: AiFillPending | null
  result: AiFillResultState | null
  error: { text: string; message: string } | null
  /** 「在此基础上再改」→ 输入框抢焦点（每次 +1） */
  focusNonce: number
  /** 输入框里的字（换页回来还在） */
  draft: string
  setDraft: (s: string) => void
  start: (text: string, engine: AiEngineId | null) => void
  cancel: () => void
  accept: () => void
  refine: () => void
  revert: () => void
  switchTo: (which: 'main' | 'alt') => void
  /**
   * 结果卡上的「换成 X」：把方案里这一类的名字 from（现在方案里的写法）换成 to（进撤销历史），然后重新算人数。
   * original = 卡片上这一项最初的名字（后端自动换过的项，from 是换好的写法，original 是 AI 原来写的），用来记「这一项现在是什么」。
   */
  applyNameFix: (style: AiNameStyle, from: string, to: string, original?: string) => void
  clearError: () => void
  /** 打开工作台 / 输入框拿到焦点时调：让后端提前开好 AI 进程（60 秒内只发一次） */
  warm: (engine: AiEngineId | null) => void
}

let controller: AbortController | null = null

// ---------------------------------------------------------------- 名字替换（和后端 ai.py 的 _dict_slots 同一套规则）
function tfStyle(tf: TagFilter): AiNameStyle {
  return tf.tag_mode === 'meta' ? 'meta' : 'work'
}

function swap(list: string[], from: string, to: string): string[] {
  const out: string[] = []
  for (const x of list) {
    const v = x === from ? to : x
    if (!out.includes(v)) out.push(v)
  }
  return out
}

/** 把方案里 style 这一类的名字 from 换成 to（同类里去重）；返回新方案，原方案不动 */
export function replaceNameInSpec(spec: SpecV2, style: AiNameStyle, from: string, to: string): SpecV2 {
  const out = JSON.parse(JSON.stringify(spec)) as SpecV2
  for (const r of [...out.ranges, ...out.excludes]) {
    if (r.source.kind === 'rank' && r.source.work_filter && tfStyle(r.source.work_filter) === style)
      r.source.work_filter.tags = swap(r.source.work_filter.tags ?? [], from, to)
    r.conditions = r.conditions.map((c): Condition => {
      if (c.type === 'game_tags' && style === 'game') return { ...c, tags: swap(c.tags ?? [], from, to) }
      if (c.type === 'char_tags' && style === 'char') return { ...c, tags: swap(c.tags ?? [], from, to) }
      if (c.type === 'appearance' && c.work_tags && tfStyle(c.work_tags) === style)
        return { ...c, work_tags: { ...c.work_tags, tags: swap(c.work_tags.tags ?? [], from, to) } }
      if (c.type === 'va' && style === 'va') return { ...c, names: swap(c.names ?? [], from, to) }
      return c
    })
  }
  return out
}

const short = (t: string) => (t.length > 16 ? `${t.slice(0, 16)}…` : t)

/** 结果卡上一项名字的键：同一个名字在不同类里（例：角色的作品标签 / 作品本身的标签）是两项 */
export const nameKey = (style: AiNameStyle, name: string) => `${style}:${name}`

export const useAiFill = create<AiFillState>((set, get) => ({
  pending: null,
  result: null,
  error: null,
  focusNonce: 0,
  draft: '',
  setDraft: (draft) => set({ draft }),

  start: (text, engine) => {
    const t = text.trim()
    if (!t || get().pending) return
    controller?.abort()
    const ctrl = new AbortController()
    controller = ctrl
    const clientId = newClientId('fill')
    set({
      pending: { text: t, startedAt: Date.now(), engine, clientId, stage: 'start', message: '正在连接 AI', chars: 0, warm: null },
      error: null,
      result: null,
    })
    const sent = useWb2.getState().spec
    const alive = () => controller === ctrl
    fillStream(
      { text: t, spec: sent, engine, client_id: clientId },
      {
        onStatus: (s) => {
          if (!alive()) return
          set((st) => (st.pending ? { pending: { ...st.pending, stage: s.stage, message: s.message, warm: s.warm ?? st.pending.warm } } : {}))
        },
        onDelta: (_t, full) => {
          if (!alive()) return
          set((st) => (st.pending ? { pending: { ...st.pending, chars: full.length } } : {}))
        },
      },
      ctrl.signal,
    )
      .then((resp) => {
        if (!alive()) return
        controller = null
        if (!resp.ok || !resp.spec) {
          set({ pending: null, error: { text: t, message: resp.error || resp.note || 'AI 没给出能用的方案' } })
          return
        }
        const { spec } = normalizeSpec(resp.spec)
        const before = useWb2.getState().spec
        useWb2.getState().replaceSpec(`AI 填工作台：「${short(t)}」`, spec)
        set({
          pending: null,
          draft: '',
          result: { text: t, resp, before, using: 'main', appliedFp: specFingerprint(spec), at: Date.now(), fixed: {}, totals: {}, recounting: false },
        })
      })
      .catch((e: unknown) => {
        if (!alive()) return
        controller = null
        if (isApiError(e) && e.kind === 'aborted') {
          set({ pending: null })
          return
        }
        set({ pending: null, error: { text: t, message: errorText(e) } })
      })
  },

  cancel: () => {
    const p = get().pending
    controller?.abort()
    controller = null
    set({ pending: null })
    if (p) {
      cancelAiJob(p.clientId)
      toast.info('取消了', { description: '这次的 AI 进程已经结束，工作台没有被改动' })
    }
  },

  accept: () => set({ result: null }),

  refine: () => set((s) => ({ result: null, focusNonce: s.focusNonce + 1 })),

  revert: () => {
    const r = get().result
    if (!r) return
    useWb2.getState().replaceSpec('撤销 AI 的改动', r.before)
    set({ result: null })
    toast.info('换回了 AI 之前的方案')
  },

  switchTo: (which) => {
    const r = get().result
    if (!r || r.using === which) return
    const raw = which === 'alt' ? r.resp.alternative?.spec : r.resp.spec
    if (!raw) return
    const { spec } = normalizeSpec(raw)
    useWb2.getState().replaceSpec(which === 'alt' ? '换成另一种理解' : '换回 AI 的第一种理解', spec)
    set({ result: { ...r, using: which, appliedFp: specFingerprint(spec) } })
  },

  applyNameFix: (style, from, to, original) => {
    const r = get().result
    if (!r || !to || from === to) return
    const next = replaceNameInSpec(useWb2.getState().spec, style, from, to)
    useWb2.getState().replaceSpec(`把『${from}』换成『${to}』`, next)
    const alt = r.resp.alternative
    const mainSpec = replaceNameInSpec(r.resp.spec, style, from, to)
    const altSpec = alt ? replaceNameInSpec(alt.spec, style, from, to) : null
    const fixed = { ...r.fixed, [nameKey(style, original ?? from)]: to }
    set({
      result: {
        ...r,
        resp: { ...r.resp, spec: mainSpec, alternative: alt && altSpec ? { ...alt, spec: altSpec } : alt },
        appliedFp: specFingerprint(next),
        fixed,
        totals: {},
        recounting: true,
      },
    })
    const at = get().result?.at
    const count = (sp: SpecV2 | null) =>
      sp ? v2Api.evaluate(sp).then((ev) => ev.total as number | null, () => null) : Promise.resolve(undefined)
    void Promise.all([count(mainSpec), count(altSpec)]).then(([main, altTotal]) =>
      set((s) => (s.result && s.result.at === at ? { result: { ...s.result, totals: { main, alt: altTotal }, recounting: false } } : {})),
    )
  },

  clearError: () => set({ error: null }),

  warm: (engine) => warmAi('fill', engine),
}))
