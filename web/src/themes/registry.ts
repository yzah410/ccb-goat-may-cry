/**
 * 主题自动注册：把 src/themes/<id>/ 文件夹丢进来就生效，不需要改任何共享代码。
 *
 * 每个主题文件夹：
 *   manifest.ts   必填（default export ThemeManifest）
 *   tokens.css    必填（[data-theme="<id>"] { ... }）
 *   fonts.ts      可选（import '@fontsource/...'）
 *   Backdrop.tsx  可选（default export 组件）
 *   slots.tsx     可选（default export ThemeSlots 对象）
 *
 * 隔离：
 * - 每个主题的每个文件都是**单独的动态 import**，各自 try/catch。某个主题的文件缺了、语法错、模块顶层抛错 →
 *   只有这一个主题进 THEME_LOAD_FAILURES（画廊里显示「加载失败」、不能选；选了它的用户自动退回 base），
 *   其余主题和整个网站照常。如果把所有文件一起静态导入，坏一个文件就会整站白屏。
 * - 加载是异步的：main.tsx 先等 themesReady，再加载整个应用。所以应用代码拿到的 THEMES / BASE_THEME 永远是建好的。
 *   （没用 top-level await：打包后主题的 chunk 要从入口 chunk 里 import 共享代码，入口 chunk 若在 await 主题 chunk 就会互相等死。）
 * - base 是兜底：它加载失败，themesReady 会 reject，main.tsx 显示「网站没能启动」和原因。
 */
import type { ComponentType } from 'react'
import { resolveThemeId } from './aliases'
import { setFallbackTheme } from './context'
import { declaredTokensIn, REQUIRED_TOKEN_NAMES } from './tokens'
import type { BackdropProps, RegisteredTheme, SlotName, ThemeLoadFailure, ThemeManifest, ThemeSlots } from './types'
import { hasWallpaper } from '@/lib/wallpapers'

type Loader<T> = () => Promise<T>

/** 一套主题文件的来源：正常是下面的 import.meta.glob；测试可以塞假的 / 故意坏掉的进来 */
export interface ThemeSources {
  manifests: Record<string, Loader<{ default?: ThemeManifest }>>
  /** tokens.css 本身（副作用导入：把样式挂到页面上） */
  tokens: Record<string, Loader<unknown>>
  /** tokens.css 的原文（算 token 覆盖率用；?raw 读文本不会失败，所以是同步的） */
  tokenText: Record<string, string>
  fonts: Record<string, Loader<unknown>>
  slots: Record<string, Loader<{ default?: ThemeSlots }>>
  backdrops: Record<string, Loader<{ default?: ComponentType<BackdropProps> }>>
}

export interface BuiltRegistry {
  /** 加载成功的主题：base 第一，preview 第二，其余按 id 字母序 */
  themes: RegisteredTheme[]
  /** 加载失败的主题（按文件夹名字母序） */
  failures: ThemeLoadFailure[]
}

/** './moonlit/slots.tsx' → 'moonlit'（取倒数第二段；测试用的路径前缀不一样也能用） */
const folderOf = (p: string): string => {
  const parts = p.split('/')
  return parts[parts.length - 2] ?? ''
}
const byFolder = <T,>(rec: Record<string, T>): Map<string, T> =>
  new Map(Object.entries(rec).map(([p, v]) => [folderOf(p), v]))

/** 错误信息：只留前两行、最多 300 字（Vite 的报错会带一大段代码帧） */
function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ')
    .slice(0, 300)
}

const SLOT_NAMES: SlotName[] = [
  'Logo',
  'EmptyIllustration',
  'CardOrnament',
  'LoadingIndicator',
  'PageHeaderDecor',
  'NavItemDecor',
]

function checkManifest(folder: string, m: ThemeManifest): string[] {
  const p: string[] = []
  if (m.id !== folder) p.push(`manifest.id（${m.id}）和文件夹名（${folder}）不一致`)
  if (!/^[a-z][a-z0-9-]*$/.test(m.id)) p.push(`id 只能用小写字母、数字、短横线：${m.id}`)
  if (!m.name) p.push('缺 name')
  if (!Array.isArray(m.modes) || m.modes.length === 0) p.push('modes 至少要有一个')
  else if (!m.modes.includes(m.defaultMode)) p.push(`defaultMode（${m.defaultMode}）不在 modes 里`)
  if (m.autoMode !== undefined && typeof m.autoMode !== 'function') p.push('autoMode 必须是函数（() => "light" | "dark"）')
  if (m.hidden !== undefined && typeof m.hidden !== 'boolean') p.push('hidden 必须是布尔值')
  if (!['sidebar', 'topbar', 'dock', 'split'].includes(m.shell)) p.push(`shell 不合法：${m.shell}`)
  if (!['compact', 'comfortable', 'spacious'].includes(m.density)) p.push(`density 不合法：${m.density}`)
  for (const s of m.wallpapers ?? []) if (!hasWallpaper(s)) p.push(`壁纸 slug 不存在：${s}`)
  if (m.previewWallpaper && !hasWallpaper(m.previewWallpaper)) p.push(`previewWallpaper 不存在：${m.previewWallpaper}`)
  return p
}

/**
 * 按主题逐个、按文件逐个加载并登记。任何一步失败都只记在这个主题的 failure 里，不抛错。
 * 一个主题只要有任何一个文件加载失败，整个主题都算失败（半个主题比没有更让人困惑）。
 */
export async function buildRegistry(src: ThemeSources): Promise<BuiltRegistry> {
  const manifests = byFolder(src.manifests)
  const tokens = byFolder(src.tokens)
  const tokenText = byFolder(src.tokenText)
  const fonts = byFolder(src.fonts)
  const slots = byFolder(src.slots)
  const backdrops = byFolder(src.backdrops)

  const loaded = await Promise.all(
    [...manifests.keys()].map(async (folder): Promise<RegisteredTheme | ThemeLoadFailure> => {
      const errors: string[] = []
      const load = async <T,>(file: string, loader: Loader<T> | undefined): Promise<T | undefined> => {
        if (!loader) return undefined
        try {
          return await loader()
        } catch (e) {
          errors.push(`${file}：${errText(e)}`)
          return undefined
        }
      }
      const [manifestMod, , , slotsMod, backdropMod] = await Promise.all([
        load('manifest.ts', manifests.get(folder)),
        load('tokens.css', tokens.get(folder)),
        load('fonts.ts', fonts.get(folder)),
        load('slots.tsx', slots.get(folder)),
        load('Backdrop.tsx', backdrops.get(folder)),
      ])
      const manifest = manifestMod?.default
      if (manifestMod && !manifest) errors.push('manifest.ts：没有 default export')
      if (errors.length || !manifest) return { id: folder, name: manifest?.name || folder, errors }

      const problems = checkManifest(folder, manifest)
      const css = tokenText.get(folder)
      if (css === undefined) problems.push('缺 tokens.css')
      const declaredTokens = declaredTokensIn(css ?? '')
      const missingRequired = REQUIRED_TOKEN_NAMES.filter((n) => !declaredTokens.has(n))
      const coverage = (REQUIRED_TOKEN_NAMES.length - missingRequired.length) / REQUIRED_TOKEN_NAMES.length
      return {
        manifest,
        slots: slotsMod?.default ?? {},
        Backdrop: backdropMod?.default,
        declaredTokens,
        missingRequired,
        coverage,
        problems,
      }
    }),
  )

  const themes = loaded.filter((x): x is RegisteredTheme => 'manifest' in x)
  const failures = loaded.filter((x): x is ThemeLoadFailure => !('manifest' in x))
  // base 永远第一，preview 第二，其余按 id 字母序
  const rank = (id: string) => (id === 'base' ? 0 : id === 'preview' ? 1 : 2)
  themes.sort((a, b) => rank(a.manifest.id) - rank(b.manifest.id) || a.manifest.id.localeCompare(b.manifest.id))
  failures.sort((a, b) => a.id.localeCompare(b.id))
  return { themes, failures }
}

// ---------------------------------------------------------------------------------------------
// 应用用的注册表。
// - 数据放在 globalThis 上，这个文件的所有模块实例共用一份：开发时热更新可能把这个文件重新求值一次（新实例），
//   新实例一出生就能读到上一次建好的数据（不会出现 BASE_THEME 是 undefined、外壳一渲染就崩的情况）。
// - 第一次加载时，下面这些导出在 themesReady 完成之后才有内容（main.tsx 保证应用在那之后才加载）。
// ---------------------------------------------------------------------------------------------
interface RegistryState {
  themes: RegisteredTheme[]
  map: Map<string, RegisteredTheme>
  failures: ThemeLoadFailure[]
  base?: RegisteredTheme
  /** 这个文件在当前页面里被求值过几次（开发时热更新会让它大于 1） */
  evaluations: number
}
const R: RegistryState = ((globalThis as { __outsetterRegistry?: RegistryState }).__outsetterRegistry ??= {
  themes: [],
  map: new Map(),
  failures: [],
  evaluations: 0,
})
R.evaluations += 1

/** 加载成功的主题（base 第一、preview 第二、其余按 id 字母序） */
export const THEMES: readonly RegisteredTheme[] = R.themes
export const THEME_MAP: ReadonlyMap<string, RegisteredTheme> = R.map
/** 加载失败的主题（画廊里显示「加载失败」卡片） */
export const THEME_LOAD_FAILURES: readonly ThemeLoadFailure[] = R.failures
/** base 主题：所有主题的兜底（第一次建好时赋值；热更新重新求值出来的实例一出生就拿到上一次的） */
export let BASE_THEME: RegisteredTheme = R.base as RegisteredTheme

/** 建好的结果写进共享的注册表（原地更新：别的模块实例拿着的数组 / Map 也跟着变） */
function apply({ themes, failures }: BuiltRegistry): void {
  const base = themes.find((t) => t.manifest.id === 'base')
  if (!base) {
    const why = failures.find((f) => f.id === 'base')
    throw new Error(
      `base 主题（src/themes/base/）加载失败，它是所有主题的兜底，网站没法启动。${why ? `原因：${why.errors.join('；')}` : '找不到 src/themes/base/manifest.ts。'}`,
    )
  }
  const missingBaseSlots = SLOT_NAMES.filter((n) => !base.slots[n])
  if (missingBaseSlots.length) throw new Error(`base 主题缺少 slot：${missingBaseSlots.join(', ')}`)

  R.themes.splice(0, R.themes.length, ...themes)
  R.map.clear()
  for (const t of themes) R.map.set(t.manifest.id, t)
  R.failures.splice(0, R.failures.length, ...failures)
  R.base = base
  BASE_THEME = base
  setFallbackTheme(base)

  for (const f of failures)
    console.error(`[theme:${f.id}] 加载失败，已跳过（其余主题不受影响；选了它的会自动用 base）：\n- ${f.errors.join('\n- ')}`)
  if (import.meta.env.DEV) {
    for (const t of themes) {
      if (t.problems.length) console.warn(`[theme:${t.manifest.id}] manifest 有问题：\n- ${t.problems.join('\n- ')}`)
    }
  }
}

/** 注册表建好（所有主题都试着加载过一遍）；base 本身加载失败时 reject */
export const themesReady: Promise<void> = buildRegistry({
  manifests: import.meta.glob<{ default?: ThemeManifest }>('./*/manifest.ts'),
  tokens: import.meta.glob('./*/tokens.css'),
  tokenText: import.meta.glob<string>('./*/tokens.css', { eager: true, query: '?raw', import: 'default' }),
  fonts: import.meta.glob('./*/fonts.ts'),
  slots: import.meta.glob<{ default?: ThemeSlots }>('./*/slots.tsx'),
  backdrops: import.meta.glob<{ default?: ComponentType<BackdropProps> }>('./*/Backdrop.tsx'),
}).then(apply)

/**
 * 开发时这个文件被热更新重新求值了（= 某个主题文件改了，而 Vite 没有整页刷新，只替换了一部分模块）：
 * 整页刷新一次，保证页面上跑的是一套一致的新代码——注册表是异步建的，就地替换会有一段新旧代码混用的时间。
 * 防循环：离上一次这样刷新不到 5 秒，就只提示、不刷新。生产构建里 import.meta.hot 不存在，这段不会执行。
 */
function reloadForFreshRegistry(): void {
  const KEY = 'outsetter.registry-hmr-reload'
  let last = 0
  try {
    last = Number(sessionStorage.getItem(KEY) ?? 0)
  } catch {
    /* 拿不到 sessionStorage 就当没刷新过 */
  }
  if (Date.now() - last < 5000) {
    console.warn('[theme] 主题文件改了，但 5 秒内已经自动刷新过一次，这次不刷新：页面上可能是新旧混合的样子，手动刷新一下即可。')
    return
  }
  try {
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    /* 忽略 */
  }
  console.info('[theme] 主题文件改了：整页刷新一次，保证用的是一套一致的新代码。')
  window.location.reload()
}
if (import.meta.hot && R.evaluations > 1) {
  themesReady.catch((e: unknown) => console.error('[theme] 热更新后重建主题注册表失败：', e))
  reloadForFreshRegistry()
}

const warned = new Set<string>()
/** 开发环境：某个主题第一次被用上时，报告它缺了哪些必填 token（只报一次） */
export function warnMissingTokens(t: RegisteredTheme): void {
  if (!import.meta.env.DEV || warned.has(t.manifest.id) || !t.missingRequired.length) return
  warned.add(t.manifest.id)
  console.warn(
    `[theme:${t.manifest.id}] 缺少 ${t.missingRequired.length} 个必填 token（已用 base 默认值兜底）：${t.missingRequired.join(', ')}`,
  )
}

/**
 * 按 id 取主题；没有这个主题、或它加载失败了 → undefined（调用方一般 ?? BASE_THEME）。
 * 先过一遍主题 id 别名表（THEME_ID_ALIASES）。
 */
export function getTheme(id: string | null | undefined): RegisteredTheme | undefined {
  return id ? THEME_MAP.get(resolveThemeId(id)) : undefined
}

/** 这个 id 的主题是不是加载失败了（失败原因见返回值） */
export function getThemeLoadFailure(id: string | null | undefined): ThemeLoadFailure | undefined {
  return id ? THEME_LOAD_FAILURES.find((f) => f.id === id) : undefined
}

export function themeIds(): string[] {
  return THEMES.map((t) => t.manifest.id)
}

/** 画廊 / 命令面板 / 分屏对比下拉要列出的主题：加载成功、且没设 hidden */
export function visibleThemes(): RegisteredTheme[] {
  return THEMES.filter((t) => !t.manifest.hidden)
}

/** 随机挑一个和 exclude 不同的主题 id（只从「列出来的」主题里挑，不会随机跳到 hidden 主题上） */
export function randomThemeId(exclude?: string): string {
  const pool = visibleThemes()
    .map((t) => t.manifest.id)
    .filter((id) => id !== exclude)
  if (!pool.length) return 'base'
  return pool[Math.floor(Math.random() * pool.length)] ?? 'base'
}
