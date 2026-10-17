/**
 * 角色卡片上的数（features/workbench2/card.ts）：评分 / 热度 / 登场 / 时间线 / 代表作 +N 部 / 分栏开关。
 * 例子按 /v2/candidates 接口的返回构造。
 */
import { describe, expect, it } from 'vitest'
import type { CandidateV2, GridV2 } from '@/features/v2/types'
import { cardNumbers, chipForStyle, presentNum, representativeWork, tagRuleInput } from './card'

const grid = (over: Partial<GridV2> = {}): GridV2 => ({
  mode: 'anime',
  n: 6,
  tags: [],
  n_app: 4,
  earliest: 2011,
  latest: 2018,
  rating: 8.8,
  source_tag: null,
  fallback: false,
  ...over,
})
const character = { id: 12393, name: '牧濑红莉栖', gender: '♀', heat: 3901, max_score: 8.8, earliest_year: 2011, latest_year: 2018 }

describe('卡片上的数', () => {
  it('评分 = grid.rating；null / -1 / 0 都算「没有」', () => {
    expect(cardNumbers({ character, grid: grid() })).toEqual({ rating: 8.8, heat: 3901, nApp: 4, earliest: 2011, latest: 2018 })
    expect(cardNumbers({ character: { ...character, max_score: null }, grid: grid({ rating: null }) }).rating).toBeNull()
    expect(cardNumbers({ character, grid: grid({ rating: -1 }) }).rating).toBeNull()
    expect(cardNumbers({ character, grid: grid({ rating: 0 }) }).rating).toBeNull()
  })
  it('登场年份 -1 / null = 没有；登场数不会是负数', () => {
    const n = cardNumbers({ character: { ...character, earliest_year: null, latest_year: null }, grid: grid({ earliest: -1, latest: null, n_app: 0 }) })
    expect(n.earliest).toBeNull()
    expect(n.latest).toBeNull()
    expect(n.nApp).toBe(0)
    expect(presentNum(-1)).toBeNull()
    expect(presentNum(Number.NaN)).toBeNull()
    expect(presentNum(0)).toBe(0)
  })
})

describe('代表作 +N 部', () => {
  const apps = ['命运石之门', '命运石之门 0', '命运石之门 负荷领域的既视感', '命运石之门 聪明睿智的认知计算']
  it('取到这个角色的作品（appear_best）在登场作品里：用它，带年份；+N = 登场数 − 1，悬停列其余的', () => {
    expect(representativeWork({ appearances: apps, grid: grid({ n_app: 4 }), appear_best: { name: '命运石之门 0', year: 2018 } })).toEqual({
      name: '命运石之门 0',
      year: 2018,
      more: 3,
      others: ['命运石之门', '命运石之门 负荷领域的既视感', '命运石之门 聪明睿智的认知计算'],
      unnamed: 0,
    })
  })
  it('不在登场作品里（例：按动画范围取的人、对局模式是游戏）：用登场作品第一部，不写年份', () => {
    expect(representativeWork({ appearances: ['明日方舟'], grid: grid({ mode: 'game', n_app: 1 }), appear_best: { name: '明日方舟：黎明前奏', year: 2022 } })).toEqual({
      name: '明日方舟',
      year: null,
      more: 0,
      others: [],
      unnamed: 0,
    })
  })
  it('登场数比接口给的名字多（最多 10 个）：「…还有 K 部」', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `作品${i + 1}`)
    const w = representativeWork({ appearances: ten, grid: grid({ n_app: 42 }), appear_best: { name: '作品3', year: 2012 } })
    expect(w.name).toBe('作品3')
    expect(w.more).toBe(41)
    expect(w.others).toHaveLength(9)
    expect(w.unnamed).toBe(32)
  })
  it('没有登场作品：不显示代表作', () => {
    expect(representativeWork({ appearances: [], grid: grid({ n_app: 0 }), bound_work: { name: '某部动画', year: 2020 } }).name).toBeNull()
  })
})

describe('分栏开关（has_anime：顶层和 character 里各有一份）', () => {
  const base = { grid: grid() } as Pick<CandidateV2, 'grid'>
  it('顶层 has_anime', () => {
    expect(tagRuleInput({ ...base, has_anime: true })).toEqual({ mode: 'anime', fallback: false, hasAnime: true })
  })
  it('character.has_anime（后端两处各给一份）', () => {
    expect(tagRuleInput({ ...base, character: { has_anime: true } }).hasAnime).toBe(true)
  })
  it('没有这个字段 = 没有动画登场', () => {
    expect(tagRuleInput(base).hasAnime).toBe(false)
  })
  it('退回规则 = grid.fallback', () => {
    expect(tagRuleInput({ grid: grid({ mode: 'game', fallback: true }), has_anime: false })).toEqual({ mode: 'game', fallback: true, hasAnime: false })
  })
})

describe('配色 → 标签芯片', () => {
  it('来源加粗、播放形式普通、绿色题材加粗 / 普通、公司、其余灰色', () => {
    expect(chipForStyle('source')).toEqual({ kind: 'source', emphasis: 'strong' })
    expect(chipForStyle('playback')).toEqual({ kind: 'playback', emphasis: 'soft' })
    expect(chipForStyle('genre-primary')).toEqual({ kind: 'genre', emphasis: 'strong' })
    expect(chipForStyle('genre-secondary')).toEqual({ kind: 'genre', emphasis: 'soft' })
    expect(chipForStyle('studio')).toEqual({ kind: 'studio', emphasis: 'soft' })
    expect(chipForStyle(null)).toEqual({ kind: 'work', emphasis: 'soft' })
  })
})
