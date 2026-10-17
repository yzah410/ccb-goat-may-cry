/**
 * 经典工作台（/classic）：页面主体是 pages/workbench/WorkbenchPage.tsx，
 * 顶部有一条提示，说明它和工作台的关系。方案存在 data/plans/（和工作台的 data/plans_v2/ 分开）。
 */
import { useShellNav } from '@/app/shell/nav'
import { IconArrowRight, IconLayers } from '@/lib/icons'
import WorkbenchPage from '@/pages/workbench/WorkbenchPage'

export default function ClassicWorkbenchPage() {
  const nav = useShellNav()
  return (
    <>
      <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-bg-elevated px-4 py-2 text-sm text-fg-2">
        <IconLayers className="size-4 shrink-0 text-fg-3" aria-hidden />
        <span className="font-medium text-fg-1">经典工作台</span>
        <span>按顺序组块：从上到下依次纳入 / 排除，顺序会影响结果。方案和工作台分开保存。</span>
        <button type="button" onClick={() => nav.go('workbench')} className="inline-flex items-center gap-1 text-link hover:underline">
          去工作台 <IconArrowRight className="size-3.5" />
        </button>
      </div>
      <WorkbenchPage />
    </>
  )
}
