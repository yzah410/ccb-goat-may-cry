/**
 * 「设置 → AI」卡片的表单逻辑（纯函数，组件和测试共用）：
 * 后端设置 ↔ 表单、选服务商、API key 输入框的几种状态、保存前的检查、测试结果和保存后的提示。
 */
import { AI_PROVIDERS, CUSTOM_PROVIDER, providerById, type AiProtocol } from './providers'
import type { AiApiConfig, AiConfigBody, AiTestResp } from './api'

export interface AiForm {
  /** 选中的服务商 id（custom = 自定义）；null = 还没选 */
  preset: string | null
  protocol: AiProtocol
  base_url: string
  model: string
  /** 输入框里填的 key；空 = 保存时不改 key */
  api_key: string
  /** 点了「清除」：保存时清掉存着的 key */
  clear_key: boolean
  /** 页面上不改，保存时原样带回去 */
  max_tokens: number | null
}

export const EMPTY_FORM: AiForm = { preset: null, protocol: 'openai', base_url: '', model: '', api_key: '', clear_key: false, max_tokens: null }

/** 和后端一致：去掉首尾空白、末尾的 /、误粘进来的 /chat/completions 或 /v1/messages */
export function normalizeBaseUrl(url: string): string {
  let u = url.trim()
  for (;;) {
    const next = u.replace(/\/+$/, '').replace(/\/(chat\/completions|v1\/messages)$/i, '')
    if (next === u) return u
    u = next
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(normalizeBaseUrl(url)).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}

/**
 * 协议 + 域名 + 端口，例如 https://api.deepseek.com、http://127.0.0.1:11434。
 * 和后端一样，这三样有一个不同就算换了接口地址（已存的 key 不发过去）。地址不对时返回 ''。
 */
export function originOf(url: string): string {
  try {
    const u = new URL(normalizeBaseUrl(url))
    return /^https?:$/.test(u.protocol) ? u.origin : ''
  } catch {
    return ''
  }
}

/** 实际会请求的地址：anthropic 协议不填地址时用官方地址（和后端一致） */
export function effectiveBaseUrl(form: Pick<AiForm, 'protocol' | 'base_url'>): string {
  const u = normalizeBaseUrl(form.base_url)
  return !u && form.protocol === 'anthropic' ? 'https://api.anthropic.com' : u
}

const sameOrigin = (a: Pick<AiForm, 'protocol' | 'base_url'>, b: Pick<AiForm, 'protocol' | 'base_url'>) =>
  originOf(effectiveBaseUrl(a)) === originOf(effectiveBaseUrl(b))

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
export const isLocalUrl = (url: string) => LOCAL_HOSTS.has(hostOf(url))

/** 按地址认服务商（没存 preset 时用）；认不出来返回 null */
export function presetForUrl(protocol: AiProtocol, url: string): string | null {
  const u = normalizeBaseUrl(url).toLowerCase()
  if (!u) return null
  return AI_PROVIDERS.find((p) => p.protocol === protocol && p.baseUrl.toLowerCase() === u)?.id ?? null
}

/** 后端的设置 → 表单。preset 没存时按地址认一个，认不出来算「自定义」 */
export function formFromConfig(c: AiApiConfig | undefined): AiForm {
  if (!c) return EMPTY_FORM
  const known = providerById(c.preset)
  const preset = known ? known.id : presetForUrl(c.protocol, c.base_url) ?? (c.base_url ? CUSTOM_PROVIDER.id : null)
  return { preset, protocol: c.protocol, base_url: c.base_url, model: c.model, api_key: '', clear_key: false, max_tokens: c.max_tokens }
}

/**
 * 选了一个服务商：填好地址和协议。换了服务商时清空模型名（各家的模型名不一样）；选「自定义」保留现在的地址和模型。
 * 从一个接口地址换到另一个时，输入框里还没保存的 key 也清空：那是给上一个服务商的，留着的话点「测试」会把它发给这个服务商。
 * 表单里还没有地址时（先粘贴 key、再选服务商）保留 key。
 */
export function applyPreset(form: AiForm, id: string): AiForm {
  const p = providerById(id)
  if (!p) return form
  if (p.id === CUSTOM_PROVIDER.id) return { ...form, preset: p.id, protocol: 'openai' }
  const next: AiForm = { ...form, preset: p.id, protocol: p.protocol, base_url: p.baseUrl, model: form.preset === p.id ? form.model : '' }
  return !originOf(effectiveBaseUrl(form)) || sameOrigin(next, form) ? next : { ...next, api_key: '' }
}

/** 表单 → 发给后端的内容。没填新 key 就不带 api_key（后端保留存着的 key） */
export function bodyFromForm(form: AiForm, opts: { keyFromEnv?: boolean } = {}): AiConfigBody {
  const body: AiConfigBody = {
    protocol: form.protocol,
    preset: form.preset,
    base_url: normalizeBaseUrl(form.base_url),
    model: form.model.trim(),
    max_tokens: form.max_tokens,
  }
  if (opts.keyFromEnv) return body
  const key = form.api_key.trim()
  if (key) body.api_key = key
  else if (form.clear_key) body.clear_key = true
  return body
}

export interface FormIssues {
  base_url?: string
  model?: string
  api_key?: string
}

/** 有没有控制字符、单独的代理码元（和后端一样：这些字符存不进配置文件，也不能放进请求） */
export function hasBadChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 32 || c === 127) return true
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) return true
  }
  return false
}

/** 接口地址的格式问题（文字和后端 check_url 一样）；没问题返回 undefined */
export function urlProblem(url: string): string | undefined {
  if (!/^https?:\/\/[^\s/]+/i.test(url) || /\s/.test(url)) return '要以 http:// 或 https:// 开头，中间不能有空格'
  if (hasBadChars(url)) return '接口地址里有不能用的字符'
  if (url.includes('\\')) return '接口地址里不能有反斜杠 \\'
  if (url.includes('?')) return '接口地址里不要带 ? 参数'
  if (url.includes('#')) return '接口地址里不要带 # 和后面的内容'
  const authority = url.replace(/^https?:\/\//i, '').split('/')[0] ?? ''
  if (authority.includes('@')) return '接口地址里不要带用户名或密码（@ 和它前面的部分）'
  const port = /^(?:\[[^\]]*\]|[^:]*):(.*)$/.exec(authority)?.[1]
  if (port !== undefined && port !== '' && (!/^\d+$/.test(port) || Number(port) > 65535)) return '接口地址的端口不对'
  return undefined
}

/** 保存 / 测试前的检查（后端会再查一遍） */
export function formIssues(form: AiForm): FormIssues {
  const out: FormIssues = {}
  const url = normalizeBaseUrl(form.base_url)
  if (!url) {
    if (form.protocol !== 'anthropic') out.base_url = '要填接口地址（选服务商会自动填）'
  } else {
    const problem = urlProblem(url)
    if (problem) out.base_url = problem
  }
  if (!form.model.trim()) out.model = '要填模型名'
  else if (form.model.trim().length > 200) out.model = '模型名太长了（最多 200 个字符）'
  else if (hasBadChars(form.model)) out.model = '模型名里有不能用的字符'
  const key = form.api_key.trim()
  if (/\s/.test(key)) out.api_key = 'API key 里不能有空格或换行'
  else if (key.length > 500) out.api_key = 'API key 太长了（最多 500 个字符）'
  return out
}

export type KeyMode = 'env' | 'cleared' | 'host_changed' | 'saved' | 'local' | 'empty'

export interface KeyFieldState {
  mode: KeyMode
  disabled: boolean
  placeholder: string
  /** 输入框下面的说明；null = 不显示 */
  note: string | null
  /** 显示「清除」按钮 */
  canClear: boolean
}

/** API key 输入框：来自环境变量（不能改）/ 已保存（留空不改，可以清除）/ 没有 key（本机服务不用填） */
export function keyFieldState(config: AiApiConfig | undefined, form: AiForm): KeyFieldState {
  if (config?.key_from_env)
    return {
      mode: 'env',
      disabled: true,
      placeholder: `来自环境变量（${config.key_hint || '…'}）`,
      note:
        'API key 来自环境变量 OUTSETTER_AI_API_KEY，这里改不了。要换 key，改这个环境变量后重启后端。' +
        (sameOrigin(form, config) ? '' : '换了接口地址后，这个 key 也会发到新填的地址；不想这样就先取消这个环境变量。'),
      canClear: false,
    }
  const typed = form.api_key.trim() !== ''
  if (config?.has_key && form.clear_key && !typed)
    return { mode: 'cleared', disabled: false, placeholder: '保存后清掉已存的 key', note: '点「保存」后清掉已存的 API key。', canClear: false }
  if (config?.has_key && !typed && !sameOrigin(form, config))
    return {
      mode: 'host_changed',
      disabled: false,
      placeholder: '接口地址换了：填这个服务商的 API key',
      note: `已存的 key 是给 ${originOf(effectiveBaseUrl(config)) || '另一个地址'} 的，保存时会清掉它，不会发给新填的地址。`,
      canClear: false,
    }
  if (config?.has_key) return { mode: 'saved', disabled: false, placeholder: `已保存（${config.key_hint}），留空不改`, note: null, canClear: true }
  if (isLocalUrl(form.base_url) || providerById(form.preset)?.local)
    return { mode: 'local', disabled: false, placeholder: '本机服务一般不用填', note: null, canClear: false }
  return { mode: 'empty', disabled: false, placeholder: '粘贴服务商给的 API key', note: null, canClear: false }
}

/** 表单和已保存的设置有没有不一样（显示「有改动还没保存」） */
export function formDirty(config: AiApiConfig | undefined, form: AiForm): boolean {
  const saved = formFromConfig(config)
  return (
    form.api_key.trim() !== '' ||
    form.clear_key ||
    form.preset !== saved.preset ||
    form.protocol !== saved.protocol ||
    normalizeBaseUrl(form.base_url) !== normalizeBaseUrl(saved.base_url) ||
    form.model.trim() !== saved.model.trim()
  )
}

/**
 * 「测试」结果的那句话。真的没连上（error_code 是 api_connect）才说「没连上」；
 * 连上了、但接口报错（HTTP 错误、跳转、超时、回答不对等）说「测试没通过」。
 */
export function testResultText(r: AiTestResp, ms: (n: number) => string): string {
  if (r.ok) return `连上了：AI 回复「${r.reply ?? ''}」，用时 ${ms(r.ms)}`
  const why = r.error || '接口没有返回错误说明'
  return r.error_code === 'api_connect' ? `没连上：${why}` : `测试没通过：${why}`
}

export interface SaveNotice {
  kind: 'success' | 'warning'
  title: string
  description?: string
}

/**
 * 保存成功后的提示，按保存后的设置说清楚输入条现在能不能用：
 * - 还缺东西（模型名 / 接口地址 / API key）或后端说用不了 → 警告「已保存，但还差 …」「已保存，但现在还用不了」；
 * - 设置齐了、这张卡片里用一模一样的值测试通过过 →「已保存，输入条可以用了」；
 * - 设置齐了、没测试过 →「已保存。建议点「测试」确认能连上」。
 * 后端带了说明（例如 key 被清掉了、环境变量的 key 会发到新地址）时放在描述里，并且用警告。
 */
export function saveNotice(config: AiApiConfig, opts: { message?: string | null; testedSame?: boolean } = {}): SaveNotice {
  const message = opts.message || undefined
  const base = effectiveBaseUrl(config)
  const missing: string[] = []
  if (!base) missing.push('接口地址')
  if (!config.model.trim()) missing.push('模型名')
  if (base && !config.has_key && !isLocalUrl(base)) missing.push('API key')
  const list = missing.join('、')
  if (list) return { kind: 'warning', title: `已保存，但还差${/^[A-Za-z]/.test(list) ? ' ' : ''}${list}`, description: message }
  if (config.configured === false)
    return { kind: 'warning', title: '已保存，但现在还用不了', description: config.problem ?? message }
  const title = opts.testedSame ? '已保存，输入条可以用了' : '已保存。建议点「测试」确认能连上'
  return message ? { kind: 'warning', title, description: message } : { kind: 'success', title }
}
