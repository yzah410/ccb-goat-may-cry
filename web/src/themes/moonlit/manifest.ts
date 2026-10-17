import type { ThemeManifest } from '../types'
import { hasWallpaper } from '@/lib/wallpapers'
import { SCENES } from './scenes'

/**
 * 月夜·萤火：暖深色。
 * 深靛蓝的夜做底，月光金只给「这一页唯一的主要操作」和焦点，暖红只标「当前题目」。
 * 壁纸是可选的（assets/wallpapers/，见该目录的 README.md）：每个页面认准一张夜景，工作页只在右上角像隔着起雾的窗一样透出来，
 * 主题画廊和 404 才把画面整张打开。没有壁纸时，用纯 CSS 的夜空、月晕和萤火。
 */
// 只登记真的存在的壁纸：没放壁纸时是空数组；把 scenes.ts 里用到的 slug 放进 assets/wallpapers/ 就会自动出现
const wallpapers = [...new Set(Object.values(SCENES).map((s) => s.slug))].filter(hasWallpaper)

const manifest: ThemeManifest = {
  id: 'moonlit',
  name: '月夜·萤火',
  nameEn: 'Moonlit',
  tagline: '深靛夜色里，只有主按钮是那轮月亮',
  description:
    '底色取自萤火夜空的靛蓝，主色取满月的金，点缀取一点暖红。卡片是起雾的玻璃，背后有月晕和几点萤火慢慢闪；有壁纸时每页一张夜景，只从右上角透出来，不抢内容。',
  wallpapers,
  previewWallpaper: hasWallpaper(SCENES.themes.slug) ? SCENES.themes.slug : undefined,
  modes: ['dark'],
  defaultMode: 'dark',
  shell: 'topbar',
  density: 'comfortable',
  fonts: {
    display: 'Fraunces + Noto Serif SC（标题用宋体，像月下写信）',
    body: 'Manrope + Noto Sans SC',
    mono: 'JetBrains Mono',
  },
  author: '山羊五月哭',
  createdAt: '2026-10-18',
}

export default manifest
