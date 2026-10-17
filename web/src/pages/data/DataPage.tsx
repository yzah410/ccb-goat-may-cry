import { PageHeader } from '@/app/shell/PageHeader'
import { Button } from '@/components/ui/Button'
import { IconDatabase, IconRefresh } from '@/lib/icons'
import { useV2Meta } from '@/features/v2/hooks'
import { V2DbCard } from '@/features/v2/components/V2DbCard'
import { ClassicDataSection } from '@/features/classic/ClassicDataSection'

export default function DataPage() {
  const meta = useV2Meta()

  return (
    <>
      <PageHeader
        route="data"
        title="数据"
        icon={<IconDatabase />}
        description="出题器用的数据库：有多少数据、什么时候建的、作品标签覆盖到什么程度；经典工作台数据是否可用。"
        actions={
          <Button variant="secondary" icon={<IconRefresh />} loading={meta.isFetching} onClick={() => void meta.refetch()}>
            刷新
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        <V2DbCard />
        <ClassicDataSection />
      </div>
    </>
  )
}
