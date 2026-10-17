import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { AppErrorBoundary } from './AppErrorBoundary'
import { AppProviders } from './providers'
import { router } from './router'

/** 挂载整个应用（main.tsx 在主题注册表建好之后才加载这个文件） */
export function mountApp(el: HTMLElement): void {
  createRoot(el).render(
    <StrictMode>
      <AppErrorBoundary>
        <AppProviders>
          <RouterProvider router={router} />
        </AppProviders>
      </AppErrorBoundary>
    </StrictMode>,
  )
}
