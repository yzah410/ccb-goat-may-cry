/**
 * 命令面板（Ctrl/⌘ + K）：跳页面、切主题、执行预览/抽题/保存/发送。
 * 键盘：↑↓ 选择，回车执行，Esc 关闭。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { Dialog as D } from 'radix-ui'
import { cn } from '@/lib/cn'
import { visibleThemes } from '@/themes/registry'
import { Kbd } from '@/components/ui/Input'
import {
  IconColumns,
  IconDice,
  IconDownload,
  IconFolderOpen,
  IconMoon,
  IconPalette,
  IconSave,
  IconSearch,
  IconSend,
  IconShuffle,
  IconUndo,
  IconUsers,
  IconWand,
} from '@/lib/icons'
import { useDrawV2 } from '@/features/workbench2/hooks'
import { usePlanDialogsV2, useQuickSaveV2 } from '@/features/workbench2/planDialogs'
import { useWb2 } from '@/features/workbench2/store'
import { usePick } from '@/features/candidates/store'
import { useDrawAction, usePreviewAction } from '@/features/candidates/hooks'
import { useSendToGuessr } from '@/features/clicker/hooks'
import { useClassicAvailable } from '@/features/classic/api'
import { usePlanDialogs, useQuickSave } from '@/features/plans/components/PlanDialogs'
import { randomThemeId } from '@/themes/registry'
import { usePrefs } from '@/features/settings/store'
import { visibleRoutes } from '../routes'
import { useThemeActions } from '../themeActions'
import { useCommandPalette } from './parts'

interface Cmd {
  id: string
  group: '页面' | '操作' | '主题'
  label: string
  hint?: string
  keywords?: string
  icon: ReactNode
  run: () => void
}

function score(c: Cmd, q: string): number {
  if (!q) return 1
  const hay = `${c.label} ${c.keywords ?? ''} ${c.hint ?? ''}`.toLowerCase()
  const k = q.toLowerCase()
  if (c.label.toLowerCase().startsWith(k)) return 3
  if (c.label.toLowerCase().includes(k)) return 2
  return hay.includes(k) ? 1 : 0
}

function PaletteBody({ close }: { close: () => void }) {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const classic = useClassicAvailable()
  const preview = usePreviewAction()
  const draw = useDrawAction()
  const pick = usePick((s) => s.pick)
  const { send } = useSendToGuessr()
  const quick = useQuickSave()
  const openLoad = usePlanDialogs((s) => s.openLoad)
  const openSaveAs = usePlanDialogs((s) => s.openSaveAs)
  const drawV2 = useDrawV2()
  const quickV2 = useQuickSaveV2()
  const openSaveAsV2 = usePlanDialogsV2((s) => s.openSaveAs)
  const openLoadV2 = usePlanDialogsV2((s) => s.openLoad)
  const undoV2 = useWb2((s) => s.undo)
  const { setTheme, toggleMode } = useThemeActions()
  const currentTheme = usePrefs((s) => s.theme)

  const cmds = useMemo<Cmd[]>(() => {
    const go = (path: string) => () => navigate(path)
    const list: Cmd[] = [
      ...visibleRoutes(classic).map<Cmd>((r) => ({
        id: `page:${r.id}`,
        group: '页面',
        label: `去${r.label}`,
        hint: r.description,
        keywords: r.id,
        icon: <r.icon />,
        run: go(r.path),
      })),
      // 工作台
      { id: 'act:v2draw', group: '操作', label: '抽一题', hint: '工作台：从题库里随机抽一个角色', keywords: 'draw 抽题 出题 随机 工作台', icon: <IconDice />, run: () => { drawV2.run(); navigate('/') } },
      { id: 'act:v2save', group: '操作', label: '保存方案', hint: '工作台：有名字就覆盖保存，没有就另存为', keywords: 'save 保存 工作台', icon: <IconSave />, run: quickV2.save },
      { id: 'act:v2saveas', group: '操作', label: '方案另存为…', hint: '工作台', keywords: 'save as 另存 工作台', icon: <IconSave />, run: openSaveAsV2 },
      { id: 'act:v2open', group: '操作', label: '打开方案…', hint: '工作台的方案', keywords: 'load open 加载 打开 工作台', icon: <IconFolderOpen />, run: openLoadV2 },
      { id: 'act:v2undo', group: '操作', label: '撤销', hint: '工作台：撤销上一步修改', keywords: 'undo 撤销 工作台', icon: <IconUndo />, run: undoV2 },
      // 经典工作台（按顺序组块；只在装了经典工作台数据时有）
      ...(classic
        ? [
            { id: 'act:preview', group: '操作' as const, label: '经典工作台：预览人数', hint: '看经典方案能圈到多少人', keywords: 'preview 预览 classic 经典', icon: <IconUsers />, run: () => { preview.run(); navigate('/classic') } },
            { id: 'act:draw', group: '操作' as const, label: '经典工作台：随机抽一题', hint: '按权重随机抽一个角色', keywords: 'draw 抽题 出题 随机 classic 经典', icon: <IconDice />, run: () => { draw.run(); navigate('/classic') } },
            { id: 'act:list', group: '操作' as const, label: '经典工作台：列出候选', hint: '按时间排序分页看全部候选', keywords: 'candidates 出题 列表 classic 经典', icon: <IconUsers />, run: go('/candidates') },
            { id: 'act:save', group: '操作' as const, label: '经典工作台：保存方案', hint: '有名字就覆盖保存，没有就另存为', keywords: 'save 保存 classic 经典', icon: <IconSave />, run: quick.save },
            { id: 'act:saveas', group: '操作' as const, label: '经典工作台：另存为…', keywords: 'save as 另存 classic 经典', icon: <IconSave />, run: openSaveAs },
            { id: 'act:open', group: '操作' as const, label: '经典工作台：打开方案…', keywords: 'load open 加载 classic 经典', icon: <IconFolderOpen />, run: openLoad },
          ]
        : []),
      { id: 'act:canvas', group: '操作', label: '导出导图', keywords: 'canvas obsidian 导图', icon: <IconDownload />, run: go('/canvas') },
      ...(pick
        ? [{ id: 'act:send', group: '操作' as const, label: `把「${pick.item.character.name}」发到猜猜呗`, keywords: 'send 发送 猜猜呗', icon: <IconSend />, run: () => send(pick.item) }]
        : []),
      { id: 'theme:mode', group: '主题', label: '切换浅色 / 深色', keywords: 'dark light 明暗', icon: <IconMoon />, run: toggleMode },
      { id: 'theme:random', group: '主题', label: '随机换一个主题', keywords: 'random theme', icon: <IconShuffle />, run: () => setTheme(randomThemeId(currentTheme)) },
      { id: 'theme:compare', group: '主题', label: '分屏对比两个主题', keywords: 'compare 对比', icon: <IconColumns />, run: () => navigate(`/themes/compare?a=${currentTheme}&b=${randomThemeId(currentTheme)}`) },
      ...visibleThemes().map<Cmd>((t) => ({
        id: `theme:${t.manifest.id}`,
        group: '主题',
        label: `主题：${t.manifest.name}`,
        hint: t.manifest.tagline,
        keywords: `${t.manifest.id} ${t.manifest.nameEn}`,
        icon: t.manifest.id === currentTheme ? <IconWand /> : <IconPalette />,
        run: () => setTheme(t.manifest.id),
      })),
    ]
    return list
  }, [navigate, classic, preview, draw, drawV2, quickV2.save, openSaveAsV2, openLoadV2, undoV2, pick, send, quick.save, openSaveAs, openLoad, toggleMode, setTheme, currentTheme])

  const results = useMemo(() => {
    const k = q.trim()
    const ranked = cmds
      .map((c) => ({ c, s: score(c, k) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c)
    // 同一组放在一起：组的先后按组里最好的那条排，组内保持得分顺序
    const groupOrder: string[] = []
    for (const c of ranked) if (!groupOrder.includes(c.group)) groupOrder.push(c.group)
    return ranked
      .map((c, i) => ({ c, i }))
      .sort((a, b) => groupOrder.indexOf(a.c.group) - groupOrder.indexOf(b.c.group) || a.i - b.i)
      .map((x) => x.c)
  }, [cmds, q])

  const active = Math.min(idx, Math.max(0, results.length - 1))

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const exec = (c: Cmd | undefined) => {
    if (!c) return
    close()
    // 等弹层关掉再执行（有的命令会再开一个弹窗）
    window.setTimeout(c.run, 0)
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx(Math.min(results.length - 1, active + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx(Math.max(0, active - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      exec(results[active])
    }
  }

  const rows = results.map((c, i) => ({ c, i, head: i === 0 || results[i - 1]!.group !== c.group ? c.group : null }))
  return (
    <>
      <div className="flex items-center gap-3 border-b border-border px-4">
        <IconSearch className="size-5 shrink-0 text-fg-3" aria-hidden />
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setIdx(0)
          }}
          onKeyDown={onKey}
          placeholder="想做什么？输入「抽」「主题」「方案」试试"
          aria-label="搜索命令"
          className="h-14 flex-1 bg-transparent text-lg text-fg-1 outline-none placeholder:text-fg-3"
        />
      </div>
      <div ref={listRef} className="max-h-[min(60vh,440px)] overflow-y-auto p-2 scroll-thin" role="listbox" aria-label="命令">
        {results.length === 0 && <p className="px-3 py-8 text-center text-sm text-fg-3">没有匹配的命令</p>}
        {rows.map(({ c, i, head }) => {
          return (
            <div key={c.id}>
              {head && <p className="px-3 pb-1 pt-3 text-xs font-medium text-fg-3">{head}</p>}
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                data-idx={i}
                onMouseMove={() => setIdx(i)}
                onClick={() => exec(c)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm',
                  i === active ? 'bg-primary-100 text-primary-900' : 'text-fg-1',
                  '[&_svg]:size-4 [&_svg]:shrink-0',
                )}
              >
                <span className={cn(i === active ? 'text-primary-700' : 'text-fg-3')}>{c.icon}</span>
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                {c.hint && <span className="hidden max-w-[45%] truncate text-xs text-fg-3 sm:block">{c.hint}</span>}
              </button>
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-xs text-fg-3">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> 选择
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Enter</Kbd> 执行
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Esc</Kbd> 关闭
        </span>
      </div>
    </>
  )
}

export function CommandPalette() {
  const open = useCommandPalette((s) => s.open)
  const setOpen = useCommandPalette((s) => s.setOpen)

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(!useCommandPalette.getState().open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpen])

  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[80] bg-overlay data-[state=open]:animate-[fade-in_var(--motion-duration)_var(--motion-ease)]" />
        <D.Content
          className={cn(
            'fixed left-1/2 top-[12vh] z-[80] w-[calc(100%-32px)] max-w-xl -translate-x-1/2 overflow-hidden',
            'rounded-xl border border-border bg-surface-1 text-fg-1 shadow-3 outline-none',
            'data-[state=open]:animate-[pop-in_var(--motion-duration)_var(--motion-ease)]',
          )}
          aria-describedby={undefined}
        >
          <D.Title className="sr-only">命令面板</D.Title>
          {open && <PaletteBody close={() => setOpen(false)} />}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
