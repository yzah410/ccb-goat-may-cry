import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { EmptyState, ErrorState, Loading } from '@/components/data-display/Misc'
import { useShellNav } from '@/app/shell/nav'
import { useClassicStatus } from './api'

/**
 * 经典工作台的页面（/classic、/candidates）外面包一层：
 * 后端装了经典工作台数据才显示页面；没装时说明原因，其他页面不受影响。
 */
export function ClassicGate({ children }: { children: ReactNode }) {
  const nav = useShellNav()
  const q = useClassicStatus()
  if (q.isPending) return <Loading label="正在检查经典工作台数据…" className="py-24" />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />
  if (q.data.available) return <>{children}</>
  return (
    <EmptyState
      kind="data"
      size="lg"
      title="没有安装经典工作台数据"
      description={
        <>
          这台后端没有加载经典工作台数据，所以经典工作台用不了（工作台和其他页面不受影响）。
          在 Releases 页面下载经典工作台数据包，解压到仓库的 <code className="font-mono">data/</code> 文件夹（会得到 <code className="font-mono">data/classic/</code>），重启后端就能用，详见仓库里 <code className="font-mono">docs/legacy.md</code> 的「经典工作台」一节。
        </>
      }
      action={
        <Button variant="secondary" onClick={() => nav.go('workbench')}>
          回工作台
        </Button>
      }
    />
  )
}
