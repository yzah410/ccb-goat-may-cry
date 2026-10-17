import { useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router'
import { usePrefs, type DensityPref, type ModePref, type ShellPref } from '@/features/settings/store'
import { resolveThemeId } from '@/themes/aliases'
import { getTheme, getThemeLoadFailure } from '@/themes/registry'
import { resolveTheme } from '@/themes/ThemeProvider'
import { toast } from '@/components/ui/Toast'

const SHELLS = ['auto', 'sidebar', 'topbar', 'dock', 'split'] as const
const DENSITIES = ['auto', 'compact', 'comfortable', 'spacious'] as const
const MODES = ['auto', 'light', 'dark'] as const

/**
 * URL → 设置：?theme=<id>&mode=dark&shell=dock&density=compact
 * URL 优先于 localStorage；读到后写进设置（持久化），这样站内跳转丢了参数也不会变回去。
 */
export function ThemeUrlSync() {
  const [params] = useSearchParams()
  const theme = params.get('theme')
  const mode = params.get('mode')
  const shell = params.get('shell')
  const density = params.get('density')
  useEffect(() => {
    const st = usePrefs.getState()
    const patch: Partial<{ theme: string; modePref: ModePref; shellPref: ShellPref; densityPref: DensityPref }> = {}
    if (theme) {
      // 先过一遍主题 id 别名表（themes/aliases.ts）
      const realTheme = resolveThemeId(theme)
      const failed = getThemeLoadFailure(realTheme)
      if (getTheme(realTheme)) {
        if (st.theme !== realTheme) patch.theme = realTheme
      } else if (failed)
        toast.warning(`主题「${failed.name}」加载失败`, { id: 'bad-theme', description: '先用着当前主题；失败原因在「主题」页的那张卡片上' })
      else toast.warning(`没有叫「${theme}」的主题`, { id: 'bad-theme', description: '先用着当前主题；可用的主题在「主题」页' })
    }
    if (mode && (MODES as readonly string[]).includes(mode) && st.modePref !== mode) patch.modePref = mode as ModePref
    if (shell && (SHELLS as readonly string[]).includes(shell) && st.shellPref !== shell) patch.shellPref = shell as ShellPref
    if (density && (DENSITIES as readonly string[]).includes(density) && st.densityPref !== density)
      patch.densityPref = density as DensityPref
    if (Object.keys(patch).length) st.set(patch)
  }, [theme, mode, shell, density])
  return null
}

/** 界面上切主题/明暗/布局：写设置 + 把 URL 里对应的参数去掉（否则刷新又被 URL 改回去） */
export function useThemeActions() {
  const set = usePrefs((s) => s.set)
  const [params, setParams] = useSearchParams()

  const clearUrl = useCallback(
    (keys: string[]) => {
      if (!keys.some((k) => params.has(k))) return
      const next = new URLSearchParams(params)
      for (const k of keys) next.delete(k)
      setParams(next, { replace: true })
    },
    [params, setParams],
  )

  const setTheme = useCallback(
    (id: string) => {
      set({ theme: id })
      clearUrl(['theme', 'mode'])
    },
    [set, clearUrl],
  )

  const setModePref = useCallback(
    (m: ModePref) => {
      set({ modePref: m })
      clearUrl(['mode'])
    },
    [set, clearUrl],
  )

  const toggleMode = useCallback(() => {
    const st = usePrefs.getState()
    const r = resolveTheme(st.theme, st.modePref, st.densityPref, st.shellPref)
    // 按「屏幕上现在是什么」来反转（= ThemeProvider 写到 <html> 上的值）。「自动」模式按时间算的结果
    // 最多每 5 分钟才同步到界面一次，直接用 r.mode 可能和屏幕上的不一样，点了看起来没反应。
    const now = st.resolvedMode
    const want = now === 'dark' ? 'light' : 'dark'
    if (!r.theme.manifest.modes.includes(want)) {
      toast.info(`「${r.theme.manifest.name}」只有${now === 'dark' ? '深色' : '浅色'}`, { id: 'mode-locked' })
      return
    }
    set({ modePref: want })
    clearUrl(['mode'])
  }, [set, clearUrl])

  const setShellPref = useCallback(
    (s: ShellPref) => {
      set({ shellPref: s })
      clearUrl(['shell'])
    },
    [set, clearUrl],
  )

  const setDensityPref = useCallback(
    (d: DensityPref) => {
      set({ densityPref: d })
      clearUrl(['density'])
    },
    [set, clearUrl],
  )

  return { setTheme, setModePref, toggleMode, setShellPref, setDensityPref }
}
