import { useEffect } from 'react'
import { PageHeader } from '@/app/shell/PageHeader'
import { useShellNav } from '@/app/shell/nav'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Overlay'
import { confirm } from '@/components/ui/Confirm'
import { toast } from '@/components/ui/Toast'
import { IconAlert, IconArrowRight, IconDice, IconFilePlus, IconFolderOpen, IconSave, IconUsers, IconWorkbench } from '@/lib/icons'
import { fmtInt } from '@/lib/format'
import { BlockList } from '@/features/blocks/components/BlockList'
import { BlockEditor } from '@/features/blocks/components/BlockEditor'
import { GlobalSettings } from '@/features/blocks/components/GlobalSettings'
import { useDraft, useIsDirty } from '@/features/blocks/store'
import { DrawPanel, PreviewPanel, WorkbenchActions } from '@/features/candidates/components/WorkbenchResults'
import { useConfigPayload, useDrawAction, usePreviewAction } from '@/features/candidates/hooks'
import { useResults } from '@/features/candidates/store'
import { usePlanDialogs, useQuickSave } from '@/features/plans/components/PlanDialogs'
import { usePrefs } from '@/features/settings/store'

/** 标题下面一行：当前方案名 + 有没有没保存的改动 + 加载时自动修正的提示 */
function PlanStatusLine() {
  const planName = useDraft((s) => s.planName)
  const warnings = useDraft((s) => s.loadWarnings)
  const dirty = useIsDirty()
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-fg-3">方案</span>
      <span className="font-medium text-fg-1">{planName ?? '未命名（还没保存过）'}</span>
      {dirty ? (
        <Badge tone="warning">
          <span className="size-1.5 rounded-full bg-warning" />
          有改动还没保存
        </Badge>
      ) : planName ? (
        <Badge tone="success">已保存</Badge>
      ) : null}
      {warnings.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className="inline-flex items-center gap-1 text-xs text-warning-fg hover:underline">
              <IconAlert className="size-3.5" />
              加载时自动修正了 {warnings.length} 处
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-96">
            <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-fg-2">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}

/** 中等宽度时放在顶部的横向操作条（宽屏时操作按钮在右栏） */
function ActionsBar() {
  const preview = usePreviewAction()
  const draw = useDrawAction()
  const nav = useShellNav()
  const pv = useResults((s) => s.preview)
  const { fp } = useConfigPayload()
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-1 px-4 py-3 shadow-1">
      <span className="mr-auto flex items-baseline gap-2 text-sm text-fg-3">
        候选
        <span className={pv && pv.fp === fp ? 'tabular text-xl font-semibold text-fg-1' : 'tabular text-xl font-semibold text-fg-3'}>
          {pv ? fmtInt(pv.data.total_candidates) : '—'}
        </span>
        人{pv && pv.fp !== fp ? '（方案改过了）' : ''}
      </span>
      <Button variant="secondary" icon={<IconUsers />} loading={preview.isPending} onClick={preview.run}>
        预览人数
      </Button>
      <Button variant="secondary" icon={<IconArrowRight />} onClick={() => nav.go('candidates')}>
        列出候选
      </Button>
      <Button variant="primary" icon={<IconDice />} loading={draw.isPending} onClick={draw.run}>
        随机抽一题
      </Button>
    </div>
  )
}

/** 设置里打开「改完组块自动预览人数」时：配置停下来 0.7 秒后自动预览一次 */
function AutoPreview() {
  const { fp } = useConfigPayload()
  const { run } = usePreviewAction()
  const lastFp = useResults((s) => s.preview?.fp)
  useEffect(() => {
    if (lastFp === fp) return
    const t = window.setTimeout(run, 700)
    return () => window.clearTimeout(t)
  }, [fp, lastFp, run])
  return null
}

/** 经典工作台的页面主体（pages/classic/ClassicWorkbenchPage.tsx 在它上方放了一条和工作台关系的提示） */
export default function WorkbenchPage() {
  const quick = useQuickSave()
  const openSaveAs = usePlanDialogs((s) => s.openSaveAs)
  const openLoad = usePlanDialogs((s) => s.openLoad)
  const resetDraft = useDraft((s) => s.resetDraft)
  const dirty = useIsDirty()
  const autoPreview = usePrefs((s) => s.autoPreview)

  const onNew = async () => {
    if (dirty) {
      const ok = await confirm({
        title: '新建一个空方案？',
        description: '当前方案有改动还没保存，新建会把它们丢掉。',
        confirmLabel: '丢掉改动并新建',
        tone: 'danger',
      })
      if (!ok) return
    }
    resetDraft()
    toast.info('新建了一个方案', { description: '里面默认有一个「作品范围」组块' })
  }

  return (
    <>
      <PageHeader
        route="classic"
        title="经典工作台"
        icon={<IconWorkbench />}
        description="左边列组块（从上到下依次纳入 / 排除），中间改参数，右边预览人数、随机抽题。"
        actions={
          <>
            <Button variant="ghost" icon={<IconFilePlus />} onClick={onNew}>
              新建
            </Button>
            <Button variant="secondary" icon={<IconFolderOpen />} onClick={openLoad}>
              打开方案
            </Button>
            <Button variant="secondary" onClick={openSaveAs}>
              另存为
            </Button>
            <Button variant="secondary" icon={<IconSave />} loading={quick.isPending} onClick={quick.save}>
              保存
            </Button>
          </>
        }
      >
        <PlanStatusLine />
      </PageHeader>

      <div className="flex flex-col gap-4">
        <GlobalSettings />
        <div className="@6xl/main:hidden">
          <ActionsBar />
        </div>
        <div className="grid items-start gap-4 @3xl/main:grid-cols-[minmax(260px,320px)_minmax(0,1fr)] @6xl/main:grid-cols-[minmax(270px,310px)_minmax(0,1fr)_minmax(320px,380px)]">
          <BlockList />
          <BlockEditor />
          <div className="flex flex-col gap-4 @3xl/main:col-span-2 @6xl/main:sticky @6xl/main:top-[calc(var(--shell-sticky-top,0px)+var(--space-unit)*4)] @6xl/main:col-span-1">
            <div className="hidden @6xl/main:block">
              <WorkbenchActions />
            </div>
            <PreviewPanel />
            <DrawPanel />
          </div>
        </div>
      </div>
      {autoPreview && <AutoPreview />}
    </>
  )
}
