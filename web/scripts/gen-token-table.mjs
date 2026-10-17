// 从 src/themes/tokens.ts + src/styles/tokens.base.css 生成主题 token 表（markdown）
// 用法：node scripts/gen-token-table.mjs > /tmp/token-table.md
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ts = fs.readFileSync(path.join(root, 'src/themes/tokens.ts'), 'utf8')
const css = fs.readFileSync(path.join(root, 'src/styles/tokens.base.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

function block(sel) {
  const i = css.indexOf(sel)
  const a = css.indexOf('{', i)
  const b = css.indexOf('}', a)
  const out = {}
  for (const m of css.slice(a + 1, b).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}
const light = block(':root,')
const dark = block('[data-theme][data-mode="dark"]')

const rows = [...ts.matchAll(/t\('(--[a-z0-9-]+)', '([^']+)', '([^']+)', '([^']*)'(, false)?\)/g)].map((m) => ({
  name: m[1], group: m[2], usage: m[3], required: !m[5],
}))
let group = ''
const esc = (s) => String(s ?? '').replace(/\|/g, '\|')
const lines = []
for (const r of rows) {
  if (r.group !== group) {
    group = r.group
    lines.push('', `#### ${group}`, '', '| token | 必填 | 用在哪 | base 浅色 | base 深色 |', '|---|---|---|---|---|')
  }
  const d = dark[r.name] ?? '（同浅色）'
  lines.push(`| \`${r.name}\` | ${r.required ? '是' : '可选'} | ${esc(r.usage)} | \`${esc(light[r.name])}\` | ${d === '（同浅色）' ? d : '`' + esc(d) + '`'} |`)
}
process.stdout.write(lines.join('\n') + '\n')
console.error(`rows=${rows.length}`)
