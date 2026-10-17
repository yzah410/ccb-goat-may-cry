/**
 * 「问数据」的状态：放在模块级 store 里（换页再回来结果还在）。
 * - ask()：一句话 → 流式 POST /v2/ai/ask/stream → AI 边写边显示「说明 / 范围 / SQL」→ 写完后端**自动运行** SQL → 结果表
 * - fix()：SQL 报错时的「让 AI 改」→ 流式 POST /v2/ai/ask/fix/stream（把 SQL 和报错发给 AI，改好照样自动运行）
 *   SQL 报错时后端不自动重试：停下来显示错误和这个按钮，由用户决定要不要让 AI 改。
 * - run()：把编辑框里的 SQL 自己跑一次（POST /v2/sql）；自己改的 SQL 报错也可以「让 AI 改」
 * - warm()：用 Claude 命令行时，打开问数据页 / 点进输入框就让后端提前开好 claude 进程（省掉每次启动进程的等待）；API 不用预热
 * - 最近问过的 10 个问题持久化（outsetter.ask.v1），方便再问一次
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { z } from 'zod'
import { errorText, isApiError } from '@/lib/apiClient'
import { localJSONStorage, makeMigrate, validatedMerge } from '@/lib/persist'
import { toast } from '@/components/ui/Toast'
import { v2Api } from '@/features/v2/api'
import { askFixStream, askStream, cancelAiJob, newClientId, warmAi, type AiStreamHandlers } from '@/features/v2/aiStream'
import type { AiAskResult, AiEngineId } from '@/features/v2/types'

export interface AskTable {
  /** 产生这张表的 SQL（和编辑框不一样 = 改过还没重跑） */
  sql: string
  columns: string[]
  rows: unknown[][]
  truncated: boolean
  elapsed_ms: number
  /** 这张表是 AI 跑的还是自己跑的 */
  by: 'ai' | 'manual'
  /** 这张表回答的是哪个问题（存清单 / 存条件的默认名字用它；AI 这次的 SQL 出错时，下面挂的还是上一个问题的表） */
  question?: string
  at: number
}

export interface AskHistoryItem {
  question: string
  sql: string
  at: number
}

export interface AskPending {
  question: string
  startedAt: number
  /** ask = 问问题；fix = 让 AI 改报错的 SQL */
  mode: 'ask' | 'fix'
  clientId: string
  engine: AiEngineId | null
  /** 后端的进度：start / queue / thinking / writing / sql / restart */
  stage: string
  message: string
  warm: boolean | null
  /** AI 到现在为止写的全文（页面边写边解析显示，见 draft.ts） */
  text: string
  /** fix 模式：正在改的那段 SQL 和它的报错 */
  fixing?: { sql: string; error: string }
}

/** 有这个就显示「让 AI 改」按钮 */
export interface AskFixable {
  question: string
  sql: string
  error: string
}

interface AskState {
  question: string
  setQuestion: (q: string) => void
  sql: string
  setSql: (s: string) => void
  pending: AskPending | null
  running: boolean
  /** 最近一次 AI 的回答（说明、统计范围、存清单的提示、耗时）；SQL 报错时也有（带着那条出错的 SQL） */
  answer: (AiAskResult & { question: string }) | null
  table: AskTable | null
  error: string | null
  fixable: AskFixable | null
  history: AskHistoryItem[]
  ask: (engine: AiEngineId | null) => void
  /** 「让 AI 改」 */
  fix: (engine: AiEngineId | null) => void
  cancel: () => void
  run: () => void
  /** 用一个例子 / 历史记录填进来（不自动跑） */
  load: (question: string, sql: string) => void
  warm: (engine: AiEngineId | null) => void
}

let controller: AbortController | null = null
let runController: AbortController | null = null

export const useAsk = create<AskState>()(
  persist(
    (set, get) => {
      /** ask / fix 共用：开流、边写边更新 pending.text、拿到结果后填表 / 报错 */
      const go = (
        mode: 'ask' | 'fix',
        question: string,
        engine: AiEngineId | null,
        call: (clientId: string, h: AiStreamHandlers, signal: AbortSignal) => Promise<AiAskResult>,
        fixing?: { sql: string; error: string },
      ) => {
        controller?.abort()
        const ctrl = new AbortController()
        controller = ctrl
        const clientId = newClientId(mode)
        const alive = () => controller === ctrl
        set({
          pending: { question, startedAt: Date.now(), mode, clientId, engine, stage: 'start', message: '正在连接 AI', warm: null, text: '', fixing },
          error: null,
          fixable: null,
        })
        call(
          clientId,
          {
            onStatus: (s) => alive() && set((st) => (st.pending ? { pending: { ...st.pending, stage: s.stage, message: s.message, warm: s.warm ?? st.pending.warm } } : {})),
            onDelta: (_t, full) => alive() && set((st) => (st.pending ? { pending: { ...st.pending, text: full } } : {})),
          },
          ctrl.signal,
        )
          .then((r) => {
            if (!alive()) return
            controller = null
            if (!r.ok) {
              const sql = r.sql || ''
              set({
                pending: null,
                error: r.error || 'AI 没写出能跑的 SQL',
                // SQL 报错：留下这次的说明和 SQL（编辑框里也放上），给「让 AI 改」
                answer: sql ? { ...r, question } : get().answer,
                sql: sql || get().sql,
                fixable: r.fixable && sql ? { question, sql, error: r.sql_error || r.error || '' } : null,
              })
              return
            }
            set((s) => ({
              pending: null,
              answer: { ...r, question },
              sql: r.sql,
              table: {
                sql: r.sql,
                columns: r.columns,
                rows: r.rows,
                truncated: r.truncated,
                elapsed_ms: r.sql_ms ?? 0,
                by: 'ai',
                question,
                at: Date.now(),
              },
              history: [{ question, sql: r.sql, at: Date.now() }, ...s.history.filter((h) => h.question !== question)].slice(0, 10),
            }))
          })
          .catch((e: unknown) => {
            if (!alive()) return
            controller = null
            if (isApiError(e) && e.kind === 'aborted') {
              set({ pending: null })
              return
            }
            set({ pending: null, error: errorText(e), fixable: fixing ? { question, ...fixing } : null })
          })
      }

      return {
        question: '',
        setQuestion: (question) => set({ question }),
        sql: '',
        setSql: (sql) => set({ sql }),
        pending: null,
        running: false,
        answer: null,
        table: null,
        error: null,
        fixable: null,
        history: [],

        ask: (engine) => {
          const q = get().question.trim()
          if (!q || get().pending) return
          go('ask', q, engine, (client_id, h, signal) => askStream({ question: q, engine, client_id }, h, signal))
        },

        fix: (engine) => {
          const f = get().fixable
          if (!f || get().pending) return
          const fixing = { sql: f.sql, error: f.error }
          go('fix', f.question, engine, (client_id, h, signal) => askFixStream({ ...f, engine, client_id }, h, signal), fixing)
        },

        cancel: () => {
          const p = get().pending
          controller?.abort()
          controller = null
          if (p) {
            cancelAiJob(p.clientId)
            // 取消「让 AI 改」：按钮还在，可以再点
            set({ pending: null, fixable: p.fixing ? { question: p.question, ...p.fixing } : get().fixable })
            toast.info('取消了', { description: '这次的 AI 进程已经结束' })
          } else set({ pending: null })
        },

        run: () => {
          const sql = get().sql.trim()
          if (!sql || get().running) return
          runController?.abort()
          const ctrl = new AbortController()
          runController = ctrl
          set({ running: true, error: null, fixable: null })
          v2Api
            .sql(sql, undefined, ctrl.signal)
            .then((r) => {
              if (runController !== ctrl) return
              runController = null
              const question = get().question.trim() || get().answer?.question || undefined
              set({ running: false, table: { sql, columns: r.columns, rows: r.rows, truncated: r.truncated, elapsed_ms: r.elapsed_ms, by: 'manual', question, at: Date.now() } })
            })
            .catch((e: unknown) => {
              if (runController !== ctrl) return
              runController = null
              const msg = errorText(e)
              const question = get().question.trim() || get().answer?.question || '修好这段 SQL，让它能在这个库上运行'
              set({ running: false, error: msg, fixable: isApiError(e) && e.kind === 'http' && e.status === 400 ? { question, sql, error: msg } : null })
            })
        },

        load: (question, sql) => set({ question, sql, error: null, fixable: null }),

        warm: (engine) => warmAi('ask', engine),
      }
    },
    {
      name: 'outsetter.ask.v1',
      version: 1,
      storage: localJSONStorage(),
      migrate: makeMigrate('ask', 1),
      merge: validatedMerge<AskState>('ask', {
        history: z.array(z.object({ question: z.string(), sql: z.string(), at: z.number() })),
      }),
      partialize: (s) => ({ history: s.history }),
    },
  ),
)
