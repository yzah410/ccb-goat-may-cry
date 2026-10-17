import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeBlock, normalizeBlocks, normalizeTagGroups } from './normalize'
import { configFingerprint, hasEnabledInclude, toConfigPayload, validateConfig } from './payload'
import { isAllExcludeGroup, summarizeBlock, tagGroupText, tagGroupsText } from './summary'
import { newBlock } from './defaults'
import { useDraft } from './store'
import type { Block } from './schema'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLANS_DIR = path.resolve(HERE, '../../../../examples/classic-plans')

describe('样例方案文件（examples/classic-plans/*.json）', () => {
  const files = fs.existsSync(PLANS_DIR) ? fs.readdirSync(PLANS_DIR).filter((f) => f.endsWith('.json')) : []

  it('仓库里确实有方案可测', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('每个方案：加载规整后原样不变（不丢字段、不凭空加字段），并能通过发送前检查', () => {
    let blocksTotal = 0
    for (const f of files) {
      const plan = JSON.parse(fs.readFileSync(path.join(PLANS_DIR, f), 'utf8'))
      const { blocks, warnings } = normalizeBlocks(plan.blocks)
      expect(warnings, `${f} 不应该有警告`).toEqual([])
      expect(JSON.stringify(blocks), `${f} 往返后应该字节级一致`).toBe(JSON.stringify(plan.blocks))
      const payload = toConfigPayload(
        { mode: plan.mode, seed: plan.seed, includeExtraWorkTags: plan.include_extra_work_tags, blocks },
        plan.theme,
      )
      expect(validateConfig(payload), `${f} 应该能直接发给后端`).toEqual([])
      blocksTotal += blocks.length
    }
    expect(blocksTotal).toBeGreaterThan(0)
  })

  it('全是排除项的标签组能正常加载', () => {
    // 选这个样例方案，是因为它带一个全是排除项的标签组
    const p = path.join(PLANS_DIR, '0108-1849.json')
    if (!fs.existsSync(p)) return
    const plan = JSON.parse(fs.readFileSync(p, 'utf8'))
    const { blocks } = normalizeBlocks(plan.blocks)
    const groups = blocks.flatMap((b) => ('tag_groups' in b.params ? (b.params.tag_groups as Block['params']['tag_groups']) : []) ?? [])
    expect(groups.some((g) => isAllExcludeGroup(g as never))).toBe(true)
  })
})

describe('normalizeTagGroups：三种形态', () => {
  const item = { name: '治愈', kind: 'work', color: 'red' }
  it('列表的列表原样', () => {
    expect(normalizeTagGroups([[item]])).toEqual([[item]])
  })
  it('[{items:[...]}] → 列表的列表', () => {
    expect(normalizeTagGroups([{ items: [item] }])).toEqual([[item]])
  })
  it('单组平铺 → 一组', () => {
    expect(normalizeTagGroups([item, { ...item, name: '日常' }])).toEqual([[item, { ...item, name: '日常' }]])
  })
  it('null / 空 → []', () => {
    expect(normalizeTagGroups(null)).toEqual([])
    expect(normalizeTagGroups([])).toEqual([])
  })
  it('非法 kind / color 会被纠正并给警告', () => {
    const w: string[] = []
    const g = normalizeTagGroups([[{ name: '甲', kind: '角色', color: 'green' }]], '测试', w)
    expect(g).toEqual([[{ name: '甲', kind: 'work', color: 'red' }]])
    expect(w.length).toBe(2)
  })
})

describe('normalizeBlock', () => {
  it('缺必填字段时补默认值并警告', () => {
    const r = normalizeBlock({ id: 'x', kind: 'work-range', color: 'red', weight: 1, enabled: true, params: {} }, 0)
    expect(r.block?.kind).toBe('work-range')
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(validateConfig(toConfigPayload({ mode: 'char-weight', seed: null, includeExtraWorkTags: false, blocks: [r.block!] }))).toEqual([])
  })
  it('char-range 的 null 区间视为不限（字段去掉）', () => {
    const r = normalizeBlock({ id: 'y', kind: 'char-range', color: 'blue', weight: 1, enabled: true, params: { earliest_year: null, tag_groups: [] } }, 0)
    expect(r.block?.params).toEqual({ tag_groups: [] })
  })
  it('未知类型直接跳过', () => {
    expect(normalizeBlock({ kind: 'what' }, 3).block).toBeNull()
  })
  it('权重：没写 → 1；不是数字或负数 → 0（和编辑框一致）', () => {
    const mk = (weight: unknown) => normalizeBlock({ id: 'w', kind: 'char-list', color: 'red', weight, enabled: true, params: { char_lines: 'a' } }, 0)
    expect(mk(undefined).block?.weight).toBe(1)
    expect(mk(null).block?.weight).toBe(1)
    expect(mk(2.5).block?.weight).toBe(2.5)
    expect(mk('3').block?.weight).toBe(3)
    expect(mk(-1).block?.weight).toBe(0)
    expect(mk(-1).warnings.length).toBe(1)
    expect(mk('abc').block?.weight).toBe(0)
    expect(mk('abc').warnings.length).toBe(1)
  })
  it('额外字段原样保留', () => {
    const r = normalizeBlock({ id: 'z', kind: 'char-list', color: 'red', weight: 2, enabled: false, params: { char_lines: 'a', foo: 1 }, bar: true }, 0)
    expect(r.block).toMatchObject({ bar: true, params: { char_lines: 'a', foo: 1 } })
  })
})

describe('发送前检查 validateConfig', () => {
  const ok = { mode: 'char-weight' as const, seed: null, includeExtraWorkTags: false, blocks: [newBlock('work-range')] }
  it('默认草稿能发', () => {
    expect(validateConfig(toConfigPayload(ok))).toEqual([])
  })
  it('种子必须是整数', () => {
    expect(validateConfig({ ...toConfigPayload(ok), seed: 1.5 })).not.toEqual([])
  })
  it('标签 kind 必须合法', () => {
    const b = newBlock('char-range')
    const bad = { ...b, params: { tag_groups: [[{ name: 'x', kind: 'nope', color: 'red' }]] } } as unknown as Block
    expect(validateConfig(toConfigPayload({ ...ok, blocks: [bad] })).length).toBeGreaterThan(0)
  })
  it('有没有启用的纳入块', () => {
    const blue = { ...newBlock('char-list'), color: 'blue' as const }
    expect(hasEnabledInclude([blue])).toBe(false)
    expect(hasEnabledInclude([newBlock('char-list')])).toBe(true)
  })
})

describe('组块摘要', () => {
  it('作品范围', () => {
    const lines = summarizeBlock(newBlock('work-range'))
    expect(lines[0]).toBe('1980–2025 年')
    expect(lines.join('')).toContain('前 20 名')
  })
  it('标签组文字：纳入用 +，排除用 −，组之间「或」', () => {
    const g = [
      [
        { name: '治愈', kind: 'work' as const, color: 'red' as const },
        { name: '日常', kind: 'work' as const, color: 'red' as const },
        { name: '百合', kind: 'work' as const, color: 'blue' as const },
      ],
      [{ name: '恋爱', kind: 'work' as const, color: 'red' as const }],
    ]
    expect(tagGroupText(g[0]!)).toBe('治愈 + 日常 −百合')
    expect(tagGroupsText(g)).toBe('治愈 + 日常 −百合 ｜或｜ 恋爱')
  })
  it('没设条件的角色范围会提示「全部角色」', () => {
    expect(summarizeBlock(newBlock('char-range'))).toEqual(['没设任何条件 = 全部角色'])
  })
})

describe('草稿 store', () => {
  beforeEach(() => useDraft.getState().resetDraft())

  it('新增组块后自动选中', () => {
    const id = useDraft.getState().addBlock('char-list')
    expect(useDraft.getState().selectedId).toBe(id)
    expect(useDraft.getState().blocks).toHaveLength(2)
  })

  it('删除后选中前一个：max(0, 原下标 - 1)', () => {
    const s = useDraft.getState()
    const a = s.blocks[0]!.id
    const b = s.addBlock('char-list')
    const c = s.addBlock('work-list')
    useDraft.getState().select(c)
    useDraft.getState().removeBlock(c)
    expect(useDraft.getState().selectedId).toBe(b)
    useDraft.getState().select(a)
    useDraft.getState().removeBlock(a)
    expect(useDraft.getState().selectedId).toBe(b)
  })

  it('上移/下移交换顺序并选中被移动的组块', () => {
    const s = useDraft.getState()
    const a = s.blocks[0]!.id
    const b = s.addBlock('char-list')
    useDraft.getState().moveBlock(b, -1)
    expect(useDraft.getState().blocks.map((x) => x.id)).toEqual([b, a])
    expect(useDraft.getState().selectedId).toBe(b)
    useDraft.getState().moveBlock(b, -1) // 已经在最上面：不变
    expect(useDraft.getState().blocks.map((x) => x.id)).toEqual([b, a])
  })

  it('改了就「有改动」，保存后清掉；加载方案后不算改动', () => {
    const st = () => useDraft.getState()
    const fp = () => configFingerprint(st())
    expect(fp()).toBe(st().baseline)
    st().setSeed(42)
    expect(fp()).not.toBe(st().baseline)
    st().markSaved('测试')
    expect(fp()).toBe(st().baseline)
    st().loadPlan('p', { mode: 'work-weight', seed: 7, blocks: [newBlock('char-list')], include_extra_work_tags: true })
    expect(st().mode).toBe('work-weight')
    expect(st().seed).toBe(7)
    expect(st().includeExtraWorkTags).toBe(true)
    expect(fp()).toBe(st().baseline)
  })

  it('撤销删除：插回原位置', () => {
    const s = useDraft.getState()
    s.addBlock('char-list')
    const third = useDraft.getState().addBlock('work-list')
    const r = useDraft.getState().removeBlock(useDraft.getState().blocks[1]!.id)!
    useDraft.getState().insertBlock(r.block, r.index)
    expect(useDraft.getState().blocks[1]!.id).toBe(r.block.id)
    expect(useDraft.getState().blocks[2]!.id).toBe(third)
  })
})
