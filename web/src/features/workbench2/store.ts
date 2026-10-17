/**
 * 工作台的方案草稿 + 编辑历史（撤销 / 重做）。
 *
 * - 草稿（spec / 方案名 / 保存时的指纹）持久化到 localStorage（key `outsetter.workbench2.v1`），刷新不丢；
 *   编辑历史只在内存里（刷新后从当前状态重新开始记）。
 * - 每次修改走 edit(说明, 改法)：旧状态进「撤销」栈，「重做」栈清空。连续改同一个输入框（coalesce 相同、1.5 秒内）
 *   合并成一步，打字不会攒出几十步撤销。
 * - 「打开方案」「新建」也能撤销：这一步连方案名和保存状态一起恢复（不然撤销之后按「保存」会把旧内容写进刚打开的方案）。
 * - 「保存」不进历史，只更新方案名和保存时的指纹（撤销到保存之前的内容会显示「有改动」：已保存的方案是保存时的内容）。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { z } from 'zod'
import { localJSONStorage, makeMigrate, validatedMerge } from '@/lib/persist'
import type { DrawV2, SpecV2 } from '@/features/v2/types'
import { defaultSpec, normalizeSpec, specFingerprint } from './spec'

export interface HistoryEntry {
  /** 这一步做了什么（撤销按钮的提示：「撤销：改了年份」） */
  label: string
  /** 这一步之前的方案 */
  spec: SpecV2
  /** 「打开方案」「新建」这类换了一份方案的步骤：之前的方案名和保存状态 */
  plan?: { planName: string | null; baseline: string }
}

export const HISTORY_LIMIT = 100
export const COALESCE_MS = 1500

export interface EditOptions {
  /** 同一个 key、1.5 秒内的连续修改合并成一步撤销（例：`r_x:year_from`） */
  coalesce?: string
  /** 测试用：当前时间 */
  now?: number
}

export interface Wb2State {
  spec: SpecV2
  /** 当前对应的方案名（打开或保存过才有） */
  planName: string | null
  /** 上次打开 / 保存 / 新建时的指纹；和当前不同 = 有没保存的改动 */
  baseline: string
  past: HistoryEntry[]
  future: HistoryEntry[]
  lastCoalesce: { key: string; at: number } | null
  /** 最近一次打开方案时自动修正的地方 */
  loadWarnings: string[]

  edit: (label: string, f: (s: SpecV2) => SpecV2, opts?: EditOptions) => void
  /** 整个换掉（AI 填工作台、撤销 AI 的改动）；方案名不变 */
  replaceSpec: (label: string, spec: SpecV2) => void
  undo: () => void
  redo: () => void
  loadPlan: (name: string, spec: SpecV2, warnings?: string[]) => void
  /** 新建：回到默认方案（没有方案名） */
  newPlan: (spec?: SpecV2) => void
  markSaved: (name: string) => void
}

function pushPast(past: HistoryEntry[], e: HistoryEntry): HistoryEntry[] {
  const next = [...past, e]
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next
}

function initial() {
  const spec = defaultSpec()
  return { spec, planName: null, baseline: specFingerprint(spec), past: [], future: [], lastCoalesce: null, loadWarnings: [] }
}

/** 草稿的存储版本；以后改存储结构时版本 +1，并在 makeMigrate 里加迁移 */
const WB2_VERSION = 1
/** 只查「像不像一份方案」；具体字段交给 normalizeSpec 逐项规整 */
const SpecShape = z.looseObject({ version: z.literal(2) })

export const useWb2 = create<Wb2State>()(
  persist(
    (set, get) => ({
      ...initial(),

      edit: (label, f, opts = {}) => {
        const s = get()
        const next = f(s.spec)
        if (next === s.spec || specFingerprint(next) === specFingerprint(s.spec)) {
          // 没变（例如把 6 改成 6）：不进历史；但如果只有 meta 变了还是要写进去
          if (next !== s.spec) set({ spec: next })
          return
        }
        const now = opts.now ?? Date.now()
        const merge = !!opts.coalesce && s.lastCoalesce?.key === opts.coalesce && now - s.lastCoalesce.at < COALESCE_MS && s.past.length > 0
        set({
          spec: next,
          past: merge ? s.past : pushPast(s.past, { label, spec: s.spec }),
          future: [],
          lastCoalesce: opts.coalesce ? { key: opts.coalesce, at: now } : null,
        })
      },

      replaceSpec: (label, spec) => get().edit(label, () => spec),

      undo: () => {
        const s = get()
        const e = s.past[s.past.length - 1]
        if (!e) return
        const redoEntry: HistoryEntry = { label: e.label, spec: s.spec, ...(e.plan ? { plan: { planName: s.planName, baseline: s.baseline } } : {}) }
        set({
          spec: e.spec,
          ...(e.plan ? { planName: e.plan.planName, baseline: e.plan.baseline } : {}),
          past: s.past.slice(0, -1),
          future: [...s.future, redoEntry],
          lastCoalesce: null,
        })
      },

      redo: () => {
        const s = get()
        const e = s.future[s.future.length - 1]
        if (!e) return
        const undoEntry: HistoryEntry = { label: e.label, spec: s.spec, ...(e.plan ? { plan: { planName: s.planName, baseline: s.baseline } } : {}) }
        set({
          spec: e.spec,
          ...(e.plan ? { planName: e.plan.planName, baseline: e.plan.baseline } : {}),
          past: pushPast(s.past, undoEntry),
          future: s.future.slice(0, -1),
          lastCoalesce: null,
        })
      },

      loadPlan: (name, spec, warnings = []) => {
        const s = get()
        set({
          spec,
          planName: name,
          baseline: specFingerprint(spec),
          past: pushPast(s.past, { label: `打开方案「${name}」`, spec: s.spec, plan: { planName: s.planName, baseline: s.baseline } }),
          future: [],
          lastCoalesce: null,
          loadWarnings: warnings,
        })
      },

      newPlan: (spec) => {
        const s = get()
        const next = spec ?? defaultSpec()
        set({
          spec: next,
          planName: null,
          baseline: specFingerprint(next),
          past: pushPast(s.past, { label: '新建（回到默认）', spec: s.spec, plan: { planName: s.planName, baseline: s.baseline } }),
          future: [],
          lastCoalesce: null,
          loadWarnings: [],
        })
      },

      markSaved: (name) => set((s) => ({ planName: name, baseline: specFingerprint(s.spec) })),
    }),
    {
      name: 'outsetter.workbench2.v1',
      version: WB2_VERSION,
      storage: localJSONStorage(),
      migrate: makeMigrate('workbench2', WB2_VERSION),
      merge: validatedMerge<Wb2State>(
        'workbench2',
        {
          spec: SpecShape,
          planName: z.string().nullable(),
          baseline: z.string(),
        },
        (next, persisted) => {
          if (!SpecShape.safeParse(persisted.spec).success) {
            // 草稿坏得认不出来：换默认方案，并去掉方案名（免得下次「保存」把默认方案覆盖到原来的方案上）
            console.warn('[store:workbench2] 本地草稿坏了，换成了默认方案')
            const spec = defaultSpec()
            return { ...next, spec, planName: null, baseline: specFingerprint(spec), past: [], future: [], lastCoalesce: null }
          }
          // 方案本身逐项规整（缺的补默认值、不认识的字段原样留着）；规整前后内容一样的话「有没有改动」不变
          const { spec, warnings } = normalizeSpec(next.spec)
          if (warnings.length) console.warn(`[store:workbench2] 本地草稿有 ${warnings.length} 处自动修正：${warnings.slice(0, 3).join('；')}`)
          const wasClean = typeof persisted.baseline === 'string' && next.spec && specFingerprint(next.spec) === persisted.baseline
          return {
            ...next,
            spec,
            baseline: wasClean ? specFingerprint(spec) : typeof persisted.baseline === 'string' ? persisted.baseline : specFingerprint(spec),
            past: [],
            future: [],
            lastCoalesce: null,
          }
        },
      ),
      partialize: (s) => ({ spec: s.spec, planName: s.planName, baseline: s.baseline }),
    },
  ),
)

export function useIsDirtyV2(): boolean {
  return useWb2((s) => specFingerprint(s.spec) !== s.baseline)
}

// ---------------------------------------------------------------- 最近一次抽题（内存，不持久化）
interface DrawState {
  /** poolKey：抽的时候题库是哪一份（方案改了 → 提示「这是改之前抽的」） */
  last: { key: string; data: DrawV2; at: number } | null
  set: (key: string, data: DrawV2) => void
  clear: () => void
}

export const useWb2Draw = create<DrawState>((set) => ({
  last: null,
  set: (key, data) => set({ last: { key, data, at: Date.now() } }),
  clear: () => set({ last: null }),
}))
