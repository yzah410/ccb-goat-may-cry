/**
 * 草稿 → 发给后端的 ConfigPayload，以及发送前的检查。
 */
import { ConfigPayloadSchema, KIND_LABEL, type Block, type ConfigPayload, type DrawMode } from './schema'

export interface DraftConfig {
  mode: DrawMode
  seed: number | null
  includeExtraWorkTags: boolean
  blocks: Block[]
}

export function toConfigPayload(d: DraftConfig, theme: string | null = null): ConfigPayload {
  return {
    mode: d.mode,
    seed: d.seed,
    theme,
    blocks: d.blocks,
    include_extra_work_tags: d.includeExtraWorkTags,
  }
}

/** 稳定指纹：判断「有没有没保存的改动」、当查询缓存的 key */
export function configFingerprint(d: DraftConfig): string {
  return JSON.stringify([d.mode, d.seed, d.includeExtraWorkTags, d.blocks])
}

/**
 * 发送前检查：返回给人看的问题列表（空 = 可以发）。
 * 只拦「后端一定会拒绝（422）」的情况；语义上的提醒（比如全是排除项）不拦。
 */
export function validateConfig(p: ConfigPayload): string[] {
  const issues: string[] = []
  const res = ConfigPayloadSchema.safeParse(p)
  if (!res.success) {
    for (const iss of res.error.issues.slice(0, 3)) {
      const path = iss.path
      let where = '配置'
      if (path[0] === 'blocks' && typeof path[1] === 'number') {
        const b = p.blocks[path[1]]
        where = `第 ${path[1] + 1} 个组块${b ? `（${KIND_LABEL[b.kind] ?? b.kind}）` : ''}`
      } else if (path[0] === 'seed') where = '随机种子'
      issues.push(`${where}：${iss.message}`)
    }
  }
  return issues
}

/** 有没有至少一个启用的纳入块（没有的话候选池必然是空的） */
export function hasEnabledInclude(blocks: Block[]): boolean {
  return blocks.some((b) => b.enabled && b.color === 'red')
}
