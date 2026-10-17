/**
 * AI 能不能用：/v2/ai/status 的结果 → 输入条要的东西（能用的 AI、默认用哪个、不能用的原因、显示名）。
 * 纯函数，hooks.ts 的 useAiAvailability 和测试共用。显示名用后端给的 label（API 是服务商名，命令行是「Claude（本机命令行）」）。
 */
import type { AiEngine, AiStatusResp } from './types'

export const AI_NOT_CONFIGURED = '还没设置 AI：在「设置 → AI」里填接口地址、模型和 API key'

/** 后端没给 label 时的显示名 */
const FALLBACK_LABEL: Record<string, string> = { api: 'AI 接口', claude: 'Claude（本机命令行）', codex: 'Codex（本机命令行）' }

export interface AiAvailability {
  ready: boolean
  engines: { id: string; label: string }[]
  defaultEngine: string | null
  reason: string | null
  loading: boolean
  /** 任意 engine id（包括现在用不了的）→ 显示名 */
  labelOf: (id: string | null | undefined) => string
}

export function engineLabelOf(all: readonly AiEngine[], id: string | null | undefined): string {
  if (!id) return 'AI'
  const e = all.find((x) => x.id === id)
  return (e?.label && e.label.trim()) || FALLBACK_LABEL[id] || id
}

export function aiAvailabilityOf(data: AiStatusResp | undefined): AiAvailability {
  const all = data?.engines ?? []
  const labelOf = (id: string | null | undefined) => engineLabelOf(all, id)
  const ok = all.filter((e) => e.available && e.channel_ok)
  if (!ok.length) {
    const api = all.find((e) => e.id === 'api')
    if (api) {
      // 有 API 这条路却用不了：还没填好 → 告诉去哪里填；填了但有问题（例如 key 里有换行、地址带了 ?）→ 用后端说的原因
      const note = (api.note ?? '').trim()
      const reason = !note || note.startsWith('还没设置') ? AI_NOT_CONFIGURED : note
      return { ready: false, engines: [], defaultEngine: null, reason, loading: false, labelOf }
    }
    const notes = all.map((e) => `${labelOf(e.id)}：${e.note || (!e.available ? '这台电脑上没找到' : '登录方式不是订阅登录，已拒绝调用')}`)
    return { ready: false, engines: [], defaultEngine: null, reason: notes.length ? notes.join('；') : '没有可用的 AI', loading: false, labelOf }
  }
  const def = ok.some((e) => e.id === data?.default) ? data!.default : ok[0]!.id
  return { ready: true, engines: ok.map((e) => ({ id: e.id, label: labelOf(e.id) })), defaultEngine: def, reason: null, loading: false, labelOf }
}

/**
 * 输入条下面「用不了」的那句话（不带句号）。原因本身就以「还没设置 AI」开头时直接显示原因，
 * 不拼成「AI 现在用不了：还没设置 AI：…」这样两个冒号。
 */
export function unavailableText(reason: string | null | undefined): string {
  const r = (reason ?? '').trim().replace(/[。；]+$/, '')
  if (!r) return 'AI 现在用不了'
  return r.startsWith('还没设置 AI') ? r : `AI 现在用不了：${r}`
}

/** 输入条右边「用哪个 AI」下拉框里的名字：codex 标上「较慢」 */
export function engineOptionLabel(id: string, label: string): string {
  return id === 'codex' ? `${label} · 较慢` : label
}
