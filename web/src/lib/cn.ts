import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * 合并 className，后面的覆盖前面的（tailwind-merge）。
 * 我们的主题 token 名（shadow-1、text-fg-1、rounded-md …）需要告诉 tailwind-merge 它们属于哪一组。
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      shadow: ['1', '2', '3'],
      radius: ['sm', 'md', 'lg', 'xl', 'full'],
      text: ['xs', 'sm', 'base', 'lg', 'xl', '2xl'],
      font: ['display', 'body', 'mono'],
      blur: ['glass'],
      leading: ['tight', 'body'],
    },
  },
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
