/**
 * 纯逻辑：键盘切到搜作品（←/→）、搜索状态、本地搜索接口（容错 / 别名）、
 * 界面大小和「从作品里选」加时的设置、结算计时里的加时文字。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '@/lib/apiClient'
import { normalizeSearch, soloApi, type SoloSearchItem, type Timing } from './api'
import { caretAtEnd, caretAtStart, globalKeyAction, searchKeyAction, type Caret, type KeyLike } from './keyboard'
import { fromLocalCharacters, fromLocalWorks, viaOf, viewAfterGuess, viewAfterTyping, type SearchView } from './search'
import { clampUiScale, clampWorkBonus, pendingChanges, SOLO_DEFAULTS, UI_SCALES, useSoloSettings } from './settings'
import { avgThresholdDigits, fmtNum, intervalBonusText, thresholdOf, thresholdText, timingLine, timingView } from './view'

// ---------------------------------------------------------------- 键盘：←/→ 切换搜索状态
const k = (key: string, more: Partial<KeyLike> = {}): KeyLike => ({ key, ...more })
const items = [{}, { disabled: true }, {}]
/** 光标：start..end，输入框里一共 length 个字 */
const caret = (start: number, end = start, length = 5): Caret => ({ start, end, length })
const ctx = (p: Partial<{ index: number; open: boolean; view: SearchView; caret: Caret; canRegrade: boolean }> = {}) => ({
  items,
  index: -1,
  open: true,
  canRegrade: false,
  view: 'char' as SearchView,
  caret: caret(5),
  ...p,
})

describe('搜索框按键：→ 切到搜作品、← 回来', () => {
  it('搜角色：光标在最后按 → 切到搜作品（空输入框也算；下拉没开也行）', () => {
    expect(searchKeyAction(k('ArrowRight'), ctx())).toEqual({ type: 'to-works' })
    expect(searchKeyAction(k('ArrowRight'), ctx({ caret: caret(0, 0, 0) }))).toEqual({ type: 'to-works' })
    expect(searchKeyAction(k('ArrowRight'), ctx({ open: false }))).toEqual({ type: 'to-works' })
    expect(searchKeyAction(k('ArrowRight'), ctx({ index: 0 }))).toEqual({ type: 'to-works' })
  })
  it('搜角色：光标不在最后、选中了一段字、按着 Shift → 照常移动光标（不处理）', () => {
    expect(searchKeyAction(k('ArrowRight'), ctx({ caret: caret(2) }))).toBeNull()
    expect(searchKeyAction(k('ArrowRight'), ctx({ caret: caret(0, 5) }))).toBeNull()
    expect(searchKeyAction(k('ArrowRight', { shiftKey: true }), ctx()))
      .toBeNull()
    // 搜角色里 ← 不切换
    expect(searchKeyAction(k('ArrowLeft'), ctx({ caret: caret(0) }))).toBeNull()
  })
  it('作品列表：已经用 ↑/↓ 选中一部作品时 → = Enter（进入它的角色列表）；没选中 / 选不了 / 下拉收起 → 照常移动光标', () => {
    expect(searchKeyAction(k('ArrowRight'), ctx({ view: 'works', index: 2, caret: caret(1) }))).toEqual({ type: 'pick', index: 2 })
    expect(searchKeyAction(k('Enter'), ctx({ view: 'works', index: 2 }))).toEqual({ type: 'pick', index: 2 })
    expect(searchKeyAction(k('ArrowRight'), ctx({ view: 'works', index: -1 }))).toBeNull()
    expect(searchKeyAction(k('ArrowRight'), ctx({ view: 'works', index: 1 }))).toBeNull()
    expect(searchKeyAction(k('ArrowRight'), ctx({ view: 'works', index: 2, open: false }))).toBeNull()
  })
  it('作品列表：光标在最前按 ← 回到搜角色（空输入框也算）；不在最前 / 选中了字 → 照常移动光标', () => {
    expect(searchKeyAction(k('ArrowLeft'), ctx({ view: 'works', caret: caret(0) }))).toEqual({ type: 'to-chars' })
    expect(searchKeyAction(k('ArrowLeft'), ctx({ view: 'works', caret: caret(0, 0, 0) }))).toEqual({ type: 'to-chars' })
    expect(searchKeyAction(k('ArrowLeft'), ctx({ view: 'works', caret: caret(3) }))).toBeNull()
    expect(searchKeyAction(k('ArrowLeft'), ctx({ view: 'works', caret: caret(0, 3) }))).toBeNull()
    expect(searchKeyAction(k('ArrowLeft', { shiftKey: true }), ctx({ view: 'works', caret: caret(0) }))).toBeNull()
  })
  it('作品的角色列表：← 回到作品列表（不管光标在哪）；→ 照常移动光标；↑/↓、Enter 照常选和猜', () => {
    expect(searchKeyAction(k('ArrowLeft'), ctx({ view: 'work-chars', caret: caret(3) }))).toEqual({ type: 'back-to-works' })
    expect(searchKeyAction(k('ArrowLeft'), ctx({ view: 'work-chars', caret: caret(5) }))).toEqual({ type: 'back-to-works' })
    expect(searchKeyAction(k('ArrowRight'), ctx({ view: 'work-chars', index: 0 }))).toBeNull()
    expect(searchKeyAction(k('ArrowDown'), ctx({ view: 'work-chars', index: 0 }))).toEqual({ type: 'move', index: 2 })
    expect(searchKeyAction(k('Enter'), ctx({ view: 'work-chars', index: 0 }))).toEqual({ type: 'pick', index: 0 })
  })
  it('输入法正在拼字、按着 Ctrl / Alt / Meta 时 ←/→ 都不处理', () => {
    expect(searchKeyAction(k('ArrowRight', { isComposing: true }), ctx())).toBeNull()
    expect(searchKeyAction(k('Process'), ctx())).toBeNull()
    expect(searchKeyAction(k('ArrowLeft', { isComposing: true }), ctx({ view: 'work-chars' }))).toBeNull()
    expect(searchKeyAction(k('ArrowLeft', { isComposing: true }), ctx({ view: 'works', caret: caret(0) }))).toBeNull()
    expect(searchKeyAction(k('ArrowRight', { ctrlKey: true }), ctx())).toBeNull()
    expect(searchKeyAction(k('ArrowLeft', { altKey: true }), ctx({ view: 'work-chars' }))).toBeNull()
    expect(searchKeyAction(k('ArrowRight', { metaKey: true }), ctx())).toBeNull()
  })
  it('Shift+Enter = 用当前文字搜作品（三种状态都是）；Alt+1–4 改评级、Tab 跳到上一局', () => {
    for (const view of ['char', 'works', 'work-chars'] as const)
      expect(searchKeyAction(k('Enter', { shiftKey: true }), ctx({ view }))).toEqual({ type: 'search-works' })
    expect(searchKeyAction(k('2', { altKey: true, code: 'Digit2' }), ctx({ view: 'works', canRegrade: true }))).toEqual({ type: 'regrade', grade: 'good' })
    expect(searchKeyAction(k('Tab'), ctx({ view: 'work-chars', canRegrade: true }))).toEqual({ type: 'focus-last' })
  })
  it('没给光标位置：←/→ 一律照常移动光标', () => {
    expect(searchKeyAction(k('ArrowRight'), { items, index: -1, open: true, canRegrade: false })).toBeNull()
    expect(searchKeyAction(k('ArrowLeft'), { items, index: -1, open: true, canRegrade: false, view: 'works' })).toBeNull()
  })
  it('光标位置：selectionStart / End 是 null（拿不到）不算在最前 / 最后', () => {
    expect(caretAtEnd({ start: 3, end: 3, length: 3 })).toBe(true)
    expect(caretAtStart({ start: 0, end: 0, length: 3 })).toBe(true)
    expect(caretAtEnd({ start: null, end: null, length: 0 })).toBe(false)
    expect(caretAtStart({ start: null, end: null, length: 0 })).toBe(false)
    expect(caretAtEnd(undefined)).toBe(false)
  })
  it('手动结算的全局 ←/→ 改评级不受影响：焦点不在输入框时改评级；在输入框里时全局不处理（交给搜索框）', () => {
    const outside = { editable: false, inOverlay: false }
    expect(globalKeyAction(k('ArrowRight'), { phase: 'ended', manualEnd: true, target: outside })).toEqual({ type: 'grade-step', dir: 1 })
    expect(globalKeyAction(k('ArrowLeft'), { phase: 'ended', manualEnd: true, target: outside })).toEqual({ type: 'grade-step', dir: -1 })
    expect(globalKeyAction(k('ArrowRight'), { phase: 'playing', manualEnd: true, target: { editable: true, inOverlay: false } })).toBeNull()
  })
})

// ---------------------------------------------------------------- 搜索状态
describe('搜索状态', () => {
  it('打字：搜角色还是搜角色；搜作品（包括在作品的角色列表里）回到作品列表', () => {
    expect(viewAfterTyping('char')).toBe('char')
    expect(viewAfterTyping('works')).toBe('works')
    expect(viewAfterTyping('work-chars')).toBe('works')
  })
  it('猜完一次：留在原来那种状态（从作品里选的 → 作品列表）', () => {
    expect(viewAfterGuess('char')).toBe('char')
    expect(viewAfterGuess('works')).toBe('works')
    expect(viewAfterGuess('work-chars')).toBe('works')
  })
  it('via：只有从作品的角色列表里选的算 work', () => {
    expect(viaOf('work-chars')).toBe('work')
    expect(viaOf('char')).toBe('name')
    expect(viaOf('works')).toBe('name')
  })
})

// ---------------------------------------------------------------- 搜索接口
describe('本地搜索接口（/v2/solo/search）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('解析：外层有没有 ok 都行；缺字段补默认值；matched 和 value 一样 / 空白时不算；fuzzy 不是布尔 → null', () => {
    const r = normalizeSearch({
      ok: true,
      items: [
        { id: 1, value: '鲁路修·兰佩路基', label: '鲁路修·兰佩路基（Code Geass）', count: 1234, matched: 'Lelouch Lamperouge', match: 'fuzzy' },
        { id: 2, value: 'C.C.', matched: 'C.C.' },
        { value: '没 id', matched: '  ' },
        'oops',
      ],
      fuzzy: false,
    })
    expect(r.fuzzy).toBe(false)
    expect(r.items).toHaveLength(3)
    expect(r.items[0]).toEqual({
      id: 1,
      value: '鲁路修·兰佩路基',
      label: '鲁路修·兰佩路基（Code Geass）',
      count: 1234,
      matched: 'Lelouch Lamperouge',
      match: 'fuzzy',
    })
    expect(r.items[1]).toMatchObject({ id: 2, value: 'C.C.', label: 'C.C.', count: 0, matched: null })
    expect(r.items[2]).toMatchObject({ id: undefined, matched: null })
    expect(normalizeSearch({ items: [] }).fuzzy).toBeNull()
    expect(normalizeSearch(null)).toEqual({ items: [], fuzzy: null })
  })

  it('请求 /v2/solo/search（kind / q / limit）并解析结果', async () => {
    const get = vi
      .spyOn(api, 'get')
      .mockResolvedValue({ ok: true, items: [{ id: 1, value: 'A', label: 'A（X）', count: 3, matched: 'Lelouch', match: 'fuzzy' }], fuzzy: true })
    const r = await soloApi.search('character', 'lel', 12)
    expect(get).toHaveBeenCalledWith('/v2/solo/search', expect.objectContaining({ query: { kind: 'character', q: 'lel', limit: 12 } }))
    expect(r.fuzzy).toBe(true)
    expect(r.items[0]!.matched).toBe('Lelouch')
  })

  it('请求出错时照常抛出：500、带错误码的 404、网络错误', async () => {
    const get = vi.spyOn(api, 'get')
    get.mockRejectedValueOnce(new ApiError({ kind: 'http', status: 500, path: '/v2/solo/search', message: '后端出错' }))
    await expect(soloApi.search('character', 'x', 12)).rejects.toBeInstanceOf(ApiError)
    get.mockRejectedValueOnce(
      new ApiError({ kind: 'http', status: 404, path: '/v2/solo/search', message: 'x', detail: { ok: false, error: 'not_ready', message: 'x' } }),
    )
    await expect(soloApi.search('character', 'x', 12)).rejects.toBeInstanceOf(ApiError)
    get.mockRejectedValueOnce(new ApiError({ kind: 'network', path: '/v2/solo/search', message: '连不上' }))
    await expect(soloApi.search('character', 'x', 12)).rejects.toBeInstanceOf(ApiError)
  })

  it('下拉的小字行：命中的是别名 → 「别名：…」接在最佳作品后面；没有别名就不接', () => {
    const chars: SoloSearchItem[] = [
      { id: 1, value: '鲁路修·兰佩路基', label: '鲁路修·兰佩路基（Code Geass）', count: 1, matched: 'Lelouch Lamperouge' },
      { id: 2, value: '雷姆', label: '雷姆（Re:从零开始的异世界生活）', count: 1 },
      { id: 3, value: '无作品', label: '无作品', count: 1, matched: 'Alias' },
    ]
    const r = fromLocalCharacters(chars)
    expect(r[0]!.sub).toBe('Code Geass · 别名：Lelouch Lamperouge')
    expect(r[1]!.sub).toBe('Re:从零开始的异世界生活')
    expect(r[2]!.sub).toBe('别名：Alias')
    const works: SoloSearchItem[] = [{ id: 9, value: 'コードギアス', label: 'コードギアス（2006 · 动画）', count: 1, matched: '反叛的鲁路修' }]
    const w = fromLocalWorks(works)
    expect(w[0]!.sub).toBe('2006 · 动画 · 别名：反叛的鲁路修')
  })
})

// ---------------------------------------------------------------- 设置
describe('界面大小、从作品里选的加时', () => {
  it('默认 125%、2 秒；夹取', () => {
    expect(SOLO_DEFAULTS.uiScale).toBe(1.25)
    expect(SOLO_DEFAULTS.workBonusSec).toBe(2)
    expect([...UI_SCALES]).toEqual([1, 1.25, 1.5, 1.75, 2])
    expect(clampUiScale(1.3)).toBe(1.25)
    expect(clampUiScale(9)).toBe(2)
    expect(clampUiScale(0.2)).toBe(1)
    expect(clampUiScale(Number.NaN)).toBe(1.25)
    expect(clampWorkBonus(-1)).toBe(0)
    expect(clampWorkBonus(11)).toBe(10)
    expect(clampWorkBonus(2.3)).toBe(2.5)
    expect(clampWorkBonus(2.2)).toBe(2)
    expect(clampWorkBonus(Number.NaN)).toBe(2)
  })
  it('「下一局生效」：加时改了要提示；这一局没有加时记录时不比', () => {
    const round = { subject_tag_num: 6, character_tag_num: 0, good_sec: 10, time_limit_sec: null, work_bonus_sec: 2 }
    expect(pendingChanges(SOLO_DEFAULTS, round, 6)).toEqual([])
    expect(pendingChanges({ ...SOLO_DEFAULTS, workBonusSec: 3 }, round, 6)).toEqual(['从作品里选的加时'])
    const { work_bonus_sec: _omit, ...oldRound } = round
    void _omit
    expect(pendingChanges({ ...SOLO_DEFAULTS, workBonusSec: 3 }, oldRound, 6)).toEqual([])
  })

  describe('存浏览器', () => {
    let warn: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      localStorage.clear()
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(() => {
      warn.mockRestore()
      useSoloSettings.setState({ ...SOLO_DEFAULTS })
    })

    it('合法的读回来；不在可选值里的界面大小、超范围或不是 0.5 倍数的加时 → 默认值', async () => {
      localStorage.setItem('outsetter.solo.v1', JSON.stringify({ state: { ...SOLO_DEFAULTS, uiScale: 1.75, workBonusSec: 4.5 }, version: 1 }))
      await useSoloSettings.persist.rehydrate()
      expect(useSoloSettings.getState().uiScale).toBe(1.75)
      expect(useSoloSettings.getState().workBonusSec).toBe(4.5)
      useSoloSettings.setState({ ...SOLO_DEFAULTS }) // 不合法的字段保留内存里现有的值（这里 = 默认值）
      localStorage.setItem('outsetter.solo.v1', JSON.stringify({ state: { ...SOLO_DEFAULTS, uiScale: 1.3, workBonusSec: 2.2 }, version: 1 }))
      await useSoloSettings.persist.rehydrate()
      expect(useSoloSettings.getState().uiScale).toBe(1.25)
      expect(useSoloSettings.getState().workBonusSec).toBe(2)
      expect(warn).toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------- 结算计时里的加时
describe('计时：从作品里选的加时', () => {
  const hit = { ended_by: 'work' as const, again_locked: false, hit_seq: 3 }

  it('fmtNum：最多 1 位小数，去掉 .0', () => {
    expect(fmtNum(10)).toBe('10')
    expect(fmtNum(2.5)).toBe('2.5')
    expect(fmtNum(10.666)).toBe('10.7')
    expect(fmtNum(12.04)).toBe('12')
  })

  it('第 3 次是从作品里选的：间隔后面写「（从作品里选，+2 秒）」，分界 12 秒（10 + 2），11 秒 → Good', () => {
    const t: Timing = { intervals: [{ from: 2, to: 3, sec: 11, via: 'work', bonus_sec: 2 }], avg_sec: 11, good_sec: 10, work_bonus_sec: 2, threshold_sec: 12 }
    const v = timingView(t, hit)
    expect(v.intervals).toEqual(['第 2→3 次 11 秒（从作品里选，+2 秒）'])
    expect(v.summary).toBe('平均 11 秒（分界 12 秒（10 + 2） → Good）')
    expect(timingLine({ timing: t, ...hit })).toBe('2→3 次 11 秒（从作品里选，+2 秒） · 平均 11 秒（分界 12 秒（10 + 2） → Good）')
  })

  it('同样 11 秒但是按名字搜的：没有加时，分界 10 秒 → Hard', () => {
    const t: Timing = { intervals: [{ from: 2, to: 3, sec: 11, via: 'name', bonus_sec: 0 }], avg_sec: 11, good_sec: 10, work_bonus_sec: 2, threshold_sec: 10 }
    expect(timingView(t, hit).summary).toBe('平均 11 秒（分界 10 秒 → Hard）')
    expect(timingView(t, hit).intervals).toEqual(['第 2→3 次 11 秒'])
  })

  it('两个间隔只有一个是从作品里选的：分界 11 秒（10 + 2 × 1/2）', () => {
    const t: Timing = {
      intervals: [
        { from: 2, to: 3, sec: 9, via: 'name', bonus_sec: 0 },
        { from: 3, to: 4, sec: 12.5, via: 'work', bonus_sec: 2 },
      ],
      avg_sec: 10.75,
      good_sec: 10,
      work_bonus_sec: 2,
      threshold_sec: 11,
    }
    expect(thresholdOf(t)).toEqual({ threshold: 11, extra: 1 })
    expect(thresholdText(t)).toBe('分界 11 秒（10 + 2 × 1/2）')
    // 平均 10.75 和分界一样按 1 位小数显示
    expect(timingView(t, { ...hit, hit_seq: 4 }).summary).toBe('平均 10.8 秒（分界 11 秒（10 + 2 × 1/2） → Good）')
    expect(intervalBonusText(t.intervals[0]!)).toBe('')
    expect(intervalBonusText(t.intervals[1]!)).toBe('（从作品里选，+2 秒）')
  })

  it('后端没给 threshold_sec 但间隔里有 bonus_sec：自己按平均算', () => {
    const t: Timing = { intervals: [{ from: 2, to: 3, sec: 11, bonus_sec: 2.5 }], avg_sec: 11, good_sec: 10 }
    expect(thresholdOf(t)).toEqual({ threshold: 12.5, extra: 2.5 })
    expect(thresholdText(t)).toBe('分界 12.5 秒（10 + 2.5）')
  })

  it('没有 via / bonus_sec / threshold_sec 时：按没有加时算', () => {
    const t: Timing = { intervals: [{ from: 2, to: 3, sec: 11 }], avg_sec: 11, good_sec: 10 }
    expect(timingView(t, hit)).toEqual({ intervals: ['第 2→3 次 11 秒'], summary: '平均 11 秒（分界 10 秒 → Hard）' })
  })

  describe('平均和分界同一种精度，显示出来的大小和判定一致', () => {
    const work = (sec: number) => ({ from: 2, to: 3, sec, via: 'work' as const, bonus_sec: 2 })
    const one = (avg: number): Timing => ({ intervals: [work(avg)], avg_sec: avg, good_sec: 10, work_bonus_sec: 2, threshold_sec: 12 })

    it('平均 12.4、分界 12 → Hard：显示「平均 12.4 秒」，两个数看得出大小', () => {
      expect(timingView(one(12.4), hit).summary).toBe('平均 12.4 秒（分界 12 秒（10 + 2） → Hard）')
      // 间隔也用同一种精度：只有一段间隔时不会写成「2→3 次 12 秒 · 平均 12.4 秒」
      expect(timingLine({ timing: one(12.4), ...hit })).toBe('2→3 次 12.4 秒（从作品里选，+2 秒） · 平均 12.4 秒（分界 12 秒（10 + 2） → Hard）')
      expect(timingView(one(12.4), hit).intervals).toEqual(['第 2→3 次 12.4 秒（从作品里选，+2 秒）'])
    })

    it('平均 10.6、分界 10.667（10 + 2 × 1/3）→ Good：两个数都按 1 位小数显示', () => {
      const t: Timing = {
        intervals: [
          { from: 2, to: 3, sec: 9.4, via: 'name', bonus_sec: 0 },
          { from: 3, to: 4, sec: 10.2, via: 'name', bonus_sec: 0 },
          { from: 4, to: 5, sec: 12.2, via: 'work', bonus_sec: 2 },
        ],
        avg_sec: 10.6,
        good_sec: 10,
        work_bonus_sec: 2,
        threshold_sec: 10.667,
      }
      expect(timingView(t, { ...hit, hit_seq: 5 }).summary).toBe('平均 10.6 秒（分界 10.7 秒（10 + 2 × 1/3） → Good）')
    })

    it('正好等于分界 = Good，两个数显示一样', () => {
      expect(timingView(one(12), hit).summary).toBe('平均 12 秒（分界 12 秒（10 + 2） → Good）')
      const t: Timing = { intervals: [{ from: 2, to: 3, sec: 10 }], avg_sec: 10, good_sec: 10 }
      expect(timingView(t, hit).summary).toBe('平均 10 秒（分界 10 秒 → Good）')
    })

    it('Hard 但 1 位小数四舍五入后一样：多显示小数，两个数位数对齐', () => {
      expect(timingView(one(12.04), hit)).toEqual({
        intervals: ['第 2→3 次 12.04 秒（从作品里选，+2 秒）'],
        summary: '平均 12.04 秒（分界 12.00 秒（10 + 2） → Hard）',
      })
      // 分界 10.667、平均 10.67：2 位小数还是一样（10.67），要 3 位
      const t: Timing = {
        intervals: [
          { from: 2, to: 3, sec: 10.67, via: 'work', bonus_sec: 2 },
          { from: 3, to: 4, sec: 10.67, via: 'name', bonus_sec: 0 },
          { from: 4, to: 5, sec: 10.67, via: 'name', bonus_sec: 0 },
        ],
        avg_sec: 10.67,
        good_sec: 10,
        work_bonus_sec: 2,
        threshold_sec: 10.667,
      }
      expect(avgThresholdDigits(10.67, 10.667)).toBe(3)
      expect(timingView(t, { ...hit, hit_seq: 5 }).summary).toBe('平均 10.670 秒（分界 10.667 秒（10 + 2 × 1/3） → Hard）')
      // 没有加时也一样：平均 10.04、分界 10，两个数都显示 2 位小数
      const plain: Timing = { intervals: [{ from: 2, to: 3, sec: 10.04 }], avg_sec: 10.04, good_sec: 10 }
      expect(timingView(plain, hit).summary).toBe('平均 10.04 秒（分界 10.00 秒 → Hard）')
    })

    it('分界不是整数时保留小数（分界 12.5 显示 12.5）', () => {
      const t: Timing = { intervals: [{ from: 2, to: 3, sec: 12.7 }], avg_sec: 12.7, good_sec: 12.5 }
      expect(timingView(t, hit).summary).toBe('平均 12.7 秒（分界 12.5 秒 → Hard）')
    })

    it('Good 时不加小数位；Hard 且 1 位小数看得出大小时也不加', () => {
      expect(avgThresholdDigits(11.96, 12)).toBe(1)
      expect(avgThresholdDigits(12, 12)).toBe(1)
      expect(avgThresholdDigits(12.4, 12)).toBe(1)
      expect(avgThresholdDigits(12.04, 12)).toBe(2)
      expect(avgThresholdDigits(null, 12)).toBe(1)
    })
  })

  it('投降 / 错满时写「不按计时评级」，分界也写明加时', () => {
    const t: Timing = { intervals: [{ from: 2, to: 3, sec: 11, via: 'work', bonus_sec: 2 }], avg_sec: 11, good_sec: 10, work_bonus_sec: 2, threshold_sec: 12 }
    expect(timingView(t, { ended_by: 'surrender', again_locked: false, hit_seq: null }).summary).toBe('平均 11 秒（分界 12 秒（10 + 2）；投降了，不按计时评级）')
  })
})
