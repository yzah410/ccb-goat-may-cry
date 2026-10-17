/**
 * 「新建标签笔记」标签：用工作台的当前方案生成标签笔记 → 预览六视图 → 存进方案库 / 下载 Obsidian 笔记。
 */
import { useRef } from 'react'
import { useShellNav } from '@/app/shell/nav'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { SegmentedControl } from '@/components/ui/Controls'
import { Field, Input } from '@/components/ui/Input'
import { toast } from '@/components/ui/Toast'
import { KeyValue } from '@/components/data-display/Misc'
import { IconDownload, IconFilePlus, IconRefresh, IconSave } from '@/lib/icons'
import { errorText } from '@/lib/apiClient'
import { cn } from '@/lib/cn'
import { fmtInt } from '@/lib/format'
import { useCanvasTab } from '@/features/canvas/store'
import { useWb2 } from '@/features/workbench2/store'
import { useEvaluate } from '@/features/workbench2/hooks'
import { MODE_BY_ID, poolKey } from '@/features/workbench2/spec'
import { generateErrorInfo } from '../api'
import { useCreateMap, useDownloadDataNote, useGenerateTagNote } from '../hooks'
import { CROWDED_WORKS, TAG_MODE_TEXT, UNTITLED, generateErrorText, withTitleAndLayout } from '../library'
import { useTagNoteLocal, useTagNotePreview } from '../store'
import { wsActions } from '../workspace/actions'
import { TagNoteView, type TagNoteViewHandle } from './TagNoteView'

export function NewTagNote() {
  const nav = useShellNav()
  const spec = useWb2((s) => s.spec)
  const planName = useWb2((s) => s.planName)
  const ev = useEvaluate()
  const tagMode = useTagNoteLocal((s) => s.tagMode)
  const setTagMode = useTagNoteLocal((s) => s.setTagMode)
  const setTab = useCanvasTab((s) => s.setTab)
  const preview = useTagNotePreview((s) => s.preview)
  const title = useTagNotePreview((s) => s.title)
  const setTitle = useTagNotePreview((s) => s.setTitle)
  const setPreview = useTagNotePreview((s) => s.setPreview)
  const clearPreview = useTagNotePreview((s) => s.clear)
  const gen = useGenerateTagNote()
  const create = useCreateMap()
  const download = useDownloadDataNote()
  const viewRef = useRef<TagNoteViewHandle>(null)

  const specErrors = !ev.stale ? (ev.data?.errors ?? []) : []
  const empty = !ev.stale && ev.data?.total === 0
  const genError = gen.error ? generateErrorInfo(gen.error) : null
  const tooMany = genError?.code === 'too_many_works'
  const stale = !!preview && (preview.poolKey !== poolKey(spec) || preview.tagMode !== tagMode)
  const nWorks = preview?.data.works.length ?? 0
  const cleanTitle = title.trim()

  const run = () => {
    const s = useWb2.getState()
    const name = s.planName ?? UNTITLED
    const mode = useTagNoteLocal.getState().tagMode
    gen.mutate(
      { spec: s.spec, title: name, tag_mode: mode },
      { onSuccess: (data) => setPreview({ data, poolKey: poolKey(s.spec), tagMode: mode }, data.collection?.title || name) },
    )
  }

  const finalData = () => {
    if (!preview) return null
    return withTitleAndLayout(preview.data, cleanTitle || preview.data.collection?.title || UNTITLED, viewRef.current?.getLayoutCache())
  }

  const save = async () => {
    const data = finalData()
    if (!data) return
    try {
      const summary = await create.mutateAsync(data)
      // 在方案库的当前格新开一个标签看它（不顶掉正开着的图）
      wsActions.open(summary.id, { newTab: true })
      clearPreview()
      setTab('library')
      toast.success('已存进方案库', { description: summary.title })
    } catch {
      // 提示已由 useCreateMap 弹出
    }
  }

  return (
    <div className="flex flex-col gap-4" data-new-tagnote="">
      <Card>
        <CardHeader
          title="用当前方案生成标签笔记"
          description="把工作台当前方案的候选角色按作品合并，生成六种视图。生成后可以存进方案库，或下载成 Obsidian 笔记。"
        />
        <CardBody className="flex flex-col gap-5">
          <KeyValue
            items={[
              { label: '方案', value: planName ?? '未命名（没保存也能生成）' },
              { label: '对局设置', value: `${MODE_BY_ID.get(spec.game.mode)?.label ?? spec.game.mode}模式 · 作品标签数 ${spec.game.tag_count}` },
              { label: '候选人数', value: ev.stale || !ev.data ? '正在计算当前方案…' : `${fmtInt(ev.data.total)} 人` },
            ]}
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-tag-mode="">
            <SegmentedControl
              size="sm"
              value={tagMode}
              onChange={setTagMode}
              aria-label="标签口径"
              options={[
                { value: 'map', label: '导图里的标签' },
                { value: 'full', label: '全部标签' },
              ]}
            />
            <span className="text-sm text-fg-3">{TAG_MODE_TEXT[tagMode]}</span>
          </div>
          {!!ev.error && <p className="text-sm text-danger-fg">候选人数没算出来：{errorText(ev.error)}</p>}
          {specErrors.length > 0 && <p className="text-sm text-danger-fg">先修好方案中没生效的部分：{specErrors.map((e) => e.message).join('；')}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant={preview ? 'secondary' : 'primary'}
              size={preview ? 'md' : 'lg'}
              icon={preview ? <IconRefresh /> : <IconFilePlus />}
              loading={gen.isPending}
              disabled={empty || specErrors.length > 0}
              onClick={run}
            >
              {preview ? '重新生成' : '生成标签笔记'}
            </Button>
            <Button variant="ghost" onClick={() => nav.go('workbench')}>
              回工作台改筛选
            </Button>
          </div>
          {empty && <p className="text-sm text-fg-3">候选池为空，先放宽筛选范围。</p>}
          {gen.isPending && <p className="text-sm text-fg-3">正在生成标签笔记，候选较多时需要稍等…</p>}
          {genError && !gen.isPending && (
            <p className={cn(tooMany ? 'text-warning-fg' : 'text-danger-fg', 'text-sm')} role="alert" data-generate-error={genError.code}>
              {generateErrorText(genError)}
            </p>
          )}
        </CardBody>
      </Card>

      {preview && (
        <section className="flex min-w-0 flex-col gap-3" aria-label="生成结果" data-tagnote-preview="">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={`存进方案库时的名字（${nWorks} 部作品）`} className="min-w-0 flex-1 basis-72">
              {({ id }) => <Input id={id} value={title} invalid={!cleanTitle} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}
            </Field>
            <Button variant="primary" icon={<IconSave />} loading={create.isPending} disabled={!cleanTitle} onClick={() => void save()}>
              存进方案库
            </Button>
            <Button
              variant="secondary"
              icon={<IconDownload />}
              loading={download.isPending}
              disabled={!cleanTitle}
              onClick={() => {
                const data = finalData()
                if (data) download.mutate(data)
              }}
            >
              下载 Obsidian 笔记
            </Button>
          </div>
          {stale && <p className="text-sm text-warning-fg">方案或标签口径已改动，下面是上一次生成的结果；重新生成会使用当前设置。</p>}
          {nWorks > CROWDED_WORKS && (
            <p className="text-sm text-fg-3" data-crowded-hint="">
              这份有 {nWorks} 部作品。作品多时画面会挤，建议 20 部以内。
            </p>
          )}
          <TagNoteView ref={viewRef} data={preview.data} dataKey={`preview|${preview.seq}`} aria-label="刚生成的标签笔记" />
        </section>
      )}
    </div>
  )
}
