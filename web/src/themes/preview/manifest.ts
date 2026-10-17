import type { ThemeManifest } from '../types'

/**
 * preview：验证用的极简主题。
 * 目的只有一个：验证 Backdrop / slots / ThemeScope 分屏对比 / ?theme= 参数这条链路能用。
 * 它故意只改了少量 token（其余走 base 兜底），所以画廊里覆盖率不是 100% —— 正式主题必须 100%。
 */
const manifest: ThemeManifest = {
  id: 'preview',
  name: '预览',
  nameEn: 'Preview',
  tagline: '验证用：轻渐变 + 少量 token',
  description:
    '不用壁纸，主色是浅蓝，点缀色是暖粉。其余 token 故意不写，用来演示 base 兜底；布局换成顶栏，演示 manifest.shell 可以切换布局。',
  wallpapers: [],
  modes: ['light'],
  defaultMode: 'light',
  shell: 'topbar',
  density: 'comfortable',
  fonts: {
    display: 'Inter + Noto Sans SC（沿用 base）',
    body: 'Inter + Noto Sans SC（沿用 base）',
    mono: 'JetBrains Mono（沿用 base）',
  },
  author: '山羊五月哭',
  createdAt: '2026-10-18',
  // 隐藏：演示/测试用主题，不出现在日常选主题的地方（画廊、命令面板、分屏对比下拉），
  // 但 ?theme=preview 可以直接打开，主题契约的演示和 themes.test.ts 都要用它。
  hidden: true,
}

export default manifest
