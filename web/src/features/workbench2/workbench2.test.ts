/**
 * 工作台的纯逻辑：默认方案、规整 / 往返、指纹、条件摘要、编辑 store（撤销重做、合并、打开 / 新建、持久化）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Condition, Role, SpecV2 } from '@/features/v2/types'
import {
  conditionComplete,
  defaultSpec,
  evalKey,
  newCondition,
  newId,
  normalizeSpec,
  specFingerprint,
  stableStringify,
  takenIds,
  mapRange,
  pickWithRoles,
} from './spec'
import { conditionText, localSentence, pickText, sourceText, tagFilterText, type NameLookup } from './summary'
import { HISTORY_LIMIT, useWb2 } from './store'

const TODAY = new Date('2026-06-15T12:00:00')

/**
 * 默认方案的 JSON（键的顺序也一致）。per_work 是 null：和游戏一样，只要主角时每部不限人数（题库 150 人）；和后端 /v2/meta 的 default_spec 一致。
 */
const CONTRACT_DEFAULT = `{ "version": 2,
  "game": { "mode": "anime", "tag_count": 6 },
  "ranges": [ { "id": "r_default", "enabled": true, "label": null, "share": null,
      "source": { "kind": "rank", "subject_types": [2], "year_from": 2016, "year_to": 2026,
                  "rank_from": 1, "rank_to": 50, "rank_scope": "merged", "work_filter": null },
      "pick": { "roles": ["主角"], "per_work": null, "order": "heat" },
      "conditions": [] } ],
  "excludes": [],
  "draw": { "method": "per_character", "seed": null } }`

function cond(c: Partial<Condition> & { type: Condition['type'] }, id = 'c_1'): Condition {
  return { ...newCondition(c.type, id), ...c } as Condition
}

/** 一个把所有条件类型、所有来源都用上的方案（往返测试用） */
function bigSpec(): SpecV2 {
  const s = defaultSpec(TODAY)
  s.game = { mode: 'game', tag_count: 4 }
  s.ranges[0]!.conditions = [
    cond({ type: 'gender', values: ['女', '未知'] }, 'c_g'),
    cond({ type: 'char_heat', min: 1000, max: null }, 'c_h'),
    cond({ type: 'game_tags', quant: 'all', tags: ['百合', '日常'] }, 'c_t'),
    cond({ type: 'char_tags', quant: 'at_least', k: 2, tags: ['黑发'], tag_list_id: 'l_tag' }, 'c_ct'),
    cond({ type: 'va', names: ['花泽香菜'] }, 'c_va'),
    cond({ type: 'source_tag', values: ['漫画改'] }, 'c_src'),
    cond({ type: 'n_app', min: 2, max: 5 }, 'c_n'),
    cond({ type: 'earliest_year', min: 2010, max: null }, 'c_e'),
    cond({ type: 'latest_year', min: null, max: 2020 }, 'c_l'),
    cond({ type: 'rating', min: 7.5, max: null, negate: true }, 'c_r'),
    cond(
      {
        type: 'appearance',
        subject_types: [2],
        year_from: 2024,
        year_to: 2024,
        roles: ['主角'],
        work_tags: { quant: 'any', k: null, tags: ['百合'], tag_list_id: null, tag_mode: 'any' },
        work_list_id: null,
      },
      'c_a',
    ),
    cond({ type: 'char_list', list_id: 'l_chars', enabled: false }, 'c_cl'),
    cond({ type: 'sql', sql: 'SELECT id FROM character WHERE heat > 100', label: '热门' }, 'c_sql'),
  ]
  s.ranges.push({
    id: 'r_two',
    enabled: true,
    label: '老番',
    share: 3,
    source: {
      kind: 'rank',
      subject_types: [2, 4],
      year_from: null,
      year_to: 2005,
      rank_from: 10,
      rank_to: null,
      rank_scope: 'per_year',
      work_filter: { quant: 'none', k: null, tags: ['BL'], tag_list_id: null, tag_mode: 'main' },
    },
    pick: { roles: ['主角', '配角'], per_work: null, order: 'game' },
    conditions: [],
  })
  s.excludes = [
    { id: 'x_1', enabled: true, label: null, share: null, source: { kind: 'char_list', list_id: 'l_done' }, pick: { roles: ['主角'], per_work: 6, order: 'heat' }, conditions: [] },
    {
      id: 'x_2',
      enabled: false,
      label: null,
      share: null,
      source: { kind: 'all_characters' },
      pick: { roles: ['主角'], per_work: 6, order: 'heat' },
      conditions: [cond({ type: 'gender', values: ['男'] }, 'c_x')],
    },
    { id: 'x_3', enabled: true, label: null, share: null, source: { kind: 'work_list', list_id: 'l_works' }, pick: { roles: ['配角'], per_work: 2, order: 'heat' }, conditions: [] },
  ]
  s.draw = { method: 'range_share', seed: 42 }
  s.meta = { name: '测试方案', note: '备注', created: '2026-06-15T00:00:00', updated: '2026-06-15T01:00:00' }
  return s
}

describe('默认方案', () => {
  it('和默认方案的 JSON 一样（键的顺序也一样；年份按当天算；per_work 是 null）', () => {
    expect(JSON.stringify(defaultSpec(TODAY))).toBe(JSON.stringify(JSON.parse(CONTRACT_DEFAULT)))
  })

  it('年份跟着「今天」走：起始年 = 今年 − 10', () => {
    const s = defaultSpec(new Date('2030-01-02T00:00:00'))
    const src = s.ranges[0]!.source
    expect(src.kind === 'rank' && [src.year_from, src.year_to]).toEqual([2020, 2030])
  })

  it('默认值：作品标签数 6、只要主角、每部不限人数（和游戏一样）、按热度、机会均等', () => {
    const s = defaultSpec(TODAY)
    expect(s.game.tag_count).toBe(6)
    expect(s.ranges[0]!.pick).toEqual({ roles: ['主角'], per_work: null, order: 'heat' })
    expect(s.draw.method).toBe('per_character')
  })
})

describe('规整 / 往返（payload 往返）', () => {
  it('默认方案规整后逐字节不变、没有警告', () => {
    const s = defaultSpec(TODAY)
    const r = normalizeSpec(JSON.parse(JSON.stringify(s)), TODAY)
    expect(JSON.stringify(r.spec)).toBe(JSON.stringify(s))
    expect(r.warnings).toEqual([])
  })

  it('用上全部条件类型和来源的方案：JSON 往返 → 规整，逐字节不变', () => {
    const s = bigSpec()
    const wire = JSON.stringify(s)
    const r = normalizeSpec(JSON.parse(wire), TODAY)
    expect(JSON.stringify(r.spec)).toBe(wire)
    expect(r.warnings).toEqual([])
  })

  it('键的顺序被打乱（例如后端 / AI 返回的）：规整成固定顺序，指纹不受影响', () => {
    const s = bigSpec()
    const shuffled = JSON.parse(JSON.stringify(s), (_k, v: unknown) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v as object).reverse())
      return v
    }) as SpecV2
    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(s))
    expect(specFingerprint(shuffled)).toBe(specFingerprint(s))
    expect(JSON.stringify(normalizeSpec(shuffled, TODAY).spec)).toBe(JSON.stringify(s))
  })

  it('缺字段 / 不合法：补默认值并写中文警告', () => {
    const r = normalizeSpec(
      {
        version: 2,
        game: { mode: 'moba', tag_count: 12 },
        ranges: [{ source: { kind: 'rank', subject_types: [], rank_from: 20, rank_to: 5 } }, '坏的'],
        draw: { method: '乱抽' },
      },
      TODAY,
    )
    expect(r.spec.game).toEqual({ mode: 'anime', tag_count: 6 })
    expect(r.spec.ranges).toHaveLength(1)
    const rg = r.spec.ranges[0]!
    expect(rg.id).toMatch(/^r_/)
    expect(rg.pick).toEqual({ roles: ['主角'], per_work: null, order: 'heat' })
    expect(rg.source).toMatchObject({ kind: 'rank', subject_types: [2], rank_from: 20, rank_to: 20 })
    expect(r.spec.excludes).toEqual([])
    expect(r.spec.draw).toEqual({ method: 'per_character', seed: null })
    expect(r.warnings.length).toBeGreaterThanOrEqual(4)
    expect(r.warnings.join('\n')).toMatch(/moba/)
  })

  it('不认识的字段原样保留（后端以后可能加字段）；认不出的条件类型原样保留并提醒', () => {
    const raw = JSON.parse(JSON.stringify(defaultSpec(TODAY))) as Record<string, unknown>
    raw.extra_top = { a: 1 }
    const rg = (raw.ranges as Record<string, unknown>[])[0]!
    rg.future_field = 'x'
    rg.conditions = [{ id: 'c_z', enabled: true, negate: false, type: 'moon_phase', phase: 'full' }]
    const r = normalizeSpec(raw, TODAY)
    expect((r.spec as unknown as Record<string, unknown>).extra_top).toEqual({ a: 1 })
    expect((r.spec.ranges[0] as unknown as Record<string, unknown>).future_field).toBe('x')
    expect(r.spec.ranges[0]!.conditions[0]).toMatchObject({ type: 'moon_phase', phase: 'full' })
    expect(r.warnings.join()).toMatch(/moon_phase/)
  })

  it('重复的 id 会换成新的（范围之间、条件之间都不重复）', () => {
    const s = defaultSpec(TODAY)
    const dup = { ...s, ranges: [s.ranges[0]!, { ...s.ranges[0]!, conditions: [cond({ type: 'gender' }, 'c_same'), cond({ type: 'gender' }, 'c_same')] }] }
    const r = normalizeSpec(dup, TODAY)
    const ids = [...takenIds(r.spec)]
    expect(new Set(ids).size).toBe(ids.length)
    expect(r.spec.ranges[0]!.id).toBe('r_default')
    expect(r.spec.ranges[1]!.id).not.toBe('r_default')
  })

  it('占比 0 是合法的（这个范围不参与抽题），往返后还是 0；负数才当没写', () => {
    const s = defaultSpec(TODAY)
    const withZero = { ...s, ranges: [{ ...s.ranges[0]!, share: 0 }, { ...s.ranges[0]!, id: 'r_b', share: -1 }] }
    const r = normalizeSpec(JSON.parse(JSON.stringify(withZero)), TODAY)
    expect(r.spec.ranges[0]!.share).toBe(0)
    expect(r.spec.ranges[1]!.share).toBeNull()
  })

  it('work_filter_order、include_unaired、tag_mode=meta 这些字段原样保留', () => {
    const s = defaultSpec(TODAY)
    const raw = {
      ...s,
      ranges: [
        {
          ...s.ranges[0]!,
          source: { ...(s.ranges[0]!.source as object), include_unaired: false, work_filter_order: 'after_rank', work_filter: { quant: 'any', k: null, tags: ['Galgame'], tag_list_id: null, tag_mode: 'meta' } },
        },
      ],
    }
    const r = normalizeSpec(JSON.parse(JSON.stringify(raw)), TODAY)
    expect(r.spec.ranges[0]!.source).toMatchObject({ include_unaired: false, work_filter_order: 'after_rank', work_filter: { tag_mode: 'meta' } })
    expect(r.warnings).toEqual([])
  })

  it('不是对象：换成默认方案', () => {
    const r = normalizeSpec('哈哈', TODAY)
    expect(JSON.stringify(r.spec)).toBe(JSON.stringify(defaultSpec(TODAY)))
    expect(r.warnings).toHaveLength(1)
  })
})

describe('指纹', () => {
  it('specFingerprint 不看 meta（名字、时间不算改动）', () => {
    const a = defaultSpec(TODAY)
    const b = { ...a, meta: { name: 'x', updated: 'y' } }
    expect(specFingerprint(a)).toBe(specFingerprint(b))
  })

  it('evalKey 不看抽题方式、种子、范围名字、占比；条件变了才变', () => {
    const a = defaultSpec(TODAY)
    const b: SpecV2 = { ...a, draw: { method: 'per_work', seed: 7 }, ranges: [{ ...a.ranges[0]!, label: '改名', share: 5 }] }
    expect(evalKey(a)).toBe(evalKey(b))
    const c = mapRange(a, 'r_default', (r) => ({ ...r, conditions: [cond({ type: 'gender' })] }))
    expect(evalKey(c)).not.toBe(evalKey(a))
    const d: SpecV2 = { ...a, game: { ...a.game, tag_count: 4 } }
    expect(evalKey(d)).not.toBe(evalKey(a))
  })

  it('stableStringify：键排序、跳过 undefined', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: undefined }] })).toBe('{"a":[{"d":2}],"b":1}')
  })

  it('newId 不和已有的重复', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 200; i++) taken.add(newId('c', taken))
    expect(taken.size).toBe(200)
  })
})

describe('条件摘要（chip 上的字）', () => {
  const lk: NameLookup = { list: (id) => ({ l_tag: '一级标签', l_chars: '已记住', l_done: '已记住', l_works: '京阿尼' })[id] ?? null }

  it('每种条件都有一句直接的中文', () => {
    const s = bigSpec()
    const byId = new Map(s.ranges[0]!.conditions.map((c) => [c.id, conditionText(c, lk)]))
    expect(byId.get('c_g')).toBe('性别 女或未知')
    expect(byId.get('c_h')).toBe('角色热度 ≥ 1,000')
    expect(byId.get('c_t')).toBe('作品标签（格子） 同时含：百合、日常')
    expect(byId.get('c_ct')).toBe('角色标签 至少含 2 个：黑发 + 标签清单「一级标签」')
    expect(byId.get('c_va')).toBe('声优 花泽香菜（任一）')
    expect(byId.get('c_src')).toBe('来源 漫画改')
    expect(byId.get('c_n')).toBe('登场数 2–5 部')
    expect(byId.get('c_e')).toBe('最早登场 ≥ 2010 年')
    expect(byId.get('c_l')).toBe('最晚登场 ≤ 2020 年')
    expect(byId.get('c_r')).toBe('不满足：最高评分 ≥ 7.5 分')
    expect(byId.get('c_a')).toBe('登场作品 至少一部：2024 年的动画，在里面是主角，作品本身的标签含任一：百合（有人打过就算）')
    expect(byId.get('c_cl')).toBe('在角色清单「已记住」里')
    expect(byId.get('c_sql')).toBe('查询 热门')
  })

  it('没填完整 / 清单被删了：写清楚现在是什么状态', () => {
    expect(conditionText(cond({ type: 'va', names: [] }))).toBe('声优 （还没选声优）')
    expect(conditionText(cond({ type: 'char_list', list_id: 'l_gone' }), lk)).toBe('在角色清单（清单已删除）里')
    expect(conditionText(cond({ type: 'char_heat' }))).toBe('角色热度 （还没设范围）')
    expect(tagFilterText({ quant: 'none', k: null, tags: ['BL', '乙女', '耽美', '后宫', '腐'], tag_list_id: null })).toBe('都不含：BL、乙女、耽美、后宫 等 5 个')
  })

  it('「从哪来」「取角色」一句话', () => {
    const s = bigSpec()
    expect(sourceText(defaultSpec(TODAY).ranges[0]!.source)).toBe('2016–2026 年热度前 50 部动画')
    // 作品本身的标签：默认先筛标签再排名（和游戏一样，后端的 work_filter_order 默认 before_rank）
    expect(sourceText(s.ranges[1]!.source)).toBe('2005 年以前动画/游戏里作品本身的标签都不含：BL的作品中，热度第 10 名以后')
    expect(
      sourceText({ kind: 'rank', subject_types: [4], year_from: 2016, year_to: 2026, rank_from: 1, rank_to: 50, rank_scope: 'merged', work_filter: { quant: 'any', k: null, tags: ['Galgame'], tag_list_id: null, tag_mode: 'meta' } }),
    ).toBe('2016–2026 年游戏里作品本身的标签含任一：Galgame（公共标签）的作品中，热度前 50 部')
    expect(
      sourceText({
        kind: 'rank',
        subject_types: [2],
        year_from: 2016,
        year_to: 2026,
        rank_from: 1,
        rank_to: 50,
        rank_scope: 'merged',
        work_filter: { quant: 'any', k: null, tags: ['战斗'], tag_list_id: null, tag_mode: 'main' },
        work_filter_order: 'after_rank',
      }),
    ).toBe('2016–2026 年热度前 50 部动画，其中作品本身的标签含任一：战斗的作品')
    expect(sourceText({ kind: 'rank', subject_types: [2], year_from: 2024, year_to: 2024, rank_from: 1, rank_to: null, rank_scope: 'merged' })).toBe(
      '2024 年的全部动画',
    )
    expect(sourceText({ kind: 'rank', subject_types: [4], year_from: 2020, year_to: 2025, rank_from: 1, rank_to: 10, rank_scope: 'per_year' })).toBe(
      '2020–2025 年每年热度前 10 部游戏',
    )
    expect(sourceText(s.excludes[0]!.source, lk)).toBe('角色清单「已记住」里的角色')
    expect(sourceText({ kind: 'all_characters' })).toBe('整个角色库（不限作品）')
    expect(pickText(defaultSpec(TODAY).ranges[0]!.pick)).toBe('只要主角，每部不限人数')
    expect(pickText(s.ranges[1]!.pick)).toBe('主角和配角，每部不限人数')
    expect(pickText({ roles: ['主角', '配角'], per_work: 6, order: 'game' })).toBe('主角和配角，每部最多 6 人（和游戏一样的顺序）')
    expect(pickText({ roles: ['配角'], per_work: 3, order: 'heat' })).toBe('只要配角，每部最多 3 人（按角色热度）')
  })

  it('兜底句子：没有条件 / 有条件', () => {
    const s = defaultSpec(TODAY)
    expect(localSentence(s.ranges[0]!)).toBe('2016–2026 年热度前 50 部动画的主角')
    const r = { ...s.ranges[0]!, conditions: [cond({ type: 'game_tags', quant: 'all', tags: ['百合', '日常'] })] }
    expect(localSentence(r)).toBe('2016–2026 年热度前 50 部动画的主角里，作品标签（格子） 同时含：百合、日常的角色')
  })

  it('填完整了吗', () => {
    expect(conditionComplete(newCondition('gender', 'c'))).toBe(false) // 不预选任何性别
    expect(conditionComplete(cond({ type: 'gender', values: ['男'] }))).toBe(true)
    expect(conditionComplete(newCondition('game_tags', 'c'))).toBe(false)
    expect(conditionComplete(cond({ type: 'game_tags', quant: 'at_least', k: null, tags: ['百合'] }))).toBe(false)
    expect(conditionComplete(cond({ type: 'game_tags', quant: 'at_least', k: 1, tags: [], tag_list_id: 'l' }))).toBe(true)
    expect(conditionComplete(newCondition('n_app', 'c'))).toBe(false)
    expect(conditionComplete(cond({ type: 'n_app', min: 0 }))).toBe(true)
    expect(conditionComplete(newCondition('appearance', 'c'))).toBe(false)
    expect(conditionComplete(cond({ type: 'appearance', year_from: 2024 }))).toBe(true)
    expect(conditionComplete(newCondition('sql', 'c'))).toBe(false)
    expect(conditionComplete(newCondition('char_list', 'c'))).toBe(false)
  })
})

// ---------------------------------------------------------------- 编辑 store
function resetStore(spec: SpecV2 = defaultSpec(TODAY)) {
  useWb2.setState({ spec, planName: null, baseline: specFingerprint(spec), past: [], future: [], lastCoalesce: null, loadWarnings: [] })
}
const st = () => useWb2.getState()
const dirty = () => specFingerprint(st().spec) !== st().baseline
const setTagCount = (n: number, now?: number, coalesce?: string) =>
  st().edit('改作品标签数', (s) => ({ ...s, game: { ...s.game, tag_count: n } }), { now, coalesce })

describe('编辑 store：撤销 / 重做', () => {
  beforeEach(() => resetStore())

  it('改一次 → 可以撤销 → 可以重做；改动标记跟着变', () => {
    setTagCount(4)
    expect(st().spec.game.tag_count).toBe(4)
    expect(dirty()).toBe(true)
    expect(st().past.map((e) => e.label)).toEqual(['改作品标签数'])
    st().undo()
    expect(st().spec.game.tag_count).toBe(6)
    expect(dirty()).toBe(false)
    expect(st().future).toHaveLength(1)
    st().redo()
    expect(st().spec.game.tag_count).toBe(4)
    expect(st().future).toHaveLength(0)
  })

  it('新的修改会清空「重做」', () => {
    setTagCount(4)
    st().undo()
    setTagCount(3)
    expect(st().future).toHaveLength(0)
    expect(st().past).toHaveLength(1)
  })

  it('没变的修改不进历史', () => {
    setTagCount(6)
    expect(st().past).toHaveLength(0)
  })

  it('同一个输入框 1.5 秒内的连续修改合并成一步；隔久了或换了输入框就是新的一步', () => {
    setTagCount(5, 1000, 'tag_count')
    setTagCount(4, 1500, 'tag_count')
    setTagCount(3, 2000, 'tag_count')
    expect(st().past).toHaveLength(1)
    st().undo()
    expect(st().spec.game.tag_count).toBe(6)
    resetStore()
    setTagCount(5, 1000, 'tag_count')
    setTagCount(4, 5000, 'tag_count')
    expect(st().past).toHaveLength(2)
    setTagCount(3, 5100, 'other')
    expect(st().past).toHaveLength(3)
  })

  it('撤销「打开方案」连方案名和保存状态一起恢复；重做再回来', () => {
    setTagCount(4)
    const before = st().spec
    const plan = { ...defaultSpec(TODAY), game: { mode: 'book' as const, tag_count: 2 } }
    st().loadPlan('方案A', plan)
    expect(st().planName).toBe('方案A')
    expect(dirty()).toBe(false)
    st().undo()
    expect(st().spec).toBe(before)
    expect(st().planName).toBeNull()
    expect(dirty()).toBe(true) // 回到打开之前那份没保存的草稿
    st().redo()
    expect(st().planName).toBe('方案A')
    expect(st().spec.game.mode).toBe('book')
    expect(dirty()).toBe(false)
  })

  it('新建：回到默认方案、没有方案名；可以撤销回原来的方案', () => {
    st().loadPlan('方案B', { ...defaultSpec(TODAY), game: { mode: 'real', tag_count: 1 } })
    st().newPlan(defaultSpec(TODAY))
    expect(st().planName).toBeNull()
    expect(st().spec.game.mode).toBe('anime')
    st().undo()
    expect(st().planName).toBe('方案B')
    expect(st().spec.game.mode).toBe('real')
  })

  it('保存不进历史；保存后撤销 = 有改动（已保存的方案是保存时的内容）', () => {
    setTagCount(4)
    st().markSaved('方案C')
    expect(dirty()).toBe(false)
    expect(st().past).toHaveLength(1)
    st().undo()
    expect(st().planName).toBe('方案C')
    expect(dirty()).toBe(true)
  })

  it(`历史最多 ${HISTORY_LIMIT} 步`, () => {
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) setTagCount(i % 2 ? 3 : 4)
    expect(st().past).toHaveLength(HISTORY_LIMIT)
  })
})

describe('编辑 store：草稿持久化（outsetter.workbench2.v1）', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    localStorage.clear()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())
  const put = (state: unknown, version = 1) => localStorage.setItem('outsetter.workbench2.v1', JSON.stringify({ state, version }))

  it('正常草稿原样读回，「有没有改动」不变，不报警', async () => {
    resetStore()
    setTagCount(3)
    st().markSaved('方案D')
    setTagCount(2)
    const snap = JSON.stringify([st().spec, st().planName, st().baseline])
    await useWb2.persist.rehydrate()
    expect(JSON.stringify([st().spec, st().planName, st().baseline])).toBe(snap)
    expect(dirty()).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('键顺序不同但内容相同的干净草稿：读回来仍然是「没改动」', async () => {
    const s = bigSpec()
    const reversed = JSON.parse(JSON.stringify(s), (_k, v: unknown) =>
      v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as object).reverse()) : v,
    ) as SpecV2
    put({ spec: reversed, planName: 'E', baseline: specFingerprint(reversed) })
    await useWb2.persist.rehydrate()
    expect(st().planName).toBe('E')
    expect(dirty()).toBe(false)
    expect(JSON.stringify(st().spec)).toBe(JSON.stringify(normalizeSpec(s, TODAY).spec))
  })

  it('草稿坏了：换默认方案、去掉方案名（免得保存时覆盖原方案）', async () => {
    put({ spec: '坏了', planName: '别覆盖我', baseline: 'x' })
    await useWb2.persist.rehydrate()
    expect(st().planName).toBeNull()
    expect(st().spec.ranges).toHaveLength(1)
    expect(dirty()).toBe(false)
  })

  it('缺字段的草稿：逐项补默认值，历史清空', async () => {
    put({ spec: { version: 2, ranges: [{ id: 'r_a' }] }, planName: null, baseline: 'x' })
    await useWb2.persist.rehydrate()
    expect(st().spec.game).toEqual({ mode: 'anime', tag_count: 6 })
    expect(st().spec.ranges[0]!.id).toBe('r_a')
    expect(st().spec.ranges[0]!.pick.per_work).toBeNull() // 只要主角、没写 → 不限（和游戏一样）
    expect(st().past).toEqual([])
  })
})

describe('新条件没有看不见的预设值', () => {
  const ALL: Condition['type'][] = [
    'gender',
    'char_heat',
    'game_tags',
    'char_tags',
    'va',
    'source_tag',
    'n_app',
    'earliest_year',
    'latest_year',
    'rating',
    'appearance',
    'char_list',
    'sql',
  ]
  it('每种条件刚新建时都是「没填完整」：「加上这个条件 / 排除这些人」按钮是灰的，必须自己选', () => {
    for (const t of ALL) expect(conditionComplete(newCondition(t, 'c')), t).toBe(false)
  })
  it('性别不预选：新建时一个都不勾', () => {
    const c = newCondition('gender', 'c')
    expect(c.type === 'gender' && c.values).toEqual([])
  })
})

describe('取角色：和游戏一样', () => {
  const p0 = { roles: ['主角'] as Role[], per_work: null, order: 'heat' as const }
  it('只要主角 → 主角和配角：不限人数变成每部 6 个；切回只要主角 → 不限', () => {
    const both = pickWithRoles(p0, ['主角', '配角'])
    expect(both).toEqual({ roles: ['主角', '配角'], per_work: 6, order: 'heat' })
    expect(pickWithRoles(both, ['主角'])).toEqual(p0)
  })
  it('自己填过的数字，加上配角时保留；只要配角也按「加上配角」处理', () => {
    expect(pickWithRoles({ ...p0, per_work: 4 }, ['主角', '配角']).per_work).toBe(4)
    expect(pickWithRoles(p0, ['配角']).per_work).toBe(6)
  })
  it("'bangumi' 当作 'game'；没写 per_work：只要主角 → 不限，有配角 → 6", () => {
    const s = defaultSpec(TODAY)
    const raw = JSON.parse(JSON.stringify(s)) as { ranges: { pick: Record<string, unknown> }[] }
    raw.ranges[0]!.pick = { roles: ['主角'], order: 'bangumi' }
    raw.ranges.push({ ...JSON.parse(JSON.stringify(s.ranges[0])), id: 'r_b', pick: { roles: ['主角', '配角'] } })
    const r = normalizeSpec(raw, TODAY)
    expect(r.spec.ranges[0]!.pick).toEqual({ roles: ['主角'], per_work: null, order: 'game' })
    expect(r.spec.ranges[1]!.pick).toEqual({ roles: ['主角', '配角'], per_work: 6, order: 'heat' })
  })
  it('在 store 里换「取哪些角色」是一步修改，可以撤销回去', () => {
    resetStore()
    st().edit('改成主角和配角', (s) => ({ ...s, ranges: s.ranges.map((r) => ({ ...r, pick: pickWithRoles(r.pick, ['主角', '配角']) })) }))
    expect(st().spec.ranges[0]!.pick.per_work).toBe(6)
    st().undo()
    expect(st().spec.ranges[0]!.pick).toEqual({ roles: ['主角'], per_work: null, order: 'heat' })
  })
})
