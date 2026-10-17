import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Tooltip } from '@/components/ui/Overlay'
import { StatTile } from '@/components/data-display/StatTile'
import { ErrorState, Skeleton } from '@/components/data-display/Misc'
import { IconFile, IconFilm, IconFolderOpen, IconServer, IconUsers } from '@/lib/icons'
import { fmtBytes, fmtDateTime, fmtInt, relativeTime } from '@/lib/format'
import { cn } from '@/lib/cn'
import { usePlansList } from '@/features/plans/hooks'
import { useClassicCounts, useClassicMeta, useClassicStatus } from './api'

/** 数据页里「经典工作台用的数据」一节：装了经典工作台数据时显示数据量和文件新鲜度，没装时说明怎么装 */
export function ClassicDataSection() {
  const status = useClassicStatus()
  if (status.data?.available) return <ClassicDataLoaded />
  if (!status.data) return null
  return (
    <>
      <h2 className="mt-4 text-lg text-fg-1">经典工作台用的数据</h2>
      <Card>
        <CardHeader icon={<IconFile />} title="没有安装经典工作台数据" description="经典工作台读这份数据；没有时导航里看不到它的入口，工作台和其他页面不受影响。" />
        <CardBody className="flex flex-col gap-2 text-sm leading-body text-fg-2">
          <p>
            要用经典工作台：在 Releases 页面下载经典工作台数据包，解压到仓库的 <code className="font-mono">data/</code> 文件夹（会得到 <code className="font-mono">data/classic/</code>），再重启后端。
            装好后这里会显示作品数、角色数和各数据文件的更新时间。
          </p>
          {status.data.reason && <p className="text-xs text-fg-3">后端的检查结果：{status.data.reason}</p>}
        </CardBody>
      </Card>
    </>
  )
}

function ClassicDataLoaded() {
  const counts = useClassicCounts()
  const meta = useClassicMeta()
  const plans = usePlansList()
  const m = meta.data
  const c = counts.data
  return (
    <>
      <h2 className="mt-4 text-lg text-fg-1">经典工作台用的数据</h2>
      {counts.isError ? (
        <Card>
          <ErrorState error={counts.error} onRetry={() => void counts.refetch()} />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
          <StatTile icon={<IconFilm />} label="动画作品" value={c ? fmtInt(c.works) : '—'} loading={counts.isPending} hint="已去掉 NSFW 和没年份的" />
          <StatTile icon={<IconUsers />} label="角色" value={c ? fmtInt(c.chars) : '—'} loading={counts.isPending} hint="在这些作品里当过主角或配角" />
          <StatTile
            icon={<IconServer />}
            label="经典工作台数据"
            value={c?.ready ? '已加载' : counts.isPending ? '…' : '没加载好'}
            tone={c?.ready ? 'success' : 'default'}
            loading={counts.isPending}
            hint="后端启动时一次性加载完"
          />
          <StatTile
            icon={<IconFolderOpen />}
            label="保存的方案"
            value={m?.plans_count != null ? fmtInt(m.plans_count) : plans.data ? fmtInt(plans.data.plans.length) : '—'}
            loading={plans.isPending && !m}
            hint="data/plans/ 里的文件"
          />
        </div>
      )}

      <Card>
        <CardHeader icon={<IconFile />} title="数据新鲜度" description="后端读的经典工作台数据文件（data/classic/）。鼠标放在文件名上能看到路径。" />
        <CardBody>
          {meta.isPending ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : meta.isError ? (
            <ErrorState error={meta.error} size="sm" onRetry={() => void meta.refetch()} />
          ) : m ? (
            <div className="flex flex-col gap-5">
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="bg-bg-elevated text-left text-xs text-fg-3">
                    <tr>
                      <th className="px-3 py-2 font-medium">文件</th>
                      <th className="px-3 py-2 text-right font-medium">大小</th>
                      <th className="px-3 py-2 font-medium">最后更新</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.files.map((f) => (
                      <tr key={f.key} className="border-t border-border">
                        <td className="px-3 py-2">
                          <Tooltip content={f.path}>
                            <span className={cn('font-mono text-xs', f.exists ? 'text-fg-1' : f.required === false ? 'text-fg-3' : 'text-danger-fg')}>
                              {f.name}
                              {!f.exists && (f.required === false ? '（没提供，可选）' : '（缺失）')}
                            </span>
                          </Tooltip>
                        </td>
                        <td className="tabular px-3 py-2 text-right text-fg-2">{f.size != null ? fmtBytes(f.size) : '—'}</td>
                        <td className="px-3 py-2 text-fg-2">
                          {f.mtime ? (
                            <>
                              {fmtDateTime(f.mtime * 1000)} <span className="text-xs text-fg-3">（{relativeTime(f.mtime * 1000)}）</span>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </CardBody>
      </Card>
    </>
  )
}
