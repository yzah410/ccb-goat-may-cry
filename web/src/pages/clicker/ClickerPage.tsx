import { PageHeader } from '@/app/shell/PageHeader'
import { CurrentPickCard } from '@/app/shell/CurrentPick'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { IconClicker, IconScanSearch } from '@/lib/icons'
import { relativeTime } from '@/lib/format'
import { useClickerStatus } from '@/features/clicker/hooks'
import { useClickerTask } from '@/features/clicker/store'
import { AutoModeCard, ConnectionCard, LocateResultView, LogPanel } from '@/features/clicker/components/ClickerPanels'

export default function ClickerPage() {
  const status = useClickerStatus({ idleMs: 3000 })
  const view = status.data
  const dry = useClickerTask((s) => s.lastDryRun)
  const outcome = useClickerTask((s) => s.lastOutcome)

  return (
    <>
      <PageHeader
        route="clicker"
        title="自动点击"
        icon={<IconClicker />}
        description="把「当前题目」自动填进猜猜呗的出题弹窗（房主出题）。也可以开自动模式，让后端按方案一轮一轮出题。"
      >
        {outcome && (
          <p className={`mt-2 text-sm ${outcome.ok ? 'text-success-fg' : 'text-danger-fg'}`}>
            上一次发送（{outcome.charName}，{relativeTime(outcome.at)}）：{outcome.ok ? '成功' : '没成功'} —— {outcome.message}
          </p>
        )}
      </PageHeader>

      <div className="grid items-start gap-4 @4xl/main:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <CurrentPickCard />
        <ConnectionCard view={view} />
        {dry && (
          <Card className="@4xl/main:col-span-2">
            <CardHeader
              icon={<IconScanSearch />}
              title={`只定位不点击：${dry.charName}`}
              description={`${relativeTime(dry.at)}验证的。没有真的点，只是看它在搜索结果里的位置。`}
            />
            <CardBody>
              <LocateResultView r={dry.result} />
            </CardBody>
          </Card>
        )}
        <AutoModeCard view={view} className="@4xl/main:col-span-2" />
        <LogPanel view={view} className="@4xl/main:col-span-2" />
      </div>
    </>
  )
}
