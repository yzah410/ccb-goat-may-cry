/**
 * 开局问卷的配对算法（recs.ts）。前半用手写的小数据，期望值手推；后半检查打包进去的 recs.json 本身。
 */
import { describe, expect, it } from 'vitest'
import { parseRecs, RECS, rankAdds, searchChars, slotOf, swapOptions, tiersFor, unionOf } from './recs'

// 标签按常见程度排：0 最常见
const R = parseRecs({
  generated: 'test',
  tags: ['恋爱', '搞笑', '战斗', '校园', '奇幻', '音乐', '百合', '科幻'],
  freq: [0.5, 0.45, 0.4, 0.3, 0.25, 0.1, 0.08, 0.05],
  chars: [
    [101, '甲', '作品A', 900, [0, 1, 3], [[102, '甲二'], [103, '甲三']]], // 0
    [201, '乙', '作品B', 500, [2, 4, 7], []], // 1：新带来 2、4、7
    [301, '丙', '作品C', 800, [2, 4, 5], []], // 2：新带来 2、4、5（频率和比乙高）
    [401, '丁', '作品D', 300, [0, 1], []], // 3：一个新标签都不带
    [501, '戊', '作品E', 700, [5, 6], []], // 4
    [601, '己', '作品F', 100, [2, 4, 5], []], // 5：和丙新带来的一样，热度低
  ],
  singles: [0],
  pairs: [[0, 2]],
})

describe('rankAdds：按新带来几个分档标签排', () => {
  it('多的在前；一样多时常见标签多的在前；新带来的一样只留一个；不带新标签的不要', () => {
    const base = unionOf(R, [0])
    const out = rankAdds(R, base, new Set([0]))
    expect(out.map((r) => R.chars[r.idx]!.name)).toEqual(['丙', '乙', '戊'])
    expect(out[0]!.add).toEqual([2, 4, 5])
  })
  it('limit 生效', () => {
    expect(rankAdds(R, unionOf(R, [0]), new Set([0]), 1)).toHaveLength(1)
  })
})

describe('tiersFor：两人 → 第 1 档，第 3 个人新带来的 → 第 2 档，其余 → 第 3 档', () => {
  it('两人公式：第 2 档空', () => {
    expect(tiersFor(R, 0, 2, null)).toEqual({
      G_1: ['恋爱', '搞笑', '战斗', '校园', '奇幻', '音乐'],
      G_2: [],
      G_3: ['百合', '科幻'],
      G_4: [],
    })
  })
  it('三人公式：第 3 个人和前两人重复的标签不进第 2 档', () => {
    expect(tiersFor(R, 0, 2, 4)).toEqual({
      G_1: ['恋爱', '搞笑', '战斗', '校园', '奇幻', '音乐'],
      G_2: ['百合'],
      G_3: ['科幻'],
      G_4: [],
    })
  })
  it('每个标签正好在一档', () => {
    const t = tiersFor(R, 0, 1, 4)
    const all = [...t.G_1, ...t.G_2, ...t.G_3, ...t.G_4]
    expect(all.slice().sort()).toEqual(R.tags.slice().sort())
  })
})

describe('可替换角色', () => {
  it('swapOptions = 代表 + 替换角色，去掉正在显示的', () => {
    expect(swapOptions(R, slotOf(R, 0)).map((x) => x.name)).toEqual(['甲二', '甲三'])
    expect(swapOptions(R, slotOf(R, 0, { id: 103, name: '甲三' })).map((x) => x.name)).toEqual(['甲', '甲二'])
  })
})

describe('searchChars', () => {
  it('也搜替换角色，搜到的是谁就显示谁', () => {
    expect(searchChars(R, '甲三')).toEqual([{ idx: 0, shown: { id: 103, name: '甲三' } }])
  })
  it('完全一样 > 开头 > 包含；排除已选的；空白不搜', () => {
    expect(searchChars(R, '甲').map((h) => h.shown.name)).toEqual(['甲'])
    expect(searchChars(R, '甲', new Set([0]))).toEqual([])
    expect(searchChars(R, '  ')).toEqual([])
  })
})

describe('打包进去的 recs.json', () => {
  const byName = new Map(RECS.chars.map((c) => [c.name, c]))
  it('下标都有效、每人带的标签按常见程度排', () => {
    for (const c of RECS.chars) {
      for (const t of c.k) expect(t).toBeLessThan(RECS.tags.length)
      expect([...c.k]).toEqual([...c.k].sort((a, b) => a - b))
    }
    for (const i of RECS.singles) expect(RECS.chars[i]).toBeDefined()
    for (const [a, b] of RECS.pairs) expect(RECS.chars[a] && RECS.chars[b]).toBeTruthy()
  })
  it('单人推荐都至少带 5 个分档标签', () => {
    for (const i of RECS.singles) expect(RECS.chars[i]!.k.length).toBeGreaterThanOrEqual(5)
    expect(RECS.singles.length).toBeGreaterThan(20)
  })
  it('分档标签共 40 个：1–4 档的 36 个，加上穿越、超能力、日本、吐槽', () => {
    expect(RECS.tags).toHaveLength(40)
    for (const t of ['穿越', '超能力', '日本', '吐槽', '恋爱', '百合', '历史', 'BL']) expect(RECS.tags).toContain(t)
  })
  it('秋山澪可以换成其他轻音角色', () => {
    const mio = byName.get('秋山澪')!
    expect(mio.alts.map((a) => a.name)).toEqual(expect.arrayContaining(['平泽唯', '中野梓']))
  })
})
