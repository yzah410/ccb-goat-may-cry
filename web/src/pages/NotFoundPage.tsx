import { useShellNav } from '@/app/shell/nav'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/data-display/Misc'

export default function NotFoundPage() {
  const nav = useShellNav()
  return (
    <EmptyState
      kind="not-found"
      size="lg"
      className="min-h-[60vh]"
      title="没有这个页面"
      description="可能是地址打错了。从下面回到常用的地方："
      action={
        <>
          <Button variant="primary" onClick={() => nav.go('workbench')}>
            回工作台
          </Button>
          <Button variant="secondary" onClick={() => nav.go('pool')}>
            去候选池
          </Button>
        </>
      }
    />
  )
}
