import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { z } from 'zod'
import { clamp } from '@/lib/format'
import { localJSONStorage, makeMigrate, validatedMerge } from '@/lib/persist'
import type { DrawResult, PreviewResp, ResolvedCharacter } from './types'

// ---------------------------------------------------------------- 候选列表显示设置（持久化）
export type DisplayMode = 'card' | 'row'

interface CandidateViewState {
  /** 每页显示 1–20（超出范围就钳制，不让请求失败） */
  pageSize: number
  displayMode: DisplayMode
  /** 全局「显示角色标签」开关 */
  showCharTags: boolean
  setPageSize: (n: number) => void
  setDisplayMode: (m: DisplayMode) => void
  setShowCharTags: (v: boolean) => void
}

export const useCandidateView = create<CandidateViewState>()(
  persist(
    (set) => ({
      pageSize: 10,
      displayMode: 'card',
      showCharTags: false,
      setPageSize: (n) => set({ pageSize: clamp(Number.isFinite(n) ? Math.round(n) : 10, 1, 20) }),
      setDisplayMode: (displayMode) => set({ displayMode }),
      setShowCharTags: (showCharTags) => set({ showCharTags }),
    }),
    {
      name: 'outsetter.candidate-view.v1',
      version: 1,
      storage: localJSONStorage(),
      migrate: makeMigrate('candidate-view', 1),
      merge: validatedMerge<CandidateViewState>('candidate-view', {
        pageSize: z.number().int().min(1).max(20),
        displayMode: z.enum(['card', 'row']),
        showCharTags: z.boolean(),
      }),
    },
  ),
)

// ---------------------------------------------------------------- 最近一次预览 / 抽题的结果（不持久化）
interface ResultsState {
  preview: { fp: string; data: PreviewResp; at: number } | null
  draw: { fp: string; data: DrawResult; at: number } | null
  setPreview: (fp: string, data: PreviewResp) => void
  setDraw: (fp: string, data: DrawResult) => void
}

export const useResults = create<ResultsState>((set) => ({
  preview: null,
  draw: null,
  setPreview: (fp, data) => set({ preview: { fp, data, at: Date.now() } }),
  setDraw: (fp, data) => set({ draw: { fp, data, at: Date.now() } }),
}))

// ---------------------------------------------------------------- 当前题目（持久化）
export interface Pick {
  item: ResolvedCharacter
  /** 从哪来的：随机抽的 / 候选列表里手挑的 */
  source: 'draw' | 'candidates'
  at: number
}

interface PickState {
  pick: Pick | null
  setPick: (item: ResolvedCharacter, source: Pick['source']) => void
  clear: () => void
}

/** 当前题目只查界面和点击器真正要用的字段（角色 id、名字）；其余字段原样保留 */
const PickSchema = z
  .object({
    item: z.looseObject({
      char_id: z.number(),
      character: z.looseObject({ id: z.number(), name: z.string() }),
    }),
    source: z.enum(['draw', 'candidates']),
    at: z.number(),
  })
  .nullable()

export const usePick = create<PickState>()(
  persist(
    (set) => ({
      pick: null,
      setPick: (item, source) => set({ pick: { item, source, at: Date.now() } }),
      clear: () => set({ pick: null }),
    }),
    {
      name: 'outsetter.pick.v1',
      version: 1,
      storage: localJSONStorage(),
      migrate: makeMigrate('pick', 1),
      merge: validatedMerge<PickState>('pick', { pick: PickSchema }),
    },
  ),
)
