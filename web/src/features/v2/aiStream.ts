/**
 * AI 的流式接口（后端 /v2/ai/fill/stream、/v2/ai/ask/stream、/v2/ai/ask/fix/stream，SSE 格式）。
 *
 * 为什么不用 EventSource：它只能发 GET，这几个接口要 POST 一段 JSON（当前方案、问题）。
 * 所以用 fetch + ReadableStream 自己按 SSE 格式切事件。
 *
 * 后端的事件顺序：
 *   open {job_id} → status {stage, message, ms} / delta {text} …（可能很多条）→ result {和非流式接口一样的返回}
 *   意外情况（没有库、后端出错、被取消）是 error {code, message}。
 * 取消：abort 这个请求就行（连接断开，后端会断开 API 连接或杀掉正在用的 AI 进程）；另外再调一次 /v2/ai/cancel 兜底。
 */
import { ApiError, getApiBase, WRITE_GUARD_HEADERS } from '@/lib/apiClient'
import { v2AiApi } from './api'
import type { AiAskResult, AiEngineId, AiFillResult, AiStreamStatus, SpecV2 } from './types'

export interface SseEvent {
  event: string
  data: unknown
}

/** 切出一个完整事件的分隔：空行（\n\n 或 \r\n\r\n） */
function nextBoundary(buf: string): { at: number; len: number } | null {
  const a = buf.indexOf('\n\n')
  const b = buf.indexOf('\r\n\r\n')
  if (a < 0 && b < 0) return null
  if (b >= 0 && (a < 0 || b < a)) return { at: b, len: 4 }
  return { at: a, len: 2 }
}

/** 一个事件块 → {event, data}；只有注释（: keep-alive）的块返回 null。data 是 JSON 就解析，不是就原样给字符串 */
export function parseSseBlock(block: string): SseEvent | null {
  let event = 'message'
  const data: string[] = []
  for (const raw of block.split(/\r?\n/)) {
    if (!raw || raw.startsWith(':')) continue
    const i = raw.indexOf(':')
    const field = i < 0 ? raw : raw.slice(0, i)
    let value = i < 0 ? '' : raw.slice(i + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (!data.length) return null
  const text = data.join('\n')
  try {
    return { event, data: JSON.parse(text) as unknown }
  } catch {
    return { event, data: text }
  }
}

/** 把一串文本块（可能在任意位置被切开）变成事件。给测试和 sseStream 共用 */
export class SseParser {
  private buf = ''
  push(chunk: string): SseEvent[] {
    this.buf += chunk
    const out: SseEvent[] = []
    for (let b = nextBoundary(this.buf); b; b = nextBoundary(this.buf)) {
      const ev = parseSseBlock(this.buf.slice(0, b.at))
      this.buf = this.buf.slice(b.at + b.len)
      if (ev) out.push(ev)
    }
    return out
  }
  /** 连接结束时：最后一块没有空行结尾也算一个事件 */
  flush(): SseEvent[] {
    const rest = this.buf.trim()
    this.buf = ''
    const ev = rest ? parseSseBlock(rest) : null
    return ev ? [ev] : []
  }
}

function httpMessage(status: number, body: unknown): string {
  const b = body as { message?: unknown; detail?: unknown } | null
  if (b && typeof b.message === 'string' && b.message) return b.message
  if (status === 404 || status === 405) return '后端没有 AI 流式接口：后端可能是更新代码之前启动的。关掉后端和前端窗口，重新运行启动脚本（Windows：start-all.bat；macOS / Linux：start-all.sh）'
  if (status >= 500) return `后端出错了（${status}），看一下后端窗口的报错`
  return `请求失败（${status}）`
}

/**
 * POST 一段 JSON，按 SSE 逐个产出事件。
 * idleTimeoutMs：这么久一个字节都没收到就当断线（后端每 10 秒发一次 keep-alive 注释）。
 */
export async function* sseStream(
  path: string,
  body: unknown,
  opts: { signal?: AbortSignal; idleTimeoutMs?: number } = {},
): AsyncGenerator<SseEvent, void, undefined> {
  const base = getApiBase()
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  opts.signal?.addEventListener('abort', onAbort)
  if (opts.signal?.aborted) ctrl.abort()
  const idleMs = opts.idleTimeoutMs ?? 45_000
  let idle = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      idle = true
      ctrl.abort()
    }, idleMs)
  }
  const fail = (e: unknown): never => {
    if (idle) throw new ApiError({ kind: 'timeout', path, message: `后端 ${Math.round(idleMs / 1000)} 秒没有任何回应，已断开` })
    if (opts.signal?.aborted) throw new ApiError({ kind: 'aborted', path, message: '请求已取消' })
    throw new ApiError({ kind: 'network', path, message: `连不上后端（${base}）。后端开着吗？`, detail: e instanceof Error ? e.message : String(e) })
  }
  try {
    arm()
    let res: Response
    try {
      res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...WRITE_GUARD_HEADERS },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } catch (e) {
      return fail(e)
    }
    if (!res.ok) {
      const b: unknown = await res.json().catch(() => null)
      throw new ApiError({ kind: 'http', status: res.status, path, message: httpMessage(res.status, b), detail: b })
    }
    if (!res.body) throw new ApiError({ kind: 'parse', path, message: '浏览器不支持流式读取' })
    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    const parser = new SseParser()
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await reader.read()
        } catch (e) {
          return fail(e)
        }
        arm()
        if (chunk.done) break
        for (const ev of parser.push(decoder.decode(chunk.value, { stream: true }))) yield ev
      }
      for (const ev of parser.push(decoder.decode())) yield ev
      for (const ev of parser.flush()) yield ev
    } finally {
      reader.cancel().catch(() => {})
    }
  } finally {
    if (timer) clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

export interface AiStreamHandlers {
  onOpen?: (jobId: string) => void
  onStatus?: (s: AiStreamStatus) => void
  /** text = 这一段；full = 到现在为止 AI 写的全部文字 */
  onDelta?: (text: string, full: string) => void
}

/** 跑一个 AI 流式请求，直到拿到 result（resolve）或 error（reject 成 ApiError）。 */
export async function runAiStream<R>(path: string, body: unknown, handlers: AiStreamHandlers = {}, signal?: AbortSignal): Promise<R> {
  let full = ''
  for await (const ev of sseStream(path, body, { signal })) {
    const d = (ev.data ?? {}) as Record<string, unknown>
    if (ev.event === 'open') handlers.onOpen?.(String(d.job_id ?? ''))
    else if (ev.event === 'status') handlers.onStatus?.(d as unknown as AiStreamStatus)
    else if (ev.event === 'delta') {
      const t = typeof d.text === 'string' ? d.text : ''
      full += t
      handlers.onDelta?.(t, full)
    } else if (ev.event === 'result') return ev.data as R
    else if (ev.event === 'error') {
      const code = String(d.code ?? 'error')
      if (code === 'cancelled') throw new ApiError({ kind: 'aborted', path, message: '请求已取消' })
      throw new ApiError({ kind: 'http', status: code === 'no_db' ? 503 : code === 'bad_spec' ? 422 : 500, path, message: String(d.message ?? 'AI 出错了'), detail: d })
    }
  }
  if (signal?.aborted) throw new ApiError({ kind: 'aborted', path, message: '请求已取消' })
  throw new ApiError({ kind: 'parse', path, message: '后端还没给出结果连接就断了，再试一次' })
}

/** 每次请求一个新的 id：取消时告诉后端杀哪个进程 */
export function newClientId(kind: string): string {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 取消：断开连接（后端据此杀进程）之外，再明确告诉后端一次（失败也无所谓） */
export function cancelAiJob(clientId: string | null | undefined): void {
  if (clientId) v2AiApi.cancel(clientId).catch(() => {})
}

export const fillStream = (
  body: { text: string; spec: SpecV2; engine?: AiEngineId | null; client_id: string },
  handlers?: AiStreamHandlers,
  signal?: AbortSignal,
) => runAiStream<AiFillResult>('/v2/ai/fill/stream', body.engine ? body : { ...body, engine: undefined }, handlers, signal)

export const askStream = (
  body: { question: string; engine?: AiEngineId | null; client_id: string },
  handlers?: AiStreamHandlers,
  signal?: AbortSignal,
) => runAiStream<AiAskResult>('/v2/ai/ask/stream', body, handlers, signal)

export const askFixStream = (
  body: { question: string; sql: string; error: string; engine?: AiEngineId | null; client_id: string },
  handlers?: AiStreamHandlers,
  signal?: AbortSignal,
) => runAiStream<AiAskResult>('/v2/ai/ask/fix/stream', body, handlers, signal)

/** 预热（节流：同一种用途 60 秒内只发一次）。只有 Claude 命令行有预热（提前开好进程），API 和 codex 不发。失败不提示：预热只是让下一次更快 */
const lastWarm: Record<string, number> = {}
export function warmAi(kind: 'fill' | 'ask', engine?: AiEngineId | null): void {
  if (engine !== 'claude') return
  const now = Date.now()
  if (now - (lastWarm[kind] ?? 0) < 60_000) return
  lastWarm[kind] = now
  v2AiApi.warm([kind], engine ?? null).catch(() => {
    lastWarm[kind] = 0
  })
}
