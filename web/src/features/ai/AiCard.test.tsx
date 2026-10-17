/**
 * 「设置 → AI」卡片：服务端渲染出来的结构。选服务商、key 状态这些判断在 form.test.ts 里测过，这里看画出来的东西。
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/Overlay'
import { ThemeScopeContext, type ThemeScopeValue } from '@/themes/context'
import type { AiApiConfig } from './api'
import { AiConfigForm, KeyField } from './AiCard'
import { applyPreset, EMPTY_FORM, formFromConfig } from './form'

const scope = { theme: { manifest: { id: 'moonlit' } }, mode: 'dark', portalContainer: null } as unknown as ThemeScopeValue
const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ThemeScopeContext.Provider value={scope}>
        <TooltipProvider>{node}</TooltipProvider>
      </ThemeScopeContext.Provider>
    </QueryClientProvider>,
  )

const saved: AiApiConfig = {
  protocol: 'openai',
  preset: 'deepseek',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  max_tokens: null,
  has_key: true,
  key_hint: '…abcd',
  key_from_env: false,
  configured: true,
  problem: null,
}
const none: AiApiConfig = { ...saved, preset: null, base_url: '', model: '', has_key: false, key_hint: '', configured: false, problem: '还没设置 AI 接口' }

const keyInput = (html: string) => /<input[^>]*type="password"[^>]*>/.exec(html)?.[0] ?? ''

describe('AI 卡片', () => {
  it('已保存的设置：服务商文档链接、地址、模型、key 显示「已保存（…后 4 位）」和「清除」', () => {
    const html = wrap(<AiConfigForm config={saved} />)
    expect(html).toContain('id="ai"')
    expect(html).toContain('href="https://api-docs.deepseek.com/"')
    expect(html).toContain('DeepSeek 的接口文档')
    expect(html).toContain('value="https://api.deepseek.com"')
    expect(html).toContain('value="deepseek-flash"')
    expect(html).toContain('模型名以服务商文档为准')
    expect(keyInput(html)).toContain('placeholder="已保存（…abcd），留空不改"')
    expect(keyInput(html)).not.toContain(' disabled=""')
    expect(html).toContain('清除')
    expect(html).toContain('列出模型')
    expect(html).toContain('测试')
    expect(html).toContain('保存')
  })

  it('说明 key 存在哪、每次发什么、按服务商的价格计费', () => {
    const html = wrap(<AiConfigForm config={saved} />)
    expect(html).toContain('backend/config.json')
    expect(html).toContain('不进 git')
    expect(html).toContain('6–7 千字')
    expect(html).toContain('按服务商的价格计费')
  })

  it('还没设置：服务商没选，模型输入框只有占位提示，key 输入框提示粘贴，没有「清除」', () => {
    const html = wrap(<AiConfigForm config={none} />)
    expect(html).toContain('选一个服务商')
    expect(html).toContain('placeholder="填服务商文档里的模型名，或点「列出模型」"')
    expect(keyInput(html)).toContain('placeholder="粘贴服务商给的 API key"')
    expect(html).not.toContain('清除')
  })

  it('key 来自环境变量：输入框禁用，说明环境变量名', () => {
    const html = wrap(<AiConfigForm config={{ ...saved, key_from_env: true, key_hint: '…9999' }} />)
    expect(keyInput(html)).toContain(' disabled=""')
    expect(keyInput(html)).toContain('来自环境变量（…9999）')
    expect(html).toContain('OUTSETTER_AI_API_KEY')
    expect(html).not.toContain('清除')
  })
})

describe('API key 输入框的几种状态', () => {
  const field = (config: AiApiConfig, form = formFromConfig(config)) =>
    wrap(<KeyField form={form} config={config} onChange={() => {}} onClear={() => {}} />)

  it('已保存 / 没有 / 来自环境变量', () => {
    expect(field(saved)).toContain('data-key-mode="saved"')
    expect(field(none)).toContain('data-key-mode="empty"')
    expect(field({ ...saved, key_from_env: true })).toContain('data-key-mode="env"')
  })

  it('点了清除：显示「不清除了」；换了服务商没填 key：说明保存时会清掉已存的 key', () => {
    const cleared = field(saved, { ...formFromConfig(saved), clear_key: true })
    expect(cleared).toContain('data-key-mode="cleared"')
    expect(cleared).toContain('不清除了')
    const moved = field(saved, applyPreset(formFromConfig(saved), 'moonshot'))
    expect(moved).toContain('data-key-mode="host_changed"')
    expect(moved).toContain('保存时会清掉它')
  })

  it('本机服务：提示一般不用填', () => {
    expect(field(none, applyPreset(EMPTY_FORM, 'lmstudio'))).toContain('本机服务一般不用填')
  })

  it('输入框是密码框，不自动补全', () => {
    const input = keyInput(field(saved))
    expect(input).toContain('type="password"')
    expect(input).toMatch(/autocomplete="off"/i)
  })
})
