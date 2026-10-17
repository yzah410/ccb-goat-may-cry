/**
 * 问数据（/ask）：一句话 → AI 边写边显示「说明 / 统计范围 / SQL」→ 写完后端自动在只读数据库上运行 → 结果表。
 * 显示「AI x.x 秒 · SQL y 毫秒」。SQL 报错时显示错误和「让 AI 改」按钮（不会自动重试）。
 * SQL 可以改了自己重跑（POST /v2/sql）；结果能存成清单，或者把 SQL 存成工作台某个范围的条件。
 * 右边是表结构参考（GET /v2/sql/schema），方便对照着写或改 SQL。用 Claude 命令行时，打开这一页后端提前开好 claude 进程（预热）。
 */
import { useEffect, useRef, useState } from 'react'
import { PageHeader } from '@/app/shell/PageHeader'
import { cn } from '@/lib/cn'
import { copyText } from '@/lib/clipboard'
import { fmtMs } from '@/lib/format'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Select } from '@/components/ui/Controls'
import { Textarea } from '@/components/ui/Input'
import { toast } from '@/components/ui/Toast'
import { EmptyState } from '@/components/data-display/Misc'
import {
  IconAlert,
  IconCopy,
  IconHistory,
  IconInfo,
  IconListPlus,
  IconLoader,
  IconMessageQuestion,
  IconPlay,
  IconPlus,
  IconSparkles,
  IconTable,
  IconWand,
  IconX,
} from '@/lib/icons'
import { useAiAvailability } from '@/features/v2/hooks'
import { engineOptionLabel, unavailableText } from '@/features/v2/aiAvailability'
import type { AiEngineId } from '@/features/v2/types'
import { GoSettings } from '@/features/ai/GoSettings'
import { useAsk } from '@/features/ask/store'
import { parseAskDraft } from '@/features/ask/draft'
import { ResultTable } from '@/features/ask/components/ResultTable'
import { SchemaPanel } from '@/features/ask/components/SchemaPanel'
import { SaveConditionDialog, SaveListDialog } from '@/features/ask/components/SaveDialogs'

const EXAMPLES = ['「百合」这个标签在多少部动画里出现？', '作品标签同时有「百合」和「校园」的动画主角', '2024 年登场的动画主角里，热度最高的 20 个']

/** 从 since 开始过了多少秒（0.1 秒一跳） */
function useSeconds(since: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since == null) return
    const t = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(t)
  }, [since])
  return since == null ? 0 : Math.max(0, (now - since) / 1000)
}

/** 选中的 AI（问题卡和「让 AI 改」共用） */
function useEngine(): { eng: AiEngineId | null; setEngine: (v: string | null) => void; ai: ReturnType<typeof useAiAvailability> } {
  const ai = useAiAvailability()
  const [engine, setEngine] = useState<string | null>(null)
  const eng = (engine && ai.engines.some((e) => e.id === engine) ? engine : ai.defaultEngine) as AiEngineId | null
  return { eng, setEngine, ai }
}

function stageText(stage: string, message: string, mode: 'ask' | 'fix'): string {
  if (stage === 'writing') return mode === 'fix' ? 'AI 在改 SQL' : 'AI 在写'
  if (stage === 'thinking') return 'AI 在想'
  if (stage === 'sql') return 'AI 写完了，正在只读库上运行 SQL'
  return message
}

function QuestionCard({ eng, setEngine, ai }: ReturnType<typeof useEngine>) {
  const question = useAsk((s) => s.question)
  const setQuestion = useAsk((s) => s.setQuestion)
  const pending = useAsk((s) => s.pending)
  const ask = useAsk((s) => s.ask)
  const cancel = useAsk((s) => s.cancel)
  const history = useAsk((s) => s.history)
  const load = useAsk((s) => s.load)
  const warm = useAsk((s) => s.warm)
  const secs = useSeconds(pending?.startedAt ?? null)
  const submit = () => {
    if (ai.ready && question.trim() && !pending) ask(eng)
  }

  // 选的是 Claude 命令行时，打开问数据页就让后端提前开好 claude 进程（API 和 codex 没有预热，warmAi 不发请求）
  useEffect(() => {
    if (ai.ready && eng) warm(eng)
  }, [ai.ready, eng, warm])

  return (
    <Card className="p-5">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <label htmlFor="ask-q" className="flex items-center gap-2 text-sm font-medium text-fg-1">
          <span className="grid size-7 place-items-center rounded-md bg-primary-100 text-primary-700 [&_svg]:size-4">
            <IconSparkles aria-hidden />
          </span>
          你想知道什么？
        </label>
        <Textarea
          id="ask-q"
          rows={2}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onFocus={() => ai.ready && eng && warm(eng)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          disabled={!!pending}
          maxLength={500}
          placeholder={`例：${EXAMPLES[0]}`}
        />
        <div className="flex flex-wrap items-center gap-2">
          {ai.engines.length > 1 && (
            <div className="w-48">
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
            <Button type="submit" variant="primary" icon={<IconSparkles />} disabled={!ai.ready || !question.trim()}>
              问
            </Button>
          )}
          <span className="text-xs text-fg-3">回车发送，Shift+回车换行</span>
        </div>

        {pending ? (
          <div className="flex flex-col gap-2" role="status">
            <p className="flex flex-wrap items-center gap-x-2 text-sm text-fg-2">
              <IconLoader className="size-4 animate-spin text-primary" aria-hidden />
              {stageText(pending.stage, pending.message, pending.mode)}
              <span className="tabular font-medium text-fg-1">{secs.toFixed(1)} 秒</span>
              {pending.engine === 'codex' && <span className="text-xs text-fg-3">Codex 较慢：没有预热，也不能边写边显示</span>}
            </p>
            <div className="h-1 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full w-1/3 animate-[ai-progress_1.6s_ease-in-out_infinite] rounded-full bg-primary" />
            </div>
          </div>
        ) : !ai.ready && !ai.loading ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
            <span>{unavailableText(ai.reason)}。你还是可以在下面直接写 SQL 跑。</span>
            <GoSettings />
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-3">
            试试：
            {EXAMPLES.map((x) => (
              <button
                key={x}
                type="button"
                onClick={() => setQuestion(x)}
                className="rounded-full px-2 py-0.5 text-fg-2 ring-1 ring-inset ring-border hover:bg-surface-2 hover:text-fg-1"
              >
                {x}
              </button>
            ))}
          </div>
        )}
        {history.length > 0 && !pending && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-3">
            <IconHistory className="size-3.5" aria-hidden />
            最近问过：
            {history.slice(0, 5).map((h) => (
              <button
                key={h.at}
                type="button"
                title={h.sql}
                onClick={() => load(h.question, h.sql)}
                className="max-w-64 truncate rounded-full px-2 py-0.5 text-fg-2 ring-1 ring-inset ring-border hover:bg-surface-2 hover:text-fg-1"
              >
                {h.question}
              </button>
            ))}
          </div>
        )}
      </form>
    </Card>
  )
}

/** AI 正在写：说明、范围、SQL 边写边显示（写完后端自动运行，结果出现在下面的「结果」里） */
function LiveAnswerCard() {
  const pending = useAsk((s) => s.pending)
  if (!pending) return null
  const d = parseAskDraft(pending.text)
  const nothingYet = !d.explanation && !d.scope && !d.sql && !d.unstructured
  return (
    <Card className="p-5" data-slot="ask-live">
      <div className="flex flex-col gap-3" aria-live="polite">
        <div className="flex flex-wrap items-center gap-2">
          <IconSparkles className="size-4 text-primary-700" aria-hidden />
          <span className="text-base font-semibold text-fg-1">{pending.mode === 'fix' ? 'AI 正在改 SQL' : 'AI 正在回答'}</span>
          <span className="text-xs text-fg-3">问题：「{pending.question}」· 写完会自动运行</span>
        </div>
        {pending.fixing && (
          <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-fg-2">
            上一次的报错：<span className="font-mono text-fg-1">{pending.fixing.error}</span>
          </p>
        )}
        {nothingYet ? (
          <p className="text-sm text-fg-3">{pending.warm === false ? '这次没有预热好的 AI 进程，正在现开一个（多等几秒）…' : '等 AI 开口…'}</p>
        ) : d.unstructured ? (
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 px-3 py-2 font-mono text-xs text-fg-2 scroll-thin">{pending.text}</pre>
        ) : (
          <>
            {d.explanation && <p className="whitespace-pre-wrap text-base leading-body text-fg-1">{d.explanation}</p>}
            {d.scope && (
              <div className="flex items-start gap-2 rounded-md bg-warning-bg px-3 py-2.5 text-sm text-warning-fg">
                <IconInfo className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="whitespace-pre-line">
                  <b className="font-semibold">统计范围：</b>
                  {d.scope}
                </span>
              </div>
            )}
            {d.sql && (
              <pre className="max-h-72 overflow-auto rounded-md bg-surface-2 px-3 py-2 font-mono text-sm leading-body text-fg-1 scroll-thin">
                {d.sql}
                {d.sqlOpen && <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-primary align-middle" aria-hidden />}
              </pre>
            )}
          </>
        )}
      </div>
    </Card>
  )
}

function AnswerCard({ eng, labelOf }: { eng: AiEngineId | null; labelOf: (id: string | null | undefined) => string }) {
  const answer = useAsk((s) => s.answer)
  const error = useAsk((s) => s.error)
  const fixable = useAsk((s) => s.fixable)
  const pending = useAsk((s) => s.pending)
  const fix = useAsk((s) => s.fix)
  const clearError = () => useAsk.setState({ error: null, fixable: null })
  if (pending) return null
  const aiSecs = answer?.ai_total_ms != null ? answer.ai_total_ms / 1000 : null
  return (
    <>
      {error && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-danger-bg px-4 py-3 text-sm text-danger-fg" data-slot="ask-error">
          <div className="flex items-start gap-2">
            <IconAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{error}</span>
            <Button size="icon-sm" variant="ghost" aria-label="关掉" onClick={clearError}>
              <IconX />
            </Button>
          </div>
          {fixable && (
            <div className="flex flex-wrap items-center gap-2 pl-6">
              <Button size="sm" variant="soft" icon={<IconWand />} onClick={() => fix(eng)}>
                让 AI 改
              </Button>
              <span className="text-xs text-fg-2">把这段 SQL 和报错发给 AI，改好后自动再运行一次；也可以自己在下面的编辑框里改</span>
            </div>
          )}
        </div>
      )}
      {answer && (
        <Card className="p-5" data-slot="ask-answer">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <IconSparkles className="size-4 text-primary-700" aria-hidden />
              <span className="text-base font-semibold text-fg-1">{answer.fixed_from ? 'AI 改过的回答' : 'AI 的回答'}</span>
              <span className="text-xs text-fg-3">
                问题：「{answer.question}」 · {labelOf(answer.engine)}
              </span>
              <span className="tabular ml-auto rounded-md bg-surface-2 px-2 py-0.5 text-xs text-fg-2" data-slot="ask-timing">
                AI {aiSecs != null ? `${aiSecs.toFixed(1)} 秒` : fmtMs(answer.elapsed_ms)}
                {' · '}
                {answer.sql_ms != null ? `SQL ${Math.max(1, Math.round(answer.sql_ms))} 毫秒` : 'SQL 没跑成'}
              </span>
            </div>
            {answer.explanation && <p className="whitespace-pre-wrap text-base leading-body text-fg-1">{answer.explanation}</p>}
            {answer.scope_note && (
              <div className="flex items-start gap-2 rounded-md border border-[color-mix(in_oklab,var(--warning)_45%,transparent)] bg-warning-bg px-3 py-2.5 text-sm text-warning-fg">
                <IconInfo className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="whitespace-pre-line">
                  <b className="font-semibold">统计范围：</b>
                  {answer.scope_note.replace(/^\s*统计范围[：:]\s*/, '')}
                </span>
              </div>
            )}
          </div>
        </Card>
      )}
    </>
  )
}

export default function AskPage() {
  const engine = useEngine()
  const sql = useAsk((s) => s.sql)
  const setSql = useAsk((s) => s.setSql)
  const run = useAsk((s) => s.run)
  const running = useAsk((s) => s.running)
  const table = useAsk((s) => s.table)
  const answer = useAsk((s) => s.answer)
  const question = useAsk((s) => s.question)
  const load = useAsk((s) => s.load)
  const pending = useAsk((s) => s.pending)
  const [showSchema, setShowSchema] = useState(true)
  const [saveList, setSaveList] = useState(false)
  const [saveCond, setSaveCond] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  // 编辑框里是这次 AI 写的、运行出错的 SQL（不是用户改过的），下面的表是上一个问题的结果
  const failedAiSql = !!answer && answer.ok === false && !!answer.sql && sql.trim() === answer.sql.trim()
  const dirty = !!table && sql.trim() !== table.sql.trim() && !failedAiSql
  const previousTable = !!table && failedAiSql && table.sql.trim() !== sql.trim()
  // AI 给的「存清单提示」只在 SQL 没改过时才可信
  const hint = answer && table && table.sql === answer.sql ? (answer.save_hint ?? null) : null
  // 存清单 / 存条件的默认名字：用这张表自己回答的那个问题（AI 这次出错时，表还是上一个问题的）
  const tableQuestion = table?.question || (table?.by === 'ai' && answer ? answer.question : question) || '问数据的结果'

  const insert = (text: string) => {
    const el = ref.current
    const cur = useAsk.getState().sql
    if (!el) {
      setSql(cur ? `${cur} ${text}` : text)
      return
    }
    const a = el.selectionStart ?? cur.length
    const b = el.selectionEnd ?? cur.length
    const next = cur.slice(0, a) + text + cur.slice(b)
    setSql(next)
    window.requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(a + text.length, a + text.length)
    })
  }

  return (
    <>
      <PageHeader
        route="ask"
        title="问数据"
        icon={<IconMessageQuestion />}
        description="一句话问数据：AI 边写边显示说明和 SQL，写完自动在只读数据库上运行。SQL 原文给你看、可以改了自己重跑；报错了可以让 AI 改。结果能存成清单，或者把 SQL 存成工作台的条件。"
        actions={
          <Button variant="secondary" icon={<IconTable />} onClick={() => setShowSchema((v) => !v)} aria-pressed={showSchema}>
            {showSchema ? '收起表结构' : '看表结构'}
          </Button>
        }
      />
      <div className={cn('grid items-start gap-5', showSchema && '@5xl/main:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]')}>
        <div className="flex min-w-0 flex-col gap-5">
          <QuestionCard {...engine} />
          <LiveAnswerCard />
          <AnswerCard eng={engine.eng} labelOf={engine.ai.labelOf} />

          <Card className="p-5">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold text-fg-1">SQL</span>
                <span className="text-xs text-fg-3">只读；一条 SELECT / WITH；5 秒超时；最多 2,000 行</span>
                {dirty && <Badge tone="warning">改过了，还没运行</Badge>}
              </div>
              <Textarea
                ref={ref}
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    run()
                  }
                }}
                rows={8}
                spellCheck={false}
                className="font-mono text-sm leading-body"
                placeholder={'SELECT c.display_name, c.heat\nFROM character c\nORDER BY c.heat DESC\nLIMIT 20'}
                aria-label="SQL"
                disabled={!!pending}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" icon={<IconPlay />} loading={running} disabled={!sql.trim() || !!pending} onClick={run}>
                  运行
                </Button>
                <span className="text-xs text-fg-3">Ctrl+回车 也能运行</span>
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconCopy />}
                    disabled={!sql.trim()}
                    onClick={async () => {
                      if (await copyText(sql)) toast.success('SQL 已复制', { id: 'copy' })
                    }}
                  >
                    复制
                  </Button>
                  <Button size="sm" variant="ghost" icon={<IconX />} disabled={!sql || !!pending} onClick={() => setSql('')}>
                    清空
                  </Button>
                </div>
              </div>
            </div>
          </Card>

          <Card className="p-5">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold text-fg-1">结果</span>
                {table && (
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="soft" icon={<IconListPlus />} disabled={!table.rows.length} onClick={() => setSaveList(true)}>
                      存为清单
                    </Button>
                    <Button size="sm" variant="secondary" icon={<IconPlus />} onClick={() => setSaveCond(true)} title="把这段 SQL 存成工作台某个范围的条件">
                      存为条件
                    </Button>
                  </div>
                )}
              </div>
              {table ? (
                <>
                  {dirty && <p className="text-xs text-warning-fg">下面是改之前那段 SQL 的结果；点「运行」看新的。</p>}
                  {previousTable && (
                    <p className="text-xs text-warning-fg" data-slot="ask-previous-table">
                      这次 AI 写的 SQL 运行出错，没有新结果；下面还是上一个问题{table.question ? `「${table.question}」` : ''}的结果。
                    </p>
                  )}
                  <ResultTable key={table.at} table={table} stale={running || !!pending} />
                </>
              ) : (
                <EmptyState kind="data" size="sm" title="还没有结果" description="问一个问题（AI 写完会自动运行），或者自己写一段 SQL 点「运行」" />
              )}
            </div>
          </Card>
        </div>

        {showSchema && (
          <aside
            aria-label="表结构"
            className="rounded-lg border border-border bg-surface-1 p-4 shadow-1 @5xl/main:sticky @5xl/main:top-[calc(var(--shell-sticky-top,0px)+var(--space-unit)*4)] @5xl/main:max-h-[calc(100dvh-var(--shell-sticky-top,0px)-7rem)] @5xl/main:overflow-y-auto @5xl/main:scroll-thin"
          >
            <SchemaPanel onInsert={insert} onExample={(q, s) => load(q, s)} />
          </aside>
        )}
      </div>

      {table && (
        <>
          <SaveListDialog key={`l-${table.at}-${saveList}`} open={saveList} onClose={() => setSaveList(false)} table={table} question={tableQuestion} hint={hint} />
          <SaveConditionDialog
            key={`c-${table.at}-${saveCond}`}
            open={saveCond}
            onClose={() => setSaveCond(false)}
            sql={table.sql}
            question={tableQuestion}
            firstColumn={table.columns[0] ?? null}
            hintKind={hint?.kind ?? null}
          />
        </>
      )}
    </>
  )
}
