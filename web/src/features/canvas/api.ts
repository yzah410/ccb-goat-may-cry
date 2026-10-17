/**
 * 导图导出：工作台 POST /v2/generate_canvas，请求体是 {spec}；经典工作台 POST /generate_canvas，请求体是 {config}。
 * 响应是 Obsidian .canvas（JSON：nodes + edges）。文件名都用 candidates-<毫秒时间戳>.canvas。
 */
import { useMutation } from '@tanstack/react-query'
import { api, errorText } from '@/lib/apiClient'
import { toast } from '@/components/ui/Toast'
import { validateConfig } from '@/features/blocks/payload'
import type { ConfigPayload } from '@/features/blocks/schema'
import type { SpecV2 } from '@/features/v2/types'

export interface CanvasResult {
  fileName: string
  blob: Blob
  size: number
  nodes: number
  edges: number
  /** 导图里的角色卡数量（text 节点里带 [[...]] 链接的） */
  characters: number
  elapsedMs: number
}

export const canvasApi = {
  generate: (config: ConfigPayload) =>
    api.post<Blob>('/generate_canvas', { config }, { responseType: 'blob', timeoutMs: 120_000 }),
  generateV2: (spec: SpecV2) =>
    api.post<Blob>('/v2/generate_canvas', { spec }, { responseType: 'blob', timeoutMs: 120_000 }),
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function inspect(blob: Blob): Promise<{ nodes: number; edges: number; characters: number }> {
  try {
    const j = JSON.parse(await blob.text()) as { nodes?: { type?: string; text?: string }[]; edges?: unknown[] }
    const nodes = j.nodes ?? []
    return {
      nodes: nodes.length,
      edges: (j.edges ?? []).length,
      characters: nodes.filter((n) => typeof n.text === 'string' && n.text.includes('[[')).length,
    }
  } catch {
    return { nodes: 0, edges: 0, characters: 0 }
  }
}

/** 生成并立即下载（经典工作台）；结果（大小、节点数）返回给页面展示 */
export function useGenerateCanvas() {
  return useMutation({
    mutationFn: async (config: ConfigPayload): Promise<CanvasResult> => {
      const issues = validateConfig(config)
      if (issues.length) throw new Error(`配置有问题：${issues.join('；')}`)
      const t0 = performance.now()
      const blob = await canvasApi.generate(config)
      const elapsedMs = performance.now() - t0
      const fileName = `candidates-${Date.now()}.canvas`
      const info = await inspect(blob)
      downloadBlob(blob, fileName)
      return { fileName, blob, size: blob.size, elapsedMs, ...info }
    },
    onSuccess: (r) => toast.success('导图已下载', { description: `${r.fileName}（${r.characters} 张角色卡）` }),
    onError: (e) => toast.error('导出失败', { description: errorText(e) }),
  })
}

/** 生成并立即下载（工作台）；直接发送当前完整草稿，不读取候选页的分页。 */
export function useGenerateCanvasV2() {
  return useMutation({
    mutationFn: async (spec: SpecV2): Promise<CanvasResult> => {
      const t0 = performance.now()
      const blob = await canvasApi.generateV2(spec)
      const elapsedMs = performance.now() - t0
      const fileName = `candidates-${Date.now()}.canvas`
      const info = await inspect(blob)
      downloadBlob(blob, fileName)
      return { fileName, blob, size: blob.size, elapsedMs, ...info }
    },
    onSuccess: (r) => toast.success('导图已下载', { description: `${r.fileName}（${r.characters} 张角色卡）` }),
    onError: (e) => toast.error('导出失败', { description: errorText(e) }),
  })
}
