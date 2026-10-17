import type { ThemeManifest } from '../types'

/**
 * 基础主题：中性、克制、浅色为主、深色可用。
 * 它是「组件本来长什么样」的参考实现，也是所有主题缺 token / 缺 slot 时的兜底。
 */
const manifest: ThemeManifest = {
  id: 'base',
  name: '基础',
  nameEn: 'Base',
  tagline: '中性克制的参考主题，所有主题的兜底',
  description:
    '不带壁纸、不做装饰，只把层级、间距、状态做对。做主题时可以拿它当对照：组件在这里长什么样，就是「没有任何主题化」时的样子。',
  wallpapers: [],
  modes: ['light', 'dark'],
  defaultMode: 'light',
  shell: 'sidebar',
  density: 'comfortable',
  fonts: {
    display: 'Inter + Noto Sans SC',
    body: 'Inter + Noto Sans SC',
    mono: 'JetBrains Mono',
  },
  author: '山羊五月哭',
  createdAt: '2026-10-18',
}

export default manifest
