/**
 * 壁纸取用 API。
 *
 * 壁纸是可选的，素材包在 assets/wallpapers/（web/ 的兄弟目录，说明见该目录的 README.md）：
 *   full/<slug>.webp   1920 宽
 *   thumb/<slug>.webp  480 宽
 *   palette.json       壁纸清单（每项至少有 slug，其余字段可选）
 * 没有 palette.json、或清单是空的：listWallpapers() 返回空数组，getWallpaper() 返回 undefined，应用照常运行。
 * 开发时 Vite 中间件把它映射到 /wallpapers/*，构建时复制进 dist/wallpapers/。
 *
 * 用法：
 *   const w = getWallpaper('my-slug')   // 没有这张就是 undefined
 *   w.full / w.thumb      图片 URL
 *   w.blurDataURL         16px 宽的模糊占位图（data URL，可立即显示；清单里没写就是空串）
 *   w.colors              主色（清单里没写就是空数组）
 *   w.tone                'light' | 'mid' | 'dark'
 */
// 用 glob 而不是直接 import：palette.json 不存在时是空对象，不会让构建失败
const PALETTE_FILES = import.meta.glob<unknown>('@assets/wallpapers/palette.json', { eager: true, import: 'default' })

export type WallpaperTone = 'light' | 'mid' | 'dark'
export type WallpaperTemperature = 'warm' | 'cool' | 'neutral'

export interface WallpaperMeta {
  slug: string
  /** 原始文件名 */
  file: string
  width: number
  height: number
  /** 16px 宽的模糊占位图 */
  blurDataURL: string
  /** 6 个主色 hex，按像素占比从高到低（没剔除近白/近黑） */
  colors: string[]
  /** 0–1 平均亮度 */
  avgLuminance: number
  tone: WallpaperTone
  temperature: WallpaperTemperature
  /** 占比最高颜色的色相 0–360 */
  dominantHue: number
  /** 一句话画面描述 */
  subject: string
  /** 2–4 个氛围词 */
  mood: string
}

export interface Wallpaper extends WallpaperMeta {
  /** 1920 宽 WebP 的 URL */
  full: string
  /** 480 宽 WebP 的 URL */
  thumb: string
}

const BASE = import.meta.env.BASE_URL ?? '/'

const TONES: readonly WallpaperTone[] = ['light', 'mid', 'dark']
const TEMPERATURES: readonly WallpaperTemperature[] = ['warm', 'cool', 'neutral']

/**
 * 把 palette.json 的内容整理成壁纸列表：不是数组 → 空列表；某项不是对象或没有 slug → 跳过；
 * 其余字段缺了就补默认值（所以清单里每项只写 slug 就够）。
 */
export function buildWallpaperList(raw: unknown): Wallpaper[] {
  if (!Array.isArray(raw)) return []
  const out: Wallpaper[] = []
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Partial<WallpaperMeta>
    if (typeof r.slug !== 'string' || !r.slug) continue
    out.push({
      slug: r.slug,
      file: r.file ?? r.slug,
      width: r.width ?? 1920,
      height: r.height ?? 1080,
      blurDataURL: r.blurDataURL ?? '',
      colors: Array.isArray(r.colors) ? r.colors : [],
      avgLuminance: r.avgLuminance ?? 0.5,
      tone: TONES.includes(r.tone as WallpaperTone) ? (r.tone as WallpaperTone) : 'mid',
      temperature: TEMPERATURES.includes(r.temperature as WallpaperTemperature) ? (r.temperature as WallpaperTemperature) : 'neutral',
      dominantHue: r.dominantHue ?? 0,
      subject: r.subject ?? '',
      mood: r.mood ?? '',
      full: `${BASE}wallpapers/full/${r.slug}.webp`,
      thumb: `${BASE}wallpapers/thumb/${r.slug}.webp`,
    })
  }
  return out
}

const LIST: readonly Wallpaper[] = buildWallpaperList(Object.values(PALETTE_FILES)[0])

const BY_SLUG = new Map(LIST.map((w) => [w.slug, w]))

/** 全部壁纸（没有壁纸时是空数组） */
export function listWallpapers(): readonly Wallpaper[] {
  return LIST
}

/** 按 slug 取一张；没有返回 undefined（开发环境会 warn） */
export function getWallpaper(slug: string): Wallpaper | undefined {
  const w = BY_SLUG.get(slug)
  if (!w && import.meta.env.DEV) console.warn(`[wallpapers] 没有这张壁纸：${slug}（看 assets/wallpapers/palette.json 里的 slug）`)
  return w
}

/** 按 slug 取一张；没有就抛错（适合 manifest 里写死的 slug） */
export function requireWallpaper(slug: string): Wallpaper {
  const w = BY_SLUG.get(slug)
  if (!w) throw new Error(`没有这张壁纸：${slug}`)
  return w
}

export function hasWallpaper(slug: string): boolean {
  return BY_SLUG.has(slug)
}

/** 简单稳定哈希（FNV-1a） */
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * 确定性地从一组壁纸里选一张：同一个 key（例如「路由」）同一天总是同一张，换一天才换。
 * （不用纯随机：同一天打开同一页看到的是同一张，方便对比和截图）
 */
export function pickDaily(slugs: readonly string[], key: string, date: Date = new Date()): string | undefined {
  if (!slugs.length) return undefined
  const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
  return slugs[hash(`${key}|${day}`) % slugs.length]
}

/** 预加载一张图（切主题前调用，避免闪） */
export function preloadWallpaper(slug: string, size: 'full' | 'thumb' = 'full'): Promise<void> {
  const w = BY_SLUG.get(slug)
  if (!w || typeof Image === 'undefined') return Promise.resolve()
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve()
    img.onerror = () => resolve()
    img.src = size === 'full' ? w.full : w.thumb
  })
}
