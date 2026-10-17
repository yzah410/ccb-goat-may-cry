/**
 * 导图一侧「跟随」的状态。
 * - useFollow（持久化，浏览器 localStorage）：哪一格在跟随、方案、图组、设置。刷新后还原，再发一次 map:hello。
 * - useFollowRuntime（不持久化）：连到的单人标签页、断开没有、字幕、角落的提示。
 * 消息处理、计时器在 ./followController.ts。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { z } from 'zod'
import { localJSONStorage, makeMigrate, validatedMerge } from '@/lib/persist'
import type { SpecV2 } from '@/features/v2/types'
import { DEFAULT_FOLLOW_SETTINGS, clampReturnSec, type FollowSettings } from './follow'
import type { LinkSource } from './protocol'

export interface FollowState {
  /** 跟随中的格子 id；null = 没在跟随 */
  pane: string | null
  /** 图组属于哪个方案（plan:<名> / workbench） */
  planKey: string | null
  planName: string | null
  /** 联动的图（顺序 = 组里的顺序；找目标图时排在前面的优先） */
  mapIds: string[]
  settings: FollowSettings
  /** 用户撤销过的方案切换：单人猜猜呗还在用这个方案时不自动换 */
  declinedPlanKey: string | null

  start: (p: { pane: string; planKey: string; planName: string | null; mapIds: string[] }) => void
  /** 跟随移到另一格（图组不变） */
  moveTo: (pane: string) => void
  stop: () => void
  setGroup: (p: { planKey: string; planName: string | null; mapIds: string[] }) => void
  setSettings: (patch: Partial<FollowSettings>) => void
  setDeclined: (planKey: string | null) => void
}

export const FOLLOW_STORE_KEY = 'outsetter.maplink.follow.v1'

const sanitizeSettings = (s: FollowSettings): FollowSettings => ({ ...s, returnSec: clampReturnSec(s.returnSec) })

export const useFollow = create<FollowState>()(
  persist(
    (set) => ({
      pane: null,
      planKey: null,
      planName: null,
      mapIds: [],
      settings: { ...DEFAULT_FOLLOW_SETTINGS },
      declinedPlanKey: null,
      start: ({ pane, planKey, planName, mapIds }) => set({ pane, planKey, planName, mapIds: [...new Set(mapIds)], declinedPlanKey: null }),
      moveTo: (pane) => set((s) => (s.pane && s.pane !== pane ? { pane } : {})),
      stop: () => set({ pane: null }),
      setGroup: ({ planKey, planName, mapIds }) => set({ planKey, planName, mapIds: [...new Set(mapIds)] }),
      setSettings: (patch) => set((s) => ({ settings: sanitizeSettings({ ...s.settings, ...patch }) })),
      setDeclined: (declinedPlanKey) => set({ declinedPlanKey }),
    }),
    {
      name: FOLLOW_STORE_KEY,
      version: 1,
      storage: localJSONStorage(),
      migrate: makeMigrate('maplink-follow', 1),
      partialize: (s) => ({
        pane: s.pane,
        planKey: s.planKey,
        planName: s.planName,
        mapIds: s.mapIds,
        settings: s.settings,
        declinedPlanKey: s.declinedPlanKey,
      }),
      merge: validatedMerge<FollowState>(
        'maplink-follow',
        {
          pane: z.string().nullable(),
          planKey: z.string().nullable(),
          planName: z.string().nullable(),
          mapIds: z.array(z.string()),
          settings: z.object({
            mode: z.enum(['stay', 'flash', 'return']),
            returnSec: z.number(),
            hardOnly: z.boolean(),
            markWrong: z.boolean(),
            caption: z.boolean(),
            showDot: z.boolean(),
          }),
          declinedPlanKey: z.string().nullable(),
        },
        // 跟随中却没有方案：数据不完整，当作没在跟随
        (next) => ({ ...next, settings: sanitizeSettings(next.settings), pane: next.planKey ? next.pane : null }),
      ),
    },
  ),
)

// ---------------------------------------------------------------- 运行时（不持久化）
/** 最近一次 solo:state 的内容 */
export interface SoloInfo {
  src: string
  plan_key: string
  plan_name: string | null
  source: LinkSource
  spec: SpecV2
  pool_total: number
  /** 收到的时间（毫秒） */
  at: number
}

/** 'none' = 还没听到过单人猜猜呗；'live' = 连着；'bye' = 它说了再见（页面关了、离开了） */
export type LinkStatus = 'none' | 'live' | 'bye'

export interface Caption {
  key: number
  roundId: string
  text: string
}

export interface Notice {
  key: number
  text: string
  /** 带「撤销」按钮（换方案的提示） */
  undo?: boolean
  /** 带「选图组」按钮：打开跟随格的设置面板（换了方案、新方案没有图组时） */
  panel?: boolean
}

interface RuntimeState {
  link: LinkStatus
  solo: SoloInfo | null
  caption: Caption | null
  notice: Notice | null
  /** 没连上单人猜猜呗时，面板里手选的方案（关了面板再开还是它；不存盘） */
  pick: string | null
}

export const useFollowRuntime = create<RuntimeState>(() => ({ link: 'none', solo: null, caption: null, notice: null, pick: null }))
