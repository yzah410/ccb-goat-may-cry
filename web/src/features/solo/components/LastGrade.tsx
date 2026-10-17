/**
 * 自动模式右上角「上一局：Good」：这一局里随时可以改上一局的评级。
 * - 鼠标：点一个评级
 * - 键盘：在输入框里按 Tab 跳到这里，←/→ 改，Enter / Esc 回到输入框；或者在输入框里直接 Alt+1/2/3/4
 * ←/→ 连按时只在停下 0.4 秒后发一次请求（免得几个请求先后乱序）。
 * 父组件用 key={last.round_id}：换了一局就重新开始（丢掉没发出的改动）。
 * 鼠标移到「上一局 名字」上能看到这局的计时（自动模式的结算卡片只停一两秒）。
 */
import { useEffect, useRef, useState, type Ref } from 'react'
import { cn } from '@/lib/cn'
import { GRADES, type Grade } from '../api'
import type { LastRound } from '../game'
import { GRADE_HINT, GRADE_LABEL, stepGrade } from '../grades'
import { lastGradeKeyAction } from '../keyboard'

const DEBOUNCE_MS = 400

export function LastGrade({ last, onRegrade, onBack, ref }: { last: LastRound; onRegrade: (g: Grade) => void; onBack: () => void; ref?: Ref<HTMLDivElement> }) {
  const [pending, setPending] = useState<Grade | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shown = pending ?? last.grade

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const commit = (g: Grade, delay: number) => {
    setPending(g)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      setPending(null)
      onRegrade(g)
    }, delay)
  }

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={`上一局（${last.name}）的评级，←/→ 改，Enter 回到输入框`}
      tabIndex={0}
      data-solo-own-keys
      className="flex items-center gap-2 rounded-md px-1 py-0.5 text-xs text-fg-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onKeyDown={(e) => {
        const a = lastGradeKeyAction({ key: e.key, code: e.code, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing })
        if (!a) return
        e.preventDefault()
        if (a.type === 'step') commit(stepGrade(shown, a.dir), DEBOUNCE_MS)
        else if (a.type === 'set') commit(a.grade, 0)
        else onBack()
      }}
    >
      <span className="max-w-40 cursor-help truncate" title={`${last.name}\n计时：${last.timing}`}>
        上一局 {last.name}：
      </span>
      <span className="flex items-center gap-0.5">
        {GRADES.map((g) => (
          <button
            key={g}
            type="button"
            role="radio"
            aria-checked={g === shown}
            tabIndex={-1}
            title={`${GRADE_HINT[g]}${g === last.grade_auto ? '（自动评级）' : ''}`}
            className={cn(
              'rounded-sm px-1.5 py-0.5 transition-colors',
              g === shown ? 'bg-surface-3 font-medium text-fg-1 ring-1 ring-inset ring-border-strong' : 'hover:bg-surface-2 hover:text-fg-2',
            )}
            onClick={() => commit(g, 0)}
          >
            {GRADE_LABEL[g]}
          </button>
        ))}
      </span>
      {last.saving && <span aria-live="polite">保存中…</span>}
    </div>
  )
}
