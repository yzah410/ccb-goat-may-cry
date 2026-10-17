/**
 * 数据页的「出题器数据库」（GET /v2/meta）：数据量、dump 版本、构建时间、作品标签覆盖。
 */
import type { ReactNode } from 'react'
import { copyText } from '@/lib/clipboard'
import { fmtDateTime, fmtInt, relativeTime } from '@/lib/format'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { toast } from '@/components/ui/Toast'
import { StatTile } from '@/components/data-display/StatTile'
import { ErrorState, KeyValue, Skeleton } from '@/components/data-display/Misc'
import { IconCopy, IconDatabase, IconFilm, IconTags, IconUsers } from '@/lib/icons'
import { isV2Missing, useV2Meta } from '../hooks'

const MODE_LABEL: Record<string, string> = { anime: '动画', game: '游戏', book: '书籍', real: '三次元', all: '全部' }

type Obj = Record<string, unknown>
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-medium text-fg-1">{title}</h4>
      {children}
    </div>
  )
}

export function V2DbCard() {
  const q = useV2Meta()
  const db = q.data?.db ?? null
  const dbError = (q.data as unknown as Obj | undefined)?.db_error
  const status = (q.data as unknown as Obj | undefined)?.status as Obj | undefined

  if (q.isPending)
    return (
      <Card>
        <CardHeader icon={<IconDatabase />} title="出题器数据库（工作台 / 问数据用的）" />
        <CardBody className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-32 w-full" />
        </CardBody>
      </Card>
    )
  if (q.isError)
    return (
      <Card>
        <CardHeader icon={<IconDatabase />} title="出题器数据库（工作台 / 问数据用的）" />
        <CardBody>
          {isV2Missing(q.error) ? (
            <p className="text-sm text-fg-2">后端没有出题器接口（/v2）：后端可能是更新代码之前启动的。关掉后端和前端窗口，重新运行启动脚本（Windows：start-all.bat；macOS / Linux：start-all.sh）。</p>
          ) : (
            <ErrorState error={q.error} size="sm" onRetry={() => void q.refetch()} />
          )}
        </CardBody>
      </Card>
    )
  if (!db)
    return (
      <Card>
        <CardHeader icon={<IconDatabase />} title="出题器数据库（工作台 / 问数据用的）" />
        <CardBody>
          <p className="text-sm text-danger-fg">没找到出题器数据库{typeof dbError === 'string' ? `：${dbError}` : ''}</p>
          <p className="mt-1 text-xs text-fg-3">下载和放置方法见 README 的「放数据库」。</p>
        </CardBody>
      </Card>
    )

  const counts = (db.counts ?? {}) as Record<string, unknown>
  const api = num(db.tags_api_subjects) ?? 0
  const dump = num(db.tags_dump_subjects) ?? 0
  const cover = api + dump > 0 ? api / (api + dump) : 0
  const loaded = Array.isArray(status?.loaded_modes) ? (status!.loaded_modes as string[]) : []

  return (
    <Card>
      <CardHeader
        icon={<IconDatabase />}
        title="出题器数据库（工作台 / 问数据用的）"
        description="角色、作品、完整标签和每种模式的游戏格子数据都在这一个 SQLite 文件里。"
      />
      <CardBody className="flex flex-col gap-5">
        <div className="grid grid-cols-1 gap-3 @2xl/main:grid-cols-3">
          <StatTile icon={<IconUsers />} label="角色" value={fmtInt(num(counts.characters))} hint="在任意非 NSFW 条目里当过主角或配角" />
          <StatTile
            icon={<IconFilm />}
            label="条目"
            value={fmtInt(num(counts.subjects))}
            hint={num(counts.subjects_with_characters) != null ? `有角色的 ${fmtInt(num(counts.subjects_with_characters))} 部` : undefined}
          />
          <StatTile icon={<IconTags />} label="有完整标签的条目" value={fmtInt(api)} hint={`另有 ${fmtInt(dump)} 部只有 dump 前 11 个标签`} />
        </div>

        <KeyValue
          items={[
            {
              label: '库文件',
              value: (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <code className="font-mono text-xs">{String(db.path ?? '—')}</code>
                  {db.path && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="复制路径"
                      onClick={async () => {
                        if (await copyText(String(db.path))) toast.success('路径已复制', { id: 'copy' })
                      }}
                    >
                      <IconCopy />
                    </Button>
                  )}
                </span>
              ),
            },
            { label: 'dump 版本', value: String(db.dump_name ?? '—') },
            { label: '构建时间', value: db.built_at ? fmtDateTime(String(db.built_at)) : '—', hint: db.built_at ? relativeTime(String(db.built_at)) : undefined },
            { label: '「未上映」按哪天算', value: String(db.today ?? '—') },
            { label: '后端已载入的模式', value: loaded.length ? loaded.map((m) => MODE_LABEL[m] ?? m).join('、') : '—', hint: '第一次用某个模式时才载入' },
          ]}
        />

        <Section title="作品标签覆盖">
          <div className="flex flex-col gap-1.5">
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-3" role="img" aria-label={`完整标签 ${api} 部，只有 dump 前 11 个的 ${dump} 部`}>
              <span className="h-full rounded-l-full" style={{ width: `${cover * 100}%`, background: 'var(--chart-1)' }} />
            </div>
            <p className="text-xs text-fg-2">
              <span className="font-medium text-fg-1">{fmtInt(api)}</span> 部有完整标签（接口取的，最多 30 个）；
              <span className="font-medium text-fg-1">{fmtInt(dump)}</span> 部只有 dump 公开的前 11 个。
              统计「某个标签在多少部作品出现」这类问题时，只有前一类是完整的。
            </p>
          </div>
        </Section>
      </CardBody>
    </Card>
  )
}
