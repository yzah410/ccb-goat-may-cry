import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * 主内容区：自己滚动（shell 是一整屏高、不滚），这样壁纸层固定不动。
 * 它是容器查询的容器（@container/main）：页面用 @3xl/main: 这类变体按「可用宽度」排版，
 * 所以分屏对比的半宽格子里也能正常换行，不用靠窗口宽度。
 */
export function MainArea({ children, className, innerClassName }: { children: ReactNode; className?: string; innerClassName?: string }) {
  return (
    <main
      id="main"
      tabIndex={-1}
      className={cn('@container/main relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden scroll-thin outline-none', className)}
    >
      <div className={cn('mx-auto w-full max-w-[1480px] px-4 pb-16 @3xl/main:px-8', innerClassName)}>{children}</div>
    </main>
  )
}
