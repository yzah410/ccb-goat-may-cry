/**
 * 工作台方案对话框的开关 +「保存」（有名字直接存，没名字弹另存为）。对话框本身在 components/PlanDialogsV2.tsx。
 */
import { create } from 'zustand'
import { useWb2 } from './store'
import { useSavePlanV2 } from './hooks'

interface DialogsState {
  saveAsOpen: boolean
  openOpen: boolean
  openSaveAs: () => void
  openLoad: () => void
  close: () => void
}

export const usePlanDialogsV2 = create<DialogsState>((set) => ({
  saveAsOpen: false,
  openOpen: false,
  openSaveAs: () => set({ saveAsOpen: true, openOpen: false }),
  openLoad: () => set({ openOpen: true, saveAsOpen: false }),
  close: () => set({ saveAsOpen: false, openOpen: false }),
}))

/** 「保存」：有方案名就直接覆盖保存，没有就弹「另存为」 */
export function useQuickSaveV2() {
  const save = useSavePlanV2()
  const openSaveAs = usePlanDialogsV2((s) => s.openSaveAs)
  return {
    save: () => {
      const name = useWb2.getState().planName
      if (name) save.mutate(name)
      else openSaveAs()
    },
    isPending: save.isPending,
  }
}

