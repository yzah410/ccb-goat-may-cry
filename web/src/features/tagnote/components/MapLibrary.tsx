/**
 * 「方案库」标签：左边按年份分组的导图列表（新的在上，可按来源筛选；窄屏、或宽屏收起列表时变成上方下拉框），
 * 右边是导图工作区（标签页 + 分屏，见 ../workspace/Workspace.tsx）。
 *
 * 点列表里的图 = 当前格的当前标签换成它；Ctrl+点击或中键点击 = 在当前格新开一个标签。
 * 图头（改名、删除、下载）作用于当前格的当前标签。整块占满页面剩下的高度，列表和每一格各自滚动。
 * 还有没载入的样例导图时显示「载入全部样例导图」按钮（见 SampleLoader）：宽屏在列表下面，窄屏、收起列表时在图头上面。
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { confirm } from '@/components/ui/Confirm'
import { SegmentedControl, Select } from '@/components/ui/Controls'
import { Input } from '@/components/ui/Input'
import { Dialog, DialogContent } from '@/components/ui/Overlay'
import { toast } from '@/components/ui/Toast'
import { EmptyState, ErrorState, Loading } from '@/components/data-display/Misc'
import { IconChevronRight, IconDownload, IconFilePlus, IconPanelLeftClose, IconPanelLeftOpen, IconPencil, IconSearch, IconTrash } from '@/lib/icons'
import { cn } from '@/lib/cn'
import { useCanvasTab } from '@/features/canvas/store'
import { useDeleteMap, useDownloadMapNote, useLayoutSaver, useMaps, useRenameMap } from '../hooks'
import { buildGroups, flatOrder, neighborAfterDelete, sourceCounts, sourceMeta, type MapGroup, type SourceCount } from '../library'
import { useTagNoteLocal } from '../store'
import type { MapSummary } from '../types'
import { wsActions } from '../workspace/actions'
import { useFillHeight } from '../workspace/fillHeight'
import { activeTabOf, clickIntent } from '../workspace/tree'
import { Workspace } from '../workspace/Workspace'
import { SampleLoader } from './SampleLoader'

// 每个来源一条竖线（列表每行左边、来源筛选按钮里各一小段）：精选样例 = 主色实线；补充样例 = 虚线；在这里新建、其它 = 细灰线
const SOURCE_RULE: Record<string, string> = {
  manual: 'border-l-2 border-primary',
  batch: 'border-l-2 border-dashed border-border-strong',
  outsetter: 'border-l-2 border-border',
}
const ruleOf = (source: string | null) => SOURCE_RULE[source ?? ''] ?? SOURCE_RULE.outsetter

// ---------------------------------------------------------------- 列表（宽屏）
/** 选一张图：newTab = 新开标签（Ctrl / ⌘ + 点击、中键点击），否则换掉当前标签里的图 */
type OnSelect = (id: string, newTab: boolean) => void

function MapRow({ item, selected, onSelect }: { item: MapSummary; selected: boolean; onSelect: OnSelect }) {
  const pick = (e: MouseEvent) => {
    const intent = clickIntent(e)
    if (intent) onSelect(item.id, intent === 'newTab')
  }
  return (
    <li className={cn('py-px pl-1.5', ruleOf(item.source))} data-source={item.source ?? ''}>
      <button
        type="button"
        onClick={pick}
        onMouseDown={(e) => {
          if (e.button === 1) e.preventDefault() // 中键：别进浏览器的自动滚动
        }}
        onAuxClick={(e) => {
          if (e.button !== 1) return
          e.preventDefault()
          pick(e)
        }}
        aria-current={selected ? 'true' : undefined}
        data-map-id={item.id}
        className={cn(
          'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors',
          'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
          selected ? 'bg-selected text-fg-1' : 'text-fg-2 hover:bg-surface-2 hover:text-fg-1',
        )}
      >
        <span className={cn('line-clamp-2 text-sm leading-snug', selected && 'font-medium')}>{item.title}</span>
        <span className="flex min-w-0 items-center gap-2 text-xs text-fg-3">
          <span className="shrink-0 font-mono">{item.n_works} 部</span>
          {item.common_tags.length > 0 && <span className="truncate">{item.common_tags.join('、')}</span>}
        </span>
      </button>
    </li>
  )
}

/** 只看某个来源（只有一种来源时不显示） */
function SourceFilter({ counts, value, onChange }: { counts: SourceCount[]; value: string; onChange: (source: string) => void }) {
  if (counts.length < 2) return null
  const options = [
    { value: 'all', label: '全部' },
    ...counts.map((c) => ({ value: c.source, label: c.meta.short, icon: <span aria-hidden className={cn('h-3', ruleOf(c.source))} /> })),
  ]
  return <SegmentedControl size="sm" value={value} onChange={onChange} options={options} aria-label="只看哪个来源" />
}

function MapList({
  groups,
  selectedId,
  searching,
  onSelect,
}: {
  groups: MapGroup[]
  selectedId: string | null
  searching: boolean
  onSelect: OnSelect
}) {
  const openGroups = useTagNoteLocal((s) => s.openGroups)
  const toggleGroup = useTagNoteLocal((s) => s.toggleGroup)
  const openGroup = useTagNoteLocal((s) => s.openGroup)
  const selectedKey = groups.find((g) => g.items.some((it) => it.id === selectedId))?.key ?? null
  // 选中的图换了（点了别的图、用下拉框选、删除后跳到下一张、刚打开页面），展开它所在的组；之后这个组也能手动收起
  const openedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedId || !selectedKey || openedFor.current === selectedId) return
    openedFor.current = selectedId
    openGroup(selectedKey)
  }, [selectedId, selectedKey, openGroup])
  return (
    <div className="flex flex-col gap-0.5">
      {groups.map((g) => {
        const open = searching || openGroups.includes(g.key)
        const hasSelected = g.key === selectedKey
        return (
          <div key={g.key} data-group={g.key}>
            <button
              type="button"
              aria-expanded={open}
              disabled={searching}
              onClick={() => toggleGroup(g.key)}
              data-has-selected={hasSelected ? '' : undefined}
              className={cn(
                'flex w-full items-center gap-1 rounded-md px-1 py-1 text-left text-sm transition-colors',
                'hover:bg-surface-2 hover:text-fg-1 disabled:cursor-default disabled:hover:bg-transparent',
                'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
                hasSelected ? 'font-medium text-fg-1' : 'text-fg-2',
              )}
            >
              <IconChevronRight className={cn('size-3.5 shrink-0 text-fg-3 transition-transform', open && 'rotate-90')} />
              <span className="min-w-0 flex-1 truncate">{g.label}</span>
              {/* 收起时用一个小圆点标出选中的图在这一组 */}
              {hasSelected && !open && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />}
              {hasSelected && <span className="sr-only">（选中的图在这一组）</span>}
              <span className="shrink-0 font-mono text-xs font-normal text-fg-3">{g.items.length}</span>
            </button>
            {open && (
              <ul className="mb-1.5 ml-2 flex flex-col">
                {g.items.map((it) => (
                  <MapRow key={it.id} item={it} selected={it.id === selectedId} onSelect={onSelect} />
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- 改名
function RenameDialog({ item, open, onOpenChange }: { item: MapSummary; open: boolean; onOpenChange: (open: boolean) => void }) {
  const rename = useRenameMap()
  const [title, setTitle] = useState(item.title)
  const clean = title.trim()
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (!clean || clean === item.title) return onOpenChange(false)
    rename.mutate({ id: item.id, title: clean }, { onSuccess: () => onOpenChange(false) })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        title="重命名"
        description="只改方案库里显示的名字和下载笔记的文件名。"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button variant="primary" loading={rename.isPending} disabled={!clean} onClick={() => submit()}>
              保存
            </Button>
          </>
        }
      >
        <form onSubmit={submit}>
          <Input autoFocus aria-label="新名字" value={title} invalid={!clean} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- 当前标签的图：标题区
// 宽屏：紧凑的两行（第二行是共有标签和来源，放不下就截断、悬停看全文）：给下面的工作区多留高度。
// 窄屏（没有左栏）：压成一行 = 下拉框（它就显示图名，标题只留给读屏）+ 来源和作品数 + 短名按钮；
// 共有标签和来源那一行不占高度，悬停作品数看。放不下时按钮换到第二行。
function MapHeader({
  item,
  select,
  beforeDelete,
  onDeleted,
}: {
  item: MapSummary
  /** 窄屏时放在这一行最前面的选图下拉框 */
  select?: ReactNode
  /** 确认删除、发请求之前（丢掉这张图还没存的布局） */
  beforeDelete: (id: string) => void
  onDeleted: (id: string) => void
}) {
  const meta = sourceMeta(item.source)
  const download = useDownloadMapNote()
  const del = useDeleteMap()
  const [renaming, setRenaming] = useState(false)
  const remove = async () => {
    const ok = await confirm({
      title: `删除「${item.title}」？`,
      description: meta.deleteNote,
      confirmLabel: '删除',
      tone: 'danger',
    })
    if (!ok) return
    beforeDelete(item.id)
    del.mutate(item.id, {
      onSuccess: () => {
        onDeleted(item.id)
        toast.success('已删除', { description: item.title })
      },
    })
  }
  const tags = item.common_tags.length > 0 ? `共有标签：${item.common_tags.join('、')}` : null
  const metaLine = [tags, item.origin && `来自 ${item.origin}`].filter(Boolean).join('\n')
  // 窄屏的样式都写成 @max-6xl/main: 变体（类名要原样写出来，Tailwind 才扫得到）
  return (
    <header
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 @max-6xl/main:gap-x-2 @max-6xl/main:gap-y-2"
      data-map-header={item.id}
    >
      {select && (
        <div className="min-w-40 flex-1 basis-40 @6xl/main:hidden" data-map-select-inline="">
          {select}
        </div>
      )}
      <div className="flex min-w-0 flex-1 basis-72 items-center gap-2 @max-6xl/main:flex-none @max-6xl/main:basis-auto">
        <Badge tone={meta.tone} className="shrink-0" data-source-badge={item.source ?? ''}>
          {meta.short}
        </Badge>
        <h2 className="min-w-0 truncate text-lg font-semibold leading-snug text-fg-1 @max-6xl/main:sr-only" title={item.title}>
          {item.title}
        </h2>
        <span className="shrink-0 text-sm text-fg-2 @max-6xl/main:hidden">{item.n_works} 部作品</span>
        <span className="hidden shrink-0 text-sm text-fg-2 @max-6xl/main:inline" title={metaLine || undefined}>
          {item.n_works} 部作品
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Button
          variant="secondary"
          size="sm"
          icon={<IconDownload />}
          loading={download.isPending}
          onClick={() => download.mutate({ id: item.id, title: item.title })}
        >
          <span className="@max-6xl/main:hidden">下载 Obsidian 笔记</span>
          <span className="hidden @max-6xl/main:inline">下载笔记</span>
        </Button>
        <Button variant="ghost" size="sm" icon={<IconPencil />} onClick={() => setRenaming(true)}>
          重命名
        </Button>
        <Button variant="danger-ghost" size="sm" icon={<IconTrash />} loading={del.isPending} onClick={() => void remove()}>
          删除
        </Button>
      </div>
      {(tags || item.origin) && (
        <p className="flex w-full min-w-0 items-baseline gap-4 text-xs @max-6xl/main:hidden" data-map-meta="">
          {tags && (
            <span className="min-w-0 truncate text-fg-2" title={tags}>
              {tags}
            </span>
          )}
          {item.origin && (
            <span className="min-w-0 shrink-[2] truncate font-mono text-fg-3" title={item.origin}>
              来自 {item.origin}
            </span>
          )}
        </p>
      )}
      {renaming && <RenameDialog item={item} open={renaming} onOpenChange={setRenaming} />}
    </header>
  )
}

// ---------------------------------------------------------------- 整个标签页
export function MapLibrary() {
  const maps = useMaps()
  const workspace = useTagNoteLocal((s) => s.workspace)
  const listCollapsed = useTagNoteLocal((s) => s.listCollapsed)
  const setListCollapsed = useTagNoteLocal((s) => s.setListCollapsed)
  const sourceFilter = useTagNoteLocal((s) => s.sourceFilter)
  const setSourceFilter = useTagNoteLocal((s) => s.setSourceFilter)
  const setTab = useCanvasTab((s) => s.setTab)
  const [query, setQuery] = useState('')
  const saver = useLayoutSaver()
  const fillRef = useRef<HTMLDivElement>(null)

  const items = useMemo(() => maps.data ?? [], [maps.data])
  const counts = useMemo(() => sourceCounts(items), [items])
  // 存的筛选对应的来源已经没有图了（或只剩一种来源、不显示筛选按钮），就当「全部」
  const filter = counts.length > 1 && counts.some((c) => c.source === sourceFilter) ? sourceFilter : 'all'
  const allGroups = useMemo(() => buildGroups(items), [items])
  const fullOrder = useMemo(() => flatOrder(allGroups), [allGroups])
  const listGroups = useMemo(() => (filter === 'all' ? allGroups : buildGroups(items, { source: filter })), [items, filter, allGroups])
  const listOrder = useMemo(() => flatOrder(listGroups), [listGroups])
  const shown = useMemo(() => (query.trim() ? buildGroups(items, { query, source: filter }) : listGroups), [items, query, filter, listGroups])

  // 列表高亮、图头都跟着当前格的当前标签
  const selectedId = activeTabOf(workspace)?.mapId ?? null
  const selected = items.find((m) => m.id === selectedId) ?? null
  const ready = items.length > 0
  useFillHeight(fillRef, ready)

  // 方案库里没有了的图（别处删了、库重新导入）：对应的标签安静地关掉。列表正在刷新时先不动，免得刚存的新图被当成没有
  useEffect(() => {
    if (!maps.data || maps.isFetching) return
    const ids = new Set(maps.data.map((m) => m.id))
    wsActions.prune((id) => ids.has(id))
  }, [maps.data, maps.isFetching, workspace.tabs])

  // 全新的工作区（从没打开过图）：自动打开列表第一张（最新的）。用户自己把标签关光了就留空
  const first = listOrder[0]?.id ?? fullOrder[0]?.id ?? null
  useEffect(() => {
    if (!workspace.opened && first && !maps.isFetching) wsActions.open(first)
  }, [workspace.opened, first, maps.isFetching])

  // 打开页面以后又换了当前的图（下拉框、刚存的新图、切标签），它不在当前来源筛选里，就把筛选换回「全部」，免得列表里找不到它。
  // 刚打开页面时不动筛选（上次选的图可能是筛选之前选的）
  const filteredFor = useRef<string | null>(null)
  const selectedSource = selected ? selected.source || 'other' : null
  useEffect(() => {
    if (!selectedId || !selectedSource || filteredFor.current === selectedId) return
    const isFirst = filteredFor.current === null
    filteredFor.current = selectedId
    if (!isFirst && filter !== 'all' && selectedSource !== filter) setSourceFilter('all')
  }, [selectedId, selectedSource, filter, setSourceFilter])

  if (maps.isPending) return <Loading label="正在读取方案库…" />
  if (maps.isError) return <ErrorState error={maps.error} title="方案库没读出来" onRetry={() => void maps.refetch()} />
  if (!ready)
    return (
      <EmptyState
        kind="canvas"
        title="方案库还是空的"
        description="在「新建标签笔记」里用当前方案生成一张，存进来就会出现在这里。"
        action={
          <>
            <Button variant="primary" icon={<IconFilePlus />} onClick={() => setTab('new')}>
              去新建标签笔记
            </Button>
            <SampleLoader />
          </>
        }
      />
    )

  const searching = !!query.trim()
  const options = fullOrder.map((m) => ({
    value: m.id,
    label: m.title,
    hint: [sourceMeta(m.source).short, m.group, `${m.n_works} 部`].filter(Boolean).join(' · '),
  }))
  const select = (id: string, newTab: boolean) => wsActions.open(id, { newTab })
  // 没有打开的图时传空字符串（显示占位文字），不传 undefined：免得在受控 / 非受控之间来回切
  const picker = <Select value={selectedId ?? ''} onChange={(id) => select(id, false)} options={options} aria-label="选一张图" placeholder="选一张图" />

  // 两栏的分界用 @6xl（72rem）：左栏占掉约 350px 后，右栏还要留够 720px（引擎窄于 720px 时侧栏改成浮层）。
  // 宽屏可以收起左栏，把宽度全给工作区，改用上方下拉框选图。
  // 整块的高度由 useFillHeight 定（占满页面剩下的高度）；行：宽屏 = 一行（收起列表时 = 下拉框 + 工作区）；
  // 窄屏有打开的图时下拉框挪进图头那一行（省出一行给工作区），整块只剩一行；没有打开的图时 = 下拉框 + 工作区
  return (
    <div
      ref={fillRef}
      className={cn(
        'grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-4',
        !listCollapsed && '@6xl/main:grid-cols-[17rem_minmax(0,1fr)] @6xl/main:grid-rows-[minmax(0,1fr)]',
        selected && '@max-6xl/main:grid-rows-[minmax(0,1fr)]',
      )}
      data-map-library=""
      data-list-collapsed={listCollapsed ? '' : undefined}
    >
      {/* 宽屏：左侧列表（搜索和筛选固定在上面，列表自己滚） */}
      {!listCollapsed && (
        <aside aria-label="方案库列表" className="hidden min-h-0 flex-col gap-3 @6xl/main:flex">
          <div className="flex items-center gap-1">
            <Input
              size="sm"
              type="search"
              leading={<IconSearch />}
              placeholder="搜标题或共有标签"
              aria-label="搜标题或共有标签"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button variant="ghost" size="sm" className="shrink-0" icon={<IconPanelLeftClose />} onClick={() => setListCollapsed(true)}>
              收起
            </Button>
          </div>
          <SourceFilter counts={counts} value={filter} onChange={setSourceFilter} />
          <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2 scroll-thin" data-map-list="">
            {shown.length ? (
              <MapList groups={shown} selectedId={selectedId} searching={searching} onSelect={select} />
            ) : (
              <p className="px-1 text-sm text-fg-3">
                {filter === 'all'
                  ? `没有标题或共有标签里含「${query.trim()}」的图。`
                  : `「${sourceMeta(filter).short}」的图里，没有标题或共有标签含「${query.trim()}」的。`}
              </p>
            )}
          </div>
          {/* 左栏窄：放不下一行时按钮里的字换行 */}
          <SampleLoader className="h-auto min-h-[var(--control-h-sm)] w-full whitespace-normal py-1" />
        </aside>
      )}

      {/* 窄屏、或宽屏收起了列表：上方下拉框（选了 = 当前标签换成它）。窄屏有打开的图时它在图头那一行里，这里藏起来 */}
      <div className={cn('flex items-center gap-2', !listCollapsed && '@6xl/main:hidden', selected && '@max-6xl/main:hidden')} data-map-select="">
        <div className="min-w-0 flex-1 @6xl/main:max-w-xl">{picker}</div>
        {listCollapsed && (
          <Button variant="ghost" size="sm" className="hidden shrink-0 @6xl/main:inline-flex" icon={<IconPanelLeftOpen />} onClick={() => setListCollapsed(false)}>
            展开列表
          </Button>
        )}
      </div>

      <section className="flex min-h-0 min-w-0 flex-col gap-3 @max-6xl/main:gap-2" aria-label="打开的图">
        {/* 没有左栏时（窄屏、收起列表）按钮放在这里；有左栏时在列表下面 */}
        <SampleLoader className={cn('self-start', !listCollapsed && '@6xl/main:hidden')} />
        {selected && (
          <MapHeader
            item={selected}
            select={picker}
            beforeDelete={(id) => saver.cancel(id)}
            onDeleted={(id) => {
              saver.cancel(id) // 删除请求进行中引擎又报了布局的话，也丢掉
              // 当前标签换成列表里它的下一张（删的图在当前筛选的列表里就按列表，否则按全部图的顺序）；别的标签里的它关掉
              const next = neighborAfterDelete(listOrder.some((m) => m.id === id) ? listOrder : fullOrder, id)
              wsActions.afterDeleted(id, next)
            }}
          />
        )}
        <Workspace items={items} onLayoutCache={saver.schedule} className="min-h-0 flex-1" />
      </section>
    </div>
  )
}
