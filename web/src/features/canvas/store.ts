import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { z } from 'zod'
import { localJSONStorage, makeMigrate, validatedMerge } from '@/lib/persist'

export type CanvasSource = 'v2' | 'classic'

/** 只影响导出页；两个工作台各自的草稿保持独立。 */
export const useCanvasSource = create<{ source: CanvasSource; setSource: (source: CanvasSource) => void }>((set) => ({
  source: 'v2',
  setSource: (source) => set({ source }),
}))

/** 导图导出页顶部的三个标签：方案库（默认）｜新建标签笔记｜导出 .canvas。记住上次选的。 */
export type CanvasTab = 'library' | 'new' | 'export'
export const CANVAS_TABS: readonly CanvasTab[] = ['library', 'new', 'export']

interface CanvasTabState {
  tab: CanvasTab
  setTab: (tab: CanvasTab) => void
}

export const useCanvasTab = create<CanvasTabState>()(
  persist(
    (set) => ({
      tab: 'library',
      setTab: (tab) => set({ tab: CANVAS_TABS.includes(tab) ? tab : 'library' }),
    }),
    {
      name: 'outsetter.canvas-tab.v1',
      version: 1,
      storage: localJSONStorage(),
      partialize: (s) => ({ tab: s.tab }),
      migrate: makeMigrate('canvas-tab', 1),
      merge: validatedMerge<CanvasTabState>('canvas-tab', { tab: z.enum(['library', 'new', 'export']) }),
    },
  ),
)
