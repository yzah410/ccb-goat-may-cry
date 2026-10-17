/** 设置页「标签分档」：看当前公式和 4 档、重新选公式、手动改分档、恢复默认。 */
import { useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { confirm } from '@/components/ui/Confirm'
import { Field, Input } from '@/components/ui/Input'
import { toast } from '@/components/ui/Toast'
import { errorText } from '@/lib/apiClient'
import { IconPencil, IconRotate, IconSparkles } from '@/lib/icons'
import { sameTiers, TIER_KEYS, TIER_LABEL, useSaveTiers, useTiers, type Tiers, type TiersResp } from './api'
import { useFormulaWizard } from './store'

export function TiersCard() {
  const q = useTiers()
  const [editing, setEditing] = useState(false)
  return (
    <Card>
      <CardHeader
        title="标签分档"
        description="分档决定导出的导图怎么分岔、方案库里导图的标签怎么排、候选卡片上哪些标签加粗。"
      />
      <CardBody className="flex flex-col gap-4">
        {q.isPending ? (
          <p className="text-sm text-fg-3">读取中…</p>
        ) : q.isError ? (
          <p className="text-sm text-danger-fg">读不到分档：{errorText(q.error)}。后端可能是更新代码之前启动的：关掉后端和前端窗口，重新运行启动脚本。</p>
        ) : editing ? (
          <TiersEditor data={q.data} onDone={() => setEditing(false)} />
        ) : (
          <TiersView data={q.data} onEdit={() => setEditing(true)} />
        )}
      </CardBody>
    </Card>
  )
}

function TiersView({ data, onEdit }: { data: TiersResp; onEdit: () => void }) {
  const save = useSaveTiers()
  const isDefault = sameTiers(data.tiers, data.defaults)
  const restore = async () => {
    if (!(await confirm({ title: '恢复默认分档？', description: '公式也会清掉。以后可以再选。', confirmLabel: '恢复默认', tone: 'danger' }))) return
    try {
      await save.mutateAsync({ formula: null, tiers: data.defaults })
      toast.success('恢复默认分档了')
    } catch (e) {
      toast.error('没存上', { description: errorText(e) })
    }
  }
  return (
    <>
      {data.error && <p className="text-sm text-warning-fg">{data.error}</p>}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="text-fg-2">公式：</span>
        <span className="text-fg-1">
          {data.formula ? data.formula.chars.map((c) => c.name).join(' + ') : data.configured ? '没选（用默认分档）' : '还没选'}
        </span>
        {isDefault && <Badge size="sm">默认分档</Badge>}
      </div>
      <div className="flex flex-col gap-2.5">
        {TIER_KEYS.map((k) => (
          <div key={k} className="flex flex-col gap-1">
            <span className="text-xs text-fg-2">
              {TIER_LABEL[k]} · {data.tiers[k].length ? `${data.tiers[k].length} 个` : '空'}
            </span>
            {data.tiers[k].length ? (
              <div className="flex flex-wrap gap-1">
                {data.tiers[k].map((t) => (
                  <Badge key={t} size="sm" tone={k === 'G_1' ? 'primary' : 'neutral'}>
                    {t}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<IconSparkles />} onClick={() => useFormulaWizard.getState().show('settings')}>
          重新选公式
        </Button>
        <Button variant="secondary" icon={<IconPencil />} onClick={onEdit}>
          手动改分档
        </Button>
        {!(isDefault && !data.formula) && (
          <Button variant="danger-ghost" icon={<IconRotate />} loading={save.isPending} onClick={() => void restore()}>
            恢复默认分档
          </Button>
        )}
      </div>
    </>
  )
}

/** 空格、逗号、顿号都能分隔 */
function splitTags(s: string): string[] {
  const out: string[] = []
  for (const t of s.split(/[\s,，、]+/)) if (t && !out.includes(t)) out.push(t)
  return out
}

function TiersEditor({ data, onDone }: { data: TiersResp; onDone: () => void }) {
  const save = useSaveTiers()
  const [text, setText] = useState<Record<string, string>>(() =>
    Object.fromEntries(TIER_KEYS.map((k) => [k, data.tiers[k].join(' ')])),
  )
  const submit = async () => {
    const tiers = Object.fromEntries(TIER_KEYS.map((k) => [k, splitTags(text[k] ?? '')])) as Tiers
    try {
      await save.mutateAsync({ formula: data.formula, tiers })
      toast.success('分档存好了')
      onDone()
    } catch (e) {
      toast.error('没存上', { description: errorText(e) })
    }
  }
  const fixed = [...data.fixed.G_source, ...data.fixed.G_format].join(' ')
  return (
    <>
      <p className="text-sm text-fg-2">标签用空格隔开，前面的排在前面。一个标签只能放一档。来源、播放形式、制作公司是固定的组，不能放进来（例：{fixed.slice(0, 40)}…）。</p>
      {TIER_KEYS.map((k) => (
        <Field key={k} label={TIER_LABEL[k]}>
          {({ id }) => (
            <Input id={id} value={text[k] ?? ''} onChange={(e) => setText((s) => ({ ...s, [k]: e.target.value }))} placeholder="空着也可以" />
          )}
        </Field>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" loading={save.isPending} onClick={() => void submit()}>
          保存
        </Button>
        <Button variant="ghost" disabled={save.isPending} onClick={onDone}>
          取消
        </Button>
      </div>
    </>
  )
}
