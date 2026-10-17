/**
 * 出题器接口（后端 /v2/*）。页面层只调这里。
 * 列表接口返回数组；asArray 也接受 `{ items: [...] }` 这样包了一层的写法，统一成数组，页面不用管。
 */
import { api } from '@/lib/apiClient'
import type {
  AiEngineId,
  AiKind,
  AiStatusResp,
  AiWarmResp,
  CandidateSort,
  CandidatesV2Resp,
  CharacterDetail,
  DrawV2Resp,
  EvaluateResp,
  ListKind,
  ListItemV2,
  ListV2,
  MetaResp,
  ModeId,
  PlanV2Summary,
  SpecV2,
  SqlResp,
  SqlSchemaResp,
  StatsV2Resp,
  SuggestItem,
  SuggestKind,
  V2Status,
} from './types'

const enc = encodeURIComponent

/** 裸数组 / { key: [...] } / { items: [...] } 都认 */
export function asArray<T>(r: unknown, ...keys: string[]): T[] {
  if (Array.isArray(r)) return r as T[]
  if (r && typeof r === 'object') {
    for (const k of [...keys, 'items', 'data', 'results']) {
      const v = (r as Record<string, unknown>)[k]
      if (Array.isArray(v)) return v as T[]
    }
  }
  return []
}

/** 某个模式第一次用时，后端要把这个模式的数据读进内存 */
const EVAL_TIMEOUT = 120_000

export interface ListBody {
  name: string
  kind: ListKind
  items: ListItemV2[]
  note?: string | null
}

export const v2Api = {
  meta: (signal?: AbortSignal) => api.get<MetaResp>('/v2/meta', { signal, timeoutMs: 30_000 }),

  evaluate: (spec: SpecV2, signal?: AbortSignal) => api.post<EvaluateResp>('/v2/evaluate', { spec }, { signal, timeoutMs: EVAL_TIMEOUT }),

  candidates: (
    body: { spec: SpecV2; page: number; page_size: number; sort?: CandidateSort; q?: string; seed?: number },
    signal?: AbortSignal,
  ) => api.post<CandidatesV2Resp>('/v2/candidates', body, { signal, timeoutMs: EVAL_TIMEOUT }),

  draw: (spec: SpecV2, seed: number | null, signal?: AbortSignal) =>
    api.post<DrawV2Resp>('/v2/draw', seed == null ? { spec } : { spec, seed }, { signal, timeoutMs: EVAL_TIMEOUT }),

  stats: (spec: SpecV2, signal?: AbortSignal) => api.post<StatsV2Resp>('/v2/stats', { spec }, { signal, timeoutMs: EVAL_TIMEOUT }),

  character: (id: number, mode: ModeId, n: number, signal?: AbortSignal) =>
    api.get<CharacterDetail>(`/v2/character/${id}`, { query: { mode, n }, signal, timeoutMs: 20_000 }),

  /** game_tag 的数字按对局设置算：带上模式和作品标签数 n */
  suggest: async (kind: SuggestKind, q: string, opts: { mode?: ModeId; n?: number; limit?: number; signal?: AbortSignal } = {}) =>
    asArray<SuggestItem>(
      await api.get<unknown>('/v2/suggest', {
        query: { kind, q, mode: opts.mode, n: opts.n, limit: opts.limit ?? 20 },
        signal: opts.signal,
        timeoutMs: 10_000,
      }),
      'suggestions',
    ),

  /** 数据加载到哪一步了（第一次用某个模式时 evaluate 会等它） */
  status: (signal?: AbortSignal) => api.get<V2Status>('/v2/status', { signal, timeoutMs: 5000 }),

  // ------------------------------------------------------------ 清单
  lists: async (signal?: AbortSignal) => asArray<ListV2>(await api.get<unknown>('/v2/lists', { signal }), 'lists'),
  list: (id: string) => api.get<ListV2>(`/v2/lists/${enc(id)}`),
  createList: (body: ListBody) => api.post<ListV2>('/v2/lists', body),
  updateList: (id: string, body: ListBody) => api.put<ListV2>(`/v2/lists/${enc(id)}`, body),
  deleteList: (id: string) => api.del<unknown>(`/v2/lists/${enc(id)}`),

  // ------------------------------------------------------------ 方案（data/plans_v2/<name>.json，内容就是 SpecV2）
  plans: async (signal?: AbortSignal) => {
    const raw = asArray<PlanV2Summary>(await api.get<unknown>('/v2/plans', { signal }), 'plans')
    return raw.filter((p) => !!p?.name)
  },
  /** 方案内容就是 SpecV2（用 normalizeSpec 读） */
  plan: (name: string) => api.get<unknown>(`/v2/plans/${enc(name)}`),
  savePlan: (name: string, spec: SpecV2) => api.post<unknown>(`/v2/plans/${enc(name)}`, spec),
  deletePlan: (name: string) => api.del<unknown>(`/v2/plans/${enc(name)}`),

  // ------------------------------------------------------------ 问数据
  sqlSchema: () => api.get<SqlSchemaResp>('/v2/sql/schema', { timeoutMs: 15_000 }),
  sql: (sql: string, limit?: number, signal?: AbortSignal) =>
    api.post<SqlResp>('/v2/sql', limit ? { sql, limit } : { sql }, { signal, timeoutMs: 30_000 }),

  // ------------------------------------------------------------ AI（三条路：API、本机 claude / codex 命令行，都由后端调用）
  aiStatus: () => api.get<AiStatusResp>('/v2/ai/status', { timeoutMs: 20_000 }),
}

// ---------------------------------------------------------------- AI：流式接口与预热
// 流式接口（填工作台 / 问数据 / 让 AI 改）在 ./aiStream.ts；这里是几个普通接口。

export const v2AiApi = {
  /** 打开工作台 / 问数据页时调：后端在后台提前开好 claude 进程（立刻返回，不等进程开好） */
  warm: (kinds: AiKind[], engine?: AiEngineId | null) =>
    api.post<AiWarmResp>('/v2/ai/warm', engine ? { kinds, engine } : { kinds }, { timeoutMs: 10_000 }),
  /** 取消：杀掉这次请求正在用的 AI 进程（job_id = 流式请求时给的 client_id） */
  cancel: (jobId: string) => api.post<{ ok: boolean }>('/v2/ai/cancel', { job_id: jobId }, { timeoutMs: 5_000 }),
}
