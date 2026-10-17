/**
 * 标签笔记前端：接口封装、方案库纯逻辑、本地偏好、token 映射、引擎胶水（假引擎）。
 * vitest 跑在 node 环境（没有 DOM），引擎本身的绘制在浏览器里用 playwright 查。
 */
import fs from 'node:fs'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/apiClient'
import { generateErrorInfo, tagnoteApi } from './api'
import { DEFAULT_PREFS, TagNoteBinding, bgmSubjectUrl, sanitizePrefs, spaceBelow, type EngineLike } from './binding'
import { MAP_KEYS, makeLayoutSave } from './hooks'
import {
  CROWDED_WORKS,
  buildGroups,
  createDebouncedSaver,
  flatOrder,
  generateErrorText,
  matchesTerms,
  neighborAfterDelete,
  noteFilename,
  sourceCounts,
  sourceMeta,
  withTitleAndLayout,
} from './library'
import { TAGNOTE_STORE_KEY, useTagNoteLocal, useTagNotePreview } from './store'
import { FRAME_VARS, HOST_VARS, TN_ENGINE_OWNED, TN_TOKEN_MAP, relayName } from './tokens'
import { wsActions } from './workspace/actions'
import { activeTabOf, emptyWorkspace } from './workspace/tree'
import { useCanvasTab } from '@/features/canvas/store'
import type { MountOptions, TagNoteData, TagNoteInstance, TagNotePrefs } from '@/vendor/tagnote/tagnote.esm.js'
import type { MapDetail, MapSummary } from './types'

// ---------------------------------------------------------------- 工具
const summary = (p: Partial<MapSummary> & { id: string }): MapSummary => ({
  title: p.id,
  source: 'outsetter',
  group: null,
  origin: null,
  n_works: 3,
  common_tags: [],
  tags_from: 'map',
  generated_at: '2026-10-10',
  updated_at: '2026-10-10T00:00:00Z',
  ...p,
})

const data = (title = '测试图', works = 2): TagNoteData => ({
  schema: 'tagnote/1',
  collection: { title, source: 'outsetter' },
  works: Array.from({ length: works }, (_, i) => ({ id: String(100 + i), title: `作品${i}`, tags: ['TV'], subject_id: 100 + i })),
})

interface Call {
  url: string
  method: string
  body: unknown
}

function mockFetch(respond: (c: Call) => Response) {
  const calls: Call[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const c = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    return respond(c)
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = orig) }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// ---------------------------------------------------------------- 接口
describe('tagnoteApi：请求方法、路径、请求体', () => {
  let m: ReturnType<typeof mockFetch>
  afterEach(() => m?.restore())

  it('GET /v2/maps：认 {items: [...]}', async () => {
    m = mockFetch(() => json({ items: [summary({ id: 'm_1' })] }))
    const list = await tagnoteApi.list()
    expect(list.map((x) => x.id)).toEqual(['m_1'])
    expect(m.calls[0]).toMatchObject({ method: 'GET' })
    expect(m.calls[0].url).toMatch(/\/v2\/maps$/)
  })

  it('PATCH /v2/maps/{id}：方法真的是 PATCH，只带要改的字段；id 做 URL 编码', async () => {
    m = mockFetch(() => json(summary({ id: 'm 1', title: '新名字' })))
    const r = await tagnoteApi.patch('m 1', { title: '新名字' })
    expect(r.title).toBe('新名字')
    expect(m.calls[0].method).toBe('PATCH')
    expect(m.calls[0].url).toMatch(/\/v2\/maps\/m%201$/)
    expect(m.calls[0].body).toEqual({ title: '新名字' })
  })

  it('DELETE 返回 204 空正文：不报解析错误', async () => {
    m = mockFetch(() => new Response(null, { status: 204 }))
    await expect(tagnoteApi.remove('m_1')).resolves.toBeUndefined()
    expect(m.calls[0].method).toBe('DELETE')
  })

  it('POST /v2/tagnote：带 spec、title、tag_mode', async () => {
    m = mockFetch(() => json(data()))
    await tagnoteApi.generate({ spec: { game: {} }, title: '我的方案', tag_mode: 'full' })
    expect(m.calls[0].method).toBe('POST')
    expect(m.calls[0].url).toMatch(/\/v2\/tagnote$/)
    expect(m.calls[0].body).toEqual({ spec: { game: {} }, title: '我的方案', tag_mode: 'full' })
  })

  it('POST /v2/maps 包一层 {data}；笔记下载按 blob 读', async () => {
    m = mockFetch((c) => (c.url.endsWith('/note') ? new Response('# 笔记', { status: 200 }) : json(summary({ id: 'm_new' }), 201)))
    const s = await tagnoteApi.create(data('存一张'))
    expect(s.id).toBe('m_new')
    expect(m.calls[0].body).toEqual({ data: data('存一张') })
    const blob = await tagnoteApi.noteFromData(data())
    expect(await blob.text()).toBe('# 笔记')
    expect(m.calls[1].url).toMatch(/\/v2\/tagnote\/note$/)
    const blob2 = await tagnoteApi.note('m_1')
    expect(await blob2.text()).toBe('# 笔记')
    expect(m.calls[2]).toMatchObject({ method: 'GET' })
  })

  it('409 的三种情况拆得开；说法和导出 .canvas 一致', async () => {
    m = mockFetch(() => json({ ok: false, error: 'too_many_works', message: '作品太多', count: 123, limit: 80 }, 409))
    const e1 = await tagnoteApi.generate({ spec: {}, title: 't', tag_mode: 'map' }).catch((e: unknown) => e)
    const i1 = generateErrorInfo(e1)
    expect(i1).toMatchObject({ code: 'too_many_works', count: 123, limit: 80 })
    expect(generateErrorText(i1)).toBe('合并后有 123 部作品，标签笔记最多 80 部。')

    const i2 = generateErrorInfo(new ApiError({ kind: 'http', status: 409, path: '/v2/tagnote', message: 'x', detail: { error: 'empty_pool' } }))
    expect(i2.code).toBe('empty_pool')
    expect(generateErrorText(i2)).toBe('候选池为空，先放宽筛选范围。')

    const i3 = generateErrorInfo(
      new ApiError({ kind: 'http', status: 409, path: '/v2/tagnote', message: 'x', detail: { error: 'spec_has_errors', errors: [{ message: '范围 1 没有作品' }, { message: '范围 2 年份不对' }] } }),
    )
    expect(i3).toMatchObject({ code: 'spec_has_errors', messages: ['范围 1 没有作品', '范围 2 年份不对'] })
    expect(generateErrorText(i3)).toBe('先修好方案中没生效的部分：范围 1 没有作品；范围 2 年份不对')

    const i4 = generateErrorInfo(new ApiError({ kind: 'network', path: '/v2/tagnote', message: '连不上后端' }))
    expect(i4).toEqual({ code: 'other', message: '连不上后端' })
  })
})

// ---------------------------------------------------------------- 方案库纯逻辑
describe('方案库：分组、搜索、删除后选谁', () => {
  const items = [
    summary({ id: 'o1', title: '新建的一张', source: 'outsetter', generated_at: '2026-10-01' }),
    summary({ id: 'c1', title: '1960 题材甲', source: 'batch', group: '1959-1978', common_tags: ['机器人'] }),
    summary({ id: 'a1', title: '2018 题材乙 日常or搞笑', source: 'manual', group: '2018', common_tags: ['百合'] }),
    summary({ id: 'a2', title: '2018 运动', source: 'manual', group: '2018', common_tags: ['运动'] }),
    summary({ id: 'c2', title: '2018 战斗', source: 'batch', group: '2018' }),
    summary({ id: 'c3', title: '2015-2018 猎奇', source: 'batch', group: '2015-2018' }),
    summary({ id: 'a3', title: '2019 题材乙', source: 'manual', group: '2019', common_tags: ['百合'] }),
    summary({ id: 'o2', title: '新建的另一张', source: 'outsetter', generated_at: '2026-10-09' }),
    summary({ id: 'x1', title: '奇怪来源', source: 'somewhere' }),
  ]

  it('新的在上：在这里新建的放最上面（新生成的在前）；图少的年代整个一组；没有年份的放最下面', () => {
    const groups = buildGroups(items)
    expect(groups.map((g) => [g.key, g.label, g.kind])).toEqual([
      ['new', '在这里新建的', 'new'],
      ['d2010-2019', '2010–2019', 'span'],
      ['d1950-1959', '1950–1959', 'span'], // 和 2010 年代中间隔着空年代，不并
      ['none', '没有年份', 'none'],
    ])
    // 年份组里：精选样例在前；同来源里起始年份新的在前，同年按标题
    expect(flatOrder(groups).map((m) => m.id)).toEqual(['o2', 'o1', 'a3', 'a1', 'a2', 'c2', 'c3', 'c1', 'x1'])
  })

  it('图多的年代按年分组；很早、很少的几个相邻年代并成一组；「1998-2002」算 1998', () => {
    const many: MapSummary[] = []
    for (let y = 2020; y <= 2025; y++) for (let i = 0; i < 5; i++) many.push(summary({ id: `y${y}_${i}`, source: 'manual', group: String(y) }))
    const add = (id: string, group: string) => many.push(summary({ id, source: 'batch', group }))
    add('s60a', '1963')
    add('s60b', '1968-1976')
    add('s70a', '1971')
    add('s70b', '1972')
    add('s80a', '1980-1989')
    add('s80b', '1983')
    add('s80c', '1984')
    for (let i = 0; i < 7; i++) add(`s90_${i}`, '1990-1994')
    add('s98', '1998-2002')
    const groups = buildGroups(many)
    expect(groups.map((g) => [g.key, g.items.length])).toEqual([
      ['y2025', 5],
      ['y2024', 5],
      ['y2023', 5],
      ['y2022', 5],
      ['y2021', 5],
      ['y2020', 5],
      ['d1990-1999', 8],
      ['d1960-1989', 7],
    ])
    expect(groups.find((g) => g.key === 'd1960-1989')?.label).toBe('1960–1989')
    expect(groups.find((g) => g.key === 'y2024')?.kind).toBe('year')
  })

  it('来源筛选：组的划分不变，只是筛掉别的来源，空了的组不显示；来源计数按固定顺序', () => {
    const batch = buildGroups(items, { source: 'batch' })
    expect(batch.map((g) => [g.key, g.items.map((m) => m.id)])).toEqual([
      ['d2010-2019', ['c2', 'c3']],
      ['d1950-1959', ['c1']],
    ])
    expect(sourceCounts(items).map((c) => [c.source, c.count, c.meta.short])).toEqual([
      ['manual', 3, '精选样例'],
      ['batch', 3, '补充样例'],
      ['outsetter', 2, '在这里新建'],
      ['somewhere', 1, '其它来源'],
    ])
  })

  it('搜索：标题或共有标签；多个词都要命中；不分大小写；可以和来源筛选一起用', () => {
    const ids = (opts: { query?: string; source?: string }) => flatOrder(buildGroups(items, opts)).map((m) => m.id)
    expect(ids({ query: '百合' })).toEqual(['a3', 'a1'])
    expect(ids({ query: '2018 百合' })).toEqual(['a1'])
    expect(ids({ query: '机器人' })).toEqual(['c1'])
    expect(ids({ query: '2018', source: 'batch' })).toEqual(['c2', 'c3'])
    expect(matchesTerms({ title: 'ABC', common_tags: [] }, ['abc'])).toBe(true)
    expect(buildGroups(items, { query: '没有这个' })).toEqual([])
  })

  it('样例导图的删除说明写明样例文件不受影响、可以重新载入；新建的说明不能恢复', () => {
    for (const source of ['manual', 'batch']) {
      expect(sourceMeta(source).deleteNote).toContain('examples/maps/')
      expect(sourceMeta(source).deleteNote).toContain('「载入全部样例导图」')
    }
    expect(sourceMeta('outsetter').deleteNote).toContain('不能恢复')
    expect(sourceMeta(null).label).toBe('其它来源')
  })

  it('删除后选下一张；删的是最后一张就选上一张；删光了是 null', () => {
    const order = flatOrder(buildGroups(items))
    expect(neighborAfterDelete(order, 'a2')).toBe('c2')
    expect(neighborAfterDelete(order, 'x1')).toBe('c1')
    expect(neighborAfterDelete([summary({ id: 'only' })], 'only')).toBeNull()
  })

  it('笔记文件名和后端 note_filename 一致（样例由后端 Python 算出）', () => {
    const cases: [string, string][] = [
      ['2018 题材乙 日常or搞笑', '2018 题材乙 日常or搞笑.md'],
      ['a/b:c*?"<>|#^[x]', 'a b c x.md'],
      ['  点结尾...  ', '点结尾.md'],
      ['', '标签笔记.md'],
      ['###', '标签笔记.md'],
      ['tab\there  多  空格', 'tab here 多 空格.md'],
      ['x'.repeat(130), 'x'.repeat(120) + '.md'],
      ['a .', 'a .md'],
    ]
    for (const [title, want] of cases) expect(noteFilename(title)).toBe(want)
  })

  it('存进方案库前：换标题、合并引擎的布局缓存；没有布局就不带 layout_cache', () => {
    const d = data('原名')
    const out = withTitleAndLayout(d, '新名', { terr: { sig: 's', cols: 2, rows: 1, pos: { '100': [0, 0] } } })
    expect(out.collection?.title).toBe('新名')
    expect(out.collection?.source).toBe('outsetter')
    expect(out.layout_cache?.terr?.sig).toBe('s')
    expect(d.collection?.title).toBe('原名') // 不改原对象
    expect('layout_cache' in withTitleAndLayout(d, '新名', {})).toBe(false)
  })
})

describe('布局缓存防抖保存', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('同一张图 0.8 秒内只存最后一次；不同的图各存各的；flush 立刻存', () => {
    const saved: [string, unknown][] = []
    const s = createDebouncedSaver((id, cache) => saved.push([id, cache]), 800)
    s.schedule('m1', { a: 1 })
    s.schedule('m1', { a: 2 })
    s.schedule('m2', { b: 1 })
    vi.advanceTimersByTime(799)
    expect(saved).toEqual([])
    vi.advanceTimersByTime(1)
    expect(saved).toEqual([
      ['m1', { a: 2 }],
      ['m2', { b: 1 }],
    ])
    s.schedule('m1', { a: 3 })
    expect(s.pending()).toEqual(['m1'])
    s.flush()
    expect(saved.at(-1)).toEqual(['m1', { a: 3 }])
    expect(s.pending()).toEqual([])
  })

  it('删除前 cancel：这张图还没存的布局不再 PATCH，别的图照常存', () => {
    const saved: string[] = []
    const s = createDebouncedSaver((id) => saved.push(id), 800)
    s.schedule('gone', { a: 1 })
    s.schedule('kept', { b: 1 })
    s.cancel('gone')
    s.cancel('never-scheduled')
    vi.advanceTimersByTime(800)
    s.flush()
    expect(saved).toEqual(['kept'])
  })

  it('同一张图只认最后发出的请求：离开方案库再回来（hook 新建）以后，旧请求晚回来也不覆盖新布局', async () => {
    const qc = new QueryClient()
    qc.setQueryData(MAP_KEYS.detail('m1'), { id: 'm1', updated_at: '', works: [], layout_cache: {} } as MapDetail)
    const answer: (() => void)[] = []
    const patch = () => new Promise<MapSummary>((ok) => answer.push(() => ok({} as MapSummary)))
    const tick = async () => {
      for (let i = 0; i < 3; i++) await Promise.resolve()
    }
    const before = makeLayoutSave(qc, patch) // 离开前的页面
    const after = makeLayoutSave(qc, patch) // 回来以后
    before('m1', { a: 'A' })
    after('m1', { a: 'B' })
    answer[1]() // 新的先回来
    await tick()
    answer[0]() // 旧的晚回来
    await tick()
    expect(qc.getQueryData<MapDetail>(MAP_KEYS.detail('m1'))?.layout_cache).toEqual({ a: 'B' })
  })
})

// ---------------------------------------------------------------- 本地偏好
describe('本地偏好：换图、刷新后保持；字号固定 1', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    localStorage.clear()
    useTagNoteLocal.setState({ workspace: emptyWorkspace() })
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

  it('sanitizePrefs：字号固定 1（存着别的档位也读成 1）；视图只认六个内置的', () => {
    expect(sanitizePrefs({ scale: 0.5 }).scale).toBe(1)
    expect(sanitizePrefs({ scale: 0.92 }).scale).toBe(1)
    expect(sanitizePrefs({ scale: 1.12 }).scale).toBe(1)
    expect(sanitizePrefs({ view: 'terr' }).view).toBe('terr')
    expect(sanitizePrefs({ view: 'nope' }).view).toBeNull()
    expect(sanitizePrefs(null)).toEqual(DEFAULT_PREFS)
  })

  it('写进 localStorage，读回来一样；坏数据回默认值', async () => {
    const st = useTagNoteLocal.getState()
    st.setPrefs({ cover: false, scale: 1.12, color: false, drawer: true, view: 'kmap' })
    wsActions.open('m_abc')
    st.toggleGroup('y2018')
    st.setSourceFilter('batch')
    st.setTagMode('full')
    const raw = JSON.parse(localStorage.getItem(TAGNOTE_STORE_KEY) ?? '{}')
    expect(raw.state.prefs).toEqual({ cover: false, scale: 1, color: false, drawer: true, view: 'kmap' })
    expect(raw.state.workspace.tabs.t2).toMatchObject({ mapId: 'm_abc', view: 'kmap' })
    expect(raw.state.openGroups).toEqual(['y2018'])
    expect(raw.state.sourceFilter).toBe('batch')
    expect(raw.state.tagMode).toBe('full')

    useTagNoteLocal.setState({ prefs: { ...DEFAULT_PREFS }, workspace: emptyWorkspace(), openGroups: [], sourceFilter: 'all', tagMode: 'map' })
    localStorage.setItem(TAGNOTE_STORE_KEY, JSON.stringify(raw))
    await useTagNoteLocal.persist.rehydrate()
    expect(useTagNoteLocal.getState().prefs.view).toBe('kmap')
    expect(activeTabOf(useTagNoteLocal.getState().workspace)?.mapId).toBe('m_abc')
    expect(useTagNoteLocal.getState().openGroups).toEqual(['y2018'])
    expect(useTagNoteLocal.getState().sourceFilter).toBe('batch')

    // 手改出来的字号 0.5 → 读回来是 1；tagMode 不合法 → 用默认值 map
    useTagNoteLocal.setState({ tagMode: 'map' })
    localStorage.setItem(
      TAGNOTE_STORE_KEY,
      JSON.stringify({ version: 1, state: { prefs: { cover: true, scale: 0.5, color: true, drawer: false, view: null }, openGroups: [], tagMode: '乱写' } }),
    )
    await useTagNoteLocal.persist.rehydrate()
    expect(useTagNoteLocal.getState().prefs.scale).toBe(1)
    expect(useTagNoteLocal.getState().tagMode).toBe('map')
  })

  it('列表收起状态会记住', () => {
    useTagNoteLocal.getState().setListCollapsed(true)
    expect(JSON.parse(localStorage.getItem(TAGNOTE_STORE_KEY) ?? '{}').state.listCollapsed).toBe(true)
  })

  it('展开分组可以来回切', () => {
    useTagNoteLocal.setState({ openGroups: [] })
    useTagNoteLocal.getState().toggleGroup('g')
    expect(useTagNoteLocal.getState().openGroups).toEqual(['g'])
    useTagNoteLocal.getState().toggleGroup('g')
    expect(useTagNoteLocal.getState().openGroups).toEqual([])
  })

  it('换选中的图时只追加展开的分组，不收起已展开的', () => {
    useTagNoteLocal.setState({ openGroups: ['a'] })
    useTagNoteLocal.getState().openGroup('a', 'b', 'b')
    expect(useTagNoteLocal.getState().openGroups).toEqual(['a', 'b'])
    useTagNoteLocal.getState().openGroup()
    expect(useTagNoteLocal.getState().openGroups).toEqual(['a', 'b'])
  })

  it('导图导出页的标签：默认方案库，记住上次选的，坏值回方案库', async () => {
    expect(useCanvasTab.getState().tab).toBe('library')
    useCanvasTab.getState().setTab('export')
    expect(JSON.parse(localStorage.getItem('outsetter.canvas-tab.v1') ?? '{}').state).toEqual({ tab: 'export' })
    localStorage.setItem('outsetter.canvas-tab.v1', JSON.stringify({ version: 1, state: { tab: 'xx' } }))
    useCanvasTab.setState({ tab: 'new' })
    await useCanvasTab.persist.rehydrate()
    expect(useCanvasTab.getState().tab).toBe('new') // 不合法 → 保留当前值（默认值）
  })

  it('预览：每次生成序号递增（包装组件据此 setData）', () => {
    const p = useTagNotePreview.getState()
    p.setPreview({ data: data(), poolKey: 'k', tagMode: 'map' }, 'a')
    const s1 = useTagNotePreview.getState().preview?.seq ?? 0
    p.setPreview({ data: data(), poolKey: 'k', tagMode: 'map' }, 'a')
    expect(useTagNotePreview.getState().preview?.seq).toBe(s1 + 1)
    p.clear()
    expect(useTagNotePreview.getState().preview).toBeNull()
    expect(CROWDED_WORKS).toBe(30)
  })
})

// ---------------------------------------------------------------- token 映射
describe('token 映射：全是变量引用，不写死颜色，不碰标签配色', () => {
  const HARD_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(/i

  it('每个 --tn-* 的取值只引用出题器主题的 token', () => {
    for (const d of TN_TOKEN_MAP) {
      expect(d.tn).toMatch(/^--tn-/)
      expect(d.value).not.toMatch(HARD_COLOR)
      expect(d.value).toMatch(/var\(--/)
    }
  })

  it('覆盖到底色、画板底、卡片、文字三级、线两级、强调色、连线、字体、吸顶偏移', () => {
    const keys = TN_TOKEN_MAP.map((d) => d.tn)
    for (const k of ['--tn-paper', '--tn-paper-2', '--tn-card', '--tn-ink', '--tn-ink-2', '--tn-ink-3', '--tn-line', '--tn-line-2', '--tn-accent', '--tn-edge', '--tn-f-body', '--tn-f-display', '--tn-f-mono', '--tn-sticky-top'])
      expect(keys).toContain(k)
  })

  it('标签色相 / 写法相关的变量不覆盖（荧光笔、字色、领地线由引擎按明暗切换）', () => {
    const keys = new Set([...TN_TOKEN_MAP.map((d) => d.tn), ...Object.keys(HOST_VARS)])
    for (const k of TN_ENGINE_OWNED) expect(keys.has(k)).toBe(false)
  })

  it('两层：外框写 --tnv-*（解析出题器主题的 token），挂载元素写 --tn-*: var(--tnv-*)', () => {
    for (const d of TN_TOKEN_MAP) {
      expect((FRAME_VARS as Record<string, string>)[relayName(d.tn)]).toBe(d.value)
      expect((HOST_VARS as Record<string, string>)[d.tn]).toBe(`var(${relayName(d.tn)})`)
    }
    expect((HOST_VARS as Record<string, string>)['--tn-drawer-max']).toContain('var(--tnv-scroll-h')
    // 挂载元素上不直接引用出题器主题的 token：引擎会在它上面写 data-theme，出题器的 [data-theme] 默认值会把 token 重置掉
    for (const v of Object.values(HOST_VARS as Record<string, string>)) expect(v).not.toMatch(/var\(--(?!tnv-|tn-)/)
  })

  it('引用的出题器主题 token 在 tokens.base.css 里都有定义（任何主题都有兜底值）', () => {
    const css = fs.readFileSync(new URL('../../styles/tokens.base.css', import.meta.url), 'utf8')
    const used = new Set<string>()
    for (const d of TN_TOKEN_MAP) for (const m of d.value.matchAll(/var\((--[\w-]+)/g)) used.add(m[1])
    used.delete('--shell-sticky-top') // 外壳变量，带了 0px 兜底
    for (const t of used) expect(css, t).toContain(`${t}:`)
  })
})

// ---------------------------------------------------------------- 引擎胶水（假引擎）
function fakeEngine() {
  const log: string[] = []
  let opts: MountOptions = {}
  let prefs: TagNotePrefs = { ...DEFAULT_PREFS }
  let cache: Record<string, unknown> = {}
  const inst = {
    host: {} as HTMLElement,
    view: 'canvas',
    M: null,
    setView: (k: string) => log.push(`setView:${k}`),
    setData: (d: TagNoteData) => log.push(`setData:${d.collection?.title}`),
    setPrefs: (p: Partial<TagNotePrefs>) => {
      prefs = { ...prefs, ...p }
      log.push(`setPrefs:${JSON.stringify(p)}`)
    },
    setTheme: (t: string) => log.push(`setTheme:${t}`),
    rerender: () => log.push('rerender'),
    getPrefs: () => ({ ...prefs }),
    getLayoutCache: () => JSON.parse(JSON.stringify(cache)),
    destroy: () => log.push('destroy'),
    getViewport: (k?: string) => (k === 'none' ? null : { zoom: 2, cx: 1, cy: 2 }),
    setViewport: (vp: unknown, k?: string) => log.push(`setViewport:${JSON.stringify(vp)}:${k ?? ''}`),
    setHostFull: (on: boolean) => log.push(`setHostFull:${on}`),
  } as unknown as TagNoteInstance
  const engine: EngineLike = {
    mount: (_el, d, o) => {
      opts = o ?? {}
      prefs = { ...DEFAULT_PREFS, ...(o?.prefs ?? {}) } as TagNotePrefs
      log.push(`mount:${d.collection?.title}`)
      return inst
    },
  }
  return {
    engine,
    log,
    opts: () => opts,
    setCache: (c: Record<string, unknown>) => (cache = c),
  }
}

describe('TagNoteBinding（假引擎）', () => {
  it('挂载一次：带工具栏、主题明暗、整理过的偏好', () => {
    const f = fakeEngine()
    new TagNoteBinding(f.engine, {} as HTMLElement, { data: data('A'), theme: 'dark', prefs: { scale: 0.3, view: 'terr' } })
    expect(f.log).toEqual(['mount:A'])
    expect(f.opts()).toMatchObject({ toolbar: true, theme: 'dark', notes: false })
    expect(f.opts().prefs).toMatchObject({ scale: 1, view: 'terr' })
  })

  it('setData 按 key 去重；setTheme 只在变了时调；destroy 只调一次', () => {
    const f = fakeEngine()
    const b = new TagNoteBinding(f.engine, {} as HTMLElement, { data: data('A'), theme: 'light' }, 'k1')
    b.setData(data('A'), 'k1')
    b.setData(data('B'), 'k2')
    b.setData(data('B'), 'k2')
    b.setTheme('light')
    b.setTheme('dark')
    b.setTheme('dark')
    b.destroy()
    b.destroy()
    b.setData(data('C'), 'k3')
    expect(f.log).toEqual(['mount:A', 'setData:B', 'setTheme:dark', 'destroy'])
    expect(b.alive).toBe(false)
    expect(b.getLayoutCache()).toEqual({})
  })

  it('偏好变化 → 回调（整理过）；引擎报上来的字号不是 1 就改回 1', () => {
    const f = fakeEngine()
    const got: TagNotePrefs[] = []
    new TagNoteBinding(f.engine, {} as HTMLElement, { data: data(), theme: 'light', onPrefsChange: (p) => got.push(p) })
    f.opts().onPrefsChange?.({ cover: false, scale: 1, color: true, drawer: true, view: 'score' })
    expect(f.log.filter((l) => l.startsWith('setPrefs'))).toEqual([])
    f.opts().onPrefsChange?.({ cover: false, scale: 0.8, color: true, drawer: true, view: 'score' })
    expect(got.map((p) => p.scale)).toEqual([1, 1])
    expect(got[0]).toMatchObject({ cover: false, drawer: true, view: 'score' })
    expect(f.log).toContain('setPrefs:{"scale":1}')
  })

  it('领地图新布局 → 回调里带上引擎完整的布局缓存', () => {
    const f = fakeEngine()
    const got: unknown[] = []
    new TagNoteBinding(f.engine, {} as HTMLElement, { data: data(), theme: 'light', onLayoutCache: (kind, _v, full) => got.push([kind, full]) })
    f.setCache({ terr: { sig: 'x' } })
    f.opts().onLayoutCache?.('terr', { sig: 'x' })
    expect(got).toEqual([['terr', { terr: { sig: 'x' } }]])
  })

  it("不传 layout（'page'，新建标签笔记的预览）：挂载参数里不带工作区专用的选项", () => {
    const f = fakeEngine()
    new TagNoteBinding(f.engine, {} as HTMLElement, { data: data(), theme: 'light' })
    for (const k of ['layout', 'fullscreen', 'onFullRequest', 'viewports', 'onViewportChange', 'onFocusTakeover']) expect(f.opts()).not.toHaveProperty(k)
  })

  it('用户接管（onFocusTakeover）：给了才传给引擎；引擎回调时用最新的函数', () => {
    const f = fakeEngine()
    const got: string[] = []
    const b = new TagNoteBinding(f.engine, {} as HTMLElement, { data: data(), theme: 'light', layout: 'pane', onFocusTakeover: (r) => got.push(`old:${r}`) })
    b.update({ onFocusTakeover: (r) => got.push(`new:${r}`) })
    f.opts().onFocusTakeover?.('esc')
    f.opts().onFocusTakeover?.('pin')
    expect(got).toEqual(['new:esc', 'new:pin'])
    // 'pane' 但没给：不传（引擎当没人听）
    const g = fakeEngine()
    new TagNoteBinding(g.engine, {} as HTMLElement, { data: data(), theme: 'light', layout: 'pane' })
    expect(g.opts()).not.toHaveProperty('onFocusTakeover')
  })

  it("'pane'（工作区）：带上布局、宿主全屏、初始视区；全屏请求和视区变化回调用最新的函数", () => {
    const f = fakeEngine()
    const full: string[] = []
    const vps: unknown[] = []
    const b = new TagNoteBinding(f.engine, {} as HTMLElement, {
      data: data(),
      theme: 'light',
      layout: 'pane',
      fullscreen: 'host',
      onFullRequest: () => full.push('old'),
      viewports: { kmap: { zoom: 2, cx: 3, cy: 4 } },
      onViewportChange: (v, vp) => vps.push(['old', v, vp]),
    })
    expect(f.opts()).toMatchObject({ layout: 'pane', fullscreen: 'host', viewports: { kmap: { zoom: 2, cx: 3, cy: 4 } } })
    b.update({ onFullRequest: () => full.push('new'), onViewportChange: (v, vp, info) => vps.push(['new', v, vp, info]) })
    f.opts().onFullRequest?.()
    f.opts().onViewportChange?.('canvas', { zoom: 1, cx: 0, cy: 0 }, { by: 'user' })
    expect(full).toEqual(['new'])
    expect(vps).toEqual([['new', 'canvas', { zoom: 1, cx: 0, cy: 0 }, { by: 'user' }]])
  })

  it('setHostFull 只在变了时告诉引擎；视区读写直通；销毁后什么都不做', () => {
    const f = fakeEngine()
    const b = new TagNoteBinding(f.engine, {} as HTMLElement, { data: data(), theme: 'light', layout: 'pane', fullscreen: 'host' })
    b.setHostFull(false)
    b.setHostFull(true)
    b.setHostFull(true)
    b.setHostFull(false)
    expect(b.getViewport('kmap')).toEqual({ zoom: 2, cx: 1, cy: 2 })
    expect(b.getViewport('none' as never)).toBeNull()
    b.setViewport({ zoom: 1.5 }, 'kmap')
    expect(b.view).toBe('canvas')
    b.destroy()
    b.setHostFull(true)
    b.setViewport({ zoom: 1 })
    expect(b.getViewport()).toBeNull()
    expect(b.view).toBeNull()
    expect(f.log.filter((l) => !l.startsWith('mount'))).toEqual(['setHostFull:true', 'setHostFull:false', 'setViewport:{"zoom":1.5}:kmap', 'destroy'])
  })

  it('syncPrefs：只推和引擎当前不一样的共用偏好（几个格子之间不来回推）；不碰视图和字号', () => {
    const f = fakeEngine()
    const b = new TagNoteBinding(f.engine, {} as HTMLElement, { data: data(), theme: 'light', prefs: { cover: true, color: true, drawer: false } })
    b.syncPrefs({ cover: true, color: true, drawer: false })
    expect(f.log.filter((l) => l.startsWith('setPrefs'))).toEqual([])
    b.syncPrefs({ cover: false, color: true })
    expect(f.log.filter((l) => l.startsWith('setPrefs'))).toEqual(['setPrefs:{"cover":false}'])
    b.syncPrefs({ cover: false })
    expect(f.log.filter((l) => l.startsWith('setPrefs'))).toHaveLength(1)
    expect(b.getPrefs()).toMatchObject({ cover: false, scale: 1 })
  })

  it('打开作品：有 subject_id 开 bgm.tv 条目；没有 subject_id 什么都不做', () => {
    const f = fakeEngine()
    const opened: string[] = []
    new TagNoteBinding(f.engine, {} as HTMLElement, { data: data(), theme: 'light', openUrl: (u) => opened.push(u) })
    const ev = {} as MouseEvent
    f.opts().onWorkOpen?.({ id: '100001', title: 'x', tags: [], subject_id: 100001 }, ev)
    f.opts().onWorkOpen?.({ id: '100001', title: '手写卡片，没有 subject_id', tags: [] }, ev)
    f.opts().onWorkOpen?.({ id: 'w1', title: 'y', tags: [], subject_id: undefined }, ev)
    expect(opened).toEqual(['https://bgm.tv/subject/100001'])
    expect(bgmSubjectUrl({ subject_id: undefined })).toBeNull()
    expect(bgmSubjectUrl({ subject_id: 0 })).toBeNull()
  })
})

// ---------------------------------------------------------------- 引擎下方的空白（node 环境没有 DOM：用假节点和假的 getComputedStyle）
describe('spaceBelow：引擎下方一定空着的高度', () => {
  type Fake = { parentElement: Fake | null; nextElementSibling: Fake | null; css: Record<string, string> }
  const node = (css: Record<string, string> = {}): Fake => ({ parentElement: null, nextElementSibling: null, css })
  const append = (parent: Fake, ...kids: Fake[]) => {
    kids.forEach((k, i) => {
      k.parentElement = parent
      k.nextElementSibling = kids[i + 1] ?? null
    })
  }
  beforeEach(() => vi.stubGlobal('getComputedStyle', (el: Fake) => ({ display: 'block', position: 'static', marginBottom: '0px', paddingBottom: '0px', borderBottomWidth: '0px', ...el.css })))
  afterEach(() => vi.unstubAllGlobals())

  // <main pb4> <div page pb64> <section pb8 border1> <p/> <frame mb2/> </section> [footer] </div> </main>
  const build = (footer?: Record<string, string>) => {
    const main = node({ paddingBottom: '4px', borderBottomWidth: '3px' })
    const page = node({ paddingBottom: '64px' })
    const sec = node({ paddingBottom: '8px', borderBottomWidth: '1px' })
    const frame = node({ marginBottom: '2px' })
    append(main, page)
    append(page, ...(footer ? [sec, node(footer)] : [sec]))
    append(sec, node(), frame)
    return { main, frame }
  }
  const run = (t: { main: Fake; frame: Fake }) => spaceBelow(t.frame as unknown as HTMLElement, t.main as unknown as HTMLElement)

  it('一路是最后一个子元素：累加下外边距、下内边距、下边框，到滚动容器为止（含它的下内边距，不含它的边框）', () => {
    expect(run(build())).toBe(2 + 8 + 1 + 64 + 4)
  })
  it('下面还有内容：停在那一层，只算已经累加的', () => {
    expect(run(build({}))).toBe(2 + 8 + 1)
  })
  it('后面的元素不占位（隐藏、绝对定位、固定定位）不算内容', () => {
    expect(run(build({ display: 'none' }))).toBe(79)
    expect(run(build({ position: 'absolute' }))).toBe(79)
    expect(run(build({ position: 'fixed' }))).toBe(79)
  })
})
