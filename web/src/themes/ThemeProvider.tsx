import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { usePrefs, type DensityPref, type ModePref, type ShellPref } from '@/features/settings/store'
import { ThemeScopeContext, type ThemeScopeValue } from './context'
import { BASE_THEME, getTheme, warnMissingTokens } from './registry'
import type { Density, RegisteredTheme, ShellKind, ThemeManifest, ThemeMode } from './types'

/** 主题不支持的明暗会被夹回它支持的那一种 */
export function clampMode(want: ThemeMode, modes: readonly ThemeMode[]): ThemeMode {
  if (modes.includes(want)) return want
  return modes[0] ?? 'light'
}

/**
 * 明暗设成「自动」时这个主题此刻该用哪种：有 manifest.autoMode 就按它算（例如按本机时间），
 * 没有就是 defaultMode；结果夹回主题支持的 modes。
 */
export function autoModeOf(m: ThemeManifest): ThemeMode {
  let want = m.defaultMode
  if (typeof m.autoMode === 'function') {
    try {
      want = m.autoMode()
    } catch (e) {
      console.warn(`[theme:${m.id}] autoMode() 出错，按 defaultMode 处理：`, e)
    }
  }
  return clampMode(want, m.modes)
}

/** 「自动」明暗的重算节奏：每 5 分钟一次，外加页面重新可见时（例如电脑从睡眠里醒来）立刻算一次 */
export const AUTO_MODE_RECHECK_MS = 5 * 60_000
function subscribeAutoModeClock(onTick: () => void): () => void {
  const id = window.setInterval(onTick, AUTO_MODE_RECHECK_MS)
  document.addEventListener('visibilitychange', onTick)
  return () => {
    window.clearInterval(id)
    document.removeEventListener('visibilitychange', onTick)
  }
}

export interface ResolvedTheme {
  theme: RegisteredTheme
  mode: ThemeMode
  density: Density
  shell: ShellKind
}

export function resolveTheme(
  themeId: string,
  modePref: ModePref,
  densityPref: DensityPref,
  shellPref: ShellPref,
): ResolvedTheme {
  const theme = getTheme(themeId) ?? BASE_THEME
  const m = theme.manifest
  const mode = modePref === 'auto' ? autoModeOf(m) : clampMode(modePref, m.modes)
  const density = densityPref === 'auto' ? m.density : densityPref
  const shell = shellPref === 'auto' ? m.shell : shellPref
  return { theme, mode, density, shell }
}

const ROOT_EL: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null

/**
 * 根主题：把 data-theme / data-mode / data-density / data-motion 写在 <html> 上。
 * 来源：设置 store（URL 的 ?theme=&mode= 由 ThemeUrlSync 先写进 store）。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const p = usePrefs(
    useShallow((s) => ({
      theme: s.theme,
      modePref: s.modePref,
      densityPref: s.densityPref,
      shellPref: s.shellPref,
      motionPref: s.motionPref,
    })),
  )
  // 「自动」明暗可能随时间变（manifest.autoMode，例如主题规定过了 18:00 换成深色）：
  // 订阅一个 5 分钟的时钟重新求值，结果真的变了才重渲染（页面开着跨过切换点也会自己换，最多晚 5 分钟）
  const current = getTheme(p.theme) ?? BASE_THEME
  const autoMode = useSyncExternalStore(subscribeAutoModeClock, () => autoModeOf(current.manifest))
  const resolved = useMemo(
    () => resolveTheme(p.theme, p.modePref === 'auto' ? autoMode : p.modePref, p.densityPref, p.shellPref),
    [p.theme, p.modePref, autoMode, p.densityPref, p.shellPref],
  )

  useLayoutEffect(() => {
    const el = ROOT_EL
    if (!el) return
    el.dataset.theme = resolved.theme.manifest.id
    el.dataset.mode = resolved.mode
    el.dataset.density = resolved.density
    el.dataset.shell = resolved.shell
    if (p.motionPref === 'system') delete el.dataset.motion
    else el.dataset.motion = p.motionPref
    el.style.colorScheme = resolved.mode
    const st = usePrefs.getState()
    if (st.resolvedMode !== resolved.mode) st.set({ resolvedMode: resolved.mode })
  }, [resolved, p.motionPref])

  useEffect(() => warnMissingTokens(resolved.theme), [resolved.theme])

  const value = useMemo<ThemeScopeValue>(
    () => ({ ...resolved, nested: false, element: ROOT_EL, portalContainer: null }),
    [resolved],
  )
  return <ThemeScopeContext.Provider value={value}>{children}</ThemeScopeContext.Provider>
}

export interface ThemeScopeProps {
  /** 主题 id；不存在（或加载失败）就用 base */
  theme: string
  /** 不填 = 主题的「自动」明暗（autoMode，没有就是 defaultMode）；主题不支持的会被夹回去 */
  mode?: ThemeMode
  density?: Density
  shell?: ShellKind
  className?: string
  style?: CSSProperties
  children?: ReactNode
}

/**
 * 嵌套主题作用域：在页面的一小块里用另一套主题（分屏对比、画廊缩略图）。
 * - 自己带一整套 token（tokens.base.css 的 [data-theme] 兜底保证不会漏外层的色）
 * - 自己带弹层挂载点（弹窗留在格子里，拿得到这个主题的 token）
 * - contain: layout paint → fixed 定位的东西也关在格子里
 */
export function ThemeScope({ theme: themeId, mode, density, shell, className, style, children }: ThemeScopeProps) {
  const theme = getTheme(themeId) ?? BASE_THEME
  const m = theme.manifest
  const resolvedMode = mode ? clampMode(mode, m.modes) : autoModeOf(m)
  const resolvedDensity = density ?? m.density
  const resolvedShell = shell ?? m.shell
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [portal, setPortal] = useState<HTMLDivElement | null>(null)
  useEffect(() => warnMissingTokens(theme), [theme])

  const value = useMemo<ThemeScopeValue>(
    () => ({
      theme,
      mode: resolvedMode,
      density: resolvedDensity,
      shell: resolvedShell,
      nested: true,
      element,
      portalContainer: portal,
    }),
    [theme, resolvedMode, resolvedDensity, resolvedShell, element, portal],
  )

  return (
    <div
      ref={setElement}
      data-theme-scope=""
      data-nested="true"
      data-theme={m.id}
      data-mode={resolvedMode}
      data-density={resolvedDensity}
      data-shell={resolvedShell}
      className={className}
      style={style}
    >
      <ThemeScopeContext.Provider value={value}>{children}</ThemeScopeContext.Provider>
      <div ref={setPortal} data-portal-root="" className="relative z-50" />
    </div>
  )
}
