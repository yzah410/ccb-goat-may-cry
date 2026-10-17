import type { ReactNode } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Button } from '@/components/ui/Button'
import { backToBaseTheme } from './recovery'

/**
 * 应用最外层的错误边界：路由之外（外壳 Provider、全局 toast、确认框……）渲染出错时，
 * 显示这一页而不是白屏。路由里面的错误由 router.tsx 的 errorElement（RouteError）先接住。
 * 这一页故意不用任何主题 slot / 主题 hook（出错的很可能就是主题），只用 token 颜色。
 */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      onError={(e) => console.error('[app] 渲染出错，已显示错误页：', e)}
      fallback={(error, reset) => <AppCrash error={error} retry={reset} />}
    >
      {children}
    </ErrorBoundary>
  )
}

function AppCrash({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div role="alert" className="grid min-h-dvh place-items-center bg-bg p-6 text-fg-1">
      <div className="flex w-full max-w-xl flex-col gap-4 rounded-xl border border-border bg-surface-1 p-6 shadow-2">
        <div>
          <h1 className="text-xl">界面出错了</h1>
          <p className="mt-2 text-sm text-fg-2">
            正在编辑的方案、当前题目都存在浏览器里，不会丢。多半是某个主题的装饰出了问题：先点「回到基础主题」
            （主题换回默认，布局和密度改回「跟随主题」，然后重新加载页面）；还不行就点「刷新页面」。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={backToBaseTheme}>
            回到基础主题
          </Button>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            刷新页面
          </Button>
          <Button variant="ghost" onClick={retry}>
            再试一次（不刷新）
          </Button>
        </div>
        <details className="text-xs text-fg-3">
          <summary className="cursor-pointer select-none">出错原因（给开发者看）</summary>
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-3 font-mono text-danger-fg">
            {error.message}
            {error.stack ? `\n\n${error.stack}` : ''}
          </pre>
        </details>
      </div>
    </div>
  )
}
