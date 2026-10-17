import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { z } from 'zod'
import { localJSONStorage, makeMigrate, validatedMerge } from '@/lib/persist'
import { resolveThemeId } from '@/themes/aliases'
import type { Density, ShellKind, ThemeMode } from '@/themes/types'

export type ModePref = 'auto' | ThemeMode
export type DensityPref = 'auto' | Density
export type ShellPref = 'auto' | ShellKind
export type MotionPref = 'system' | 'reduce' | 'full'

export interface PrefsState {
  /** 当前主题 id */
  theme: string
  /** 明暗：auto = 跟随主题（主题的 autoMode，没有就是 defaultMode） */
  modePref: ModePref
  /** 实际生效的明暗（给 index.html 的首帧脚本用，避免闪白） */
  resolvedMode: ThemeMode
  densityPref: DensityPref
  shellPref: ShellPref
  motionPref: MotionPref
  sidebarCollapsed: boolean
  /** 后端地址；空字符串 = 用默认（VITE_API_BASE 或 http://127.0.0.1:8099） */
  apiBase: string
  /** 显示 Bangumi 角色头像（候选池、抽到的人、单人猜猜呗；默认关，开了以后 ≤2 次/秒请求 api.bgm.tv） */
  avatars: boolean
  /** 经典工作台：改完组块自动预览人数（默认关，只有点按钮才请求后端） */
  autoPreview: boolean
  set: (patch: Partial<Omit<PrefsState, 'set' | 'reset'>>) => void
  reset: () => void
}

export const DEFAULT_PREFS = {
  // 默认主题：月夜·萤火（moonlit）。主题不存在或加载失败时退回 'base'。
  theme: 'moonlit',
  modePref: 'auto' as ModePref,
  resolvedMode: 'light' as ThemeMode,
  densityPref: 'auto' as DensityPref,
  shellPref: 'auto' as ShellPref,
  motionPref: 'system' as MotionPref,
  sidebarCollapsed: false,
  apiBase: '',
  avatars: false,
  autoPreview: false,
}

/** 设置的存储版本。以后改存储结构时版本 +1，并在 makeMigrate 的 steps 里加迁移 */
const PREFS_VERSION = 1

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFS,
      set: (patch) => set(patch),
      reset: () => set({ ...DEFAULT_PREFS }),
    }),
    {
      name: 'outsetter.prefs.v1',
      version: PREFS_VERSION,
      storage: localJSONStorage(),
      migrate: makeMigrate('prefs', PREFS_VERSION),
      // 主题 id 只查「是非空字符串」：主题存不存在由 ThemeProvider 兜底（不存在 / 加载失败 → base）
      merge: validatedMerge<PrefsState>(
        'prefs',
        {
          theme: z.string().min(1),
          modePref: z.enum(['auto', 'light', 'dark']),
          resolvedMode: z.enum(['light', 'dark']),
          densityPref: z.enum(['auto', 'compact', 'comfortable', 'spacious']),
          shellPref: z.enum(['auto', 'sidebar', 'topbar', 'dock', 'split']),
          motionPref: z.enum(['system', 'reduce', 'full']),
          sidebarCollapsed: z.boolean(),
          apiBase: z.string(),
          avatars: z.boolean(),
          autoPreview: z.boolean(),
        },
        // 主题 id 经 resolveThemeId 归一，别名表见 themes/aliases.ts（目前为空）
        (next) => ({ ...next, theme: resolveThemeId(next.theme) }),
      ),
    },
  ),
)
