/**
 * 「导图已联动」小灯：服务端渲染出来的结构（亮 / 灰 / 不显示）、只用主题 token、提示文字。
 * 超时、bye、show_dot 这些判断在 logic.test.ts 里测过，这里只看画出来的东西。
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/Overlay'
import { ThemeScopeContext, type ThemeScopeValue } from '@/themes/context'
import { LAMP_TIP } from './logic'
import { LampDot, MapLinkLamp } from './MapLinkLamp'

const scope = { theme: { manifest: { id: 'moonlit' } }, mode: 'dark', portalContainer: null } as unknown as ThemeScopeValue
const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <ThemeScopeContext.Provider value={scope}>
      <TooltipProvider>{node}</TooltipProvider>
    </ThemeScopeContext.Provider>,
  )

describe('LampDot', () => {
  it('亮：成功色圆点，提示「导图已联动」', () => {
    const html = wrap(<LampDot lamp="on" />)
    expect(html).toContain('data-maplink-lamp="on"')
    expect(html).toContain('role="img"')
    expect(html).toContain(`aria-label="${LAMP_TIP.on}"`)
    expect(html).toContain('bg-success')
    expect(html).not.toContain('bg-border-strong')
  })

  it('灰：边框色圆点，提示「导图联动已断开」', () => {
    const html = wrap(<LampDot lamp="off" />)
    expect(html).toContain('data-maplink-lamp="off"')
    expect(html).toContain(`aria-label="${LAMP_TIP.off}"`)
    expect(html).toContain('bg-border-strong')
    expect(html).not.toContain('bg-success')
  })

  it('提示文字固定', () => {
    expect(LAMP_TIP).toEqual({ on: '导图已联动', off: '导图联动已断开' })
  })

  it('颜色只用主题 token（没有写死的色值），圆点是 8px、感应区是 16px，传进来的 className 保留', () => {
    const html = wrap(<LampDot lamp="on" className="absolute right-0 top-0" />)
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/)
    expect(html).toContain('size-2')
    expect(html).toContain('size-4')
    expect(html).toContain('absolute right-0 top-0')
  })
})

describe('MapLinkLamp（接 store）', () => {
  // 服务端渲染读的是 store 的初始状态（zustand 的 server snapshot），所以这里只能验证“没连上过什么都不画”；
  // 心跳 / bye / 超时对应的亮灭由 logic.test.ts（lampState）和 soloLink.test.ts（真实接线）覆盖。
  it('没连上过：什么都不画', () => {
    expect(wrap(<MapLinkLamp />)).toBe('')
  })
})
