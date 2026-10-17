import { Suspense } from 'react'
import { createBrowserRouter } from 'react-router'
import { Loading } from '@/components/data-display/Misc'
import { PageById, RootLayout, RouteError } from './RootLayout'
import { ComparePage, SoloFullPage } from './pages'
import { SOLO_FULL_PATH } from './routes'

export const router = createBrowserRouter([
  {
    // 分屏对比：整屏两格，每格一套独立的外壳 + 主题，不套在普通外壳里
    path: '/themes/compare',
    errorElement: <RouteError />,
    element: (
      <Suspense fallback={<Loading label="正在准备对比…" className="h-dvh" />}>
        <ComparePage />
      </Suspense>
    ),
  },
  {
    // 单人猜猜呗独立页面：没有侧栏和外框，占满整个窗口（适合单独开一个标签页玩）
    path: SOLO_FULL_PATH,
    errorElement: <RouteError />,
    element: (
      <Suspense fallback={<Loading label="正在打开单人猜猜呗…" className="h-dvh" />}>
        <SoloFullPage />
      </Suspense>
    ),
  },
  {
    path: '/',
    element: <RootLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <PageById id="workbench" /> },
      { path: 'classic', element: <PageById id="classic" /> },
      { path: 'pool', element: <PageById id="pool" /> },
      { path: 'ask', element: <PageById id="ask" /> },
      { path: 'lists', element: <PageById id="lists" /> },
      { path: 'candidates', element: <PageById id="candidates" /> },
      { path: 'plans', element: <PageById id="plans" /> },
      { path: 'clicker', element: <PageById id="clicker" /> },
      { path: 'solo', element: <PageById id="solo" /> },
      { path: 'canvas', element: <PageById id="canvas" /> },
      { path: 'data', element: <PageById id="data" /> },
      { path: 'settings', element: <PageById id="settings" /> },
      { path: 'themes', element: <PageById id="themes" /> },
      { path: '*', element: <PageById id="not-found" /> },
    ],
  },
])
