/**
 * 单人猜猜呗的设置（存浏览器，zustand persist；每局开局时随请求发给后端）。
 * 默认值：时间限制无、角色标签数 0、作品标签数跟随方案、Good/Hard 分界 10 秒、手动模式、
 * 自动模式卡片停 1.5 秒、「搜 Bangumi 全库」关、新角色保底每 4 局 1 个、
 * 界面大小 125%（只放大 /solo 的内容区）、从作品里选时多给 2 秒（开局时发给后端）。
 * 标签数、时间限制、分界秒数在一局中途改：下一局生效（开局时才发给后端）。
 * 新角色保底在建会话时发给后端：改了就重建会话。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { z } from 'zod'
import { localJSONStorage, makeMigrate, validatedMerge } from '@/lib/persist'
import { evalKey } from '@/features/workbench2/spec'
import type { SpecV2 } from '@/features/v2/types'
import type { SessionResp, StartBody } from './api'

export type PlayMode = 'manual' | 'auto'
/** 作品标签数：'follow' = 跟随方案（会话的 default_subject_tag_num） */
export type SubjectTagSetting = 'follow' | number

export interface SoloSettings {
  /** 时间限制（秒）；null = 不限时 */
  timeLimitSec: number | null
  characterTagNum: number
  subjectTagNum: SubjectTagSetting
  /** Good / Hard 分界（秒） */
  goodSec: number
  playMode: PlayMode
  /** 自动模式：结算卡片停多久（秒） */
  autoStaySec: number
  /** 「搜 Bangumi 全库」（在线搜，用来搜别名）；关 = 搜本地全库 */
  bgmSearch: boolean
  /** 新角色保底：每 N 局至少 1 个新角色；0 = 不保底 */
  newEvery: number
  /** 出题用哪个方案：null = 工作台当前方案；否则是已保存方案的名字 */
  planName: string | null
  /** 界面大小（/solo 内容区的缩放倍数，UI_SCALES 之一） */
  uiScale: number
  /** 这一次猜测是从作品的角色列表里选的：Good / Hard 分界多给几秒（0–10，步长 0.5） */
  workBonusSec: number
}

export const SOLO_DEFAULTS: SoloSettings = {
  timeLimitSec: null,
  characterTagNum: 0,
  subjectTagNum: 'follow',
  goodSec: 10,
  playMode: 'manual',
  autoStaySec: 1.5,
  bgmSearch: false,
  newEvery: 4,
  planName: null,
  uiScale: 1.25,
  workBonusSec: 2,
}

/** 界面大小的可选值（100% – 200%） */
export const UI_SCALES = [1, 1.25, 1.5, 1.75, 2] as const

export const LIMITS = {
  timeLimit: { min: 1, max: 60 },
  tagNum: { min: 0, max: 10 },
  goodSec: { min: 1, max: 120 },
  autoStay: { min: 0.5, max: 5 },
  newEvery: { min: 0, max: 10 },
  workBonus: { min: 0, max: 10, step: 0.5 },
} as const

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function clampInt(v: number, lo: number, hi: number): number {
  return clamp(Math.round(Number.isFinite(v) ? v : lo), lo, hi)
}

/** 时间限制：null / 0 / 负数 = 不限时；其余取整夹到 1–60 */
export function clampTimeLimit(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v) || v <= 0) return null
  return clampInt(v, LIMITS.timeLimit.min, LIMITS.timeLimit.max)
}

/** 分界秒数：1–120，保留 1 位小数 */
export function clampGoodSec(v: number): number {
  if (!Number.isFinite(v)) return SOLO_DEFAULTS.goodSec
  return Math.round(clamp(v, LIMITS.goodSec.min, LIMITS.goodSec.max) * 10) / 10
}

/** 卡片停留：0.5–5 秒，保留 1 位小数 */
export function clampAutoStay(v: number): number {
  if (!Number.isFinite(v)) return SOLO_DEFAULTS.autoStaySec
  return Math.round(clamp(v, LIMITS.autoStay.min, LIMITS.autoStay.max) * 10) / 10
}

/** 从作品里选时多给的秒数：0–10，按 0.5 取整 */
export function clampWorkBonus(v: number): number {
  if (!Number.isFinite(v)) return SOLO_DEFAULTS.workBonusSec
  return Math.round(clamp(v, LIMITS.workBonus.min, LIMITS.workBonus.max) * 2) / 2
}

/** 界面大小：不在可选值里的取最接近的那个 */
export function clampUiScale(v: number): number {
  if (!Number.isFinite(v)) return SOLO_DEFAULTS.uiScale
  let best: number = UI_SCALES[0]
  for (const x of UI_SCALES) if (Math.abs(x - v) < Math.abs(best - v)) best = x
  return best
}

/** 这一局实际用的作品标签数 */
export function resolveSubjectTagNum(setting: SubjectTagSetting, sessionDefault: number | null | undefined): number {
  if (setting === 'follow') return clampInt(sessionDefault ?? 0, LIMITS.tagNum.min, LIMITS.tagNum.max)
  return clampInt(setting, LIMITS.tagNum.min, LIMITS.tagNum.max)
}

/** 开局请求体 */
export function buildStartBody(s: SoloSettings, session: Pick<SessionResp, 'session_id' | 'default_subject_tag_num'>): StartBody {
  return {
    session_id: session.session_id,
    subject_tag_num: resolveSubjectTagNum(s.subjectTagNum, session.default_subject_tag_num),
    character_tag_num: clampInt(s.characterTagNum, LIMITS.tagNum.min, LIMITS.tagNum.max),
    good_sec: clampGoodSec(s.goodSec),
    time_limit_sec: clampTimeLimit(s.timeLimitSec),
    work_bonus_sec: clampWorkBonus(s.workBonusSec),
  }
}

/**
 * 会话身份：题库（evalKey：模式 + 作品标签数 + 范围 + 排除）+ 方案名 + 新角色保底。
 * 任何一个变了就要重建会话（后端在建会话时求值题库、设 new_every）。
 */
export function sessionKeyOf(spec: SpecV2, planName: string | null, newEvery: number): string {
  return `${evalKey(spec)}|${planName ?? ''}|${clampInt(newEvery, LIMITS.newEvery.min, LIMITS.newEvery.max)}`
}

/** 设置改了、但这一局还按开局时的算：返回「下一局生效」的项（给页面一行小字） */
export function pendingChanges(
  s: SoloSettings,
  round: {
    subject_tag_num: number
    character_tag_num: number
    good_sec: number
    time_limit_sec: number | null
    /** 开局响应里没有这一项时不比较 */
    work_bonus_sec?: number
  } | null,
  sessionDefault: number | null | undefined,
): string[] {
  if (!round) return []
  const out: string[] = []
  if (resolveSubjectTagNum(s.subjectTagNum, sessionDefault) !== round.subject_tag_num) out.push('作品标签数')
  if (clampInt(s.characterTagNum, 0, 10) !== round.character_tag_num) out.push('角色标签数')
  if (clampGoodSec(s.goodSec) !== round.good_sec) out.push('Good / Hard 分界')
  if (clampTimeLimit(s.timeLimitSec) !== (round.time_limit_sec ?? null)) out.push('时间限制')
  if (round.work_bonus_sec != null && clampWorkBonus(s.workBonusSec) !== round.work_bonus_sec) out.push('从作品里选的加时')
  return out
}

// ---------------------------------------------------------------- 存储
interface SoloSettingsStore extends SoloSettings {
  set: (patch: Partial<SoloSettings>) => void
  reset: () => void
}

/** 存储版本；以后改存储结构时版本 +1，并在 makeMigrate 里加迁移 */
const VERSION = 1
const STORE = 'solo-settings'

export const useSoloSettings = create<SoloSettingsStore>()(
  persist(
    (set) => ({
      ...SOLO_DEFAULTS,
      set: (patch) => set(patch),
      // 方案选择不算「设置」，恢复默认时保留
      reset: () => set((s) => ({ ...SOLO_DEFAULTS, planName: s.planName })),
    }),
    {
      name: 'outsetter.solo.v1',
      version: VERSION,
      storage: localJSONStorage(),
      migrate: makeMigrate(STORE, VERSION),
      merge: validatedMerge<SoloSettingsStore>(STORE, {
        timeLimitSec: z.number().int().min(1).max(60).nullable(),
        characterTagNum: z.number().int().min(0).max(10),
        subjectTagNum: z.union([z.literal('follow'), z.number().int().min(0).max(10)]),
        goodSec: z.number().min(1).max(120),
        playMode: z.enum(['manual', 'auto']),
        autoStaySec: z.number().min(0.5).max(5),
        bgmSearch: z.boolean(),
        newEvery: z.number().int().min(0).max(10),
        planName: z.string().min(1).nullable(),
        uiScale: z.number().refine((v) => (UI_SCALES as readonly number[]).includes(v)),
        workBonusSec: z
          .number()
          .min(0)
          .max(10)
          .refine((v) => Number.isInteger(v * 2)),
      }),
    },
  ),
)
