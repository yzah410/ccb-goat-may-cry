import { createElement, type ComponentProps, type ComponentType } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { fallbackTheme, useThemeScope } from './context'
import type { SlotName, ThemeSlots } from './types'

export type SlotProps<K extends SlotName> = ComponentProps<NonNullable<ThemeSlots[K]>>

const warned = new Set<string>()
function warnSlotError(themeId: string, name: string, error: Error): void {
  const key = `${themeId}:${name}`
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[theme:${themeId}] 装饰位「${name}」渲染时出错，已换成 base 的实现（只影响这一个装饰位）：${error.message}`)
}

/**
 * 渲染当前主题作用域的某个 slot（主题没实现就用 base 的）。
 * 在 JSX 里请用它：<ThemeSlot name="Logo" collapsed />
 * （不要 const Logo = useThemeSlot('Logo'); <Logo />——React 编译器检查会把它当成「渲染时新建的组件」。）
 *
 * 主题自己的 slot 渲染时抛错 → 退回 base 的实现，页面其余部分照常（不会整页变成错误页）。
 */
export function ThemeSlot<K extends SlotName>(props: { name: K } & SlotProps<K>) {
  const { name, ...rest } = props
  const { theme } = useThemeScope()
  // 对外签名是强类型的；这里内部统一按「任意 props」渲染
  const base = fallbackTheme().slots[name] as unknown as ComponentType<Record<string, unknown>>
  const own = theme.slots[name] as unknown as ComponentType<Record<string, unknown>> | undefined
  if (!own || own === base) return createElement(base, rest as Record<string, unknown>)
  return (
    <ErrorBoundary
      resetKey={own}
      fallback={createElement(base, rest as Record<string, unknown>)}
      onError={(e) => warnSlotError(theme.manifest.id, name, e)}
    >
      {createElement(own, rest as Record<string, unknown>)}
    </ErrorBoundary>
  )
}
