/** 开局问卷开没开：TiersGate 在「还没选过公式」时打开；设置页「重新选公式」也打开它。 */
import { create } from 'zustand'

interface WizardState {
  open: boolean
  /** first = 开局自动弹出（底部有「先用默认分档」）；settings = 从设置页打开 */
  from: 'first' | 'settings'
  show: (from: 'first' | 'settings') => void
  close: () => void
}

export const useFormulaWizard = create<WizardState>((set) => ({
  open: false,
  from: 'first',
  show: (from) => set({ open: true, from }),
  close: () => set({ open: false }),
}))
