import { describe, expect, it } from 'vitest'
import { AI_PROVIDERS, CUSTOM_PROVIDER, MODEL_PLACEHOLDER, modelPlaceholder, providerById } from './providers'

describe('服务商预设', () => {
  it('每个预设都有 id、名字、协议、接口地址和文档链接', () => {
    for (const p of AI_PROVIDERS) {
      expect(p.id, p.label).toMatch(/^[a-z]+$/)
      expect(p.label, p.id).toBeTruthy()
      expect(['openai', 'anthropic'], p.id).toContain(p.protocol)
      expect(p.baseUrl, p.id).toMatch(/^https?:\/\/[^\s/]+/)
      expect(p.baseUrl, p.id).not.toMatch(/\/$|\/chat\/completions$|\/v1\/messages$/)
      expect(p.docs, p.id).toMatch(/^https:\/\//)
    }
  })

  it('id 不重复，和后端的预设列表一致', () => {
    const ids = AI_PROVIDERS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['deepseek', 'dashscope', 'moonshot', 'zhipu', 'siliconflow', 'openai', 'gemini', 'anthropic', 'openrouter', 'ollama', 'lmstudio'])
  })

  it('本机的两个（Ollama、LM Studio）不需要 key，地址是 127.0.0.1；其余都要 key、走 https', () => {
    const local = AI_PROVIDERS.filter((p) => p.local).map((p) => p.id)
    expect(local).toEqual(['ollama', 'lmstudio'])
    for (const p of AI_PROVIDERS) {
      if (p.local) expect(p.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
      else expect(p.baseUrl).toMatch(/^https:\/\//)
    }
  })

  it('只有 Anthropic 用 anthropic 协议', () => {
    expect(AI_PROVIDERS.filter((p) => p.protocol === 'anthropic').map((p) => p.id)).toEqual(['anthropic'])
  })

  it('模型例子只做占位提示：有例子的写「例：…」，没有的提示去看文档或列出模型', () => {
    expect(modelPlaceholder(providerById('deepseek'))).toBe('例：deepseek-flash')
    expect(modelPlaceholder(providerById('zhipu'))).toBe('例：glm-5.2')
    expect(modelPlaceholder(providerById('anthropic'))).toBe('例：claude-sonnet-5-5')
    expect(modelPlaceholder(providerById('moonshot'))).toBe(MODEL_PLACEHOLDER)
    expect(modelPlaceholder(null)).toBe(MODEL_PLACEHOLDER)
    expect(MODEL_PLACEHOLDER).toBe('填服务商文档里的模型名，或点「列出模型」')
  })

  it('自定义：OpenAI 兼容，地址自己填；不认识的 id 返回 null', () => {
    expect(providerById('custom')).toBe(CUSTOM_PROVIDER)
    expect(CUSTOM_PROVIDER).toMatchObject({ protocol: 'openai', baseUrl: '', label: '自定义（OpenAI 兼容）' })
    expect(providerById('nope')).toBeNull()
    expect(providerById(null)).toBeNull()
  })
})
