/**
 * 角色头像请求：失败重试，以及设置里的「显示角色头像」开关。
 * 失败重试：
 * - 临时失败（断网 / 5xx / 429）按 1s、3s、9s 退避重试，成功就写缓存；
 * - 3 次重试都失败 → 本次会话记成「没头像」，但不写 localStorage（下次打开页面再试）；
 * - 404（没这个角色）是确定结果：马上缓存，不重试；
 * - 等重试期间重复请求同一个 id 不会插队。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const LS_KEY = 'outsetter.avatars.v1'
const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
const httpStatus = (code: number) => ({ ok: false, status: code, json: async () => ({}) }) as unknown as Response

/** 每个用例拿一份全新的模块（队列、计时器、缓存都是模块级状态）；avatars = 设置里「显示角色头像」开关的值；这里默认传 true，方便测请求逻辑（设置本身默认是关的） */
async function freshAvatar(avatars = true) {
  vi.resetModules()
  const { usePrefs } = await import('@/features/settings/store')
  usePrefs.setState({ avatars })
  const mod = await import('./avatar')
  return { ...mod, usePrefs }
}

describe('角色头像：失败重试', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('断网两次后成功：隔 1s、3s 重试，最后拿到头像并写进缓存', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(okJson({ images: { grid: 'https://lain.bgm.tv/g.jpg' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { useAvatarStore } = await freshAvatar()

    useAvatarStore.getState().request(42)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(useAvatarStore.getState().urls['42']).toBeUndefined()

    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock).toHaveBeenCalledTimes(1) // 不到 1 秒不重试
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    expect(useAvatarStore.getState().urls['42']).toBe('https://lain.bgm.tv/g.jpg')
    expect(JSON.parse(localStorage.getItem(LS_KEY)!)).toEqual({ '42': 'https://lain.bgm.tv/g.jpg' })
  })

  it('一直 503：重试 3 次（1s/3s/9s）后本次会话记成没头像，但不写进 localStorage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpStatus(503))
    vi.stubGlobal('fetch', fetchMock)
    const { useAvatarStore } = await freshAvatar()

    useAvatarStore.getState().request(7)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(3000)
    expect(useAvatarStore.getState().urls['7']).toBeUndefined() // 还在等第 3 次重试
    await vi.advanceTimersByTimeAsync(9000)
    expect(fetchMock).toHaveBeenCalledTimes(4) // 1 次 + 重试 3 次
    expect(useAvatarStore.getState().urls['7']).toBe('')
    expect(localStorage.getItem(LS_KEY)).toBeNull()

    // 已经有结论了：再请求也不会再发
    useAvatarStore.getState().request(7)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('404（没这个角色）是确定结果：马上缓存成没头像，不重试', async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpStatus(404))
    vi.stubGlobal('fetch', fetchMock)
    const { useAvatarStore } = await freshAvatar()

    useAvatarStore.getState().request(9)
    await vi.advanceTimersByTimeAsync(0)
    expect(useAvatarStore.getState().urls['9']).toBe('')
    expect(JSON.parse(localStorage.getItem(LS_KEY)!)).toEqual({ '9': '' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('等重试的时候重复请求同一个 id 不会插队；清空缓存后可以重新请求', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(okJson({ images: { small: 'https://lain.bgm.tv/s.jpg' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { useAvatarStore } = await freshAvatar()

    useAvatarStore.getState().request(5)
    await vi.advanceTimersByTimeAsync(0)
    useAvatarStore.getState().request(5) // 正在等 1s 的重试
    await vi.advanceTimersByTimeAsync(600)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(400)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(useAvatarStore.getState().urls['5']).toBe('https://lain.bgm.tv/s.jpg') // 没有 grid 就用 small

    useAvatarStore.getState().clear()
    expect(useAvatarStore.getState().urls).toEqual({})
    expect(localStorage.getItem(LS_KEY)).toBeNull()
    useAvatarStore.getState().request(5)
    await vi.advanceTimersByTimeAsync(500) // 节流：离上一次请求不到 500ms 时排队等一下
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

/** front 选项：正在看的头像插到队首，不用等后台预取的几百个排完 */
describe('角色头像：插队（front）', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  const idOf = (url: unknown) => Number(String(url).split('/').pop())

  it('front 插到队首；已经在排队的 id 再用 front 请求会挪到队首', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => okJson({ images: { grid: `https://lain.bgm.tv/${idOf(url)}.jpg` } }))
    vi.stubGlobal('fetch', fetchMock)
    const { useAvatarStore } = await freshAvatar()
    const req = useAvatarStore.getState().request
    req(1) // 马上发
    req(2)
    req(3)
    req(4) // 队列：2 3 4
    req(5, { front: true }) // 5 2 3 4
    req(4, { front: true }) // 4 5 2 3
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(500 * 5)
    expect(fetchMock.mock.calls.map((c) => idOf(c[0]))).toEqual([1, 4, 5, 2, 3])
    expect(useAvatarStore.getState().urls['4']).toBe('https://lain.bgm.tv/4.jpg')
  })

  it('不带 front 时排到队尾；正在请求的 id 用 front 再请求不会重复发', async () => {
    let resolveFirst!: (r: Response) => void
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((res) => (resolveFirst = res)))
      .mockImplementation(async (url: string) => okJson({ images: { grid: `g${idOf(url)}` } }))
    vi.stubGlobal('fetch', fetchMock)
    const { useAvatarStore } = await freshAvatar()
    const req = useAvatarStore.getState().request
    req(1) // 正在请求
    req(2)
    req(1, { front: true }) // 已经在请求中：不动、不重复
    req(3)
    await vi.advanceTimersByTimeAsync(0)
    resolveFirst(okJson({ images: { grid: 'g1' } }))
    await vi.advanceTimersByTimeAsync(500 * 3)
    expect(fetchMock.mock.calls.map((c) => idOf(c[0]))).toEqual([1, 2, 3])
    expect(useAvatarStore.getState().urls['1']).toBe('g1')
  })

  it('已经有结果的 id 用 front 请求也不会再发', async () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ '8': 'cached' }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { useAvatarStore } = await freshAvatar()
    useAvatarStore.getState().request(8, { front: true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(useAvatarStore.getState().urls['8']).toBe('cached')
  })
})

/** 设置里的「显示角色头像」：默认关；关着时哪个调用方来请求都不发网络请求 */
describe('角色头像：设置里的开关', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('开关默认是关的', async () => {
    const { DEFAULT_PREFS } = await import('@/features/settings/store')
    expect(DEFAULT_PREFS.avatars).toBe(false)
  })

  it('关着：request（含 front、一次排 1500 个）不发请求、不排队、不写缓存', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { useAvatarStore } = await freshAvatar(false)
    for (let id = 1; id <= 1500; id++) useAvatarStore.getState().request(id)
    useAvatarStore.getState().request(9, { front: true })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(useAvatarStore.getState().urls).toEqual({})
    expect(localStorage.getItem(LS_KEY)).toBeNull()
  })

  it('排队的时候关掉开关：队里剩下的不再发，也不再重试；重新打开后可以再请求', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch')) // 第 1 个会进入等重试
      .mockImplementation(async () => okJson({ images: { grid: 'g' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { useAvatarStore, usePrefs } = await freshAvatar(true)
    const req = useAvatarStore.getState().request
    req(1)
    req(2)
    req(3)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1) // 1 失败、等 1s 重试；2、3 在排队

    usePrefs.setState({ avatars: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(useAvatarStore.getState().urls).toEqual({})

    usePrefs.setState({ avatars: true })
    req(2)
    await vi.advanceTimersByTimeAsync(500)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(useAvatarStore.getState().urls['2']).toBe('g')
  })
})
