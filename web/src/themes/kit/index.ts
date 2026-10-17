/**
 * 主题工具箱：主题包（src/themes/<id>/）可以放心 import 这里的东西。
 * 这些是所有主题共用的代码；主题包直接 import 使用，需要不同效果时在自己的目录里写。
 */
export { WallpaperImage, type WallpaperImageProps } from './WallpaperImage'
export { Veil, type VeilProps } from './Veil'
export { useThemeScope, useThemeSlot, useThemeRoute, useRuntimeTokens, usePortalContainer } from '../context'
export {
  getWallpaper,
  requireWallpaper,
  listWallpapers,
  pickDaily,
  preloadWallpaper,
  type Wallpaper,
} from '@/lib/wallpapers'
export {
  contrastRatio,
  ensureContrast,
  generateScale,
  hexToOklch,
  oklchToHex,
  luminance,
  mixHex,
  withAlpha,
} from '@/lib/color'
export { Emoji, emojiForTag, emojiForUi } from '@/lib/emoji'
export type * from '../types'
