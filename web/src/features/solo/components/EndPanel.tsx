/**
 * 一局结束：答案卡片（候选池那样的 CharacterCardV2，固定带角色标签；头像跟着设置里的「显示角色头像」开关）。
 * - 手动模式：卡片下面 Easy / Good / Hard / Again，默认选中自动评级；←/→ 换，Enter 或点一个评级开下一局。
 *   选的和自动评级不一样 → 先调 regrade 再开局（game.confirmNext）。
 * - 自动模式（compact）：只显示答案和评级，页面停几秒后自动开下一局；评级在右上角「上一局」里改。
 * 卡片旁边：计时（第 2→3 次…、平均、分界）、怎么结束的、上次出现隔了几局、为什么出这题。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Input'
import { CharacterCardV2 } from '@/features/workbench2/components/CharacterCardV2'
import { GRADES, type EndBlock, type Grade } from '../api'
import { GRADE_HINT, GRADE_LABEL } from '../grades'
import { endedByText, gapView, nameLines, nextGapView, timingLine, timingView } from '../view'

/** 答案的名字（有中文名用中文名） */
const answerName = (end: EndBlock) => nameLines({ name: end.answer_name, name_original: end.name_original, name_cn: end.name_cn }).main

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-fg-3">{label}</dt>
      <dd className="text-sm text-fg-1">{children}</dd>
    </div>
  )
}

export function EndFacts({ end }: { end: EndBlock }) {
  const t = timingView(end.timing, end)
  const next = nextGapView(end.next_gap)
  return (
    <dl className="flex flex-col gap-3">
      <Fact label="怎么结束的">{endedByText(end)}</Fact>
      <Fact label="计时">
        {t.intervals.length > 0 && <span className="block text-fg-2">{t.intervals.join(' · ')}</span>}
        <span className="block">{t.summary}</span>
      </Fact>
      <Fact label="上次出现">{gapView(end)}</Fact>
      <Fact label="为什么出这题">{end.why_label || end.why || '—'}</Fact>
      {next && (
        <Fact label={`按 ${GRADE_LABEL[end.grade] ?? end.grade} 算`}>
          <span className="text-fg-2">{next}</span>
        </Fact>
      )}
    </dl>
  )
}

export function GradePicker({ value, auto, onPick, disabled }: { value: Grade; auto: Grade; onPick: (g: Grade) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="这一局的评级" className="flex flex-wrap items-center gap-2">
      {GRADES.map((g) => {
        const on = g === value
        return (
          <Button
            key={g}
            role="radio"
            aria-checked={on}
            variant={on ? 'primary' : 'secondary'}
            size="lg"
            disabled={disabled}
            title={GRADE_HINT[g]}
            className={cn('min-w-24', !on && 'text-fg-2')}
            onClick={() => onPick(g)}
          >
            <span>{GRADE_LABEL[g]}</span>
            {g === auto && <span className="text-xs font-normal opacity-75">自动</span>}
          </Button>
        )
      })}
    </div>
  )
}

export function EndPanel({
  end,
  chosen,
  busy,
  onChoose,
  onConfirm,
}: {
  end: EndBlock
  chosen: Grade
  busy: boolean
  onChoose: (g: Grade) => void
  onConfirm: (g: Grade) => void
}) {
  // 结算出来时把焦点放到这里（输入框已经收起），←/→ / Enter 由页面的全局按键处理；
  // 卡片上沿在视野外（之前往下滚过表格）就滚回来，让「答案是…」和评级按钮都看得见
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    if (el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [end.round_id])

  return (
    <section ref={ref} tabIndex={-1} aria-label={`答案是 ${answerName(end)}`} className="flex scroll-mt-[calc(var(--shell-sticky-top,0px)+var(--space-unit)*4)] flex-col gap-4 outline-none">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-xl text-fg-1">答案是 {answerName(end)}</h2>
        <span className={cn('text-sm', end.ended_by === 'surrender' || end.again_locked ? 'text-fg-3' : 'text-success-fg')}>{endedByText(end)}</span>
      </header>
      <div className="grid items-start gap-4 @3xl/solo:grid-cols-[minmax(0,1fr)_16rem]">
        <CharacterCardV2 item={end.card} showCharTags />
        <div className="rounded-lg bg-surface-2 p-4">
          <EndFacts end={end} />
        </div>
      </div>
      <div className="flex flex-col items-center gap-2">
        <GradePicker
          value={chosen}
          auto={end.grade_auto}
          disabled={busy}
          onPick={(g) => {
            onChoose(g)
            onConfirm(g)
          }}
        />
        <p className="flex flex-wrap items-center justify-center gap-x-3 text-xs text-fg-3">
          <span>
            <Kbd>←</Kbd>
            <Kbd>→</Kbd> 换评级
          </span>
          <span>
            <Kbd>Enter</Kbd> 或点一个评级：开下一局
          </span>
        </p>
      </div>
    </section>
  )
}

/**
 * 自动模式：答案 + 评级 + 这局的计时（每段间隔、平均，方便试分界秒数合不合适），停几秒后自动开下一局。
 * grade = 当前要记的评级（手动结算里选了还没确认就切到自动时，是选的那个）。
 */
export function AutoEndCard({ end, grade, staySec }: { end: EndBlock; grade: Grade; staySec: number }) {
  return (
    <section aria-live="polite" className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-lg text-fg-1">答案是 {answerName(end)}</h2>
          <span className="text-sm text-fg-2">
            {endedByText(end)} · 评级 {GRADE_LABEL[grade]}
          </span>
          <span className="text-xs text-fg-3">{staySec} 秒后开下一局</span>
        </div>
        <p className="text-sm text-fg-2 tabular">
          <span className="text-fg-3">计时 </span>
          {timingLine(end)}
        </p>
      </header>
      <CharacterCardV2 item={end.card} showCharTags compact />
    </section>
  )
}
