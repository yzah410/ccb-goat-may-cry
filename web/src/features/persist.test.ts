/**
 * 持久化 store 读回来的校验：
 * localStorage 里是缺字段 / 字段不合法 / 干脆不是对象的数据时，hydrate 不崩，不合法的字段回默认值并 console.warn；
 * 正常的数据原样读回（不误报、不改动，草稿的「有没有改动」指纹不变）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { useDraft } from './blocks/store'
import { configFingerprint } from './blocks/payload'
import { BlockSchema } from './blocks/schema'
import { usePrefs, DEFAULT_PREFS } from './settings/store'
import { useCandidateView, usePick } from './candidates/store'

const put = (key: string, state: unknown, version = 1) => localStorage.setItem(key, JSON.stringify({ state, version }))
const draftSnapshot = () => {
  const s = useDraft.getState()
  return JSON.stringify([s.mode, s.seed, s.includeExtraWorkTags, s.blocks, s.selectedId, s.planName, s.planTheme, s.baseline])
}

describe('持久化 store：读回来先校验', () => {
  let warn: ReturnType<typeof vi.spyOn>
  let error: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    localStorage.clear()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
    error.mockRestore()
  })

  it('缺字段的草稿：不崩，缺的回默认值，组块按「载入方案」的规则补齐', async () => {
    put('outsetter.draft.v1', { blocks: [{ kind: 'work-range', color: 'red' }], mode: '不存在的模式', planName: '我的方案' })
    await useDraft.persist.rehydrate()
    const s = useDraft.getState()
    expect(s.mode).toBe('char-weight')
    expect(s.seed).toBeNull()
    expect(s.includeExtraWorkTags).toBe(false)
    expect(z.array(BlockSchema).safeParse(s.blocks).success).toBe(true)
    expect(s.blocks).toHaveLength(1)
    expect(s.blocks[0]!.kind).toBe('work-range')
    expect(s.selectedId).toBe(s.blocks[0]!.id) // 选中的组块一定存在
    expect(s.planName).toBe('我的方案') // 合法的字段保留
    expect(s.baseline).toBe(configFingerprint(s)) // baseline 缺了 → 按现在的内容算
    expect(warn).toHaveBeenCalled()
  })

  it('组块坏得修不好（不是数组）：换成一份新草稿，方案名清空', async () => {
    put('outsetter.draft.v1', { blocks: '坏掉了', planName: '别覆盖我', baseline: 'x' })
    await useDraft.persist.rehydrate()
    const s = useDraft.getState()
    expect(s.blocks).toHaveLength(1)
    expect(z.array(BlockSchema).safeParse(s.blocks).success).toBe(true)
    expect(s.planName).toBeNull()
    expect(s.baseline).toBe(configFingerprint(s))
  })

  it('正常的草稿原样读回：不报警、不改动（指纹和「有没有改动」都不变）', async () => {
    const d = useDraft.getState()
    d.resetDraft()
    d.addBlock('char-range')
    d.setSeed(42)
    d.setMode('work-weight')
    const before = draftSnapshot()
    const dirtyBefore = configFingerprint(useDraft.getState()) !== useDraft.getState().baseline
    warn.mockClear()
    await useDraft.persist.rehydrate()
    expect(draftSnapshot()).toBe(before)
    expect(configFingerprint(useDraft.getState()) !== useDraft.getState().baseline).toBe(dirtyBefore)
    expect(warn).not.toHaveBeenCalled()
  })

  it('设置：不合法的字段回默认值，合法的保留', async () => {
    put('outsetter.prefs.v1', { theme: 42, modePref: 'purple', shellPref: 'dock', avatars: 'yes', apiBase: 'http://127.0.0.1:8099' })
    await usePrefs.persist.rehydrate()
    const p = usePrefs.getState()
    expect(p.theme).toBe(DEFAULT_PREFS.theme)
    expect(p.modePref).toBe('auto')
    expect(p.avatars).toBe(false)
    expect(p.shellPref).toBe('dock')
    expect(p.apiBase).toBe('http://127.0.0.1:8099')
    expect(typeof p.set).toBe('function') // 方法不会被存储里的东西覆盖
  })

  it('整个存储不是对象：全部用默认值', async () => {
    put('outsetter.candidate-view.v1', '被写坏了')
    await useCandidateView.persist.rehydrate()
    expect(useCandidateView.getState().pageSize).toBe(10)
    put('outsetter.candidate-view.v1', { pageSize: 99, displayMode: 'row' })
    await useCandidateView.persist.rehydrate()
    expect(useCandidateView.getState().pageSize).toBe(10) // 超出 1–20
    expect(useCandidateView.getState().displayMode).toBe('row')
  })

  it('当前题目缺了角色 id：丢掉（回到「还没有当前题目」），不会让界面崩', async () => {
    put('outsetter.pick.v1', { pick: { item: { character: { name: '贝拉' } }, source: 'draw', at: 1 } })
    await usePick.persist.rehydrate()
    expect(usePick.getState().pick).toBeNull()
    const ok = { item: { char_id: 7, character: { id: 7, name: '贝拉', gender: '♀', heat: 1 }, mode: 'char-weight' }, source: 'candidates', at: 2 }
    put('outsetter.pick.v1', { pick: ok })
    await usePick.persist.rehydrate()
    expect(usePick.getState().pick).toEqual(ok) // 合法的原样保留（包括没列出来校验的字段）
  })
})
