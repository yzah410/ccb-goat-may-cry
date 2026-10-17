/**
 * 「在新标签页打开」（单独开一个标签页玩，例如一块屏幕玩、另一块屏幕看导图）。
 * 点了之后，原来这个标签页不再开着一局：两个标签页同时开着局，这边的倒计时会在后台继续走、发超时。
 * 所以这边丢掉会话和这一局，页面换成「已在新标签页打开」的提示卡片，点「在这里继续玩」才重新建会话开局。
 *
 * 只存在内存里（不存浏览器）：同一个标签页里切到别的页面再回来，还是那张卡片；刷新这一页 = 照常开局。
 * 新标签页是另一份内存，不受影响。进度在后端按「模式 + 练法」存一份，两个标签页共用，不会互相覆盖。
 */
import { create } from 'zustand'
import { useSoloGame } from './game'

interface SoloHandoffState {
  /** 已经在新标签页打开了：这一页不开局 */
  away: boolean
  setAway: (away: boolean) => void
}

export const useSoloHandoff = create<SoloHandoffState>()((set) => ({
  away: false,
  setAway: (away) => set({ away }),
}))

/**
 * 点了「在新标签页打开」：手动结算里选了还没确认的评级先交上去（请求照发），
 * 再丢掉这边的会话和这一局（不发请求；后端那一局没打完，按「没打完的一局作废」处理）。
 */
export function handOffToNewTab(): void {
  const g = useSoloGame.getState()
  void g.commitChosen()
  g.reset()
  useSoloHandoff.getState().setAway(true)
}
