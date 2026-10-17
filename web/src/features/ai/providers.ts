/**
 * 「设置 → AI」里的服务商预设：选一个就填好接口地址和协议。
 * id 和后端 backend/v2/aiapi.py 的 PRESETS 一致（后端用它显示服务商的名字）。
 * modelExample 只当输入框的占位提示，不当默认值：各家的模型名经常变，以服务商文档为准。
 */
export type AiProtocol = 'openai' | 'anthropic'

export interface AiProvider {
  id: string
  label: string
  protocol: AiProtocol
  /** 接口地址（不含 /chat/completions、/v1/messages） */
  baseUrl: string
  /** 服务商的接口文档 */
  docs: string
  /** 模型名的例子（只做占位提示） */
  modelExample?: string
  /** 本机运行的服务：不需要 API key */
  local?: boolean
}

export const AI_PROVIDERS: readonly AiProvider[] = [
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', docs: 'https://api-docs.deepseek.com/', modelExample: 'deepseek-flash' },
  {
    id: 'dashscope',
    label: '阿里云百炼（通义千问）',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    docs: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
  },
  { id: 'moonshot', label: '月之暗面 Kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', docs: 'https://platform.kimi.com/docs/' },
  {
    id: 'zhipu',
    label: '智谱',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    docs: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
    modelExample: 'glm-5.2',
  },
  { id: 'siliconflow', label: '硅基流动', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', docs: 'https://docs.siliconflow.cn/' },
  { id: 'openai', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', docs: 'https://platform.openai.com/docs/' },
  {
    id: 'gemini',
    label: 'Google Gemini',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    docs: 'https://ai.google.dev/gemini-api/docs/openai',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    docs: 'https://docs.anthropic.com/',
    modelExample: 'claude-sonnet-5-5',
  },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', docs: 'https://openrouter.ai/docs' },
  {
    id: 'ollama',
    label: 'Ollama（本机）',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    docs: 'https://docs.ollama.com/api/openai-compatibility',
    local: true,
  },
  { id: 'lmstudio', label: 'LM Studio（本机）', protocol: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', docs: 'https://lmstudio.ai/docs/', local: true },
]

/** 「自定义」：地址自己填，按 OpenAI 兼容协议调用 */
export const CUSTOM_PROVIDER: AiProvider = { id: 'custom', label: '自定义（OpenAI 兼容）', protocol: 'openai', baseUrl: '', docs: '' }

export const MODEL_PLACEHOLDER = '填服务商文档里的模型名，或点「列出模型」'

export function providerById(id: string | null | undefined): AiProvider | null {
  if (!id) return null
  if (id === CUSTOM_PROVIDER.id) return CUSTOM_PROVIDER
  return AI_PROVIDERS.find((p) => p.id === id) ?? null
}

/** 模型输入框的占位提示 */
export function modelPlaceholder(p: AiProvider | null): string {
  return p?.modelExample ? `例：${p.modelExample}` : MODEL_PLACEHOLDER
}
