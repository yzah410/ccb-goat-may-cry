/**
 * 标签笔记的本地状态。
 * - useTagNoteLocal（持久化）：引擎显示偏好、方案库的导图工作区（开着的标签、分屏、每个标签的视图和视区）、展开的分组、
 *   来源筛选、生成时用的标签口径、列表是否收起。工作区的操作在 ./workspace/actions.ts
 * - useTagNotePreview（不持久化）：「新建标签笔记」里刚生成、还没存进方案库的那份
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { z } from 'zod'
import { localJSONStorage, makeMigrate, validatedMerge } from '@/lib/persist'
import { DEFAULT_PREFS, sanitizePrefs } from './binding'
import { emptyWorkspace, normalizeWorkspace } from './workspace/tree'
import type { LayoutNode, Workspace } from './workspace/types'
import type { TagMode, TagNoteData, TagNotePrefs } from './types'

interface TagNoteLocalState {
  /**
   * 封面、配色、侧栏：所有标签共用，一格里改了其他格跟着变（字号固定为 1）。
   * view 是「上次用的视图」：新开的标签用它；每个标签自己的视图记在 workspace 里
   */
  prefs: TagNotePrefs
  /** 方案库的导图工作区：标签、分屏树、当前格 */
  workspace: Workspace
  /** 方案库列表里展开的分组（MapGroup.key） */
  openGroups: string[]
  /** 方案库列表只看哪个来源：'all' 或来源名 */
  sourceFilter: string
  /** 新建时的标签口径 */
  tagMode: TagMode
  /** 宽屏时左侧列表收起（给六视图让出宽度；收起后用上方下拉框选图） */
  listCollapsed: boolean
  setPrefs: (prefs: TagNotePrefs) => void
  toggleGroup: (key: string) => void
  /** 展开这些分组（已展开的不变） */
  openGroup: (...keys: string[]) => void
  setSourceFilter: (source: string) => void
  setTagMode: (mode: TagMode) => void
  setListCollapsed: (collapsed: boolean) => void
}

export const TAGNOTE_STORE_KEY = 'outsetter.tagnote.v1'

// 工作区的形状（意思上的校验在 normalizeWorkspace）。视图、视区这里不细查：坏了只丢那一个视图的视区，不连累整个工作区
const layoutSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('pane'), id: z.string(), tabs: z.array(z.string()), active: z.string().nullable() }),
    z.object({ type: z.literal('split'), id: z.string(), dir: z.enum(['row', 'col']), children: z.array(layoutSchema), sizes: z.array(z.number()) }),
  ]),
)
const workspaceSchema = z.object({
  tabs: z.record(
    z.string(),
    z.object({ id: z.string(), mapId: z.string(), view: z.unknown(), viewports: z.record(z.string(), z.unknown()) }),
  ),
  root: layoutSchema,
  activePane: z.string(),
  seq: z.number(),
  opened: z.boolean(),
})

export const useTagNoteLocal = create<TagNoteLocalState>()(
  persist(
    (set) => ({
      prefs: { ...DEFAULT_PREFS },
      workspace: emptyWorkspace(),
      openGroups: [],
      sourceFilter: 'all',
      tagMode: 'map',
      listCollapsed: false,
      setPrefs: (prefs) => set({ prefs: sanitizePrefs(prefs) }),
      toggleGroup: (key) =>
        set((s) => ({ openGroups: s.openGroups.includes(key) ? s.openGroups.filter((k) => k !== key) : [...s.openGroups, key] })),
      openGroup: (...keys) =>
        set((s) => {
          const add = keys.filter((k, i) => !s.openGroups.includes(k) && keys.indexOf(k) === i)
          return add.length ? { openGroups: [...s.openGroups, ...add] } : {}
        }),
      setSourceFilter: (sourceFilter) => set({ sourceFilter }),
      setTagMode: (tagMode) => set({ tagMode }),
      setListCollapsed: (listCollapsed) => set({ listCollapsed }),
    }),
    {
      name: TAGNOTE_STORE_KEY,
      // 存储版本；以后改存储结构时版本 +1，并在 makeMigrate 里加迁移
      version: 1,
      storage: localJSONStorage(),
      migrate: makeMigrate('tagnote', 1),
      merge: validatedMerge<TagNoteLocalState>(
        'tagnote',
        {
          prefs: z.object({
            cover: z.boolean(),
            scale: z.number(),
            color: z.boolean(),
            drawer: z.boolean(),
            view: z.string().nullable(),
          }),
          workspace: workspaceSchema,
          openGroups: z.array(z.string()),
          sourceFilter: z.string(),
          tagMode: z.enum(['map', 'full']),
          listCollapsed: z.boolean(),
        },
        // 字号固定 1，视图只认内置的六个；工作区再查一遍意思（标签不重复、引用都在、比例对得上……）
        (next) => ({ ...next, prefs: sanitizePrefs(next.prefs), workspace: normalizeWorkspace(next.workspace) }),
      ),
    },
  ),
)

// ---------------------------------------------------------------- 刚生成、还没存的那份（不持久化）
export interface TagNotePreview {
  data: TagNoteData
  /** 生成时的候选池指纹：方案改了就提示「已改动」 */
  poolKey: string
  tagMode: TagMode
  /** 第几次生成，给包装组件当 dataKey（重新生成 = 新数据） */
  seq: number
}

interface PreviewState {
  preview: TagNotePreview | null
  /** 存进方案库时用的标题（可改） */
  title: string
  setPreview: (p: Omit<TagNotePreview, 'seq'>, title: string) => void
  setTitle: (title: string) => void
  clear: () => void
}

let seq = 0

export const useTagNotePreview = create<PreviewState>((set) => ({
  preview: null,
  title: '',
  setPreview: (p, title) => set({ preview: { ...p, seq: ++seq }, title }),
  setTitle: (title) => set({ title }),
  clear: () => set({ preview: null, title: '' }),
}))
