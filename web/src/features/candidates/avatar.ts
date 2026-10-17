/**
 * 角色头像懒加载（可选，默认关；设置页打开）。
 * 数据源：https://api.bgm.tv/v0/characters/{id} 的 images.grid；头像图片本身在 lain.bgm.tv。
 * - 开关：设置里的「显示角色头像」关着时，不排队、不请求、也不显示已缓存的头像（所有用到头像的地方都一样）
 * - 节流：全局一个队列，每 500ms 最多发 1 个请求（≤ 2 次/秒）
 * - 缓存：localStorage（最多 3000 条）。只存「确定的」结果：有头像的 URL，或确定没头像（''，包括 404 = 没这个角色）
 * - 临时失败（断网、10 秒超时、429 限流、5xx、返回的不是 JSON）：隔 1s / 3s / 9s 各重试一次；
 *   3 次都失败 → 本次页面会话里记成「没头像」，**不写** localStorage（下次打开页面还会再试）
 *   （失败的 id 会移出「排队中」，之后还能再请求；429/5xx 不会被当成「没头像」写进缓存）
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { usePrefs } from '@/features/settings/store'

const LS_KEY = 'outsetter.avatars.v1'
const MAX = 3000
const GAP_MS = 500
const TIMEOUT_MS = 10_000
/** 第 n 次重试前等多久（毫秒）；数组长度 = 最多重试几次 */
export const AVATAR_RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 9000]

function loadCache(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

function saveCache(c: Record<string, string>) {
  try {
    const keys = Object.keys(c)
    if (keys.length > MAX) for (const k of keys.slice(0, keys.length - MAX)) delete c[k]
    localStorage.setItem(LS_KEY, JSON.stringify(c))
  } catch {
    /* localStorage 满了就算了 */
  }
}

interface AvatarStore {
  /** id → 头像 URL；'' = 没头像（或者本次会话里重试用完了） */
  urls: Record<string, string>
  /**
   * 排队请求一个头像。opts.front = 插到队首（搜索下拉 / 表格里正在看的头像，
   * 不用等后台预取的几百个排完）。不传 = 排到队尾。
   */
  request: (id: number, opts?: { front?: boolean }) => void
  /** 清空缓存（设置页「清空头像缓存」） */
  clear: () => void
}

/** 写进 localStorage 的那一份：只有确定的结果 */
let persisted: Record<string, string> = typeof localStorage !== 'undefined' ? loadCache() : {}
const queue: number[] = []
/** 在队列里、或者正在请求中的 id */
const queued = new Set<number>()
/** 正在等退避重试的 id → 计时器 */
const retryTimers = new Map<number, ReturnType<typeof setTimeout>>()
/** 每个 id 连续临时失败了几次 */
const failures = new Map<number, number>()
let timer: ReturnType<typeof setTimeout> | null = null

/** 设置里的「显示角色头像」开关 */
function avatarsEnabled(): boolean {
  return usePrefs.getState().avatars
}

export const useAvatarStore = create<AvatarStore>((set, get) => ({
  urls: { ...persisted },
  request: (id, opts) => {
    if (!avatarsEnabled()) return
    if (String(id) in get().urls || retryTimers.has(id)) return
    if (queued.has(id)) {
      if (opts?.front) moveToFront(id)
      return
    }
    enqueue(id, opts?.front)
  },
  clear: () => {
    persisted = {}
    try {
      localStorage.removeItem(LS_KEY)
    } catch {
      /* 忽略 */
    }
    for (const t of retryTimers.values()) clearTimeout(t)
    retryTimers.clear()
    failures.clear()
    set({ urls: {} })
  },
}))

function enqueue(id: number, front = false): void {
  queued.add(id)
  if (front) queue.unshift(id)
  else queue.push(id)
  pump()
}

/** 还在排队（没开始请求）的 id 挪到队首；已经在请求中的不用管 */
function moveToFront(id: number): void {
  const i = queue.indexOf(id)
  if (i > 0) {
    queue.splice(i, 1)
    queue.unshift(id)
  }
}

/** 开关关掉时：还在排队的、等重试的都放弃（正在请求中的那一个让它自己结束） */
function dropPending(): void {
  for (const id of queue) queued.delete(id)
  queue.length = 0
  for (const t of retryTimers.values()) clearTimeout(t)
  retryTimers.clear()
  failures.clear()
}

function pump(): void {
  if (timer !== null) return
  if (!avatarsEnabled()) {
    dropPending()
    return
  }
  const next = queue.shift()
  if (next === undefined) return
  timer = setTimeout(() => {
    timer = null
    pump()
  }, GAP_MS)
  void fetchOne(next)
}

type Outcome = { final: true; url: string } | { final: false }

async function fetchOne(id: number): Promise<void> {
  let outcome: Outcome
  try {
    const r = await fetch(`https://api.bgm.tv/v0/characters/${id}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (r.ok) {
      const j = (await r.json()) as { images?: { grid?: string; small?: string } } | null
      outcome = { final: true, url: j?.images?.grid || j?.images?.small || '' }
    } else if (r.status === 404) {
      outcome = { final: true, url: '' } // 没有这个角色：确定没头像
    } else {
      outcome = { final: false } // 429 限流、5xx：临时的
    }
  } catch {
    outcome = { final: false } // 断网 / 超时 / 返回的不是 JSON
  } finally {
    queued.delete(id)
  }

  if (outcome.final) {
    failures.delete(id)
    record(id, outcome.url, true)
    return
  }
  const n = (failures.get(id) ?? 0) + 1
  const delay = AVATAR_RETRY_DELAYS_MS[n - 1]
  if (delay === undefined) {
    // 重试用完：本次会话记成「没头像」，不写 localStorage（下次打开页面再试）
    failures.delete(id)
    record(id, '', false)
    return
  }
  failures.set(id, n)
  retryTimers.set(
    id,
    setTimeout(() => {
      retryTimers.delete(id)
      enqueue(id)
    }, delay),
  )
}

function record(id: number, url: string, persist: boolean): void {
  const key = String(id)
  useAvatarStore.setState((s) => ({ urls: { ...s.urls, [key]: url } }))
  if (persist) {
    persisted = { ...persisted, [key]: url }
    saveCache(persisted)
  }
}

/**
 * 取某个角色的头像 URL；enabled=false 或设置里的「显示角色头像」关着时不请求，也不返回已缓存的地址
 * （显示 <img> 本身就是一次对 lain.bgm.tv 的请求）。返回 undefined = 还不知道（或者开关关着），'' = 没头像。
 * front = 插队（见 request）。
 */
export function useBgmAvatar(id: number | null | undefined, enabled: boolean, front = false): string | undefined {
  const avatarsOn = usePrefs((s) => s.avatars)
  const active = enabled && avatarsOn
  const url = useAvatarStore((s) => (id == null ? undefined : s.urls[String(id)]))
  const request = useAvatarStore((s) => s.request)
  useEffect(() => {
    if (active && id != null && url === undefined) request(id, front ? { front: true } : undefined)
  }, [active, id, url, request, front])
  return active ? url : undefined
}
