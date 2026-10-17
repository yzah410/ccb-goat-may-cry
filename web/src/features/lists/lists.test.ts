/**
 * 清单页「粘贴一批」的拆分 / 对号 / 合并，以及方案里用到了哪些清单、方案摘要、换模式。
 */
import { describe, expect, it } from 'vitest'
import type { SpecV2, SuggestItem } from '@/features/v2/types'
import { defaultSpec, newCondition, switchMode } from '@/features/workbench2/spec'
import { listIdsInSpec, specBrief } from '@/features/workbench2/summary'
import { exactMatches, mergeItems, parsePasted } from './resolve'

describe('粘贴一批：拆分', () => {
  it('一行一个，也认逗号、顿号、分号、Tab；纯数字当 id（标签清单除外）；去重', () => {
    const r = parsePasted('后藤一里\n87968，伊地知虹夏、 山田凉;#120119\n后藤一里\t 87968 ', 'character')
    expect(r.ids).toEqual([87968, 120119])
    expect(r.names).toEqual(['后藤一里', '伊地知虹夏', '山田凉'])
  })
  it('标签清单里数字也当名字', () => {
    expect(parsePasted('百合\n2024', 'tag')).toEqual({ ids: [], names: ['百合', '2024'] })
  })
  it('空的', () => {
    expect(parsePasted(' \n ,, ', 'work')).toEqual({ ids: [], names: [] })
  })
})

describe('粘贴一批：对号', () => {
  const it_ = (value: string, label: string, count: number, id?: number): SuggestItem => ({ value, label, count, id })
  it('值一样、或者 label 是「名字（说明）」都算完全一样；包含不算', () => {
    const items = [it_('孤独摇滚！', '孤独摇滚！（2022 · 动画）', 77377, 328609), it_('孤独摇滚！第二季', '孤独摇滚！第二季（年份不明 · 动画）', 5928, 537409)]
    expect(exactMatches('孤独摇滚！', items).map((x) => x.id)).toEqual([328609])
    expect(exactMatches('孤独', items)).toEqual([])
  })
  it('合并进已有的项：按 id（没 id 按名字）去重', () => {
    const r = mergeItems([{ id: 1, name: 'a' }, { name: '百合' }], [{ id: 1, name: 'a2' }, { id: 2, name: 'b' }, { name: '百合' }, { name: '日常' }])
    expect(r.added).toBe(2)
    expect(r.items).toEqual([{ id: 1, name: 'a' }, { name: '百合' }, { id: 2, name: 'b' }, { name: '日常' }])
  })
})

describe('方案里用到的清单 / 方案摘要', () => {
  it('从哪来、角色清单条件、标签清单、登场作品的作品清单都算', () => {
    const s = defaultSpec(new Date('2026-06-15T00:00:00'))
    const r0 = s.ranges[0]!
    const spec: SpecV2 = {
      ...s,
      ranges: [
        {
          ...r0,
          source: { kind: 'rank', subject_types: [2], year_from: null, year_to: null, rank_from: 1, rank_to: 50, rank_scope: 'merged', work_filter: { quant: 'any', k: null, tags: [], tag_list_id: 'l_wf' } },
          conditions: [
            { ...newCondition('game_tags', 'c1'), type: 'game_tags', tag_list_id: 'l_tags' } as never,
            { ...newCondition('char_list', 'c2'), list_id: 'l_chars' } as never,
            { ...newCondition('appearance', 'c3'), work_list_id: 'l_works2' } as never,
          ],
        },
      ],
      excludes: [{ ...r0, id: 'x', source: { kind: 'char_list', list_id: 'l_done' } }, { ...r0, id: 'y', source: { kind: 'work_list', list_id: 'l_works' } }],
    }
    expect([...listIdsInSpec(spec)].sort()).toEqual(['l_chars', 'l_done', 'l_tags', 'l_wf', 'l_works', 'l_works2'])
    expect(specBrief(spec)).toBe('动画 · 标签数 6 · 1 个范围 · 2 个排除 · 机会均等')
  })
})

describe('换模式', () => {
  it('从旧模式那类作品里取的范围，作品类型跟着换；别的范围不动', () => {
    const s = defaultSpec(new Date('2026-06-15T00:00:00'))
    const other = { ...s.ranges[0]!, id: 'r_b', source: { ...(s.ranges[0]!.source as object), subject_types: [2, 4] } } as SpecV2['ranges'][number]
    const spec: SpecV2 = { ...s, ranges: [s.ranges[0]!, other] }
    const r = switchMode(spec, 'game')
    expect(r.spec.game.mode).toBe('game')
    expect(r.spec.ranges[0]!.source).toMatchObject({ subject_types: [4] })
    expect(r.spec.ranges[1]!.source).toMatchObject({ subject_types: [2, 4] })
    expect(r.moved).toEqual(['范围 1'])
  })
  it('换到「全部」：动画范围改成 1/2/4/6', () => {
    const r = switchMode(defaultSpec(new Date('2026-06-15T00:00:00')), 'all')
    expect(r.spec.ranges[0]!.source).toMatchObject({ subject_types: [1, 2, 4, 6] })
  })
})
