/**
 * 方案草稿（正在编辑的这一份配置）。持久化到 localStorage：刷新页面不会丢。
 *
 * 组块顺序就是筛选顺序（后端按数组顺序逐个合成：纳入 = 并集，排除 = 差集），
 * 所以「上移/下移/拖拽」改的是筛选逻辑，不只是排版。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useShallow } from 'zustand/react/shallow'
import { z } from 'zod'
import { localJSONStorage, makeMigrate, validatedMerge } from '@/lib/persist'
import { cloneBlock, newBlock } from './defaults'
import { normalizeBlocks } from './normalize'
import { configFingerprint, type DraftConfig } from './payload'
import { BlockSchema, DrawModeSchema, type Block, type BlockColor, type BlockKind, type DrawMode, type PlanFile } from './schema'

export interface DraftState extends DraftConfig {
  selectedId: string | null
  /** 当前对应的方案名（加载或保存过之后才有） */
  planName: string | null
  /** 方案文件里记录的 theme（只做展示，不自动切主题） */
  planTheme: string | null
  /** 上次加载/保存时的指纹；和当前不同 = 有没保存的改动 */
  baseline: string
  /** 最近一次加载方案时的规整警告 */
  loadWarnings: string[]

  addBlock: (kind: BlockKind) => string
  updateBlock: (id: string, patch: Partial<Pick<Block, 'color' | 'weight' | 'enabled'>>) => void
  updateParams: (id: string, patch: Record<string, unknown>) => void
  /** 整个替换 params（char-range 的「不限」要删字段时用） */
  replaceParams: (id: string, params: Record<string, unknown>) => void
  setColor: (id: string, color: BlockColor) => void
  removeBlock: (id: string) => { block: Block; index: number } | null
  insertBlock: (block: Block, index: number) => void
  duplicateBlock: (id: string) => string | null
  moveBlock: (id: string, delta: -1 | 1) => void
  reorderBlocks: (ids: string[]) => void
  select: (id: string | null) => void
  setMode: (m: DrawMode) => void
  setSeed: (s: number | null) => void
  setIncludeExtraWorkTags: (v: boolean) => void
  loadPlan: (name: string, plan: PlanFile) => string[]
  markSaved: (name: string) => void
  resetDraft: () => void
}

function initial(): Pick<
  DraftState,
  'mode' | 'seed' | 'includeExtraWorkTags' | 'blocks' | 'selectedId' | 'planName' | 'planTheme' | 'baseline' | 'loadWarnings'
> {
  const first = newBlock('work-range')
  const cfg: DraftConfig = { mode: 'char-weight', seed: null, includeExtraWorkTags: false, blocks: [first] }
  return { ...cfg, selectedId: first.id, planName: null, planTheme: null, baseline: configFingerprint(cfg), loadWarnings: [] }
}

const mapBlock = (blocks: Block[], id: string, f: (b: Block) => Block): Block[] =>
  blocks.map((b) => (b.id === id ? f(b) : b))

/** 草稿的存储版本；以后改存储结构时版本 +1，并在 makeMigrate 里加迁移 */
const DRAFT_VERSION = 1
const BlocksSchema = z.array(BlockSchema)

/**
 * 读回来的草稿做跨字段修补（字段本身已经逐个校验过，不合法的已换成默认值）：
 * - 组块坏了：先用「载入方案」那套规整逻辑抢救（缺字段补默认值、认不出的块跳过）；抢救不了 → 换一份全新草稿
 *   （同时去掉方案名，免得下次「保存」把一份空草稿覆盖到那个方案上）
 * - 选中的组块必须存在；baseline 缺了就按现在的内容算（= 当成没有未保存的改动）
 */
function fixDraft(next: DraftState, persisted: Record<string, unknown>): DraftState {
  let s = next
  if (!BlocksSchema.safeParse(persisted.blocks).success) {
    const { blocks, warnings } = normalizeBlocks(persisted.blocks)
    if (blocks.length && BlocksSchema.safeParse(blocks).success) {
      console.warn(`[store:draft] 草稿里的组块格式不对，已尽量修好（${warnings.length} 处）：${warnings.slice(0, 3).join('；')}`)
      s = { ...s, blocks }
    } else {
      console.warn('[store:draft] 草稿里的组块坏得修不好，已换成一份新草稿')
      return { ...s, ...initial() }
    }
  }
  if (!s.blocks.some((b) => b.id === s.selectedId)) s = { ...s, selectedId: s.blocks[0]?.id ?? null }
  if (typeof persisted.baseline !== 'string') s = { ...s, baseline: configFingerprint(s) }
  return s
}

export const useDraft = create<DraftState>()(
  persist(
    (set, get) => ({
      ...initial(),

      // 新增后自动选中，右边直接显示它的编辑表单
      addBlock: (kind) => {
        const b = newBlock(kind)
        set((s) => ({ blocks: [...s.blocks, b], selectedId: b.id }))
        return b.id
      },

      updateBlock: (id, patch) =>
        set((s) => ({ blocks: mapBlock(s.blocks, id, (b) => ({ ...b, ...patch }) as Block) })),

      updateParams: (id, patch) =>
        set((s) => ({
          blocks: mapBlock(s.blocks, id, (b) => ({ ...b, params: { ...b.params, ...patch } }) as Block),
        })),

      replaceParams: (id, params) =>
        set((s) => ({ blocks: mapBlock(s.blocks, id, (b) => ({ ...b, params }) as Block) })),

      setColor: (id, color) => set((s) => ({ blocks: mapBlock(s.blocks, id, (b) => ({ ...b, color }) as Block) })),

      // 删除后选中「前一个」：max(0, 原下标 - 1)
      removeBlock: (id) => {
        const s = get()
        const index = s.blocks.findIndex((b) => b.id === id)
        if (index < 0) return null
        const block = s.blocks[index]!
        const blocks = s.blocks.filter((b) => b.id !== id)
        const wasSelected = s.selectedId === id
        const nextSel = wasSelected ? (blocks[Math.max(0, index - 1)]?.id ?? null) : s.selectedId
        set({ blocks, selectedId: nextSel })
        return { block, index }
      },

      insertBlock: (block, index) =>
        set((s) => {
          const blocks = s.blocks.slice()
          blocks.splice(Math.min(Math.max(0, index), blocks.length), 0, block)
          return { blocks, selectedId: block.id }
        }),

      duplicateBlock: (id) => {
        const s = get()
        const index = s.blocks.findIndex((b) => b.id === id)
        if (index < 0) return null
        const copy = cloneBlock(s.blocks[index]!)
        const blocks = s.blocks.slice()
        blocks.splice(index + 1, 0, copy)
        set({ blocks, selectedId: copy.id })
        return copy.id
      },

      // 移动后选中被移动的那个
      moveBlock: (id, delta) =>
        set((s) => {
          const i = s.blocks.findIndex((b) => b.id === id)
          const j = i + delta
          if (i < 0 || j < 0 || j >= s.blocks.length) return {}
          const blocks = s.blocks.slice()
          const t = blocks[i]!
          blocks[i] = blocks[j]!
          blocks[j] = t
          return { blocks, selectedId: id }
        }),

      reorderBlocks: (ids) =>
        set((s) => {
          const byId = new Map(s.blocks.map((b) => [b.id, b]))
          const next = ids.map((id) => byId.get(id)).filter((b): b is Block => !!b)
          if (next.length !== s.blocks.length) return {}
          return { blocks: next }
        }),

      select: (id) => set({ selectedId: id }),
      setMode: (mode) => set({ mode }),
      setSeed: (seed) => set({ seed }),
      setIncludeExtraWorkTags: (includeExtraWorkTags) => set({ includeExtraWorkTags }),

      loadPlan: (name, plan) => {
        const { blocks, warnings } = normalizeBlocks(plan.blocks ?? [])
        const mode: DrawMode = plan.mode === 'work-weight' ? 'work-weight' : 'char-weight'
        const seed = typeof plan.seed === 'number' && Number.isInteger(plan.seed) ? plan.seed : null
        const cfg: DraftConfig = { mode, seed, includeExtraWorkTags: !!plan.include_extra_work_tags, blocks }
        set({
          ...cfg,
          selectedId: blocks[0]?.id ?? null,
          planName: name,
          planTheme: typeof plan.theme === 'string' ? plan.theme : null,
          baseline: configFingerprint(cfg),
          loadWarnings: warnings,
        })
        return warnings
      },

      markSaved: (name) => set((s) => ({ planName: name, baseline: configFingerprint(s) })),

      resetDraft: () => set({ ...initial() }),
    }),
    {
      name: 'outsetter.draft.v1',
      version: DRAFT_VERSION,
      storage: localJSONStorage(),
      migrate: makeMigrate('draft', DRAFT_VERSION),
      // 读回来逐个字段校验（zod），不合法的回默认值并 console.warn；再做跨字段修补
      merge: validatedMerge<DraftState>(
        'draft',
        {
          mode: DrawModeSchema,
          seed: z.number().int().nullable(),
          includeExtraWorkTags: z.boolean(),
          blocks: BlocksSchema,
          selectedId: z.string().nullable(),
          planName: z.string().nullable(),
          planTheme: z.string().nullable(),
          baseline: z.string(),
        },
        fixDraft,
      ),
      partialize: (s) => ({
        mode: s.mode,
        seed: s.seed,
        includeExtraWorkTags: s.includeExtraWorkTags,
        blocks: s.blocks,
        selectedId: s.selectedId,
        planName: s.planName,
        planTheme: s.planTheme,
        baseline: s.baseline,
      }),
    },
  ),
)

/** 有没有没保存的改动 */
export function useIsDirty(): boolean {
  return useDraft((s) => configFingerprint(s) !== s.baseline)
}

/** 当前草稿的配置部分（给 API 用） */
export function selectConfig(s: DraftState): DraftConfig {
  return { mode: s.mode, seed: s.seed, includeExtraWorkTags: s.includeExtraWorkTags, blocks: s.blocks }
}

/** 订阅草稿配置（浅比较，只有配置真的变了才重渲染） */
export function useDraftConfig(): DraftConfig {
  return useDraft(useShallow(selectConfig))
}

/** 当前选中的组块 */
export function useSelectedBlock(): Block | null {
  return useDraft((s) => s.blocks.find((b) => b.id === s.selectedId) ?? null)
}
