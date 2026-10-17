/**
 * 顶部的 AI 输入条：「用一句话说你想出什么题」→ AI 直接把方案填进下面的工作台，
 * 结果卡列出「你说的 / 我改了 / 沿用默认 / 另一种理解」，可以采用、在此基础上再改、撤销。
 * AI 用不了（/v2/ai/status）时输入条写原因，不报错。
 *
 * 走流式接口，进行中显示秒数（到 0.1 秒）和进度（AI 在想 / 在写 N 字 / 后端在核对）；
 * 用 Claude 命令行时，打开工作台、点进输入框会预热（后端提前开好 claude 进程）；库里没有的标签名在结果卡上给替换按钮。
 */
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { fmtInt, fmtMs } from '@/lib/format'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Controls'
import { IconAlert, IconArrowRight, IconCheck, IconInfo, IconLoader, IconPencil, IconSparkles, IconUndo, IconWand, IconX } from '@/lib/icons'
import { useAiAvailability } from '@/features/v2/hooks'
import { engineOptionLabel, unavailableText } from '@/features/v2/aiAvailability'
import { GoSettings } from '@/features/ai/GoSettings'
import type { AiEngineId, AiNameCandidate, AiNameStyle } from '@/features/v2/types'
import { specFingerprint } from '../spec'
import { useWb2 } from '../store'
import { nameKey, useAiFill } from '../ai'

const EXAMPLES = ['2024 年的百合番角色，别太冷门', '近 5 年热门游戏的女主角', '最早登场在 2010 年以前的主角，排除男性']

/** 从 since 开始过了多少秒（0.1 秒一跳；since 为 null 时不计时） */
function useSeconds(since: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since == null) return
    const t = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(t)
  }, [since])
  return since == null ? 0 : Math.max(0, (now - since) / 1000)
}

function stageText(stage: string, message: string, chars: number): string {
  if (stage === 'writing') return chars > 0 ? `AI 在写（已写 ${fmtInt(chars)} 字）` : 'AI 在写'
  if (stage === 'thinking') return 'AI 在想'
  return message
}

export function AiBar() {
  const ai = useAiAvailability()
  const pending = useAiFill((s) => s.pending)
  const error = useAiFill((s) => s.error)
  const draft = useAiFill((s) => s.draft)
  const setDraft = useAiFill((s) => s.setDraft)
  const start = useAiFill((s) => s.start)
  const cancel = useAiFill((s) => s.cancel)
  const clearError = useAiFill((s) => s.clearError)
  const focusNonce = useAiFill((s) => s.focusNonce)
  const warm = useAiFill((s) => s.warm)
  const [engine, setEngine] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const secs = useSeconds(pending?.startedAt ?? null)
  const eng = (engine && ai.engines.some((e) => e.id === engine) ? engine : ai.defaultEngine) as AiEngineId | null

  useEffect(() => {
    if (focusNonce > 0) inputRef.current?.focus()
  }, [focusNonce])

  // 选的是 Claude 命令行时，打开工作台就让后端提前开好 claude 进程（API 和 codex 没有预热，warmAi 不发请求）
  useEffect(() => {
    if (ai.ready && eng) warm(eng)
  }, [ai.ready, eng, warm])

  const submit = () => {
    if (!ai.ready || pending || !draft.trim()) return
    start(draft, eng)
  }

  return (
    <Card className="p-4" data-slot="ai-bar">
      <div className="flex flex-col gap-3">
        <form
          className="flex flex-col gap-2 @2xl/main:flex-row @2xl/main:items-center"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <label htmlFor="wb2-ai-input" className="flex shrink-0 items-center gap-2 text-sm font-medium text-fg-1">
            <span className="grid size-7 place-items-center rounded-md bg-primary-100 text-primary-700 [&_svg]:size-4">
              <IconSparkles aria-hidden />
            </span>
            用一句话说你想出什么题
          </label>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <input
              id="wb2-ai-input"
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={() => ai.ready && eng && warm(eng)}
              disabled={!ai.ready || !!pending}
              maxLength={300}
              placeholder={ai.ready ? `例：${EXAMPLES[0]}` : ai.loading ? '正在看 AI 能不能用…' : 'AI 现在用不了（原因在下面）'}
              className={cn(
                'h-[var(--control-h-md)] min-w-0 flex-1 rounded-md border border-border-strong bg-surface-1 px-3 text-base text-fg-1',
                'hover:border-fg-3 focus-visible:border-primary-500 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-primary-200',
                'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-3',
              )}
            />
            {ai.engines.length > 1 && (
              <div className="w-48 shrink-0">
                <Select
                  value={eng ?? undefined}
                  onChange={setEngine}
                  options={ai.engines.map((e) => ({ value: e.id, label: engineOptionLabel(e.id, e.label) }))}
                  aria-label="用哪个 AI"
                  disabled={!!pending}
                />
              </div>
            )}
            {pending ? (
              <Button variant="secondary" icon={<IconX />} onClick={cancel}>
                取消
              </Button>
            ) : (
              <Button type="submit" variant="soft" icon={<IconSparkles />} disabled={!ai.ready || !draft.trim()}>
                让 AI 填
              </Button>
            )}
          </div>
        </form>

        {pending ? (
          <div className="flex flex-col gap-2" role="status" data-slot="ai-pending">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-2">
              <IconLoader className="size-4 animate-spin text-primary" aria-hidden />
              AI 正在按「{pending.text}」填工作台
              <span className="tabular font-medium text-fg-1">{secs.toFixed(1)} 秒</span>
            </p>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
              <span className="text-fg-2">{stageText(pending.stage, pending.message, pending.chars)}</span>
              {pending.engine === 'codex' && <span>Codex 较慢：没有预热，也不能边写边显示</span>}
              <span>AI 填完会整个换掉下面的设置（换掉之前的样子可以撤销回来），这期间先别改</span>
            </p>
            <div className="h-1 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full w-1/3 animate-[ai-progress_1.6s_ease-in-out_infinite] rounded-full bg-primary" />
            </div>
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger-fg">
            <IconAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              AI 没填成（「{error.text}」）：{error.message}
            </span>
            <Button size="sm" variant="ghost" onClick={() => start(error.text, eng)} disabled={!ai.ready}>
              再试一次
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="关掉" onClick={clearError}>
              <IconX />
            </Button>
          </div>
        ) : !ai.ready && !ai.loading ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
            <span>{unavailableText(ai.reason)}。下面的设置照样可以手动改。</span>
            <GoSettings />
          </p>
        ) : (
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-fg-3">
            AI 只改你说到的设置，没说到的保持现在的样子；改了什么都会列出来，不满意可以撤销。试试：
            {EXAMPLES.map((x) => (
              <button
                key={x}
                type="button"
                disabled={!ai.ready}
                onClick={() => setDraft(x)}
                className="rounded-full px-2 py-0.5 text-fg-2 ring-1 ring-inset ring-border hover:bg-surface-2 hover:text-fg-1 disabled:opacity-50"
              >
                {x}
              </button>
            ))}
          </p>
        )}
      </div>
    </Card>
  )
}

/** 一排「换成 X」按钮（候选名字 + 库里的数量） */
function NameChoices({
  candidates,
  onPick,
  current,
}: {
  candidates: AiNameCandidate[]
  onPick: (name: string) => void
  current?: string | null
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {candidates.map((c) => (
        <button
          key={c.name}
          type="button"
          onClick={() => onPick(c.name)}
          disabled={c.name === current}
          title={`换成『${c.name}』（库里 ${fmtInt(c.count)} 个）`}
          className="rounded-full bg-surface-1 px-2 py-0.5 text-xs text-fg-1 ring-1 ring-inset ring-border-strong hover:bg-primary-100 hover:text-primary-800 disabled:cursor-default disabled:bg-primary-100 disabled:text-primary-800"
        >
          {c.name}
          <span className="tabular ml-1 text-fg-3">{fmtInt(c.count)}</span>
        </button>
      ))}
    </span>
  )
}

/** 结果卡里「标签名」这一块：后端已经自动换好的 + 拿不准、等你选的 */
function NameFixes() {
  const result = useAiFill((s) => s.result)
  const applyNameFix = useAiFill((s) => s.applyNameFix)
  if (!result) return null
  const replaced = result.resp.tag_replaced ?? []
  const fixes = result.resp.tag_fixes ?? []
  if (!replaced.length && !fixes.length) return null
  const nowOf = (style: AiNameStyle, original: string, fallback: string) => result.fixed[nameKey(style, original)] ?? fallback
  return (
    <div className="flex flex-col gap-2 text-sm" data-slot="ai-name-fixes">
      {replaced.map((r) => {
        const now = nowOf(r.style, r.from, r.to)
        const picked = now !== r.to
        // 可以改选的：后端换成的那个 + 其它相近写法，去掉现在用着的
        const choices = [{ name: r.to, count: r.to_count ?? 0 }, ...r.others].filter((c) => c.name !== now)
        return (
          <div key={nameKey(r.style, r.from)} className="flex flex-wrap items-start gap-x-2 gap-y-1 rounded-md bg-info-bg px-3 py-2 text-info-fg">
            <IconInfo className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              {picked ? `${r.what}『${r.from}』库里没有，已经换成『${now}』` : r.message}
              {choices.length > 0 && (
                <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-fg-2">{picked ? '也可以换成：' : '不对？换成：'}</span>
                  <NameChoices candidates={choices} onPick={(name) => applyNameFix(r.style, now, name, r.from)} />
                </span>
              )}
            </span>
          </div>
        )
      })}
      {fixes.map((f) => {
        const now = nowOf(f.style, f.name, f.name)
        const done = now !== f.name
        const choices = f.candidates.filter((c) => c.name !== now)
        return (
          <div
            key={nameKey(f.style, f.name)}
            className={cn('flex flex-wrap items-start gap-x-2 gap-y-1 rounded-md px-3 py-2', done ? 'bg-success-bg text-success-fg' : 'bg-warning-bg text-warning-fg')}
          >
            {done ? <IconCheck className="mt-0.5 size-4 shrink-0" aria-hidden /> : <IconWand className="mt-0.5 size-4 shrink-0" aria-hidden />}
            <span className="min-w-0 flex-1">
              {done ? `${f.what}『${f.name}』库里没有，已经换成『${now}』` : `${f.what}『${f.name}』库里没有，这个条件现在筛不出人。`}
              {choices.length > 0 ? (
                <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-fg-2">{done ? '也可以换成：' : '点一下换成：'}</span>
                  <NameChoices candidates={choices} onPick={(name) => applyNameFix(f.style, now, name, f.name)} />
                </span>
              ) : (
                !done && <span className="mt-0.5 block text-xs text-fg-2">库里也没有相近的写法：去下面的条件里手动改掉或删掉它。</span>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function AiResultCard() {
  const ai = useAiAvailability()
  const result = useAiFill((s) => s.result)
  const accept = useAiFill((s) => s.accept)
  const refine = useAiFill((s) => s.refine)
  const revert = useAiFill((s) => s.revert)
  const switchTo = useAiFill((s) => s.switchTo)
  const fp = useWb2((s) => specFingerprint(s.spec))
  if (!result) return null
  const r = result.resp
  const alt = r.alternative ?? null
  // 后端给的 label 自己可能就以「另一种理解：」开头，别重复
  const altLabel = alt ? alt.label.replace(/^\s*另一种理解[：:]\s*/, '') : ''
  const usingAlt = result.using === 'alt'
  const mainTotal = result.totals.main !== undefined ? result.totals.main : r.total
  const altTotal = alt ? (result.totals.alt !== undefined ? result.totals.alt : alt.total) : null
  const total = usingAlt && alt ? altTotal : mainTotal
  const editedAfter = fp !== result.appliedFp
  // 标签名的提示在上面单独一块（带按钮），warnings 里说同一个名字「库里没有 / 不存在」的话不重复显示
  const nameMsgs = new Set((r.tag_fixes ?? []).map((f) => f.message))
  const fixNames = (r.tag_fixes ?? []).map((f) => `『${f.name}』`)
  const warnings = (r.warnings ?? []).filter((w) => !nameMsgs.has(w) && !fixNames.some((n) => w.includes(n) && w.includes('不存在')))
  // 点过「换成 X」之后，下面的建议人数还是按换之前的方案算的：标出来
  const stale = Object.keys(result.fixed).length > 0
  // 有「放宽 / 收紧办法」列表时只显示 AI 自己的话（ai_note）：后端的模板句（note）和下面的列表是同一组建议，不显示两遍
  const noteText = r.suggestions?.length ? r.ai_note : r.note

  if (editedAfter)
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-1 px-4 py-2.5 text-sm text-fg-2 shadow-1">
        <IconSparkles className="size-4 shrink-0 text-primary-700" aria-hidden />
        <span className="min-w-0 flex-1">AI 按「{result.text}」填的方案在下面，你之后又改过（要回到之前，用页头的「撤销」）。</span>
        <Button size="icon-sm" variant="ghost" aria-label="关掉" onClick={accept}>
          <IconX />
        </Button>
      </div>
    )

  return (
    <Card ornament="featured" className="p-5" data-slot="ai-result">
      <div className="relative z-[1] flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-base font-semibold text-fg-1">
              <IconSparkles className="size-4 text-primary-700" aria-hidden />
              {usingAlt ? 'AI 换成了另一种理解' : 'AI 按你的话填好了'}
            </p>
            <p className="mt-1 text-sm text-fg-2">
              你说的：<span className="text-fg-1">「{result.text}」</span>
            </p>
          </div>
          <div className="text-right">
            {result.recounting ? (
              <span className="inline-flex items-center gap-1 text-sm text-fg-2">
                <IconLoader className="size-4 animate-spin" aria-hidden />
                重新算人数
              </span>
            ) : (
              <>
                <span className="tabular text-2xl font-semibold text-fg-1">{fmtInt(total)}</span>
                <span className="ml-1 text-sm text-fg-2">人</span>
              </>
            )}
            <p className="text-xs text-fg-3" title={r.engine === 'claude' && r.warm === false ? '这次没有预热好的 AI 进程，现开了一个' : undefined}>
              {ai.labelOf(r.engine)} · 共 {fmtMs(r.elapsed_ms)}
              {r.ai_first_token_ms != null && r.ai_total_ms != null && (
                <span className="block">
                  AI 第一个字 {fmtMs(r.ai_first_token_ms)} · 写完 {fmtMs(r.ai_total_ms)}
                </span>
              )}
            </p>
          </div>
        </div>

        {usingAlt && alt ? (
          <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-fg-1">现在用的是另一种理解：{altLabel}</p>
        ) : (
          <dl className="grid gap-x-4 gap-y-2 text-sm @xl/main:grid-cols-[5rem_minmax(0,1fr)]">
            <dt className="font-medium text-fg-2">我改了</dt>
            <dd className="min-w-0">
              {r.changes.length ? (
                <ul className="flex flex-col gap-1">
                  {r.changes.map((c, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-fg-1">
                      <IconPencil className="mt-1 size-3.5 shrink-0 text-primary-700" aria-hidden />
                      {c}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-fg-3">什么都没改（你说的就是现在的设置）</span>
              )}
            </dd>
            <dt className="font-medium text-fg-2">沿用默认</dt>
            <dd className="min-w-0 text-fg-2">{r.defaults_used.length ? r.defaults_used.join(' · ') : '—'}</dd>
          </dl>
        )}
        <NameFixes />
        {stale && (noteText || !!r.suggestions?.length) && (
          <p className="text-xs text-fg-3">下面的人数是按换名字之前的方案算的，仅供参考（现在的人数看右上角和工作台）。</p>
        )}
        {noteText && <p className={cn('rounded-md bg-info-bg px-3 py-2 text-sm text-info-fg', stale && 'opacity-60')}>{noteText}</p>}
        {!!r.suggestions?.length && (
          <div className={cn('rounded-md bg-surface-2 px-3 py-2 text-sm text-fg-2', stale && 'opacity-60')}>
            <p className="text-xs font-medium text-fg-3">后端算好的放宽 / 收紧办法（照着手动改就行）：</p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {r.suggestions.map((s, i) => (
                <li key={i}>
                  {s.desc}
                  <span className="tabular ml-1.5 text-fg-3">→ {fmtInt(s.total)} 人</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!!warnings.length && (
          <ul className="flex flex-col gap-1 rounded-md bg-warning-bg px-3 py-2 text-xs text-warning-fg">
            {warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <IconAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                {w}
              </li>
            ))}
          </ul>
        )}

        {alt && (
          <div className="flex flex-col gap-2 rounded-md border border-dashed border-border-strong px-3 py-2.5">
            <p className="text-sm text-fg-2">
              <span className="font-medium text-fg-1">{usingAlt ? '第一种理解' : '还有另一种理解'}</span>
              <span className="tabular ml-1.5">（{result.recounting ? '…' : fmtInt(usingAlt ? mainTotal : altTotal)} 人）</span>
              {!usingAlt && <span className="mt-0.5 block text-fg-2">{altLabel}</span>}
            </p>
            <Button size="sm" variant="secondary" className="self-start" onClick={() => switchTo(usingAlt ? 'main' : 'alt')}>
              {usingAlt ? '换回第一种理解' : '换成这种理解'}
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="soft" icon={<IconCheck />} onClick={accept}>
            采用
          </Button>
          <Button variant="secondary" icon={<IconArrowRight />} onClick={refine}>
            在此基础上再改
          </Button>
          <Button variant="ghost" icon={<IconUndo />} onClick={revert}>
            撤销
          </Button>
        </div>
      </div>
    </Card>
  )
}
