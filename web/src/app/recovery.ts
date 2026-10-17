import { usePrefs } from '@/features/settings/store'

/** URL 里会覆盖外观设置的参数（themeActions 的 ThemeUrlSync 会读它们） */
const LOOK_PARAMS = ['theme', 'mode', 'shell', 'density'] as const

/**
 * 出错页上的「回到基础主题」：主题设为 base、布局和密度设为「跟随主题」，
 * 去掉地址栏里的 ?theme= 这类参数（不然刷新后又会被参数覆盖），然后整页重新加载——
 * 这样最稳：模块里的状态全部重来，不依赖出错时 React 树里还剩什么。
 */
export function backToBaseTheme(): void {
  usePrefs.getState().set({ theme: 'base', shellPref: 'auto', densityPref: 'auto' })
  const url = new URL(window.location.href)
  for (const k of LOOK_PARAMS) url.searchParams.delete(k)
  window.location.replace(url.toString())
}

/**
 * 现在是不是用着「非基础」的外观（主题不是 base，或布局/密度被强制过）——出错页据此决定要不要显示「回到基础主题」。
 * base 是出错时的安全兜底（默认主题是 moonlit）。新用户第一次打开就是 moonlit，这里也会判定为「非基础」：
 * 出错时总是给出「退回最安全的那套」这个选项，不管用户有没有自己换过主题。
 */
export function isCustomLook(): boolean {
  const s = usePrefs.getState()
  const q = new URLSearchParams(window.location.search)
  return s.theme !== 'base' || s.shellPref !== 'auto' || s.densityPref !== 'auto' || LOOK_PARAMS.some((k) => q.has(k))
}
