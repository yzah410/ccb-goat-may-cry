import { createContext, useContext, useLayoutEffect, type Context } from 'react'
import type { Density, RegisteredTheme, RouteId, ShellKind, SlotName, ThemeMode, ThemeSlots } from './types'

export interface ThemeScopeValue {
  theme: RegisteredTheme
  mode: ThemeMode
  density: Density
  shell: ShellKind
  /** true = 在分屏对比 / 画廊缩略这类嵌套作用域里 */
  nested: boolean
  /** 作用域根元素：根作用域是 <html>，嵌套作用域是 ThemeScope 的 div */
  element: HTMLElement | null
  /** Radix 弹层（Dialog/Popover/…）挂载点；null = document.body */
  portalContainer: HTMLElement | null
}

/*
 * 这个文件的两条规矩：
 *
 * 1. **不 import registry.ts。** 否则会形成「registry → 各主题的 slots/Backdrop → kit → context → registry」
 *    的模块环：改任何一个主题文件，这个文件都会跟着失效、被重新求值。兜底主题由 registry.ts 建好注册表后
 *    调用 setFallbackTheme() 交进来。
 *
 * 2. **React Context 对象挂在 globalThis 上（单例）。** 开发时 Vite 热更新偶尔会把这个文件求值成两份（两个不同的 ?t= 时间戳）。
 *    如果每份都各自 createContext()，Provider 写进 A、另一批组件从 B 读 → 读不到 → 静默退回默认值
 *    （base + 侧栏布局 + 没有背景层），而 <html data-theme / data-shell> 却是对的，非常难查。
 *    挂到 globalThis 上以后，不管这个文件被求值几次，Context 对象都只有一个。
 */
interface ThemeGlobals {
  scope?: Context<ThemeScopeValue | null>
  route?: Context<RouteId | null>
  fallbackTheme?: RegisteredTheme
  fallbackScope?: ThemeScopeValue
  warnedNoProvider?: boolean
}
const G: ThemeGlobals = ((globalThis as { __outsetterTheme?: ThemeGlobals }).__outsetterTheme ??= {})

export const ThemeScopeContext: Context<ThemeScopeValue | null> = (G.scope ??= createContext<ThemeScopeValue | null>(null))

/** 当前页面（外壳 AppShell / RootLayout 提供）；主题的 slot / Backdrop 用 useThemeRoute() 读 */
export const ThemeRouteContext: Context<RouteId | null> = (G.route ??= createContext<RouteId | null>(null))

/** registry.ts 建好注册表后调用一次，把 base 主题交进来（所有主题的兜底） */
export function setFallbackTheme(t: RegisteredTheme): void {
  G.fallbackTheme = t
  G.fallbackScope = undefined
}

/** 兜底主题（= base）。只能在渲染 / 事件里调用（那时注册表一定建好了） */
export function fallbackTheme(): RegisteredTheme {
  const t = G.fallbackTheme
  if (!t) throw new Error('主题注册表还没建好：registry.ts 的 themesReady 完成之前就渲染了组件（检查 main.tsx 的启动顺序）')
  return t
}

function fallbackScope(): ThemeScopeValue {
  if (import.meta.env.DEV && !G.warnedNoProvider) {
    G.warnedNoProvider = true
    console.warn(
      '[theme] 有组件没找到主题作用域（ThemeScopeContext.Provider），退回了默认设置：base 主题 + 侧栏布局 + 没有背景层。\n' +
        '常见原因：① 开发服务器热更新把某个文件加载成了两份——刷新页面即可恢复；② 组件渲染在 <ThemeProvider> / <ThemeScope> 外面。',
    )
  }
  G.fallbackScope ??= {
    theme: fallbackTheme(),
    mode: 'light',
    density: 'comfortable',
    shell: 'sidebar',
    nested: false,
    element: typeof document !== 'undefined' ? document.documentElement : null,
    portalContainer: null,
  }
  return G.fallbackScope
}

/** 当前所在主题作用域（最近的 ThemeScope，或根） */
export function useThemeScope(): ThemeScopeValue {
  return useContext(ThemeScopeContext) ?? fallbackScope()
}

/**
 * 当前页面（'workbench' | 'pool' | …）。给主题的 slot 用：Logo / 空态插画 / 页头装饰想按页面换图案时读它。
 * 在外壳外面渲染的东西（例如分屏对比页顶上的工具条）拿到 null。
 */
export function useThemeRoute(): RouteId | null {
  return useContext(ThemeRouteContext)
}

/** 某个主题的某个 slot 组件；主题没实现就用 base 的 */
export function slotOf<K extends SlotName>(theme: RegisteredTheme, name: K): NonNullable<ThemeSlots[K]> {
  return (theme.slots[name] ?? fallbackTheme().slots[name]) as NonNullable<ThemeSlots[K]>
}

/** 取当前主题的某个 slot 组件；主题没实现就用 base 的 */
export function useThemeSlot<K extends SlotName>(name: K): NonNullable<ThemeSlots[K]> {
  return slotOf(useThemeScope().theme, name)
}

/** Radix Portal 的 container（嵌套作用域里的弹层要留在自己的格子里，才能拿到自己的 token） */
export function usePortalContainer(): HTMLElement | undefined {
  return useThemeScope().portalContainer ?? undefined
}

/**
 * 运行时覆盖 token（例如「壁纸驱动配色」：根据当前壁纸算出主色色阶）。
 * 写在最近的作用域元素的 inline style 上，组件卸载或 tokens 变化时自动清理。
 * 用的是 useLayoutEffect：在浏览器画出这一帧之前就写好，不会先闪一下 tokens.css 里的静态颜色。
 *
 * 用法（在你的 Backdrop 里）：
 *   const tokens = useMemo(() => ({ '--primary': '#3d6fa8' }), [slug])
 *   useRuntimeTokens(tokens)
 * ⚠️ tokens 对象请用 useMemo 包起来，否则每次渲染都会重写。
 */
export function useRuntimeTokens(tokens: Record<string, string> | null | undefined): void {
  const { element } = useThemeScope()
  useLayoutEffect(() => {
    if (!element || !tokens) return
    const entries = Object.entries(tokens)
    for (const [k, v] of entries) element.style.setProperty(k, v)
    return () => {
      for (const [k] of entries) element.style.removeProperty(k)
    }
  }, [element, tokens])
}
