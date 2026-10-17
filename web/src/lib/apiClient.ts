/**
 * 后端请求的唯一出口。
 *
 * - 地址：设置页填的 > VITE_API_BASE > http://127.0.0.1:8099
 * - 所有错误都变成 ApiError，带一句给人看的中文（error.message 就是它）
 * - 写请求（GET 以外）一律带 X-Outsetter: 1，后端据此拒绝外部网页发来的跨站请求（backend/writeguard.py）
 * - 页面层不要直接用 fetch；业务接口封装在 features/<域>/api.ts 里
 */
import { usePrefs } from '@/features/settings/store'

export const DEFAULT_API_BASE: string = (
  (import.meta.env.VITE_API_BASE as string | undefined) || 'http://127.0.0.1:8099'
).replace(/\/+$/, '')

/** 后端要求写请求带的自定义头：它会让浏览器先发预检，外部网页过不了预检，所以发不出这样的请求 */
export const WRITE_GUARD_HEADERS: Readonly<Record<string, string>> = { 'X-Outsetter': '1' }

export function getApiBase(): string {
  const custom = usePrefs.getState().apiBase.trim()
  return (custom || DEFAULT_API_BASE).replace(/\/+$/, '')
}

export type ApiErrorKind = 'network' | 'http' | 'timeout' | 'aborted' | 'parse'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status?: number
  readonly path: string
  readonly detail?: unknown

  constructor(opts: { kind: ApiErrorKind; message: string; path: string; status?: number; detail?: unknown }) {
    super(opts.message)
    this.name = 'ApiError'
    this.kind = opts.kind
    this.status = opts.status
    this.path = opts.path
    this.detail = opts.detail
  }

  /** 404/405：后端没有这个接口（通常是后端在更新代码之前启动、之后没重启） */
  get endpointMissing(): boolean {
    return this.kind === 'http' && (this.status === 404 || this.status === 405)
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError
}

/** 把 FastAPI 422 的 detail 翻译成一句话：「blocks → 第 1 个 → params → years：字段缺失」 */
export function formatValidationDetail(detail: unknown): string | undefined {
  if (!Array.isArray(detail) || detail.length === 0) return undefined
  const parts = detail.slice(0, 2).map((d) => {
    const item = d as { loc?: unknown[]; msg?: string }
    const loc = (item.loc ?? [])
      .filter((x) => x !== 'body')
      .map((x) => (typeof x === 'number' ? `第 ${x + 1} 个` : String(x)))
      .join(' → ')
    return `${loc || '（根）'}：${item.msg ?? '格式不对'}`
  })
  const more = detail.length > 2 ? `（还有 ${detail.length - 2} 处）` : ''
  return parts.join('；') + more
}

function describeHttp(status: number, path: string, body: unknown): string {
  const b = body as { error?: unknown; message?: unknown; detail?: unknown } | null
  // /v2/* 接口的错误格式：{ ok: false, error: '错误代码', message: '给人看的中文', detail?: 中文列表 / 原始报错 }
  if (b && typeof b.message === 'string' && b.message) {
    const msg = b.message
    const d = b.detail
    // message 里已经带上了 detail 的内容就不再拼一遍
    if (Array.isArray(d) && d.length && d.every((x) => typeof x === 'string') && !(d as string[]).every((x) => msg.includes(x)))
      return `${msg}：${(d as string[]).slice(0, 2).join('；')}${d.length > 2 ? `（还有 ${d.length - 2} 处）` : ''}`
    if (typeof d === 'string' && d && !msg.includes(d)) return `${msg}（${d}）`
    return msg
  }
  if (b && typeof b.error === 'string') return b.error
  if (status === 422) {
    const v = formatValidationDetail(b?.detail)
    return v ? `后端说数据格式不对：${v}` : '后端说数据格式不对（422）'
  }
  if (status === 404) return `后端没有这个接口或没找到（${path}）`
  if (status === 405) return `后端不支持这个操作（${path}）`
  if (status >= 500) return `后端出错了（${status}），看一下后端窗口的报错`
  if (b && typeof b.detail === 'string') return b.detail
  return `请求失败（${status}）`
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** 会被 JSON.stringify */
  body?: unknown
  signal?: AbortSignal
  /** 默认 30 秒 */
  timeoutMs?: number
  /** 'json'（默认）| 'blob' | 'text' */
  responseType?: 'json' | 'blob' | 'text'
  /** URL 查询参数 */
  query?: Record<string, string | number | boolean | null | undefined>
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const base = getApiBase()
  const qs = opts.query
    ? Object.entries(opts.query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : ''
  const url = `${base}${path}${qs ? `?${qs}` : ''}`

  const ctrl = new AbortController()
  const timeoutMs = opts.timeoutMs ?? 30_000
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, timeoutMs)
  const onAbort = () => ctrl.abort()
  opts.signal?.addEventListener('abort', onAbort)

  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET') Object.assign(headers, WRITE_GUARD_HEADERS)

  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
    if (timedOut)
      throw new ApiError({ kind: 'timeout', path, message: `后端太久没回应（超过 ${Math.round(timeoutMs / 1000)} 秒）` })
    if (opts.signal?.aborted) throw new ApiError({ kind: 'aborted', path, message: '请求已取消' })
    throw new ApiError({
      kind: 'network',
      path,
      message: `连不上后端（${base}）。后端开着吗？`,
      detail: e instanceof Error ? e.message : String(e),
    })
  }
  clearTimeout(timer)
  opts.signal?.removeEventListener('abort', onAbort)

  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null)
    throw new ApiError({ kind: 'http', status: res.status, path, message: describeHttp(res.status, path, body), detail: body })
  }

  const type = opts.responseType ?? 'json'
  try {
    if (type === 'blob') return (await res.blob()) as T
    if (type === 'text') return (await res.text()) as T
    return (await res.json()) as T
  } catch (e) {
    throw new ApiError({ kind: 'parse', path, message: '后端返回的内容看不懂（不是合法 JSON）', detail: String(e) })
  }
}

export const api = {
  get: <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) => request<T>(path, { ...opts, method: 'GET' }),
  post: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'PUT', body }),
  del: <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) => request<T>(path, { ...opts, method: 'DELETE' }),
}

/** 给 toast 用：任意错误 → 一句中文 */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}
