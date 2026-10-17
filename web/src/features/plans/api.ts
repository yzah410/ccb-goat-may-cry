/**
 * 经典工作台的方案存储接口（data/plans/*.json，后端文件直存），以及方案名的检查和默认名。
 * 工作台的方案走 /v2/plans（见 features/v2/api.ts）。
 *   GET    /ext/plans        列表（name / updated_at / mode / 组块摘要），后端按 updated_at 降序
 *   GET    /plans/{name}     完整方案
 *   POST   /plans/{name}     保存（同名直接覆盖；created_at 保留、updated_at 刷新）
 *   DELETE /plans/{name}     删除
 */
import { api } from '@/lib/apiClient'
import type { Block, DrawMode, PlanFile } from '@/features/blocks/schema'

export interface BlockBrief {
  kind: Block['kind']
  color: Block['color']
  enabled: boolean
  weight: number
}

export interface PlanSummary {
  name: string
  updated_at: string
  mode: string
  created_at?: string
  seed?: number | null
  theme?: string | null
  include_extra_work_tags?: boolean
  block_count?: number
  blocks?: BlockBrief[]
}

export interface PlanSaveBody {
  mode: DrawMode
  seed: number | null
  theme: string | null
  blocks: Block[]
  include_extra_work_tags: boolean
}

const enc = encodeURIComponent

export const plansApi = {
  list: () => api.get<{ plans: PlanSummary[] }>('/ext/plans'),
  get: (name: string) => api.get<PlanFile>(`/plans/${enc(name)}`),
  save: (name: string, body: PlanSaveBody) => api.post<{ ok: boolean; name: string }>(`/plans/${enc(name)}`, body),
  remove: (name: string) => api.del<{ ok: boolean }>(`/plans/${enc(name)}`),
}

/**
 * 方案名检查（名字会直接拼进后端文件路径，所以这里挡住路径符号和 ..）。
 * 返回 null = 合法。
 */
export function validatePlanName(raw: string): string | null {
  const n = raw.trim()
  if (!n) return '名字不能为空'
  if (n.length > 80) return '名字太长了（最多 80 个字）'
  if (/[\\/:*?"<>|]/.test(n)) return '名字里不能有 \\ / : * ? " < > | 这些符号'
  if (n.includes('..')) return '名字里不能有两个连着的点（..）'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(n)) return '名字里有看不见的控制字符'
  if (/[. ]$/.test(n)) return '名字不能以点或空格结尾'
  return null
}

/** 默认方案名：月日-时分，例如 0101-1200 */
export function suggestPlanName(now: Date = new Date()): string {
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`
}
