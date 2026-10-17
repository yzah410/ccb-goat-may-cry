import type { ThemeManifest } from '@/themes/types'

const manifest: ThemeManifest = {
  id: 'throws',
  name: '测试主题 throws',
  nameEn: 'Fixture throws',
  tagline: '测试用',
  description: '主题隔离测试用的假主题（见上一级 README.md）。',
  wallpapers: [],
  modes: ['light'],
  defaultMode: 'light',
  shell: 'sidebar',
  density: 'comfortable',
  fonts: { display: '-', body: '-', mono: '-' },
  author: 'test',
  createdAt: '2000-01-01',
}
export default manifest
