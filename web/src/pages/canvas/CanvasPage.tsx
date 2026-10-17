import { PageHeader } from '@/app/shell/PageHeader'
import { useShellNav } from '@/app/shell/nav'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { SegmentedControl, Tabs, TabsContent, TabsList } from '@/components/ui/Controls'
import { StatTile } from '@/components/data-display/StatTile'
import { KeyValue } from '@/components/data-display/Misc'
import { IconCanvas, IconDownload, IconFilePlus, IconInfo, IconLibrary, IconUsers } from '@/lib/icons'
import { errorText } from '@/lib/apiClient'
import { fmtBytes, fmtInt, fmtMs, relativeTime } from '@/lib/format'
import { useDraft } from '@/features/blocks/store'
import { useConfigPayload, usePreviewAction } from '@/features/candidates/hooks'
import { useResults } from '@/features/candidates/store'
import { downloadBlob, useGenerateCanvas, useGenerateCanvasV2, type CanvasResult } from '@/features/canvas/api'
import { useCanvasSource, useCanvasTab, type CanvasTab } from '@/features/canvas/store'
import { useClassicAvailable } from '@/features/classic/api'
import { MapLibrary } from '@/features/tagnote/components/MapLibrary'
import { NewTagNote } from '@/features/tagnote/components/NewTagNote'
import { useWb2 } from '@/features/workbench2/store'
import { useEvaluate } from '@/features/workbench2/hooks'
import { MODE_BY_ID, poolKey } from '@/features/workbench2/spec'

function ExportResult({ result }: { result: CanvasResult }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 @xl/main:grid-cols-4">
        <StatTile size="sm" label="角色卡" value={fmtInt(result.characters)} />
        <StatTile size="sm" label="节点 / 连线" value={`${fmtInt(result.nodes)} / ${fmtInt(result.edges)}`} />
        <StatTile size="sm" label="文件大小" value={fmtBytes(result.size)} />
        <StatTile size="sm" label="用时" value={fmtMs(result.elapsedMs)} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-fg-2">
        已下载 <code className="rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{result.fileName}</code>
        <Button size="sm" variant="ghost" icon={<IconDownload />} onClick={() => downloadBlob(result.blob, result.fileName)}>再下载一次</Button>
      </div>
    </div>
  )
}

function V2Export() {
  const nav = useShellNav()
  const spec = useWb2((s) => s.spec)
  const planName = useWb2((s) => s.planName)
  const ev = useEvaluate()
  const gen = useGenerateCanvasV2()
  const errors = !ev.stale ? (ev.data?.errors ?? []) : []
  const empty = !ev.stale && ev.data?.total === 0
  const changed = !!gen.data && !!gen.variables && poolKey(gen.variables) !== poolKey(spec)
  return (
    <Card>
      <CardHeader title="工作台的筛选结果" description="导出当前草稿的整个候选池，包括未保存的改动。候选池页的搜索和分页不影响导出。" />
      <CardBody className="flex flex-col gap-5">
        <KeyValue items={[
          { label: '方案', value: planName ?? '未命名（没保存也能导）' },
          { label: '对局设置', value: `${MODE_BY_ID.get(spec.game.mode)?.label ?? spec.game.mode}模式 · 作品标签数 ${spec.game.tag_count}` },
          { label: '范围', value: `启用 ${spec.ranges.filter((r) => r.enabled).length} 个纳入范围 / ${spec.excludes.filter((r) => r.enabled).length} 个排除项` },
          { label: '候选人数', value: ev.stale || !ev.data ? '正在计算当前方案…' : `${fmtInt(ev.data.total)} 人` },
        ]} />
        {!!ev.error && <p className="text-sm text-danger-fg">候选人数没算出来：{errorText(ev.error)}</p>}
        {errors.length > 0 && <p className="text-sm text-danger-fg">先修好方案中没生效的部分：{errors.map((e) => e.message).join('；')}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" icon={<IconDownload />} loading={gen.isPending} disabled={empty || errors.length > 0} onClick={() => gen.mutate(useWb2.getState().spec)}>
            生成并下载 .canvas
          </Button>
          <Button variant="ghost" onClick={() => nav.go('workbench')}>回工作台改筛选</Button>
        </div>
        {empty && <p className="text-sm text-fg-3">候选池为空，先放宽筛选范围。</p>}
        {gen.isPending && <p className="text-sm text-fg-3">正在生成导图，候选较多时需要稍等…</p>}
        {changed && <p className="text-sm text-warning-fg">方案已改动，下面是上一次导出的文件；重新生成会使用当前方案。</p>}
        {gen.data && <ExportResult result={gen.data} />}
      </CardBody>
    </Card>
  )
}

function ClassicExport() {
  const nav = useShellNav()
  const { payload, fp } = useConfigPayload()
  const gen = useGenerateCanvas()
  const planName = useDraft((s) => s.planName)
  const blocks = useDraft((s) => s.blocks)
  const extra = useDraft((s) => s.includeExtraWorkTags)
  const pv = useResults((s) => s.preview)
  const preview = usePreviewAction()
  const fresh = pv && pv.fp === fp
  return (
    <Card>
      <CardHeader title="经典工作台的筛选结果" description="导出整个候选池，使用经典工作台的组块与额外标签开关。" />
      <CardBody className="flex flex-col gap-5">
        <KeyValue items={[
          { label: '方案', value: planName ?? '未命名（没保存也能导）' },
          { label: '组块', value: `${blocks.length} 个（启用的：纳入 ${blocks.filter((b) => b.enabled && b.color === 'red').length} / 排除 ${blocks.filter((b) => b.enabled && b.color === 'blue').length}）` },
          { label: '额外作品标签', value: extra ? '算进来（影响导图分组）' : '不算' },
          { label: '候选人数', value: fresh ? `${fmtInt(pv.data.total_candidates)} 人（${relativeTime(pv.at)}预览的）` : (
            <Button size="sm" variant="ghost" icon={<IconUsers />} loading={preview.isPending} onClick={preview.run}>先看看有多少人</Button>
          ) },
        ]} />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" icon={<IconDownload />} loading={gen.isPending} onClick={() => gen.mutate(payload)}>生成并下载 .canvas</Button>
          <Button variant="ghost" onClick={() => nav.go('classic')}>回经典工作台改组块</Button>
        </div>
        {gen.isPending && <p className="text-sm text-fg-3">正在生成导图，候选较多时需要稍等…</p>}
        {gen.data && <ExportResult result={gen.data} />}
      </CardBody>
    </Card>
  )
}

/** 「导出 .canvas」标签页的内容 */
function CanvasExport() {
  // 装了经典工作台数据时才能选经典工作台；没装就只有工作台
  const classicAvailable = useClassicAvailable()
  const picked = useCanvasSource((s) => s.source)
  const setSource = useCanvasSource((s) => s.setSource)
  const source = classicAvailable ? picked : 'v2'
  return (
    <>
      {classicAvailable && (
        <SegmentedControl className="mb-4" value={source} onChange={setSource} aria-label="导出哪个工作台的结果"
          options={[{ value: 'v2', label: '工作台' }, { value: 'classic', label: '经典工作台' }]} />
      )}
      <div className="grid items-start gap-4 @4xl/main:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {source === 'v2' ? <V2Export /> : <ClassicExport />}
        <Card>
          <CardHeader icon={<IconInfo />} title="导图里有什么" />
          <CardBody>
            <ul className="flex list-disc flex-col gap-2.5 pl-5 text-sm leading-body text-fg-2">
              <li>按固定的标签分类顺序和分岔规则排，角色会去重（规则见后面几条）。</li>
              <li>树状布局。作品名直接作为双链，年份和评分用和作品名一样大的字；标题超过两行时，年份评分接着标题排。</li>
              <li><strong className="text-fg-1">同一部最早登场作品只保留热度最高的一个角色</strong>，因此角色卡数量可能少于候选人数。</li>
              <li>当前模式没有有效登场作品资料的角色无法形成作品卡，不会画入导图。</li>
              <li>按当前对局模式和作品标签数取数据，并补全未在分岔中展示的播放形式和原作来源。{classicAvailable && '经典工作台的结果不按对局模式取数据，用「额外作品标签」开关决定要不要算上额外标签。'}</li>
              <li>把下载的 .canvas 文件放进 Obsidian 仓库，双击就能打开。</li>
              <li>末端分类依据、尚未展示的播放形式和来源写在入线文字上；仅为 TV 的入线文字省略，TV-OVA 等组合保留。其余需补全的标签放在作品右侧的小格。</li>
              <li>分叉的最上、最下连线从上下端出发；超过 6 条时上 2、下 2、其余从右侧中间出发。颜色按主分支区分。</li>
            </ul>
          </CardBody>
        </Card>
      </div>
    </>
  )
}

export default function CanvasPage() {
  const tab = useCanvasTab((s) => s.tab)
  const setTab = useCanvasTab((s) => s.setTab)
  return (
    <>
      <PageHeader route="canvas" title="导图导出" icon={<IconCanvas />} description="把当前筛选的全部候选导出成 Obsidian .canvas，按标签分类规则整理成思维导图。" />
      <Tabs value={tab} onValueChange={(v) => setTab(v as CanvasTab)}>
        <TabsList
          className="mb-4 w-full"
          items={[
            { value: 'library', label: '方案库', icon: <IconLibrary /> },
            { value: 'new', label: '新建标签笔记', icon: <IconFilePlus /> },
            { value: 'export', label: '导出 .canvas', icon: <IconDownload /> },
          ]}
        />
        <TabsContent value="library">
          <MapLibrary />
        </TabsContent>
        <TabsContent value="new">
          <NewTagNote />
        </TabsContent>
        <TabsContent value="export">
          <CanvasExport />
        </TabsContent>
      </Tabs>
    </>
  )
}
