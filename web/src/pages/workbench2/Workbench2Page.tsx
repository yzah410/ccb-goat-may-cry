/**
 * 工作台：路由 `/`，路由 id 是 workbench（各主题按路由 id 换装饰）。
 *
 * 主流程：改设置 → 看人数 → 抽一题。宽屏时右栏吸顶（人数大字 + 抽一题 + 抽到的人），左边从上到下是
 * AI 输入条、对局设置、纳入范围、排除；窄屏时人数和「抽一题」变成吸顶的一条。
 * 题库里有谁（角色卡片 / 统计）看「候选池」页（/pool），人数旁边有「去候选池看全部 N 人」。
 */
import { useEffect } from 'react'
import { PageHeader } from '@/app/shell/PageHeader'
import { useShellNav } from '@/app/shell/nav'
import { useCanvasSource } from '@/features/canvas/store'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from '@/components/ui/Overlay'
import { Kbd } from '@/components/ui/Input'
import { IconAlert, IconCanvas, IconFilePlus, IconFolderOpen, IconRedo, IconSave, IconUndo, IconWorkbench } from '@/lib/icons'
import { useIsDirtyV2, useWb2, useWb2Draw } from '@/features/workbench2/store'
import { useEvaluate, useNewPlanV2 } from '@/features/workbench2/hooks'
import { AiBar, AiResultCard } from '@/features/workbench2/components/AiBar'
import { GameSettingsCard } from '@/features/workbench2/components/GameSettingsCard'
import { ExcludesZone, RangesZone } from '@/features/workbench2/components/Zones'
import { DrawResultCard, PoolBar, PoolCard, PoolDetailsCard } from '@/features/workbench2/components/Pool'
import { usePlanDialogsV2, useQuickSaveV2 } from '@/features/workbench2/planDialogs'

/** Ctrl+Z 撤销、Ctrl+Shift+Z / Ctrl+Y 重做（光标在输入框里时交给输入框自己） */
function useUndoShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.closest('input, textarea, select, [contenteditable="true"]') || t.closest('[role="dialog"]'))) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        useWb2.getState().undo()
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault()
        useWb2.getState().redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function PlanLine() {
  const planName = useWb2((s) => s.planName)
  const warnings = useWb2((s) => s.loadWarnings)
  const past = useWb2((s) => s.past)
  const future = useWb2((s) => s.future)
  const undo = useWb2((s) => s.undo)
  const redo = useWb2((s) => s.redo)
  const dirty = useIsDirtyV2()
  const lastUndo = past[past.length - 1]?.label
  const lastRedo = future[future.length - 1]?.label
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
              打开时自动修正了 {warnings.length} 处
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
      <span aria-hidden className="mx-1 h-4 w-px bg-border" />
      <Tooltip
        content={
          lastUndo ? (
            <span>
              撤销：{lastUndo} <Kbd className="ml-1 border-transparent bg-transparent text-bg">Ctrl Z</Kbd>
            </span>
          ) : (
            '没有可以撤销的'
          )
        }
      >
        <span>
          <Button size="sm" variant="ghost" icon={<IconUndo />} disabled={!lastUndo} onClick={undo} aria-label={lastUndo ? `撤销：${lastUndo}` : '撤销'}>
            撤销
          </Button>
        </span>
      </Tooltip>
      <Tooltip content={lastRedo ? `重做：${lastRedo}（Ctrl Shift Z）` : '没有可以重做的'}>
        <span>
          <Button size="sm" variant="ghost" icon={<IconRedo />} disabled={!lastRedo} onClick={redo} aria-label={lastRedo ? `重做：${lastRedo}` : '重做'}>
            重做
          </Button>
        </span>
      </Tooltip>
    </div>
  )
}

export default function Workbench2Page() {
  const nav = useShellNav()
  const ev = useEvaluate()
  const quick = useQuickSaveV2()
  const openSaveAs = usePlanDialogsV2((s) => s.openSaveAs)
  const openLoad = usePlanDialogsV2((s) => s.openLoad)
  const onNew = useNewPlanV2()
  const hasDraw = useWb2Draw((s) => !!s.last)
  useUndoShortcuts()

  return (
    <>
      <PageHeader
        route="workbench"
        title="工作台"
        icon={<IconWorkbench />}
        description="改设置 → 看人数 → 抽一题。每一项都有默认值，不改也能直接抽。"
        actions={
          <>
            <Button variant="secondary" icon={<IconCanvas />} onClick={() => { useCanvasSource.getState().setSource('v2'); nav.go('canvas') }}>
              导出思维导图
            </Button>
            <Button variant="ghost" icon={<IconFilePlus />} onClick={() => void onNew()}>
              新建
            </Button>
            <Button variant="secondary" icon={<IconFolderOpen />} onClick={openLoad}>
              打开
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
        <PlanLine />
      </PageHeader>

      <div className="flex flex-col gap-5">
        {/* 窄屏：人数 + 抽一题 吸顶（它必须是这一整列的直接子元素，吸顶才管整页，不会跟着一个小盒子滚走）；抽到的人紧跟在下面 */}
        <PoolBar ev={ev} className="@6xl/main:hidden" />
        {hasDraw && (
          <div className="@6xl/main:hidden">
            <DrawResultCard />
          </div>
        )}

        <div className="grid items-start gap-5 @6xl/main:grid-cols-[minmax(0,1fr)_minmax(340px,380px)]">
          <div className="flex min-w-0 flex-col gap-5">
            <AiBar />
            <AiResultCard />
            <GameSettingsCard />
            <RangesZone ev={ev.data} stale={ev.stale} />
            <ExcludesZone ev={ev.data} stale={ev.stale} />
            <div className="@6xl/main:hidden">
              <PoolDetailsCard ev={ev} />
            </div>
          </div>
          {/* 子元素（卡片）不许被压扁：卡片是 overflow-hidden，一压扁内容就被裁掉；放不下时让这一栏自己滚动（例如 1280×620 这样的矮窗口） */}
          <aside
            aria-label="题库与抽取"
            className="hidden flex-col gap-4 [&>*]:shrink-0 @6xl/main:sticky @6xl/main:top-[calc(var(--shell-sticky-top,0px)+var(--space-unit)*4)] @6xl/main:flex @6xl/main:max-h-[calc(100dvh-var(--shell-sticky-top,0px)-7rem)] @6xl/main:overflow-y-auto @6xl/main:scroll-thin"
          >
            <PoolCard ev={ev} />
            <DrawResultCard />
          </aside>
        </div>
      </div>
    </>
  )
}
