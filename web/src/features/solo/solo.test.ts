/**
 * 单人猜猜呗的纯逻辑：键盘、评级、设置（默认值 / 夹取 / 存储校验）、接口返回值解析、反馈表显示、搜索下拉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/apiClient'
import { defaultSpec } from '@/features/workbench2/spec'
import { isAllParked, isGrade, normalizeProgress, soloErrorCode, type Status } from './api'
import { gradeFromDigit, needsRegrade, stepGrade } from './grades'
import { globalKeyAction, lastGradeKeyAction, nextEnabled, searchKeyAction, targetInfo, type KeyLike } from './keyboard'
import {
  buildStartBody,
  clampAutoStay,
  clampGoodSec,
  clampTimeLimit,
  pendingChanges,
  resolveSubjectTagNum,
  sessionKeyOf,
  SOLO_DEFAULTS,
  useSoloSettings,
} from './settings'
import { arrowOf, attemptsView, endedByText, fmtSec, gapView, mergeTags, nameLines, orNone, sharedWorkView, timingLine, timingView, toneOf } from './view'
import { fromBgm, fromLocalCharacters, fromWorkCharacters, parenPart } from './search'

// ---------------------------------------------------------------- 评级
describe('评级', () => {
  it('←/→ 切换到头停住，不循环', () => {
    expect(stepGrade('easy', -1)).toBe('easy')
    expect(stepGrade('good', -1)).toBe('easy')
    expect(stepGrade('good', 1)).toBe('hard')
    expect(stepGrade('again', 1)).toBe('again')
  })
  it('Alt+1–4 → Easy / Good / Hard / Again，别的数字不算', () => {
    expect(gradeFromDigit(1)).toBe('easy')
    expect(gradeFromDigit('2')).toBe('good')
    expect(gradeFromDigit('3')).toBe('hard')
    expect(gradeFromDigit(4)).toBe('again')
    expect(gradeFromDigit(0)).toBeNull()
    expect(gradeFromDigit('5')).toBeNull()
    expect(gradeFromDigit('x')).toBeNull()
  })
  it('选的和后端记的不一样才需要 regrade', () => {
    expect(needsRegrade('good', 'good')).toBe(false)
    expect(needsRegrade('easy', 'good')).toBe(true)
  })
})

// ---------------------------------------------------------------- 键盘
const k = (key: string, more: Partial<KeyLike> = {}): KeyLike => ({ key, ...more })
const items = [{ disabled: true }, {}, { disabled: true }, {}]

describe('搜索框按键', () => {
  const ctx = (index: number, more: Partial<{ open: boolean; canRegrade: boolean }> = {}) => ({ items, index, open: true, canRegrade: false, ...more })

  it('↓/↑ 跳过选不了的项，到头停住；起点是「没选」', () => {
    expect(searchKeyAction(k('ArrowDown'), ctx(-1))).toEqual({ type: 'move', index: 1 })
    expect(searchKeyAction(k('ArrowDown'), ctx(1))).toEqual({ type: 'move', index: 3 })
    expect(searchKeyAction(k('ArrowDown'), ctx(3))).toEqual({ type: 'move', index: 3 })
    expect(searchKeyAction(k('ArrowUp'), ctx(3))).toEqual({ type: 'move', index: 1 })
    expect(searchKeyAction(k('ArrowUp'), ctx(1))).toEqual({ type: 'move', index: 1 })
    expect(searchKeyAction(k('ArrowUp'), ctx(-1))).toEqual({ type: 'move', index: -1 })
  })
  it('nextEnabled：找不到能选的就原地不动', () => {
    expect(nextEnabled([{ disabled: true }], -1, 1)).toBe(-1)
    expect(nextEnabled([{}, {}], 0, 1)).toBe(1)
  })
  it('Enter 只猜选中的、能选的项；没选中不误猜', () => {
    expect(searchKeyAction(k('Enter'), ctx(-1))).toBeNull()
    expect(searchKeyAction(k('Enter'), ctx(1))).toEqual({ type: 'pick', index: 1 })
    expect(searchKeyAction(k('Enter'), ctx(0))).toBeNull()
  })
  it('输入法拼字时一律不处理', () => {
    expect(searchKeyAction(k('Enter', { isComposing: true }), ctx(1))).toBeNull()
    expect(searchKeyAction(k('Process'), ctx(1))).toBeNull()
    expect(searchKeyAction(k('ArrowDown', { isComposing: true }), ctx(-1))).toBeNull()
  })
  it('下拉收着时方向键不管；Esc 只在开着时收起', () => {
    expect(searchKeyAction(k('ArrowDown'), ctx(-1, { open: false }))).toBeNull()
    expect(searchKeyAction(k('Escape'), ctx(-1))).toEqual({ type: 'close' })
    expect(searchKeyAction(k('Escape'), ctx(-1, { open: false }))).toBeNull()
  })
  it('Shift+Enter = 搜作品（下拉收着也行）', () => {
    expect(searchKeyAction(k('Enter', { shiftKey: true }), ctx(-1, { open: false }))).toEqual({ type: 'search-works' })
  })
  it('自动模式：Alt+1–4 改上一局，Tab 跳到「上一局」；没有上一局时不拦', () => {
    expect(searchKeyAction(k('2', { altKey: true, code: 'Digit2' }), ctx(-1, { canRegrade: true }))).toEqual({ type: 'regrade', grade: 'good' })
    // 有的键盘布局按住 Alt 时 key 不是数字：看 code
    expect(searchKeyAction(k('™', { altKey: true, code: 'Numpad3' }), ctx(-1, { canRegrade: true }))).toEqual({ type: 'regrade', grade: 'hard' })
    expect(searchKeyAction(k('2', { altKey: true, code: 'Digit2' }), ctx(-1))).toBeNull()
    expect(searchKeyAction(k('5', { altKey: true, code: 'Digit5' }), ctx(-1, { canRegrade: true }))).toBeNull()
    expect(searchKeyAction(k('Tab'), ctx(-1, { canRegrade: true }))).toEqual({ type: 'focus-last' })
    expect(searchKeyAction(k('Tab'), ctx(-1))).toBeNull()
    expect(searchKeyAction(k('Tab', { shiftKey: true }), ctx(-1, { canRegrade: true }))).toBeNull()
  })
})

describe('全局按键', () => {
  const plain = { editable: false, inOverlay: false }
  it('猜测中：空格聚焦搜索框；焦点在输入框 / 弹出面板里不管', () => {
    expect(globalKeyAction(k(' ', { code: 'Space' }), { phase: 'playing', manualEnd: true, target: plain })).toEqual({ type: 'focus-search' })
    expect(globalKeyAction(k(' '), { phase: 'playing', manualEnd: true, target: { editable: true, inOverlay: false } })).toBeNull()
    expect(globalKeyAction(k(' '), { phase: 'playing', manualEnd: true, target: { editable: false, inOverlay: true } })).toBeNull()
    expect(globalKeyAction(k('Enter'), { phase: 'playing', manualEnd: true, target: plain })).toBeNull()
  })
  it('手动结算：←/→ 换评级，Enter 开下一局；自动模式不拦', () => {
    const ended = { phase: 'ended', manualEnd: true, target: plain }
    expect(globalKeyAction(k('ArrowLeft'), ended)).toEqual({ type: 'grade-step', dir: -1 })
    expect(globalKeyAction(k('ArrowRight'), ended)).toEqual({ type: 'grade-step', dir: 1 })
    expect(globalKeyAction(k('Enter'), ended)).toEqual({ type: 'confirm' })
    expect(globalKeyAction(k('Enter'), { ...ended, manualEnd: false })).toBeNull()
    expect(globalKeyAction(k('Enter', { ctrlKey: true }), ended)).toBeNull()
    expect(globalKeyAction(k('Enter', { isComposing: true }), ended)).toBeNull()
    expect(globalKeyAction(k('Enter', { repeat: true }), ended)).toBeNull()
  })
  it('targetInfo：输入框算可编辑；带 data-solo-own-keys 的祖先算「自己管按键」', () => {
    expect(targetInfo(null)).toEqual({ editable: false, inOverlay: false })
    const input = { tagName: 'input', closest: () => null } as unknown as EventTarget
    expect(targetInfo(input)).toEqual({ editable: true, inOverlay: false })
    const own = { tagName: 'BUTTON', closest: (s: string) => (s.includes('data-solo-own-keys') ? {} : null) } as unknown as EventTarget
    expect(targetInfo(own)).toEqual({ editable: false, inOverlay: true })
  })
})

describe('「上一局」评级控件按键', () => {
  it('←/→ 改，Alt+数字直接设，Enter / Esc 回输入框', () => {
    expect(lastGradeKeyAction(k('ArrowLeft'))).toEqual({ type: 'step', dir: -1 })
    expect(lastGradeKeyAction(k('ArrowRight'))).toEqual({ type: 'step', dir: 1 })
    expect(lastGradeKeyAction(k('4', { altKey: true, code: 'Digit4' }))).toEqual({ type: 'set', grade: 'again' })
    expect(lastGradeKeyAction(k('Enter'))).toEqual({ type: 'back' })
    expect(lastGradeKeyAction(k('Escape'))).toEqual({ type: 'back' })
    expect(lastGradeKeyAction(k('a'))).toBeNull()
  })
})

// ---------------------------------------------------------------- 设置
describe('设置', () => {
  it('默认值', () => {
    expect(SOLO_DEFAULTS).toEqual({
      timeLimitSec: null,
      characterTagNum: 0,
      subjectTagNum: 'follow',
      goodSec: 10,
      playMode: 'manual',
      autoStaySec: 1.5,
      bgmSearch: false,
      newEvery: 4,
      planName: null,
      uiScale: 1.25,
      workBonusSec: 2,
    })
  })
  it('夹取：时间限制 1–60（空 / 0 = 不限时）、分界 1–120、卡片停留 0.5–5', () => {
    expect(clampTimeLimit(null)).toBeNull()
    expect(clampTimeLimit(0)).toBeNull()
    expect(clampTimeLimit(-3)).toBeNull()
    expect(clampTimeLimit(12.6)).toBe(13)
    expect(clampTimeLimit(99)).toBe(60)
    expect(clampGoodSec(0)).toBe(1)
    expect(clampGoodSec(7.25)).toBe(7.3)
    expect(clampGoodSec(Number.NaN)).toBe(10)
    expect(clampAutoStay(0.1)).toBe(0.5)
    expect(clampAutoStay(9)).toBe(5)
    expect(clampAutoStay(1.5)).toBe(1.5)
  })
  it('作品标签数：跟随方案用会话默认值，否则用自己的（夹到 0–10）', () => {
    expect(resolveSubjectTagNum('follow', 6)).toBe(6)
    expect(resolveSubjectTagNum('follow', null)).toBe(0)
    expect(resolveSubjectTagNum(3, 6)).toBe(3)
    expect(resolveSubjectTagNum(15, 6)).toBe(10)
  })
  it('开局请求体', () => {
    expect(buildStartBody(SOLO_DEFAULTS, { session_id: 's', default_subject_tag_num: 6 })).toEqual({
      session_id: 's',
      subject_tag_num: 6,
      character_tag_num: 0,
      good_sec: 10,
      time_limit_sec: null,
      work_bonus_sec: 2,
    })
    expect(
      buildStartBody({ ...SOLO_DEFAULTS, timeLimitSec: 30, subjectTagNum: 2, characterTagNum: 4, goodSec: 8, workBonusSec: 3.5 }, { session_id: 's', default_subject_tag_num: 6 }),
    ).toEqual({
      session_id: 's',
      subject_tag_num: 2,
      character_tag_num: 4,
      good_sec: 8,
      time_limit_sec: 30,
      work_bonus_sec: 3.5,
    })
  })
  it('会话身份：题库、方案名、新角色保底任何一个变了就不同；范围的显示名不算', () => {
    const spec = defaultSpec(new Date(2026, 9, 13))
    const base = sessionKeyOf(spec, null, 4)
    expect(sessionKeyOf(spec, null, 4)).toBe(base)
    expect(sessionKeyOf(spec, null, 2)).not.toBe(base)
    expect(sessionKeyOf(spec, 'plan1', 4)).not.toBe(base)
    expect(sessionKeyOf({ ...spec, game: { ...spec.game, mode: 'game' } }, null, 4)).not.toBe(base)
    const renamed = { ...spec, ranges: spec.ranges.map((r) => ({ ...r, label: '改个名' })) }
    expect(sessionKeyOf(renamed, null, 4)).toBe(base)
    // 保底超出范围按夹取后的值算
    expect(sessionKeyOf(spec, null, 99)).toBe(sessionKeyOf(spec, null, 10))
  })
  it('「下一局生效」：只列和这一局开局时不一样的项', () => {
    const round = { subject_tag_num: 6, character_tag_num: 0, good_sec: 10, time_limit_sec: null }
    expect(pendingChanges(SOLO_DEFAULTS, round, 6)).toEqual([])
    expect(pendingChanges(SOLO_DEFAULTS, null, 6)).toEqual([])
    expect(pendingChanges({ ...SOLO_DEFAULTS, timeLimitSec: 30, characterTagNum: 2 }, round, 6)).toEqual(['角色标签数', '时间限制'])
    expect(pendingChanges({ ...SOLO_DEFAULTS, subjectTagNum: 3, goodSec: 5 }, round, 6)).toEqual(['作品标签数', 'Good / Hard 分界'])
  })

  describe('存浏览器：读回来先校验', () => {
    let warn: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      localStorage.clear()
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(() => {
      warn.mockRestore()
      useSoloSettings.setState({ ...SOLO_DEFAULTS })
    })

    it('合法的字段读回来，不合法的回默认值，不崩', async () => {
      localStorage.setItem(
        'outsetter.solo.v1',
        JSON.stringify({ state: { ...SOLO_DEFAULTS, timeLimitSec: 999, newEvery: 3, playMode: 'auto', subjectTagNum: 'x', planName: '' }, version: 1 }),
      )
      await useSoloSettings.persist.rehydrate()
      const s = useSoloSettings.getState()
      expect(s.newEvery).toBe(3)
      expect(s.playMode).toBe('auto')
      expect(s.timeLimitSec).toBeNull()
      expect(s.subjectTagNum).toBe('follow')
      expect(s.planName).toBeNull()
      expect(warn).toHaveBeenCalled()
    })
    it('存的不是对象：全部用默认值', async () => {
      localStorage.setItem('outsetter.solo.v1', JSON.stringify({ state: 'oops', version: 1 }))
      await useSoloSettings.persist.rehydrate()
      expect(useSoloSettings.getState().newEvery).toBe(4)
    })
    it('恢复默认保留方案选择', () => {
      useSoloSettings.getState().set({ planName: '方案A', newEvery: 7, playMode: 'auto' })
      useSoloSettings.getState().reset()
      const s = useSoloSettings.getState()
      expect(s.planName).toBe('方案A')
      expect(s.newEvery).toBe(4)
      expect(s.playMode).toBe('manual')
    })
  })
})

// ---------------------------------------------------------------- 接口返回值解析
describe('接口返回值解析', () => {
  it('normalizeProgress：缺字段补默认值，百分比夹到 0–100；不是对象 → null', () => {
    expect(normalizeProgress(null)).toBeNull()
    expect(normalizeProgress([])).toBeNull()
    expect(normalizeProgress({ total: 150, parts: [{ id: 'stable', pct: -5 }, 'bad'], session_delta: 'x' })).toEqual({
      total: 100,
      segments: [],
      parts: [{ id: 'stable', label: 'stable', pct: 0 }],
      stable_gap: null,
      saturated: false,
      events: [],
      session_delta: null,
    })
    const p = normalizeProgress({ total: 42.5, segments: [{ id: 'new', label: '没见过', count: 3 }], saturated: true, session_delta: 1.25, stable_gap: 21 })
    expect(p?.total).toBe(42.5)
    expect(p?.segments).toEqual([{ id: 'new', label: '没见过', count: 3 }])
    expect(p?.saturated).toBe(true)
    expect(p?.session_delta).toBe(1.25)
    expect(p?.stable_gap).toBe(21)
  })
  it('round_id = null 就是选不出题', () => {
    expect(isAllParked({ round_id: null, reason: 'x', progress: normalizeProgress({})! })).toBe(true)
  })
  it('isGrade', () => {
    expect(isGrade('hard')).toBe(true)
    expect(isGrade('Hard')).toBe(false)
    expect(isGrade(null)).toBe(false)
  })
  it('soloErrorCode：只认 http 错误里的 {error: 代码}', () => {
    const http = new ApiError({ kind: 'http', status: 409, path: '/v2/solo/round/guess', message: '这一局已经结束', detail: { ok: false, error: 'round_not_active', message: '这一局已经结束' } })
    expect(soloErrorCode(http)).toBe('round_not_active')
    expect(soloErrorCode(new ApiError({ kind: 'network', path: '/x', message: '连不上' }))).toBeNull()
    expect(soloErrorCode(new ApiError({ kind: 'http', status: 500, path: '/x', message: 'x', detail: 'Internal Server Error' }))).toBeNull()
    expect(soloErrorCode(new Error('x'))).toBeNull()
  })
})

// ---------------------------------------------------------------- 反馈表 / 状态 / 结算卡片
describe('显示', () => {
  it('格子颜色和箭头：+ = 猜大了 → ↓', () => {
    expect(toneOf('=')).toBe('hit')
    expect(toneOf('yes')).toBe('hit')
    expect(toneOf('+')).toBe('near')
    expect(toneOf('-')).toBe('near')
    expect(toneOf('++')).toBe('far')
    expect(toneOf('--')).toBe('far')
    expect(toneOf('?')).toBe('unknown')
    expect(toneOf('no')).toBe('none')
    expect(arrowOf('+')).toBe('↓')
    expect(arrowOf('++')).toBe('↓')
    expect(arrowOf('-')).toBe('↑')
    expect(arrowOf('--')).toBe('↑')
    expect(arrowOf('=')).toBe('')
  })
  it('标签格：作品标签 → 角色标签 → 声优，同名合并、任一处共有就高亮', () => {
    const tags = mergeTags({
      subject_tags: [
        { tag: '校园', shared: false },
        { tag: '奇幻', shared: true },
      ],
      char_tags: [
        { tag: '校园', shared: true },
        { tag: '黑发', shared: false },
      ],
      vas: [{ name: '花泽香菜', shared: false }],
    })
    expect(tags).toEqual([
      { text: '校园', shared: true, kind: 'subject' },
      { text: '奇幻', shared: true, kind: 'subject' },
      { text: '黑发', shared: false, kind: 'char' },
      { text: '花泽香菜', shared: false, kind: 'va' },
    ])
    expect(mergeTags(null)).toEqual([])
  })
  it('共同出演：特殊游戏取不到名字时不留空块', () => {
    const fb = (name: string | null, count: number, sa: Partial<{ first: string; firstCn: string | null; firstOriginal: string | null }> = {}) => ({
      display: { shared_work: { name, name_original: null, count } } as never,
      shared_appearances: { first: '', firstCn: null, firstOriginal: null, count, ...sa },
    })
    expect(sharedWorkView(fb(null, 0))).toEqual({ text: '', has: false })
    expect(sharedWorkView(fb(null, 1))).toEqual({ text: '共同作品', has: true })
    expect(sharedWorkView(fb(null, 2, { firstCn: '中文名' }))).toEqual({ text: '中文名 +1', has: true })
    expect(sharedWorkView(fb('作品X', 3))).toEqual({ text: '作品X +2', has: true })
  })
  it('次数：分子是全部没猜中的次数，上限 = 3 + 区分不了的次数', () => {
    const st = (p: Partial<Status>): Status => ({ rows: 0, misses: 0, forgiven: 0, counted: 0, again_locked: false, limit: 3, ...p })
    expect(attemptsView(null).text).toBe('已错 0 / 3 次')
    const a = attemptsView(st({ misses: 2, forgiven: 1, counted: 1, limit: 4 }))
    expect(a).toMatchObject({ used: 2, limit: 4, full: false })
    expect(a.text).toContain('1 次区分不了')
    expect(attemptsView(st({ misses: 3, counted: 3, limit: 3, again_locked: true })).full).toBe(true)
    // 错满后接着猜，次数超过上限：不写「4 / 3」
    const over = attemptsView(st({ misses: 4, counted: 4, limit: 3, again_locked: true }))
    expect(over.text).toBe('已错 4 次，到了上限 3，本局记 Again')
    expect(over.text).not.toContain('/')
  })
  it('结算卡片文字', () => {
    expect(endedByText({ ended_by: 'surrender', again_locked: false, hit_seq: null })).toBe('投降了')
    expect(endedByText({ ended_by: 'exact', again_locked: false, hit_seq: 2 })).toBe('第 2 次猜中了答案本人')
    expect(endedByText({ ended_by: 'work', again_locked: true, hit_seq: 5 })).toContain('记 Again')
    expect(timingView(null).summary).toBe('第 1、2 次就结束了，不计时')
    const tv = timingView({ intervals: [{ from: 2, to: 3, sec: 6.24 }], avg_sec: 6.24, good_sec: 10 })
    expect(tv.intervals).toEqual(['第 2→3 次 6.2 秒'])
    expect(tv.summary).toContain('Good')
    expect(timingView({ intervals: [{ from: 2, to: 3, sec: 12 }], avg_sec: 12, good_sec: 10 }).summary).toContain('Hard')
    // 带上怎么结束的：只有猜中且没错满时才写「→ Good / Hard」
    const t2 = { intervals: [{ from: 2, to: 3, sec: 2.4 }, { from: 3, to: 4, sec: 1 }], avg_sec: 1.7, good_sec: 10 }
    // 间隔、平均、分界同一种精度（最多 1 位小数，去掉 .0）
    expect(timingLine({ timing: t2, ended_by: 'exact', again_locked: false, hit_seq: 4 })).toBe('2→3 次 2.4 秒 · 3→4 次 1 秒 · 平均 1.7 秒（分界 10 秒 → Good）')
    expect(timingView(t2, { ended_by: 'surrender', again_locked: false, hit_seq: null }).summary).toBe('平均 1.7 秒（分界 10 秒；投降了，不按计时评级）')
    expect(timingView(t2, { ended_by: 'work', again_locked: true, hit_seq: 4 }).summary).toBe('平均 1.7 秒（分界 10 秒；错满了次数，不按计时评级）')
    expect(timingLine({ timing: { intervals: [], avg_sec: null, good_sec: 10 }, ended_by: 'exact', again_locked: false, hit_seq: 2 })).toBe('第 2 次就猜中，不计时')
    expect(timingLine({ timing: { intervals: [], avg_sec: null, good_sec: 10 }, ended_by: 'surrender', again_locked: false, hit_seq: null })).toBe('第 1、2 次就结束了，不计时')
    expect(gapView({ gap_rounds: null, gap_sec: null, prev_grade: null })).toBe('新角色，第一次出现')
    expect(gapView({ gap_rounds: 3.6, gap_sec: 120, prev_grade: 'hard' })).toBe('上次出现隔了 4 局（2 分钟前），上次评 Hard')
    expect(fmtSec(6.24)).toBe('6.2 秒')
    expect(fmtSec(12.4)).toBe('12 秒')
    expect(fmtSec(null)).toBe('—')
    expect(orNone(null)).toBe('无')
    expect(orNone(0)).toBe('0')
  })
})

// ---------------------------------------------------------------- 搜索下拉
describe('搜索下拉', () => {
  it('parenPart：取末尾那对括号（可以嵌套）', () => {
    expect(parenPart('春日（凉宫春日的忧郁）', '春日')).toBe('凉宫春日的忧郁')
    expect(parenPart('A（B（C））', 'A')).toBe('B（C）')
    expect(parenPart('Saber (Fate/stay night)')).toBe('Fate/stay night')
    expect(parenPart('只有名字', '只有名字')).toBe('')
    expect(parenPart('名字 别名', '名字')).toBe('名字 别名')
    expect(parenPart(null)).toBe('')
  })
  it('本地角色：有 id 才能选，头像用角色 id', () => {
    const r = fromLocalCharacters([
      { value: '春日', label: '春日（凉宫春日的忧郁）', count: 1, id: 5 },
      { value: '无 id', label: '无 id', count: 1 },
    ])
    expect(r[0]).toMatchObject({ kind: 'char', id: 5, title: '春日', sub: '凉宫春日的忧郁', avatarId: 5, disabled: false })
    expect(r[1]).toMatchObject({ id: null, disabled: true })
  })
  it('Bangumi 在线：本地库没有的照样列出来，但选不了', () => {
    const [miss, hit] = fromBgm(
      [
        { id: 1, name: 'ハルヒ', name_cn: '春日', in_library: false, label: '' },
        { id: 2, name: 'キョン', name_cn: '', in_library: true, label: '' },
      ],
      'char',
    )
    expect(miss).toMatchObject({ id: 1, title: '春日', sub: 'ハルヒ', disabled: true, disabledText: '本地库没有', avatarId: 1 })
    expect(hit).toMatchObject({ id: 2, title: 'キョン', sub: '', disabled: false })
  })
  it('作品下的角色：副标题是关系和性别（? 不写）', () => {
    const r = fromWorkCharacters([
      { id: 3, name: 'A', relation: '主角', relation_code: 1, heat: 1, gender: '女', n_app: 1 },
      { id: 4, name: 'B', relation: '配角', relation_code: 2, heat: 1, gender: '?', n_app: 1 },
    ])
    expect(r.map((x) => x.sub)).toEqual(['主角 · 女', '配角'])
    expect(r.every((x) => !x.disabled && x.kind === 'char')).toBe(true)
  })
})

describe('名字格', () => {
  it('有中文名：上行原名小字、下行中文名；没有就只有 name 一行', () => {
    expect(nameLines({ name: '凉宫春日', name_original: '涼宮ハルヒ', name_cn: '凉宫春日' })).toEqual({ top: '涼宮ハルヒ', main: '凉宫春日' })
    expect(nameLines({ name: '涼宮ハルヒ', name_original: '涼宮ハルヒ', name_cn: null })).toEqual({ top: null, main: '涼宮ハルヒ' })
    expect(nameLines({ name: 'キョン' })).toEqual({ top: null, main: 'キョン' })
    expect(nameLines({ name: '', name_original: 'A', name_cn: '' })).toEqual({ top: null, main: 'A' })
  })
})
