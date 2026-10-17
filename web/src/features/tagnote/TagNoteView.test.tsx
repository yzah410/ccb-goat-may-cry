/**
 * 包装组件的结构（服务端渲染出来的 HTML）：外框带 --tnv-*，挂载元素带 --tn-*，都不设 overflow。
 * 挂载 / setData / setTheme / destroy 的时机由 binding 的测试和浏览器里的 DOM 检查覆盖（node 环境没有 DOM）。
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ThemeScopeContext, type ThemeScopeValue } from '@/themes/context'
import type { EngineLike } from './binding'
import { TagNoteView } from './components/TagNoteView'

const scope = (mode: 'light' | 'dark'): ThemeScopeValue =>
  ({
    theme: { manifest: { id: 'moonlit' } },
    mode,
    density: 'comfortable',
    shell: 'sidebar',
    nested: false,
    element: null,
    portalContainer: null,
  }) as unknown as ThemeScopeValue

describe('TagNoteView 的结构', () => {
  it('外框解析出题器主题的 token，挂载元素只引用外框的中转变量；服务端渲染时不挂载引擎', () => {
    let mounted = 0
    const engine: EngineLike = {
      mount: () => {
        mounted++
        throw new Error('不该在服务端渲染时挂载')
      },
    }
    const html = renderToStaticMarkup(
      <ThemeScopeContext.Provider value={scope('dark')}>
        <TagNoteView engine={engine} data={{ works: [] }} dataKey="k" aria-label="测试图" />
      </ThemeScopeContext.Provider>,
    )
    expect(mounted).toBe(0)
    expect(html).toContain('data-tagnote-frame')
    expect(html).toContain('--tnv-paper:var(--bg-elevated)')
    expect(html).toContain('--tnv-card:var(--surface-1)')
    expect(html).toContain('--tnv-sticky-top:var(--shell-sticky-top, 0px)')
    expect(html).toContain('--tn-card:var(--tnv-card)')
    expect(html).toContain('--tn-sticky-top:var(--tnv-sticky-top)')
    // 底部胶囊布局里侧栏下沿让开胶囊；其余布局这个变量不存在，按 0 算
    expect(html).toContain('in-data-[layout=dock]:[--tnv-sticky-bottom:')
    expect(html).toContain('var(--tnv-sticky-bottom, 0px)')
    expect(html).toContain('role="region"')
    expect(html).toContain('aria-label="测试图"')
    expect(html).not.toMatch(/overflow/)
    expect(html).not.toContain('--tn-hlL')
  })
})
