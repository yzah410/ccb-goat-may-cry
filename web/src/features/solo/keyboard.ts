/**
 * 键盘：纯函数（按键 + 当前状态 → 要做什么），组件里只负责执行。
 *
 * 全局（window keydown）：
 * - 猜测中：空格（焦点不在输入框里）→ 聚焦搜索框（和猜猜呗游戏一样）
 * - 手动模式结算：←/→ 切换评级，Enter 开下一局
 * 搜索框里：
 * - ↑/↓ 选下拉里的项（到头停住，不循环；起点是「没选」；跳过选不了的项）
 * - Enter 猜选中的那个；没选中就什么都不做（和猜猜呗游戏一样，不会误猜）
 * - Esc 收起下拉
 * - Shift+Enter = 用当前文字搜作品（和 → 切到「搜作品」一样）
 * - 两种搜索状态（可以纯键盘搜作品）：
 *   - 「搜角色」里光标在最后（空输入框也算）按 → → 切到「搜作品」，文字保留、马上按作品名搜
 *   - 「搜作品」的作品列表里已经选中一部作品时，→ = Enter（进入这部作品的角色列表）
 *   - 作品的角色列表里按 ← → 回到作品列表（不管光标在哪）
 *   - 作品列表里光标在最前（空输入框也算）按 ← → 回到「搜角色」，文字保留、按角色重新搜
 *   - 其他情况的 ←/→ 照常移动光标；Shift+←/→（选文字）不处理
 * - 自动模式：Alt+1/2/3/4 把上一局改成 Easy/Good/Hard/Again；Tab 跳到「上一局」评级
 * 中文输入法正在拼字（isComposing）时一律不处理。
 */
import type { Grade } from './api'
import { gradeFromDigit } from './grades'
import type { SearchView } from './search'

export interface KeyLike {
  key: string
  code?: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
  /** 按住不放时的自动重复 */
  repeat?: boolean
}

/** 正在用输入法拼字：Enter / 方向键是给输入法的 */
export function composing(e: KeyLike): boolean {
  return !!e.isComposing || e.key === 'Process'
}

/** 焦点所在元素的种类（组件里从 event.target 算出来） */
export interface TargetInfo {
  /** input / textarea / select / contenteditable */
  editable: boolean
  /** 在弹窗、下拉菜单、设置面板里（那里的方向键 / 回车归它们自己） */
  inOverlay: boolean
}

export function targetInfo(t: EventTarget | null): TargetInfo {
  const el = t as (Partial<HTMLElement> & { closest?: (s: string) => Element | null }) | null
  if (!el || typeof el !== 'object') return { editable: false, inOverlay: false }
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  const editable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
  const inOverlay =
    typeof el.closest === 'function' &&
    !!el.closest('[role="dialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper],[data-solo-own-keys]')
  return { editable, inOverlay }
}

export type GlobalAction = { type: 'focus-search' } | { type: 'grade-step'; dir: -1 | 1 } | { type: 'confirm' } | null

export function globalKeyAction(e: KeyLike, ctx: { phase: string; manualEnd: boolean; target: TargetInfo }): GlobalAction {
  if (composing(e) || e.ctrlKey || e.metaKey || e.altKey) return null
  if (ctx.target.editable || ctx.target.inOverlay) return null
  if (ctx.phase === 'playing') {
    if ((e.key === ' ' || e.code === 'Space') && !e.shiftKey) return { type: 'focus-search' }
    return null
  }
  if (ctx.phase === 'ended' && ctx.manualEnd) {
    if (e.key === 'ArrowLeft') return { type: 'grade-step', dir: -1 }
    if (e.key === 'ArrowRight') return { type: 'grade-step', dir: 1 }
    // 按住 Enter 猜中时，自动重复的 Enter 不能顺手把结算卡片跳过去
    if (e.key === 'Enter') return e.repeat ? null : { type: 'confirm' }
  }
  return null
}

export type SearchAction =
  | { type: 'move'; index: number }
  | { type: 'pick'; index: number }
  | { type: 'regrade'; grade: Grade }
  | { type: 'focus-last' }
  | { type: 'close' }
  | { type: 'search-works' }
  /** 「搜角色」→「搜作品」（文字保留） */
  | { type: 'to-works' }
  /** 作品列表 →「搜角色」（文字保留） */
  | { type: 'to-chars' }
  /** 作品的角色列表 → 作品列表 */
  | { type: 'back-to-works' }
  | null

/** 输入框里光标的位置（selectionStart / selectionEnd / value.length） */
export interface Caret {
  start: number | null
  end: number | null
  length: number
}

/** 光标在最后、没有选中文字（空输入框也算） */
export function caretAtEnd(c: Caret | undefined): boolean {
  return !!c && c.start === c.length && c.end === c.length
}

/** 光标在最前、没有选中文字（空输入框也算） */
export function caretAtStart(c: Caret | undefined): boolean {
  return !!c && c.start === 0 && c.end === 0
}

/** 从 from 往 dir 方向找下一个能选的项；找不到 → 原地不动 */
export function nextEnabled(items: readonly { disabled?: boolean }[], from: number, dir: -1 | 1): number {
  for (let i = from + dir; i >= 0 && i < items.length; i += dir) if (!items[i]?.disabled) return i
  return from
}

/** Alt+数字：有的键盘布局按住 Alt 时 key 不是数字，所以先看 code（Digit1 / Numpad1） */
function altDigitGrade(e: KeyLike): Grade | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null
  const m = /^(?:Digit|Numpad)([1-4])$/.exec(e.code ?? '')
  return gradeFromDigit(m ? m[1]! : e.key)
}

export function searchKeyAction(
  e: KeyLike,
  ctx: {
    items: readonly { disabled?: boolean }[]
    index: number
    open: boolean
    canRegrade: boolean
    /** 现在是哪种搜索状态；不给 = 搜角色 */
    view?: SearchView
    /** 不给 = 不知道光标在哪：←/→ 一律照常移动光标 */
    caret?: Caret
  },
): SearchAction {
  if (composing(e)) return null
  const g = altDigitGrade(e)
  if (g) return ctx.canRegrade ? { type: 'regrade', grade: g } : null
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  if (e.key === 'Tab' && !e.shiftKey) return ctx.canRegrade ? { type: 'focus-last' } : null
  if (e.key === 'Escape') return ctx.open ? { type: 'close' } : null
  if (e.key === 'Enter' && e.shiftKey) return { type: 'search-works' }
  if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.shiftKey) return arrowAction(e.key, ctx)
  if (!ctx.open || ctx.items.length === 0) return null
  if (e.key === 'ArrowDown') return { type: 'move', index: nextEnabled(ctx.items, ctx.index, 1) }
  if (e.key === 'ArrowUp') return { type: 'move', index: ctx.index < 0 ? ctx.index : nextEnabled(ctx.items, ctx.index, -1) }
  if (e.key === 'Enter') {
    const it = ctx.items[ctx.index]
    return ctx.index >= 0 && it && !it.disabled ? { type: 'pick', index: ctx.index } : null
  }
  return null
}

/** ←/→ 在搜索框里：切换搜索状态，或者照常移动光标（null） */
function arrowAction(
  key: 'ArrowRight' | 'ArrowLeft',
  ctx: { items: readonly { disabled?: boolean }[]; index: number; open: boolean; view?: SearchView; caret?: Caret },
): SearchAction {
  const view = ctx.view ?? 'char'
  if (key === 'ArrowRight') {
    if (view === 'char') return caretAtEnd(ctx.caret) ? { type: 'to-works' } : null
    if (view === 'works') {
      const it = ctx.items[ctx.index]
      return ctx.open && ctx.index >= 0 && it && !it.disabled ? { type: 'pick', index: ctx.index } : null
    }
    return null
  }
  if (view === 'work-chars') return { type: 'back-to-works' }
  if (view === 'works') return caretAtStart(ctx.caret) ? { type: 'to-chars' } : null
  return null
}

/** 「上一局」评级控件（自动模式，Tab 进来）：←/→ 改，Enter / Esc 回到搜索框 */
export type LastGradeAction = { type: 'step'; dir: -1 | 1 } | { type: 'back' } | { type: 'set'; grade: Grade } | null

export function lastGradeKeyAction(e: KeyLike): LastGradeAction {
  if (composing(e)) return null
  const g = altDigitGrade(e)
  if (g) return { type: 'set', grade: g }
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  if (e.key === 'ArrowLeft') return { type: 'step', dir: -1 }
  if (e.key === 'ArrowRight') return { type: 'step', dir: 1 }
  if (e.key === 'Enter' || e.key === 'Escape') return { type: 'back' }
  return null
}
