/**
 * 「载入全部样例导图（还有 N 张）」按钮：方案库里还有没载入的样例导图时才显示，全部载入后不再显示。
 * 点了把剩下的都复制进方案库（库里已有同 id 的图跳过，不覆盖），再刷新列表。
 */
import { Button } from '@/components/ui/Button'
import { IconLibrary } from '@/lib/icons'
import { useLoadSamples, useMapSamples } from '../hooks'

/** 只管显示：remaining 是 0、或还不知道（还没读到、读取失败）时不显示 */
export function SampleLoadButton({
  remaining,
  loading,
  onLoad,
  className,
}: {
  remaining: number | undefined
  loading: boolean
  onLoad: () => void
  className?: string
}) {
  if (!remaining || remaining <= 0) return null
  return (
    <Button variant="secondary" size="sm" icon={<IconLibrary />} loading={loading} onClick={onLoad} className={className} data-load-samples="">
      {`载入全部样例导图（还有 ${remaining} 张）`}
    </Button>
  )
}

export function SampleLoader({ className }: { className?: string }) {
  const samples = useMapSamples()
  const load = useLoadSamples()
  return <SampleLoadButton remaining={samples.data?.remaining} loading={load.isPending} onLoad={() => load.mutate()} className={className} />
}
