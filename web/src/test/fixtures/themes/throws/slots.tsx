import type { ThemeSlots } from '@/themes/types'

// 测试用：这个模块一被求值就抛错（模拟主题代码写错了，例如顶层访问了不存在的东西）
function boom(): never {
  throw new Error('故意坏掉的主题：slots.tsx 模块顶层抛错')
}

const slots: ThemeSlots = boom()
export default slots
