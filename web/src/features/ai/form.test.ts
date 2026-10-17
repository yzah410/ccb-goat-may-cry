import { describe, expect, it } from 'vitest'
import type { AiApiConfig } from './api'
import {
  applyPreset,
  bodyFromForm,
  EMPTY_FORM,
  formDirty,
  formFromConfig,
  formIssues,
  hasBadChars,
  hostOf,
  keyFieldState,
  normalizeBaseUrl,
  originOf,
  saveNotice,
  testResultText,
  urlProblem,
  type AiForm,
} from './form'

const NOT_SET = '还没设置 AI 接口：在「设置 → AI」里填接口地址、模型和 API key'
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
const none: AiApiConfig = { ...saved, preset: null, base_url: '', model: '', has_key: false, key_hint: '', configured: false, problem: NOT_SET }

describe('接口地址', () => {
  it('去掉末尾的 / 和误粘进来的路径，不补 /v1', () => {
    expect(normalizeBaseUrl(' https://api.deepseek.com/ ')).toBe('https://api.deepseek.com')
    expect(normalizeBaseUrl('https://api.openai.com/v1/chat/completions')).toBe('https://api.openai.com/v1')
    expect(normalizeBaseUrl('https://relay.example/v1/messages/')).toBe('https://relay.example')
    expect(hostOf('https://API.deepseek.com/x')).toBe('api.deepseek.com')
    expect(hostOf('不是地址')).toBe('')
  })

  it('originOf：协议 + 域名 + 端口，默认端口不写', () => {
    expect(originOf('https://API.deepseek.com/v1/')).toBe('https://api.deepseek.com')
    expect(originOf('https://api.deepseek.com:443/v1')).toBe('https://api.deepseek.com')
    expect(originOf('http://api.deepseek.com')).toBe('http://api.deepseek.com')
    expect(originOf('https://api.deepseek.com:8443')).toBe('https://api.deepseek.com:8443')
    expect(originOf('http://[::1]:1234/v1')).toBe('http://[::1]:1234')
    expect(originOf('ftp://x.example')).toBe('')
    expect(originOf('')).toBe('')
  })

  it('格式检查和后端一样：不带用户名密码、反斜杠、? 参数、# 片段，端口要对', () => {
    expect(urlProblem('https://api.deepseek.com/v1')).toBeUndefined()
    expect(urlProblem('http://[::1]:1234/v1')).toBeUndefined()
    expect(urlProblem('https://api.example.com:/v1')).toBeUndefined()
    expect(urlProblem('https://user:pw@api.example.com/v1')).toBe('接口地址里不要带用户名或密码（@ 和它前面的部分）')
    expect(urlProblem('https://api.example.com@evil.example/v1')).toBe('接口地址里不要带用户名或密码（@ 和它前面的部分）')
    expect(urlProblem('https://api.example.com\\v1')).toBe('接口地址里不能有反斜杠 \\')
    expect(urlProblem('https://api.example.com/v1?api-version=1')).toBe('接口地址里不要带 ? 参数')
    expect(urlProblem('https://api.example.com/v1#x')).toBe('接口地址里不要带 # 和后面的内容')
    expect(urlProblem('https://api.example.com:99999/v1')).toBe('接口地址的端口不对')
    expect(urlProblem('https://api.example.com:abc/v1')).toBe('接口地址的端口不对')
    expect(urlProblem('https://api.exa\u0001mple.com/v1')).toBe('接口地址里有不能用的字符')
    expect(urlProblem('ftp://x')).toBe('要以 http:// 或 https:// 开头，中间不能有空格')
  })

  it('不能用的字符：控制字符、单独的代理码元；完整的 emoji 可以', () => {
    expect(hasBadChars('deepseek-flash')).toBe(false)
    expect(hasBadChars('模型😀')).toBe(false)
    expect(hasBadChars('m\ud800')).toBe(true)
    expect(hasBadChars('m\udc00x')).toBe(true)
    expect(hasBadChars('m\u0000')).toBe(true)
    expect(hasBadChars('m\u007f')).toBe(true)
  })
})

describe('选服务商', () => {
  it('选一个预设：填好地址和协议；模型名不填默认值', () => {
    const f = applyPreset(EMPTY_FORM, 'zhipu')
    expect(f).toMatchObject({ preset: 'zhipu', protocol: 'openai', base_url: 'https://open.bigmodel.cn/api/paas/v4', model: '' })
    const a = applyPreset(f, 'anthropic')
    expect(a).toMatchObject({ preset: 'anthropic', protocol: 'anthropic', base_url: 'https://api.anthropic.com', model: '' })
  })

  it('换了服务商清空模型名；重选同一个保留模型名；选自定义保留地址和模型、协议变成 OpenAI 兼容', () => {
    const f: AiForm = { ...EMPTY_FORM, preset: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-flash' }
    expect(applyPreset(f, 'moonshot').model).toBe('')
    expect(applyPreset(f, 'deepseek').model).toBe('deepseek-flash')
    const c = applyPreset({ ...f, protocol: 'anthropic', base_url: 'https://relay.example' }, 'custom')
    expect(c).toMatchObject({ preset: 'custom', protocol: 'openai', base_url: 'https://relay.example', model: 'deepseek-flash' })
    expect(applyPreset(f, 'nope')).toBe(f)
  })

  it('换到另一个接口地址：清掉输入框里还没保存的 key（不发给另一个服务商）', () => {
    const f: AiForm = { ...EMPTY_FORM, preset: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', api_key: 'sk-deepseek' }
    expect(applyPreset(f, 'moonshot').api_key).toBe('')
    expect(applyPreset({ ...f, preset: 'ollama', base_url: 'http://127.0.0.1:11434/v1' }, 'lmstudio').api_key).toBe('')   // 端口不同也算
    expect(applyPreset(f, 'deepseek').api_key).toBe('sk-deepseek')                 // 同一个地址：保留
    expect(applyPreset(f, 'custom').api_key).toBe('sk-deepseek')                   // 自定义不改地址：保留
    expect(applyPreset({ ...EMPTY_FORM, api_key: 'sk-first' }, 'moonshot').api_key).toBe('sk-first')   // 先粘贴 key 再选服务商：保留
  })

  it('设置 → 表单：没存 preset 时按地址认，认不出来算自定义；什么都没设置时什么都不选', () => {
    expect(formFromConfig(saved)).toMatchObject({ preset: 'deepseek', model: 'deepseek-flash', api_key: '', clear_key: false })
    expect(formFromConfig({ ...saved, preset: null, base_url: 'https://api.moonshot.cn/v1' }).preset).toBe('moonshot')
    expect(formFromConfig({ ...saved, preset: null, base_url: 'https://relay.example/v1' }).preset).toBe('custom')
    expect(formFromConfig(none).preset).toBeNull()
    expect(formFromConfig(undefined)).toEqual(EMPTY_FORM)
  })
})

describe('发给后端的内容', () => {
  const f = formFromConfig(saved)
  it('没填 key 就不带 api_key；填了带去掉空白的 key；点了清除带 clear_key', () => {
    expect(bodyFromForm(f)).toEqual({ protocol: 'openai', preset: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', max_tokens: null })
    expect(bodyFromForm({ ...f, api_key: '  sk-new  ' }).api_key).toBe('sk-new')
    expect(bodyFromForm({ ...f, clear_key: true })).toMatchObject({ clear_key: true })
    expect(bodyFromForm({ ...f, clear_key: true })).not.toHaveProperty('api_key')
  })
  it('key 来自环境变量时 key 相关的字段都不带', () => {
    const b = bodyFromForm({ ...f, api_key: 'sk-x', clear_key: true }, { keyFromEnv: true })
    expect(b).not.toHaveProperty('api_key')
    expect(b).not.toHaveProperty('clear_key')
  })
  it('地址整理过再发', () => {
    expect(bodyFromForm({ ...f, base_url: 'https://api.deepseek.com/chat/completions' }).base_url).toBe('https://api.deepseek.com')
  })
})

describe('保存前的检查', () => {
  it('地址、模型必填；key 不能有空格', () => {
    expect(formIssues(formFromConfig(saved))).toEqual({})
    expect(formIssues(EMPTY_FORM)).toMatchObject({ base_url: expect.any(String), model: expect.any(String) })
    expect(formIssues({ ...formFromConfig(saved), base_url: 'ftp://x' }).base_url).toBeTruthy()
    expect(formIssues({ ...formFromConfig(saved), api_key: 'sk with space' }).api_key).toBeTruthy()
    expect(formIssues({ ...formFromConfig(saved), model: 'm'.repeat(201) }).model).toBeTruthy()
    expect(formIssues({ ...formFromConfig(saved), model: 'm\ud800' }).model).toBe('模型名里有不能用的字符')
    expect(formIssues({ ...formFromConfig(saved), base_url: 'https://api.deepseek.com/v1?x=1' }).base_url).toBe('接口地址里不要带 ? 参数')
  })
  it('anthropic 协议可以不填地址（用官方地址）', () => {
    expect(formIssues({ ...EMPTY_FORM, protocol: 'anthropic', model: 'claude-x' })).toEqual({})
  })
})

describe('API key 输入框', () => {
  it('来自环境变量：不能改，说明环境变量名', () => {
    const s = keyFieldState({ ...saved, key_from_env: true, key_hint: '…9999' }, formFromConfig(saved))
    expect(s).toMatchObject({ mode: 'env', disabled: true, canClear: false })
    expect(s.placeholder).toContain('…9999')
    expect(s.note).toContain('OUTSETTER_AI_API_KEY')
  })
  it('已保存：占位写后 4 位、留空不改，可以清除', () => {
    const s = keyFieldState(saved, formFromConfig(saved))
    expect(s).toEqual({ mode: 'saved', disabled: false, placeholder: '已保存（…abcd），留空不改', note: null, canClear: true })
  })
  it('没有 key：提示粘贴；本机服务提示一般不用填', () => {
    expect(keyFieldState(none, formFromConfig(none))).toMatchObject({ mode: 'empty', disabled: false, canClear: false })
    expect(keyFieldState(none, applyPreset(EMPTY_FORM, 'ollama'))).toMatchObject({ mode: 'local', placeholder: '本机服务一般不用填' })
  })
  it('点了清除：提示保存后清掉；换了域名又没填 key：提示保存时会清掉已存的 key', () => {
    const f = formFromConfig(saved)
    expect(keyFieldState(saved, { ...f, clear_key: true }).mode).toBe('cleared')
    const moved = keyFieldState(saved, applyPreset(f, 'moonshot'))
    expect(moved.mode).toBe('host_changed')
    expect(moved.note).toContain('api.deepseek.com')
    expect(keyFieldState(saved, { ...applyPreset(f, 'moonshot'), api_key: 'sk-kimi' }).mode).toBe('saved')
  })
  it('anthropic 协议不填地址等于官方地址，不算换了域名', () => {
    const a: AiApiConfig = { ...saved, protocol: 'anthropic', preset: 'anthropic', base_url: 'https://api.anthropic.com' }
    expect(keyFieldState(a, { ...formFromConfig(a), base_url: '' }).mode).toBe('saved')
  })
  it('只换了协议或端口也算换了地址；默认端口写不写都一样', () => {
    const f = formFromConfig(saved)
    const http = keyFieldState(saved, { ...f, base_url: 'http://api.deepseek.com' })
    expect(http.mode).toBe('host_changed')
    expect(http.note).toContain('https://api.deepseek.com')
    expect(keyFieldState(saved, { ...f, base_url: 'https://api.deepseek.com:8443' }).mode).toBe('host_changed')
    expect(keyFieldState(saved, { ...f, base_url: 'https://api.deepseek.com:443/beta' }).mode).toBe('saved')
  })
  it('key 来自环境变量又换了地址：提醒这个 key 会发到新地址', () => {
    const env = { ...saved, key_from_env: true }
    expect(keyFieldState(env, formFromConfig(env)).note).not.toContain('发到新填的地址')
    expect(keyFieldState(env, applyPreset(formFromConfig(env), 'moonshot')).note).toContain('这个 key 也会发到新填的地址；不想这样就先取消这个环境变量')
  })
})

describe('测试结果', () => {
  const fmt = (n: number) => `${n} 毫秒`
  it('通过：回复和用时；真的没连上：「没连上」；接口报错：「测试没通过」', () => {
    expect(testResultText({ ok: true, ms: 12, reply: 'OK', error: null }, fmt)).toBe('连上了：AI 回复「OK」，用时 12 毫秒')
    expect(testResultText({ ok: false, ms: 0, reply: null, error: '连不上接口地址 x（连接超时）', error_code: 'api_connect' }, fmt)).toBe(
      '没连上：连不上接口地址 x（连接超时）',
    )
    expect(testResultText({ ok: false, ms: 0, reply: null, error: 'API key 不对（HTTP 401）', error_code: 'api_error' }, fmt)).toBe(
      '测试没通过：API key 不对（HTTP 401）',
    )
    expect(testResultText({ ok: false, ms: 0, reply: null, error: null }, fmt)).toBe('测试没通过：接口没有返回错误说明')
  })
})

describe('保存后的提示', () => {
  it('设置齐了、没测试过：建议点测试', () => {
    expect(saveNotice(saved)).toEqual({ kind: 'success', title: '已保存。建议点「测试」确认能连上' })
  })
  it('设置齐了、用同样的值测试通过过：输入条可以用了', () => {
    expect(saveNotice(saved, { testedSame: true })).toEqual({ kind: 'success', title: '已保存，输入条可以用了' })
  })
  it('只保存了模型名、没有 key：警告还差 API key', () => {
    const n = saveNotice({ ...saved, has_key: false, key_hint: '', configured: false, problem: NOT_SET }, { testedSame: true })
    expect(n).toEqual({ kind: 'warning', title: '已保存，但还差 API key', description: undefined })
  })
  it('接口地址换了、key 被清掉：警告还差 API key，描述是后端的说明', () => {
    const msg = '接口地址换了，原来的 API key 已清掉，请重新填'
    const n = saveNotice({ ...saved, base_url: 'https://api.moonshot.cn/v1', has_key: false, configured: false, problem: NOT_SET }, { message: msg })
    expect(n).toEqual({ kind: 'warning', title: '已保存，但还差 API key', description: msg })
  })
  it('还差几样：一起列出来；本机地址不要 key', () => {
    expect(saveNotice(none).title).toBe('已保存，但还差接口地址、模型名')
    const local = { ...none, base_url: 'http://127.0.0.1:11434/v1', model: 'qwen', configured: true, problem: null }
    expect(saveNotice(local)).toEqual({ kind: 'success', title: '已保存。建议点「测试」确认能连上' })
  })
  it('后端说用不了（例如环境变量里的 key 有换行）：警告，描述是原因', () => {
    const problem = 'API key 里有不能用的字符（空格、换行或非英文字符），请检查（key 来自环境变量 OUTSETTER_AI_API_KEY）'
    expect(saveNotice({ ...saved, key_from_env: true, configured: false, problem })).toEqual({
      kind: 'warning',
      title: '已保存，但现在还用不了',
      description: problem,
    })
  })
  it('环境变量的 key 会发到新地址：设置齐了也用警告，把说明放进描述', () => {
    const msg = 'API key 来自环境变量 OUTSETTER_AI_API_KEY，换了接口地址后它也会发到新地址；不想这样就先取消这个环境变量'
    expect(saveNotice({ ...saved, key_from_env: true }, { message: msg })).toEqual({
      kind: 'warning',
      title: '已保存。建议点「测试」确认能连上',
      description: msg,
    })
  })
})

describe('有没有改动', () => {
  it('和已保存的一样 = 没改动；改了模型、填了 key、点了清除都算改动', () => {
    const f = formFromConfig(saved)
    expect(formDirty(saved, f)).toBe(false)
    expect(formDirty(saved, { ...f, base_url: 'https://api.deepseek.com/' })).toBe(false)
    expect(formDirty(saved, { ...f, model: 'deepseek-pro' })).toBe(true)
    expect(formDirty(saved, { ...f, api_key: 'sk' })).toBe(true)
    expect(formDirty(saved, { ...f, clear_key: true })).toBe(true)
  })
})
