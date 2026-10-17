import { describe, expect, it } from 'vitest'
import { AI_NOT_CONFIGURED, aiAvailabilityOf, engineOptionLabel, unavailableText } from './aiAvailability'
import type { AiEngine, AiStatusResp } from './types'

const api = (ok: boolean, label = 'DeepSeek'): AiEngine => ({ id: 'api', available: ok, channel_ok: ok, label, model: 'deepseek-flash', note: ok ? '已设置（api.deepseek.com）' : '还没设置 AI 接口' })
const claude = (ok: boolean): AiEngine => ({ id: 'claude', available: ok, channel_ok: ok, label: 'Claude（本机命令行）', note: ok ? null : '这台电脑上没找到 claude 命令' })
const codex = (ok: boolean): AiEngine => ({ id: 'codex', available: ok, channel_ok: ok, label: 'Codex（本机命令行）', note: ok ? null : '这台电脑上没找到 codex 命令' })
const status = (engines: AiEngine[], def: AiStatusResp['default'] = 'api'): AiStatusResp => ({ engines, default: def })

describe('aiAvailabilityOf', () => {
  it('API 设置好了：能用，默认用 API，显示名用后端给的服务商名', () => {
    const a = aiAvailabilityOf(status([api(true), claude(false), codex(false)]))
    expect(a.ready).toBe(true)
    expect(a.defaultEngine).toBe('api')
    expect(a.engines).toEqual([{ id: 'api', label: 'DeepSeek' }])
    expect(a.reason).toBeNull()
  })

  it('API 没设置、本机命令行也不能用：原因是「还没设置 AI」，告诉去哪里填', () => {
    const a = aiAvailabilityOf(status([api(false), claude(false), codex(false)]))
    expect(a.ready).toBe(false)
    expect(a.reason).toBe(AI_NOT_CONFIGURED)
    expect(AI_NOT_CONFIGURED).toBe('还没设置 AI：在「设置 → AI」里填接口地址、模型和 API key')
  })

  it('API 没设置、但 Claude 命令行能用：用 Claude，下拉框的名字是后端的 label', () => {
    const a = aiAvailabilityOf(status([api(false), claude(true), codex(true)]))
    expect(a.ready).toBe(true)
    expect(a.defaultEngine).toBe('claude')
    expect(a.engines.map((e) => e.label)).toEqual(['Claude（本机命令行）', 'Codex（本机命令行）'])
  })

  it('后端指定的默认能用就用它', () => {
    expect(aiAvailabilityOf(status([api(true), claude(true)], 'claude')).defaultEngine).toBe('claude')
  })

  it('labelOf：现在用不了的 engine 也有名字；后端没给 label 时用固定的名字', () => {
    const a = aiAvailabilityOf(status([api(true, 'api.example.com'), claude(false)]))
    expect(a.labelOf('api')).toBe('api.example.com')
    expect(a.labelOf('claude')).toBe('Claude（本机命令行）')
    expect(a.labelOf('codex')).toBe('Codex（本机命令行）')
    const bare = aiAvailabilityOf(status([{ id: 'api', available: true, channel_ok: true }]))
    expect(bare.labelOf('api')).toBe('AI 接口')
    expect(bare.labelOf(null)).toBe('AI')
  })

  it('后端没有 API 这条路时（只有命令行）：原因按各自的说明拼起来', () => {
    const a = aiAvailabilityOf(status([claude(false), codex(false)], 'claude'))
    expect(a.reason).toBe('Claude（本机命令行）：这台电脑上没找到 claude 命令；Codex（本机命令行）：这台电脑上没找到 codex 命令')
  })

  it('没有任何 engine：没有可用的 AI', () => {
    expect(aiAvailabilityOf(status([])).reason).toBe('没有可用的 AI')
    expect(aiAvailabilityOf(undefined).ready).toBe(false)
  })

  it('API 填了但有问题（key 里有换行、地址带了 ? 等）：原因用后端的说明，不说「还没设置」', () => {
    const note = 'API key 里有不能用的字符（空格、换行或非英文字符），请检查'
    const a = aiAvailabilityOf(status([{ ...api(false), note }, claude(false)]))
    expect(a.reason).toBe(note)
    expect(aiAvailabilityOf(status([{ ...api(false), note: null }])).reason).toBe(AI_NOT_CONFIGURED)
  })

  it('用不了的那句话：「还没设置 AI」开头时直接显示原因，前面不加「AI 现在用不了：」', () => {
    expect(unavailableText(AI_NOT_CONFIGURED)).toBe(AI_NOT_CONFIGURED)
    expect(unavailableText('API key 里有不能用的字符，请检查')).toBe('AI 现在用不了：API key 里有不能用的字符，请检查')
    expect(unavailableText('查不到 AI 状态：网络错误。')).toBe('AI 现在用不了：查不到 AI 状态：网络错误')
    expect(unavailableText(null)).toBe('AI 现在用不了')
  })

  it('下拉框里 codex 标上「较慢」', () => {
    expect(engineOptionLabel('codex', 'Codex（本机命令行）')).toBe('Codex（本机命令行） · 较慢')
    expect(engineOptionLabel('api', 'DeepSeek')).toBe('DeepSeek')
  })
})
