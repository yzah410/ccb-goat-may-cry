// 从 src/styles/tokens.base.css 生成 src/themes/base/tokens.css（值完全一致，只是换成 [data-theme="base"] 作用域）。
// 用法：node scripts/gen-base-tokens.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'src/styles/tokens.base.css'), 'utf8')

function block(selectorRe) {
  const m = src.match(selectorRe)
  if (!m) throw new Error('找不到块：' + selectorRe)
  return m[1]
}
const light = block(/:root,\s*\[data-theme\]\s*\{([\s\S]*?)\n  \}/)
const dark = block(/\[data-theme\]\[data-mode="dark"\]\s*\{([\s\S]*?)\n  \}/)

const strip = (s) =>
  s
    .split('\n')
    .map((l) => l.replace(/^ {4}/, '  '))
    .join('\n')
    .replace(/\n  \/\* 密度[\s\S]*$/, '\n') // 密度 token 交给 manifest.density，不写进主题模板
    .trimEnd()

const header = `/*
 * base 主题 token —— 写新主题时照着抄的「完整模板」。
 *
 * 做新主题：把这个文件复制到 src/themes/<你的id>/tokens.css，
 *   1) 把所有 [data-theme="base"] 换成 [data-theme="<你的id>"]
 *   2) 改值（不要删 token；删了会用 base 的值兜底并在控制台 warn）
 *   3) 只做单一明暗的主题：删掉整个 [data-mode="dark"] 块，并在 manifest.modes 里只写一种
 *
 * 规则：
 * - 不要包 @layer（不带 layer 的声明优先级最高，保证你的值一定生效）
 * - 密度 token（--space-unit / --control-h-*）不要写，交给 manifest.density
 * - 这是纯 CSS，不要写 @apply / theme()
 *
 * ⚠️ 本文件由 scripts/gen-base-tokens.mjs 从 src/styles/tokens.base.css 生成，改 base 的值请改那边再重新生成。
 */
`

const out = `${header}
[data-theme="base"] {${strip(light)}
}

[data-theme="base"][data-mode="dark"] {${strip(dark)}
}
`
fs.writeFileSync(path.join(root, 'src/themes/base/tokens.css'), out)
console.log('已生成 src/themes/base/tokens.css')
