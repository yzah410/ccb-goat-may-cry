import { afterEach, describe, expect, it, vi } from 'vitest'
import { fmtCompact, fmtWeight, parseIntStrict, relativeTime, countLines, fmtYearSpan } from './format'
import { contrastRatio, ensureContrast, generateScale, hexToOklch, mixHex } from './color'
import { formatValidationDetail, request, type ApiError } from './apiClient'
import { groupWorkTags, splitCharTags } from './tags'
import { buildWallpaperList, getWallpaper, hasWallpaper, listWallpapers, pickDaily, requireWallpaper } from './wallpapers'
import { pageSpan, pageWindow, totalPagesOf } from '@/features/candidates/pagination'
import { suggestPlanName, validatePlanName } from '@/features/plans/api'

describe('format', () => {
  it('parseIntStrict：空 → null，非整数 → NaN', () => {
    expect(parseIntStrict('')).toBeNull()
    expect(parseIntStrict(' 42 ')).toBe(42)
    expect(parseIntStrict('-3')).toBe(-3)
    expect(parseIntStrict('1.5')).toBeNaN()
    expect(parseIntStrict('abc')).toBeNaN()
  })
  it('fmtCompact：万', () => {
    expect(fmtCompact(78218)).toBe('7.8 万')
    expect(fmtCompact(9999)).toBe('9,999')
    expect(fmtCompact(1_200_000)).toBe('120 万')
  })
  it('fmtWeight', () => {
    expect(fmtWeight(1)).toBe('1')
    expect(fmtWeight(0.5)).toBe('0.5')
    expect(fmtWeight(1.25)).toBe('1.25')
  })
  it('relativeTime', () => {
    const now = Date.parse('2026-06-11T12:00:00Z')
    expect(relativeTime('2026-06-11T11:59:30Z', now)).toBe('刚刚')
    expect(relativeTime('2026-06-11T11:50:00Z', now)).toBe('10 分钟前')
    expect(relativeTime('2026-06-10T11:00:00Z', now)).toBe('昨天')
  })
  it('countLines / fmtYearSpan', () => {
    expect(countLines('a\n\n b \n')).toBe(2)
    expect(fmtYearSpan(2022, 2022)).toBe('2022')
    expect(fmtYearSpan(2020, 2025)).toBe('2020–2025')
  })
})

describe('color', () => {
  it('对比度：黑白 21', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
  })
  it('色阶：浅色模式 50→900 越来越暗；深色模式反过来', () => {
    const light = generateScale('#3f6ea8')
    const L = (h: string) => hexToOklch(h).l
    expect(L(light[50])).toBeGreaterThan(L(light[500]))
    expect(L(light[500])).toBeGreaterThan(L(light[900]))
    const dark = generateScale('#3f6ea8', true)
    expect(L(dark[50])).toBeLessThan(L(dark[900]))
  })

  // 各种主色：鲜艳紫（base）、中蓝、亮黄、近黑、纯灰、近白、纯红
  const BASES = ['#6e56cf', '#3f6ea8', '#f5c400', '#1a1a1a', '#808080', '#f0f0f0', '#ff0000']
  const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const
  const L = (h: string) => hexToOklch(h).l
  for (const base of BASES) {
    it(`色阶 ${base}：浅色 10 档亮度严格递减，相邻两档亮度差都 ≥ 0.02`, () => {
      const s = generateScale(base)
      expect(Object.keys(s).map(Number)).toEqual([...STEPS])
      for (let i = 1; i < STEPS.length; i++) {
        const d = L(s[STEPS[i - 1]!]) - L(s[STEPS[i]!])
        expect(d, `${STEPS[i - 1]}→${STEPS[i]}`).toBeGreaterThanOrEqual(0.02)
      }
      expect(contrastRatio(s[800], s[50])).toBeGreaterThanOrEqual(4.5) // 「淡底 + 深字」
    })
    it(`色阶 ${base}：深色（反向）10 档亮度严格递增，50/100/200 是三个不同的颜色`, () => {
      const s = generateScale(base, true)
      expect(Object.keys(s).map(Number)).toEqual([...STEPS])
      for (let i = 1; i < STEPS.length; i++) {
        const d = L(s[STEPS[i]!]) - L(s[STEPS[i - 1]!])
        expect(d, `${STEPS[i - 1]}→${STEPS[i]}`).toBeGreaterThanOrEqual(0.02)
      }
      expect(new Set([s[50], s[100], s[200]]).size).toBe(3)
      expect(contrastRatio(s[800], s[50])).toBeGreaterThanOrEqual(4.5) // 深色里的「淡底 + 亮字」
    })
  }
  it('深色色阶和 base 手调的深色色阶差不多（每档亮度差 ≤ 0.03）', () => {
    const hand = { 50: '#19152b', 100: '#211b3b', 200: '#2c2452', 300: '#3a2f6e', 400: '#4d3f93', 500: '#6e56cf', 600: '#7d66d9', 700: '#9d8bef', 800: '#c1b4f7', 900: '#e6e0ff' }
    const s = generateScale('#6e56cf', true)
    for (const k of STEPS) expect(Math.abs(L(s[k]) - L(hand[k])), String(k)).toBeLessThanOrEqual(0.03)
  })
  it('ensureContrast 能把文字调到 ≥ 4.5', () => {
    const fg = ensureContrast('#c3d6ec', '#ffffff')
    expect(contrastRatio(fg, '#ffffff')).toBeGreaterThanOrEqual(4.5)
  })
  it('mixHex 两端', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff')
  })
})

describe('apiClient', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('422 的 detail 翻译成一句话', () => {
    const s = formatValidationDetail([{ loc: ['body', 'blocks', 0, 'params', 'years'], msg: 'Field required' }])
    expect(s).toBe('blocks → 第 1 个 → params → years：Field required')
  })
  it('404 → endpointMissing，message 优先用后端的 error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '方案不存在' }), { status: 404 })))
    await expect(request('/plans/x')).rejects.toMatchObject({ kind: 'http', status: 404, message: '方案不存在' })
    try {
      await request('/plans/x')
    } catch (e) {
      expect((e as ApiError).endpointMissing).toBe(true)
    }
  })
  it('/v2/* 接口的错误格式：优先用 message；detail 已经在 message 里的不再拼一遍，不在的补上', async () => {
    const body = (b: unknown, status = 422) => vi.fn(async () => new Response(JSON.stringify(b), { status }))
    vi.stubGlobal('fetch', body({ ok: false, error: 'bad_spec', message: '方案格式不对：范围 1 · 终点 50 比起点 51 还小', detail: ['范围 1 · 终点 50 比起点 51 还小'] }))
    await expect(request('/v2/evaluate')).rejects.toMatchObject({ message: '方案格式不对：范围 1 · 终点 50 比起点 51 还小' })
    vi.stubGlobal('fetch', body({ ok: false, error: 'bad_spec', message: '方案格式不对', detail: ['a', 'b', 'c'] }))
    await expect(request('/v2/evaluate')).rejects.toMatchObject({ message: '方案格式不对：a；b（还有 1 处）' })
    vi.stubGlobal('fetch', body({ ok: false, error: 'sql', message: 'SQL 跑不了', detail: 'no such table: x' }, 400))
    await expect(request('/v2/sql')).rejects.toMatchObject({ message: 'SQL 跑不了（no such table: x）' })
  })
  it('连不上 → network 错误，中文提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(request('/status')).rejects.toMatchObject({ kind: 'network' })
  })
  it('写请求带 X-Outsetter: 1（包括没有请求体的 POST），GET 不带', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', f)
    const headersOf = (i: number) => ((f.mock.calls[i] as unknown[])[1] as RequestInit).headers as Record<string, string> | undefined
    await request('/v2/evaluate', { method: 'POST', body: { a: 1 } })
    await request('/autoclick/cancel', { method: 'POST' })
    await request('/v2/plans/x', { method: 'DELETE' })
    await request('/v2/lists/l1', { method: 'PUT', body: {} })
    await request('/v2/lists')
    expect(headersOf(0)).toEqual({ 'Content-Type': 'application/json', 'X-Outsetter': '1' })
    expect(headersOf(1)).toEqual({ 'X-Outsetter': '1' })
    expect(headersOf(2)).toEqual({ 'X-Outsetter': '1' })
    expect(headersOf(3)).toEqual({ 'Content-Type': 'application/json', 'X-Outsetter': '1' })
    expect(headersOf(4)).toBeUndefined()
  })
  it('查询参数会被编码', async () => {
    const f = vi.fn(async () => new Response('{"items":[]}', { status: 200 }))
    vi.stubGlobal('fetch', f)
    await request('/tags', { query: { kind: 'work', q: '治愈', limit: 5, empty: '' } })
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain('/tags?kind=work&q=%E6%B2%BB%E6%84%88&limit=5')
  })
})

describe('tags', () => {
  it('作品标签按白名单顺序分组，其余进「更多」', () => {
    const g = groupWorkTags(['治愈', 'MAPPA', '日常', '间谍过家家', '热血', '2022', 'TV'])
    expect(g.genrePrimary).toEqual(['日常', '治愈'])
    expect(g.genreSecondary).toEqual(['热血'])
    expect(g.studios).toEqual(['MAPPA'])
    expect(g.other).toEqual(['间谍过家家'])
  })
  it('角色标签高亮', () => {
    expect(splitCharTags(['黑发', '学生会长'])).toEqual({ highlight: ['黑发'], rest: ['学生会长'] })
  })
})

describe('wallpapers', () => {
  it('壁纸是可选的：没有壁纸也能取，取不到的返回 undefined / false', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(Array.isArray(listWallpapers())).toBe(true)
    expect(getWallpaper('no-such-wallpaper')).toBeUndefined()
    expect(hasWallpaper('no-such-wallpaper')).toBe(false)
    expect(() => requireWallpaper('no-such-wallpaper')).toThrow()
    warn.mockRestore()
  })
  it('buildWallpaperList：清单不是数组 → 空列表；没有 slug 的项被跳过', () => {
    expect(buildWallpaperList(undefined)).toEqual([])
    expect(buildWallpaperList({ slug: 'a' })).toEqual([])
    expect(buildWallpaperList([null, 3, {}, { slug: '' }, { slug: 5 }])).toEqual([])
  })
  it('buildWallpaperList：只写 slug 也行，URL 和默认值自动补上', () => {
    const [w] = buildWallpaperList([{ slug: 'city-night' }])
    expect(w!.full).toMatch(/\/wallpapers\/full\/city-night\.webp$/)
    expect(w!.thumb).toMatch(/\/wallpapers\/thumb\/city-night\.webp$/)
    expect(w!.blurDataURL).toBe('')
    expect(w!.colors).toEqual([])
    expect(w!.tone).toBe('mid')
  })
  it('buildWallpaperList：写了的字段原样保留', () => {
    const [w] = buildWallpaperList([{ slug: 'x', colors: ['#000000'], tone: 'dark', blurDataURL: 'data:image/webp;base64,AAAA' }])
    expect(w!.colors).toEqual(['#000000'])
    expect(w!.tone).toBe('dark')
    expect(w!.blurDataURL.startsWith('data:image/webp;base64,')).toBe(true)
  })
  it('pickDaily：同一天同一个 key 结果固定', () => {
    const slugs = ['a', 'b', 'c', 'd']
    const d = new Date('2026-06-11T10:00:00')
    expect(pickDaily(slugs, 'workbench', d)).toBe(pickDaily(slugs, 'workbench', d))
    expect(slugs).toContain(pickDaily(slugs, 'workbench', d))
    expect(pickDaily([], 'x')).toBeUndefined()
  })
})

describe('分页', () => {
  it('总页数', () => {
    expect(totalPagesOf(0, 10)).toBe(1)
    expect(totalPagesOf(2786, 10)).toBe(279)
    expect(totalPagesOf(20, 20)).toBe(1)
  })
  it('页码窗口：最多 10 个，末尾往左补齐', () => {
    expect(pageWindow(1, 279)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(pageWindow(50, 279)).toEqual([45, 46, 47, 48, 49, 50, 51, 52, 53, 54])
    expect(pageWindow(279, 279)).toEqual([270, 271, 272, 273, 274, 275, 276, 277, 278, 279])
    expect(pageWindow(2, 3)).toEqual([1, 2, 3])
  })
  it('这一页是第几到第几个', () => {
    expect(pageSpan(1, 10, 2786)).toEqual([1, 10])
    expect(pageSpan(279, 10, 2786)).toEqual([2781, 2786])
    expect(pageSpan(1, 10, 0)).toEqual([0, 0])
  })
})

describe('方案名', () => {
  it('挡住路径符号、..、结尾点/空格', () => {
    expect(validatePlanName('0101-1200')).toBeNull()
    expect(validatePlanName('我的方案 v2')).toBeNull()
    expect(validatePlanName('')).not.toBeNull()
    expect(validatePlanName('../x')).not.toBeNull()
    expect(validatePlanName('a/b')).not.toBeNull()
    expect(validatePlanName('a..b')).not.toBeNull()
    expect(validatePlanName('abc.')).not.toBeNull()
  })
  it('默认名：月日-时分', () => {
    expect(suggestPlanName(new Date(2026, 8, 3, 7, 5))).toBe('0903-0705')
  })
})
