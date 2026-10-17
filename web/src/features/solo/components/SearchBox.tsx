/**
 * 猜测输入框 + 下拉。页面上最主要的控件，做得大、放在中间。
 * 输入框有两种搜索状态，旁边的「角色 | 作品」显示当前是哪种，点一下可以切换（可以纯键盘搜作品）：
 * - 搜角色（默认）：打字停 250ms 自动搜本地全库（/v2/solo/search，能容错、能搜别名）；
 *   「搜 Bangumi 全库」打开时改用在线搜索（停 500ms 再搜）
 * - 搜作品：打字实时搜作品 → 选一部 → 列出这部作品的角色（主角在前）→ 选一个猜（这次猜测记 via = work）
 * - 按键规则在 keyboard.ts（searchKeyAction）：光标在最后按 → 切到搜作品；作品列表里光标在最前按 ← 回到搜角色；
 *   作品的角色列表里按 ← 回到作品列表；↑/↓ 选、Enter 猜（或进入作品）、Esc 收起；Shift+Enter = 用当前文字搜作品
 * - 猜完一次留在原来那种状态；新开一局由页面把状态改回搜角色（状态归页面管：view / onViewChange）
 * - 空格从页面任何地方回到这里（页面的全局按键）；自动模式：Alt+1/2/3/4 改上一局评级，Tab 跳到右上角「上一局」
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/cn'
import { errorText } from '@/lib/apiClient'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Input'
import { IconArrowLeft, IconLoader, IconSearch } from '@/lib/icons'
import { useDebounced } from '@/features/v2/hooks'
import type { ModeId } from '@/features/v2/types'
import { soloApi, soloErrorCode, type Grade, type GuessVia } from '../api'
import { searchKeyAction } from '../keyboard'
import {
  fromBgm,
  fromLocalCharacters,
  fromLocalWorks,
  fromWorkCharacters,
  viaOf,
  viewAfterGuess,
  viewAfterTyping,
  type SearchItem,
  type SearchView,
} from '../search'
import { useSoloSettings } from '../settings'
import { SoloAvatar } from './SoloAvatar'

/** 打字停多久开始搜：本地搜索 250ms；「搜 Bangumi 全库」打开时 500ms */
const LOCAL_DEBOUNCE_MS = 250
const BGM_DEBOUNCE_MS = 500

export interface SearchBoxProps {
  mode: ModeId
  /** 有会话了才能搜 */
  enabled: boolean
  /** 这一局正在进行、没有请求在路上 */
  canGuess: boolean
  /** 自动模式且有上一局：Alt+1–4、Tab 才有用 */
  canRegrade: boolean
  /** 现在的搜索状态（页面管：新开一局时改回 'char'） */
  view: SearchView
  onViewChange: (v: SearchView) => void
  /** via：从作品的角色列表里选的 = 'work'，其余 = 'name' */
  onGuess: (id: number, via: GuessVia) => Promise<'ok' | 'ignored' | 'error'>
  onRegrade: (g: Grade) => void
  onFocusLast: () => void
  inputRef: RefObject<HTMLInputElement | null>
}

export function SearchBox({ mode, enabled, canGuess, canRegrade, view, onViewChange, onGuess, onRegrade, onFocusLast, inputRef }: SearchBoxProps) {
  const bgm = useSoloSettings((s) => s.bgmSearch)
  const setSettings = useSoloSettings((s) => s.set)
  const [text, setText] = useState('')
  const [work, setWork] = useState<{ id: number; name: string } | null>(null)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const setView = onViewChange

  const dq = useDebounced(text.trim(), bgm ? BGM_DEBOUNCE_MS : LOCAL_DEBOUNCE_MS)
  const charOn = enabled && view === 'char' && dq !== ''

  const charLocal = useQuery({
    queryKey: ['solo', 'search', 'character', dq],
    queryFn: ({ signal }) => soloApi.search('character', dq, 12, signal),
    enabled: charOn && !bgm,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const charBgm = useQuery({
    queryKey: ['solo', 'bgm', 'character', dq, mode],
    queryFn: ({ signal }) => soloApi.bgmSearch('character', dq, mode, signal),
    enabled: charOn && bgm,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const works = useQuery({
    queryKey: ['solo', bgm ? 'bgm' : 'search', 'work', dq, mode],
    queryFn: async ({ signal }): Promise<{ items: SearchItem[]; fuzzy: boolean | null }> => {
      if (bgm) return { items: fromBgm(await soloApi.bgmSearch('subject', dq, mode, signal), 'work'), fuzzy: null }
      const r = await soloApi.search('work', dq, 15, signal)
      return { items: fromLocalWorks(r.items), fuzzy: r.fuzzy }
    },
    enabled: enabled && view === 'works' && dq !== '',
    staleTime: 5 * 60_000,
    retry: false,
  })
  const workChars = useQuery({
    queryKey: ['solo', 'work-characters', work?.id ?? null, mode],
    queryFn: ({ signal }) => soloApi.workCharacters(work!.id, mode, signal),
    enabled: enabled && view === 'work-chars' && work != null,
    staleTime: 5 * 60_000,
    retry: false,
  })

  const active = view === 'char' ? (bgm ? charBgm : charLocal) : view === 'works' ? works : workChars
  const items: SearchItem[] = useMemo(() => {
    if (view === 'char') return bgm ? fromBgm(charBgm.data ?? [], 'char') : fromLocalCharacters(charLocal.data?.items ?? [])
    if (view === 'works') return works.data?.items ?? []
    return fromWorkCharacters(workChars.data?.items ?? [])
  }, [view, bgm, charBgm.data, charLocal.data, works.data, workChars.data])
  // 后端的容错索引还没建好（fuzzy: false）：这次是按原名精确搜的，下拉底部说一句
  const exactOnly = !bgm && (view === 'char' ? charLocal.data?.fuzzy : view === 'works' ? works.data?.fuzzy : null) === false

  // 选中项跟着这一批结果走：结果换了就回到「没选」（和猜猜呗游戏一样）
  const [sel, setSel] = useState<{ items: SearchItem[]; index: number }>({ items: [], index: -1 })
  const index = sel.items === items ? sel.index : -1

  useEffect(() => {
    if (index < 0) return
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])

  // 点框外面：收起下拉（不清空输入）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const pick = async (it: SearchItem | undefined) => {
    if (!it || it.disabled || it.id == null) return
    if (it.kind === 'work') {
      setWork({ id: it.id, name: it.title })
      setView('work-chars')
      setOpen(true)
      return
    }
    if (!canGuess) return
    const from = view
    const r = await onGuess(it.id, viaOf(from))
    if (r !== 'ok') return
    // 猜完：清空输入框，留在原来那种状态（从作品里选的 → 回到作品列表，等打下一个作品名）
    setText('')
    setOpen(false)
    setWork(null)
    setView(viewAfterGuess(from))
  }

  /** 切到「搜作品」：输入框里的字保留，马上按作品名搜 */
  const toWorks = () => {
    setWork(null)
    setView('works')
    setOpen(true)
  }
  /** 回到「搜角色」：字保留，按角色重新搜 */
  const toChars = () => {
    setWork(null)
    setView('char')
    setOpen(true)
  }

  const typing = view !== 'work-chars' && text.trim() !== dq
  const showDrop = open && enabled && (view === 'work-chars' || text.trim() !== '')

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const el = e.currentTarget
    const a = searchKeyAction(
      { key: e.key, code: e.code, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing },
      {
        items,
        index,
        open: showDrop && items.length > 0,
        canRegrade,
        view,
        caret: { start: el.selectionStart, end: el.selectionEnd, length: el.value.length },
      },
    )
    if (!a) return
    e.preventDefault()
    if (a.type === 'move') {
      setOpen(true)
      setSel({ items, index: a.index })
    } else if (a.type === 'pick') void pick(items[a.index])
    else if (a.type === 'regrade') onRegrade(a.grade)
    else if (a.type === 'focus-last') onFocusLast()
    else if (a.type === 'close') setOpen(false)
    else if (a.type === 'search-works' || a.type === 'to-works') toWorks()
    else if (a.type === 'to-chars') toChars()
    else if (a.type === 'back-to-works') {
      setView('works')
      setOpen(true)
    }
  }

  const err = active.error
  const bgmDown = soloErrorCode(err) === 'bgm_unavailable'
  const what = view === 'char' ? '角色' : '作品'

  return (
    <div ref={boxRef} className="relative flex w-full min-w-0 items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-fg-3 [&_svg]:size-5">
          {active.isFetching ? <IconLoader className="animate-spin" aria-hidden /> : <IconSearch aria-hidden />}
        </span>
        <input
          ref={inputRef}
          data-slot="input"
          data-solo-search
          data-view={view}
          type="text"
          autoComplete="off"
          spellCheck={false}
          disabled={!enabled}
          value={text}
          placeholder={bgm ? `输入${what}名（在 Bangumi 全库里搜，能搜别名）` : `输入${what}名（本地全库）`}
          aria-label={view === 'char' ? '猜一个角色' : '按作品找角色'}
          aria-expanded={showDrop}
          aria-controls="solo-search-list"
          aria-autocomplete="list"
          role="combobox"
          className={cn(
            'h-12 w-full rounded-lg border border-border-strong bg-surface-1 pl-11 pr-3 text-lg text-fg-1 shadow-1 outline-none',
            'placeholder:text-fg-3 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
          onChange={(e) => {
            setText(e.target.value)
            // 在作品的角色列表里打字：回到作品列表，按新打的字搜作品
            if (view === 'work-chars') setWork(null)
            setView(viewAfterTyping(view))
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />

        {showDrop && (
          <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-border bg-surface-1 shadow-3">
            {view === 'work-chars' && work && (
              <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
                <Button variant="ghost" size="sm" icon={<IconArrowLeft />} onMouseDown={(e) => e.preventDefault()} onClick={() => setView('works')}>
                  返回
                </Button>
                <span className="min-w-0 truncate text-fg-1">《{work.name}》的角色</span>
                <span className="shrink-0 text-xs text-fg-3">主角在前</span>
              </div>
            )}
            {view === 'works' && <div className="border-b border-border px-3 py-2 text-xs text-fg-3">选一部作品，看它的角色</div>}

            {items.length > 0 ? (
              <ul id="solo-search-list" ref={listRef} role="listbox" className="max-h-80 overflow-y-auto py-1">
                {items.map((it, i) => (
                  <li
                    key={it.key}
                    data-index={i}
                    data-id={it.id ?? undefined}
                    data-kind={it.kind}
                    role="option"
                    aria-selected={i === index}
                    aria-disabled={it.disabled || undefined}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 border-l-[3px] border-transparent px-3 py-1.5',
                      i === index ? 'border-l-primary bg-selected' : 'hover:bg-surface-2',
                      it.disabled && 'cursor-not-allowed opacity-55',
                    )}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void pick(it)}
                  >
                    {it.kind === 'char' && <SoloAvatar id={it.avatarId} size="sm" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base text-fg-1">{it.title}</span>
                      {it.sub && <span className="block truncate text-xs text-fg-3">{it.sub}</span>}
                    </span>
                    {it.disabledText && <span className="shrink-0 text-xs text-fg-3">{it.disabledText}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="px-3 py-3 text-sm text-fg-3">
                {typing || active.isFetching ? (
                  '正在搜…'
                ) : bgmDown ? (
                  <span className="flex flex-wrap items-center gap-2">
                    Bangumi 连不上，可以关掉在线搜索用本地搜索
                    <Button size="sm" variant="secondary" onMouseDown={(e) => e.preventDefault()} onClick={() => setSettings({ bgmSearch: false })}>
                      关掉在线搜索
                    </Button>
                  </span>
                ) : err ? (
                  `没搜成：${errorText(err)}`
                ) : view === 'char' ? (
                  <>没找到。可以按 → 或点「作品」，从作品里找。</>
                ) : view === 'works' ? (
                  '没找到这部作品'
                ) : (
                  '这部作品下没有角色'
                )}
              </div>
            )}
            {exactOnly && !typing && (
              <div data-solo-exact-only className="border-t border-border px-3 py-1.5 text-xs text-fg-3">
                容错搜索还在准备，这次只按原名精确搜
              </div>
            )}
          </div>
        )}
      </div>
      <SearchViewToggle
        view={view}
        disabled={!enabled}
        onPick={(v) => {
          if (v === 'char') toChars()
          else if (view === 'char') toWorks()
          inputRef.current?.focus()
        }}
      />
    </div>
  )
}

/**
 * 「角色 | 作品」两段式切换。当前那段高亮；作品的角色列表也算「作品」。
 * 按下时不抢输入框的焦点（onMouseDown preventDefault），键盘用 →/← 切换。
 */
function SearchViewToggle({ view, disabled, onPick }: { view: SearchView; disabled: boolean; onPick: (v: 'char' | 'works') => void }) {
  const cur = view === 'char' ? 'char' : 'works'
  const opts = [
    { v: 'char' as const, label: '角色', title: '按名字搜角色（在作品列表里、光标在最前时按 ←）' },
    { v: 'works' as const, label: '作品', title: '按名字搜作品，再从作品的角色里挑（光标在最后时按 →，或 Shift+Enter）' },
  ]
  return (
    <div
      role="radiogroup"
      aria-label="搜什么"
      data-solo-view-toggle
      className="inline-flex h-12 shrink-0 items-center gap-0.5 rounded-lg bg-surface-2 p-1 ring-1 ring-inset ring-border"
    >
      {opts.map((o) => {
        const on = cur === o.v
        return (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            title={o.title}
            className={cn(
              'inline-flex h-full items-center rounded-md px-3.5 text-base font-medium text-fg-2 transition-[background-color,color,box-shadow] hover:text-fg-1',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
              'disabled:pointer-events-none disabled:opacity-45',
              on && 'bg-surface-1 text-fg-1 shadow-1 ring-1 ring-border-strong',
            )}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(o.v)}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** 搜索框下面的一行按键提示（小、淡，不抢注意力）；←/→ 那一条随搜索状态变 */
export function SearchHints({ canRegrade, view = 'char' }: { canRegrade: boolean; view?: SearchView }) {
  return (
    <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-fg-3">
      <span>
        <Kbd>空格</Kbd> 回到输入框
      </span>
      <span>
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd> 选
      </span>
      <span>
        <Kbd>Enter</Kbd> 猜
      </span>
      <span data-solo-view-hint>
        {view === 'char' ? (
          <>
            <Kbd>→</Kbd> 搜作品
          </>
        ) : view === 'works' ? (
          <>
            <Kbd>←</Kbd> 回到搜角色
          </>
        ) : (
          <>
            <Kbd>←</Kbd> 回到作品列表
          </>
        )}
      </span>
      {canRegrade && (
        <span>
          <Kbd>Alt</Kbd>+<Kbd>1–4</Kbd> 改上一局
        </span>
      )}
    </p>
  )
}
