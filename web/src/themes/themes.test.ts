/**
 * 主题契约的自动检查（做主题的人改完跑 `npm test` 就知道有没有漏）：
 * 1. tokens.base.css（兜底值）声明了总表里全部 token，浅色/深色都有
 * 2. base/tokens.css（写新主题时照着抄的模板）和兜底值逐个相同
 * 3. 每个主题：manifest 合法、壁纸 slug 存在、必填 token 100% 覆盖（preview 是故意不全的演示主题，豁免）
 * 4. emoji 映射表里的每个名字都真的存在于 fluent-emoji-flat
 * 5. 主题隔离：一个主题的文件坏了（模块顶层抛错 / import 了不存在的文件 / 没有 default export），只有它被跳过
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import { REQUIRED_TOKEN_NAMES, TOKENS, TOKEN_NAMES, declaredTokensIn } from './tokens'
import { BASE_THEME, THEMES, THEME_LOAD_FAILURES, buildRegistry, themesReady } from './registry'
import type { BackdropProps, ThemeManifest, ThemeSlots } from './types'
import { EMOJI_ICON_NAMES } from '@/lib/emoji-names'

// 注册表是异步建的（每个主题单独动态加载）；下面按主题生成用例之前先等它建好
await themesReady

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = (p: string) => fs.readFileSync(path.resolve(HERE, p), 'utf8')

/** 取出某个选择器块里的 token 声明（只认第一个同名块） */
function block(css: string, selector: string): Record<string, string> {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const i = code.indexOf(selector)
  if (i < 0) throw new Error(`找不到 ${selector}`)
  const start = code.indexOf('{', i)
  const end = code.indexOf('}', start)
  const out: Record<string, string> = {}
  for (const m of code.slice(start + 1, end).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]!] = m[2]!.trim()
  return out
}

const DENSITY = TOKENS.filter((t) => t.group === '密度').map((t) => t.name)

describe('token 兜底值（styles/tokens.base.css）', () => {
  const css = read('../styles/tokens.base.css')
  it('浅色块声明了全部 token', () => {
    const light = block(css, ':root,')
    expect(TOKEN_NAMES.filter((n) => !(n in light))).toEqual([])
  })
  it('深色块覆盖了所有颜色类 token', () => {
    const dark = block(css, '[data-theme][data-mode="dark"]')
    const colorish = TOKENS.filter((t) => ['背景与表面', '文字', '主色色阶', '语义色', '业务语义', '边框与焦点', '图表'].includes(t.group)).map((t) => t.name)
    expect(colorish.filter((n) => !(n in dark))).toEqual([])
  })
})

describe('base 模板（themes/base/tokens.css）= 兜底值', () => {
  const baseCss = read('./base/tokens.css')
  const defCss = read('../styles/tokens.base.css')
  it('浅色逐个相同（密度 token 除外）', () => {
    const a = block(baseCss, '[data-theme="base"] {')
    const b = block(defCss, ':root,')
    for (const n of TOKEN_NAMES.filter((x) => !DENSITY.includes(x))) expect(a[n], n).toBe(b[n])
  })
  it('深色逐个相同', () => {
    const a = block(baseCss, '[data-theme="base"][data-mode="dark"]')
    const b = block(defCss, '[data-theme][data-mode="dark"]')
    expect(a).toEqual(b)
  })
})

describe('每个主题包', () => {
  it('至少有 base 和 preview', () => {
    const ids = THEMES.map((t) => t.manifest.id)
    expect(ids[0]).toBe('base')
    expect(ids).toContain('preview')
  })
  for (const t of THEMES) {
    const id = t.manifest.id
    it(`${id}：manifest 没问题`, () => {
      expect(t.problems).toEqual([])
    })
    it(`${id}：tokens.css 选择器用的是自己的 id`, () => {
      const css = read(`./${id}/tokens.css`)
      const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\[data-theme="([^"]+)"\]/g)].map((m) => m[1])
      expect(selectors.length).toBeGreaterThan(0)
      expect(new Set(selectors)).toEqual(new Set([id]))
    })
    if (id !== 'preview')
      it(`${id}：必填 token 100% 覆盖`, () => {
        expect(t.missingRequired).toEqual([])
      })
  }
  it('preview 故意不全（演示兜底），但覆盖率算得出来', () => {
    const p = THEMES.find((t) => t.manifest.id === 'preview')!
    expect(p.coverage).toBeGreaterThan(0)
    expect(p.coverage).toBeLessThan(1)
    expect(REQUIRED_TOKEN_NAMES.length).toBeGreaterThan(p.declaredTokens.size - 1)
  })
  it('declaredTokensIn 不把注释里的 token 算进去', () => {
    expect([...declaredTokensIn('/* --bg: red; */ [data-theme="x"]{ --text-1: #000; }')]).toEqual(['--text-1'])
  })
})

describe('主题隔离：坏主题不拖垮注册表', () => {
  it('真实注册表：没有加载失败的主题，base 是兜底', () => {
    expect(THEME_LOAD_FAILURES).toEqual([])
    expect(BASE_THEME.manifest.id).toBe('base')
  })

  const manifestOf = (id: string, name = id): ThemeManifest => ({ ...BASE_THEME.manifest, id, name, wallpapers: [], previewWallpaper: undefined })

  it('假来源：某个主题的 fonts.ts 加载失败 / manifest.ts 语法错，只有它们被跳过，其余照常', async () => {
    const reg = await buildRegistry({
      manifests: {
        './base/manifest.ts': async () => ({ default: manifestOf('base') }),
        './alpha/manifest.ts': async () => ({ default: manifestOf('alpha') }),
        './bad-fonts/manifest.ts': async () => ({ default: manifestOf('bad-fonts', '坏字体') }),
        './bad-manifest/manifest.ts': async () => {
          throw new SyntaxError('Unexpected token (3:7)')
        },
      },
      tokens: { './alpha/tokens.css': async () => ({}) },
      tokenText: { './alpha/tokens.css': '[data-theme="alpha"] { --bg: #fff; }' },
      fonts: {
        './bad-fonts/fonts.ts': async () => {
          throw new Error('Failed to resolve import "./extras.css" from "src/themes/bad-fonts/fonts.ts".\n  1 | import ...')
        },
      },
      slots: { './base/slots.tsx': async () => ({ default: BASE_THEME.slots }) },
      backdrops: {},
    })
    expect(reg.themes.map((t) => t.manifest.id)).toEqual(['base', 'alpha'])
    expect(reg.themes[1]!.declaredTokens.has('--bg')).toBe(true)
    expect(reg.failures).toEqual([
      { id: 'bad-fonts', name: '坏字体', errors: ['fonts.ts：Failed to resolve import "./extras.css" from "src/themes/bad-fonts/fonts.ts". 1 | import ...'] },
      { id: 'bad-manifest', name: 'bad-manifest', errors: ['manifest.ts：Unexpected token (3:7)'] },
    ])
  })

  it('真实文件：模块顶层抛错、import 了不存在的文件、忘了 export default，都只挂自己（src/test/fixtures/themes）', async () => {
    const reg = await buildRegistry({
      manifests: import.meta.glob<{ default?: ThemeManifest }>('../test/fixtures/themes/*/manifest.ts'),
      tokens: import.meta.glob('../test/fixtures/themes/*/tokens.css'),
      tokenText: import.meta.glob<string>('../test/fixtures/themes/*/tokens.css', { eager: true, query: '?raw', import: 'default' }),
      fonts: import.meta.glob('../test/fixtures/themes/*/fonts.ts'),
      slots: import.meta.glob<{ default?: ThemeSlots }>('../test/fixtures/themes/*/slots.tsx'),
      backdrops: import.meta.glob<{ default?: ComponentType<BackdropProps> }>('../test/fixtures/themes/*/Backdrop.tsx'),
    })
    expect(reg.themes.map((t) => t.manifest.id)).toEqual(['good'])
    expect(reg.themes[0]!.problems).toEqual([])
    expect(reg.failures.map((f) => f.id)).toEqual(['missing-import', 'no-default', 'throws'])
    const why = Object.fromEntries(reg.failures.map((f) => [f.id, f.errors.join(' | ')]))
    expect(why['throws']).toMatch(/^slots\.tsx：.*故意坏掉/)
    expect(why['missing-import']).toMatch(/^fonts\.ts：.*extras\.css/)
    expect(why['no-default']).toBe('manifest.ts：没有 default export')
    // manifest 读到了的，失败卡片上显示它的中文名
    expect(reg.failures.find((f) => f.id === 'throws')!.name).toBe('测试主题 throws')
  })
})

describe('emoji 映射表', () => {
  it('每个名字都存在于 fluent-emoji-flat', () => {
    const require = createRequire(import.meta.url)
    const data = require('@iconify-json/fluent-emoji-flat/icons.json') as { icons: Record<string, unknown>; aliases?: Record<string, unknown> }
    const missing = EMOJI_ICON_NAMES.filter((n) => !data.icons[n] && !data.aliases?.[n])
    expect(missing).toEqual([])
  })
})
