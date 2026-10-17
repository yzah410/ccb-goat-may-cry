/**
 * 颜色工具（给主题包用，尤其是「壁纸驱动配色」的主题）。
 * 纯函数、无依赖。OKLCH 换算参考 Björn Ottosson 的 OKLab。
 */

export interface RGB {
  r: number
  g: number
  b: number
}

export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`不是合法的 hex 颜色：${hex}`)
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}

export function rgbToHex({ r, g, b }: RGB): string {
  const c = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

const toLinear = (c: number) => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const fromLinear = (v: number) => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
  return c * 255
}

/** WCAG 相对亮度 0–1 */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

/** WCAG 对比度 1–21（正文要 ≥ 4.5，大字/图标 ≥ 3） */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

export interface OKLCH {
  l: number
  c: number
  h: number
}

export function hexToOklch(hex: string): OKLCH {
  const { r, g, b } = hexToRgb(hex)
  const lr = toLinear(r)
  const lg = toLinear(g)
  const lb = toLinear(b)
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
  const C = Math.sqrt(A * A + B * B)
  let H = (Math.atan2(B, A) * 180) / Math.PI
  if (H < 0) H += 360
  return { l: L, c: C, h: H }
}

function oklchToLinear({ l, c, h }: OKLCH): [number, number, number] {
  const hr = (h * Math.PI) / 180
  const A = c * Math.cos(hr)
  const B = c * Math.sin(hr)
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
}

export function oklchToHex(o: OKLCH): string {
  const [r, g, b] = oklchToLinear(o)
  return rgbToHex({ r: fromLinear(Math.max(0, r)), g: fromLinear(Math.max(0, g)), b: fromLinear(Math.max(0, b)) })
}

/** 把颜色拉进 sRGB 色域（色度过高时逐步降色度，亮度和色相不变） */
function inGamutHex(o: OKLCH): string {
  let c = o.c
  for (let i = 0; i < 30; i++) {
    const rgb = oklchToLinear({ ...o, c })
    if (rgb.every((v) => v >= -0.0005 && v <= 1.0005)) return oklchToHex({ ...o, c })
    c *= 0.88
  }
  return oklchToHex({ ...o, c: 0 })
}

export type ScaleStep = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900

const LIGHT_L: Record<ScaleStep, number> = {
  50: 0.975,
  100: 0.95,
  200: 0.9,
  300: 0.83,
  400: 0.74,
  500: 0.64,
  600: 0.55,
  700: 0.47,
  800: 0.39,
  900: 0.31,
}

/**
 * 深色（反向）色阶的亮度和色度系数。照着 base 主题手调的深色色阶定的（#19152b → #e6e0ff，OKLCH 亮度 0.21 → 0.92）：
 * - 50/100/200 是深色模式里的「淡底」（选中行、徽标底），要比深色卡片面（亮度 0.2 左右）略亮、带一点主色，三档之间拉得开；
 * - 色度两头收：最暗的淡底只带一点点主色（不然像一块浓色补丁），最亮的 800/900 是淡底上的文字色，也收一点。
 * 不直接用「1.02 - 浅色亮度」反推：那样 50/100/200 三档会被同一个下限 0.12 钳成同一个近黑色。
 */
const DARK_L: Record<ScaleStep, number> = {
  50: 0.22,
  100: 0.255,
  200: 0.3,
  300: 0.36,
  400: 0.44,
  500: 0.54,
  600: 0.61,
  700: 0.7,
  800: 0.8,
  900: 0.91,
}
const DARK_C: Record<ScaleStep, number> = {
  50: 0.26,
  100: 0.34,
  200: 0.46,
  300: 0.6,
  400: 0.76,
  500: 1,
  600: 0.95,
  700: 0.82,
  800: 0.55,
  900: 0.25,
}

/**
 * 从一个主色生成 50–900 色阶（OKLCH 等亮度步进，色相不变，两端降色度）。
 * dark = true 时生成「反向」色阶：50 最暗（深色模式里当淡底用），900 最亮。
 * 两种色阶的亮度都是固定表（和主色本身多亮无关），10 档严格单调、相邻两档亮度差 ≥ 0.035。
 */
export function generateScale(base: string, dark = false): Record<ScaleStep, string> {
  const o = hexToOklch(base)
  const steps = Object.keys(LIGHT_L).map(Number) as ScaleStep[]
  const out = {} as Record<ScaleStep, string>
  for (const s of steps) {
    if (dark) {
      out[s] = inGamutHex({ l: DARK_L[s], c: o.c * DARK_C[s], h: o.h })
      continue
    }
    const target = LIGHT_L[s]
    const edge = Math.min(Math.abs(target - 0.55) / 0.45, 1) // 越靠两端色度越低
    const c = o.c * (1 - 0.65 * edge * edge)
    out[s] = inGamutHex({ l: Math.min(0.99, Math.max(0.12, target)), c, h: o.h })
  }
  return out
}

/** 按比例混合两个 hex（t=0 → a，t=1 → b），在线性 RGB 里混 */
export function mixHex(a: string, b: string, t: number): string {
  const A = hexToRgb(a)
  const B = hexToRgb(b)
  const mix = (x: number, y: number) => fromLinear(toLinear(x) * (1 - t) + toLinear(y) * t)
  return rgbToHex({ r: mix(A.r, B.r), g: mix(A.g, B.g), b: mix(A.b, B.b) })
}

/**
 * 调整前景色亮度，直到它和背景的对比度 ≥ min（默认 4.5）。
 * 背景亮 → 前景往暗调；背景暗 → 前景往亮调。色相保持。
 */
export function ensureContrast(fg: string, bg: string, min = 4.5): string {
  if (contrastRatio(fg, bg) >= min) return fg
  const o = hexToOklch(fg)
  const bgDark = luminance(bg) < 0.18
  let l = o.l
  for (let i = 0; i < 40; i++) {
    l = bgDark ? Math.min(0.99, l + 0.02) : Math.max(0.05, l - 0.02)
    const hex = inGamutHex({ ...o, l })
    if (contrastRatio(hex, bg) >= min) return hex
  }
  return bgDark ? '#ffffff' : '#000000'
}

/** 给 hex 加透明度 → "rgb(r g b / a)" */
export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex)
  return `rgb(${r} ${g} ${b} / ${alpha})`
}
