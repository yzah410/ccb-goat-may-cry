import { create } from 'zustand'
import type { ClickerMode, LocateResult, LogMarker } from './normalize'

/** 正在等结果的单发任务（全局只有一个；ClickerTaskWatcher 盯着它出结果 toast） */
export interface PendingTask {
  taskId: string
  charName: string
  mode: ClickerMode
  marker: LogMarker
  /** 第一次看到 busy=true 了没（避免任务还没开始就被判成「结束」） */
  seenBusy: boolean
  startedAt: number
}

interface TaskState {
  pending: PendingTask | null
  lastOutcome: { ok: boolean; message: string; charName: string; at: number } | null
  /** 最近一次「只定位不点击」的结果（自动点击页展示详情） */
  lastDryRun: { result: LocateResult; charName: string; at: number } | null
  setDryRun: (result: LocateResult, charName: string) => void
  start: (t: Omit<PendingTask, 'seenBusy' | 'startedAt'>) => void
  markBusy: () => void
  finish: (ok: boolean, message: string) => void
}

export const useClickerTask = create<TaskState>((set, get) => ({
  pending: null,
  lastOutcome: null,
  lastDryRun: null,
  setDryRun: (result, charName) => set({ lastDryRun: { result, charName, at: Date.now() } }),
  start: (t) => set({ pending: { ...t, seenBusy: false, startedAt: Date.now() } }),
  markBusy: () => {
    const p = get().pending
    if (p && !p.seenBusy) set({ pending: { ...p, seenBusy: true } })
  },
  finish: (ok, message) => {
    const p = get().pending
    set({ pending: null, lastOutcome: { ok, message, charName: p?.charName ?? '', at: Date.now() } })
  },
}))
