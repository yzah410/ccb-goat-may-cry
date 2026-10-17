/**
 * 开局问卷：选公式 → 按公式分档。
 *
 * 两种起点：
 * - 从一个角色开始：列出单人就带 5 个以上分档标签的角色；选一个以后，自动推荐最合适的第 2 个、第 3 个；
 * - 直接看两人组合：预先算好的两人组合，选一组以后可以再加第 3 个。
 * 标签完全一样的角色可以互相替换（例：同一部作品里标签完全相同的几个角色）：列表里点名字直接选这个角色，右边公式里也能换。
 * 分档：两人的标签 → 第 1 档；第 3 个人新带来的 → 第 2 档；其余 → 第 3 档（recs.ts 的 tiersFor）。
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { SegmentedControl } from '@/components/ui/Controls'
import { Input } from '@/components/ui/Input'
import { Dialog, DialogContent } from '@/components/ui/Overlay'
import { toast } from '@/components/ui/Toast'
import { IconArrowLeft, IconCheck, IconSearch, IconX } from '@/lib/icons'
import { errorText } from '@/lib/apiClient'
import { cn } from '@/lib/cn'
import { TIER_KEYS, TIER_LABEL, useSaveTiers, useTiers, type FormulaChar, type Tiers } from './api'
import { RECS, rankAdds, searchChars, slotOf, swapOptions, tiersFor, unionOf, type Recs, type Slot } from './recs'
import { useFormulaWizard } from './store'

type Start = 'single' | 'pair'

export default function FormulaWizard() {
  const open = useFormulaWizard((s) => s.open)
  const from = useFormulaWizard((s) => s.from)
  const close = useFormulaWizard((s) => s.close)
  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      {open && (
        <DialogContent
          title="选一个公式"
          description="公式 = 每局开头先猜的 2–3 个角色。公式很重要：标签分档按公式来定，导图的分组和角色卡片的标签分栏都按分档来。以后可以在设置里改。"
          className="max-h-[min(92%,880px)] max-w-6xl"
          onInteractOutside={(e) => e.preventDefault()}
        >
          <WizardBody recs={RECS} first={from === 'first'} onDone={close} />
        </DialogContent>
      )}
    </Dialog>
  )
}

function WizardBody({ recs, first, onDone }: { recs: Recs; first: boolean; onDone: () => void }) {
  const [start, setStart] = useState<Start>('single')
  const [a, setA] = useState<Slot | null>(null)
  const [b, setB] = useState<Slot | null>(null)
  const [c, setC] = useState<Slot | null>(null)
  const [noThird, setNoThird] = useState(false)
  const tiersQ = useTiers()
  const save = useSaveTiers()

  const tiers = a && b ? tiersFor(recs, a.rep, b.rep, c?.rep ?? null) : null
  const done = !!(a && b && (c || noThird))
  const reset = (to: 'a' | 'b' | 'c') => {
    if (to === 'a') setA(null)
    if (to === 'a' || to === 'b') setB(null)
    setC(null)
    setNoThird(false)
  }

  const submit = async (formula: FormulaChar[] | null, t: Tiers) => {
    try {
      await save.mutateAsync({ formula: formula ? { chars: formula } : null, tiers: t })
      toast.success(formula ? '公式和分档存好了' : '先用默认分档', { description: '以后可以在「设置 → 标签分档」里改' })
      onDone()
    } catch (e) {
      toast.error('没存上', { description: errorText(e) })
    }
  }
  const confirmFormula = () => {
    if (a && b && tiers) void submit([a.shown, b.shown, ...(c ? [c.shown] : [])], tiers)
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-3">
        {!a ? (
          <>
            <SegmentedControl<Start>
              value={start}
              onChange={setStart}
              aria-label="从哪里开始"
              options={[
                { value: 'single', label: '从一个角色开始' },
                { value: 'pair', label: '直接看两人组合' },
              ]}
            />
            {start === 'single' ? (
              <PickFirst recs={recs} onPick={(s) => setA(s)} />
            ) : (
              <PickPair
                recs={recs}
                onPick={(x, y) => {
                  setA(x)
                  setB(y)
                }}
              />
            )}
          </>
        ) : !b ? (
          <PickNext
            key={`b${a.rep}`}
            recs={recs}
            title="第 2 个角色"
            hint="按「和第 1 个合起来带几个分档标签」排。带颜色的标签是这个人新带来的。"
            base={unionOf(recs, [a.rep])}
            exclude={new Set([a.rep])}
            back={{ label: '换第 1 个', onClick: () => reset('a') }}
            countLabel={(n) => `合起来 ${n} 个`}
            onPick={setB}
          />
        ) : !c && !noThird ? (
          <PickNext
            key={`c${a.rep}-${b.rep}`}
            recs={recs}
            title="第 3 个角色（可以不选）"
            hint="第 3 个人新带来的标签（带颜色的）会成为第 2 档。不需要的话点「不要第 3 个」。"
            base={unionOf(recs, [a.rep, b.rep])}
            exclude={new Set([a.rep, b.rep])}
            back={{ label: '换第 2 个', onClick: () => reset('b') }}
            countLabel={(n) => `新带来 ${n} 个`}
            onPick={setC}
            extra={
              <Button variant="secondary" size="sm" onClick={() => setNoThird(true)}>
                不要第 3 个
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col items-start gap-4">
            <Button variant="ghost" size="sm" icon={<IconArrowLeft />} onClick={() => reset('c')}>
              {c ? '换第 3 个' : '还是加第 3 个'}
            </Button>
            <p className="text-base text-fg-1">公式选好了。分档会变成下面这样，没问题就点「用这个公式」。</p>
            <Button variant="primary" size="lg" icon={<IconCheck />} loading={save.isPending} onClick={confirmFormula}>
              用这个公式
            </Button>
            {tiers && <TierPreview tiers={tiers} />}
          </div>
        )}
      </div>

      <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-0 lg:self-start">
        <h3 className="text-base font-medium text-fg-1">你的公式</h3>
        <FormulaSlot recs={recs} n={1} slot={a} onSwap={(who) => a && setA({ ...a, shown: who })} onClear={() => reset('a')} />
        <FormulaSlot recs={recs} n={2} slot={b} onSwap={(who) => b && setB({ ...b, shown: who })} onClear={() => reset('b')} />
        <FormulaSlot
          recs={recs}
          n={3}
          slot={c}
          empty={noThird ? '不要第 3 个' : '可以不选'}
          onSwap={(who) => c && setC({ ...c, shown: who })}
          onClear={() => reset('c')}
        />
        {a && b && !done && (
          <Button variant="primary" icon={<IconCheck />} loading={save.isPending} onClick={confirmFormula}>
            两个人就够了，用这个公式
          </Button>
        )}
        {first && !b && tiersQ.data && (
          <Button variant="ghost" size="sm" disabled={save.isPending} onClick={() => void submit(null, tiersQ.data.defaults)}>
            先不选，用默认分档
          </Button>
        )}
        {tiers && !done && <TierPreview tiers={tiers} compact />}
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------- 第 1 步
function PickFirst({ recs, onPick }: { recs: Recs; onPick: (s: Slot) => void }) {
  const [q, setQ] = useState('')
  const hits = useMemo(() => searchChars(recs, q), [recs, q])
  return (
    <>
      <p className="text-sm text-fg-2">
        先选第 1 个角色。下面的人单人就带 5 个以上分档标签；选好以后，自动推荐最合适的第 2 个。
      </p>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜角色名（列表外的也能搜）" leading={<IconSearch className="size-4" />} />
      <div className="flex flex-col gap-2">
        {q.trim()
          ? hits.length
            ? hits.map((h) => <CharRow key={h.idx} recs={recs} idx={h.idx} shown={h.shown} tags={recs.chars[h.idx]!.k} onPick={onPick} />)
            : <p className="text-sm text-fg-3">没搜到。推荐数据里只有热度 100 以上的角色。</p>
          : recs.singles.map((i) => <CharRow key={i} recs={recs} idx={i} tags={recs.chars[i]!.k} onPick={onPick} />)}
      </div>
    </>
  )
}

function PickPair({ recs, onPick }: { recs: Recs; onPick: (a: Slot, b: Slot) => void }) {
  // 按「合起来带几个分档标签」分组（pairs 本来就从多到少排）
  const groups = useMemo(() => {
    const out: { size: number; rows: { x: number; y: number; tags: number[] }[] }[] = []
    for (const [x, y] of recs.pairs) {
      const tags = [...unionOf(recs, [x, y])].sort((p, q) => p - q)
      const last = out[out.length - 1]
      if (last && last.size === tags.length) last.rows.push({ x, y, tags })
      else out.push({ size: tags.length, rows: [{ x, y, tags }] })
    }
    return out
  }, [recs])
  return (
    <>
      <p className="text-sm text-fg-2">点一组就选这两个人。下一步可以再加第 3 个。</p>
      {groups.map((g) => (
        <section key={g.size} className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-fg-1">合起来 {g.size} 个分档标签</h3>
          {g.rows.map(({ x, y, tags }) => {
            const cx = recs.chars[x]!
            const cy = recs.chars[y]!
            return (
              <button
                key={`${x}-${y}`}
                type="button"
                onClick={() => onPick(slotOf(recs, x), slotOf(recs, y))}
                className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-1 p-3 text-left transition-colors hover:border-border-strong hover:bg-surface-2"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-medium text-fg-1">{cx.name}</span>
                  <span className="text-xs text-fg-3">{cx.work}</span>
                  <span className="text-fg-3">+</span>
                  <span className="font-medium text-fg-1">{cy.name}</span>
                  <span className="text-xs text-fg-3">{cy.work}</span>
                </div>
                <TagChips recs={recs} tags={tags} />
              </button>
            )
          })}
        </section>
      ))}
    </>
  )
}

// ---------------------------------------------------------------- 第 2、3 步
function PickNext({
  recs,
  title,
  hint,
  base,
  exclude,
  back,
  countLabel,
  onPick,
  extra,
}: {
  recs: Recs
  title: string
  hint: string
  base: ReadonlySet<number>
  exclude: ReadonlySet<number>
  back: { label: string; onClick: () => void }
  countLabel: (n: number) => string
  onPick: (s: Slot) => void
  extra?: ReactNode
}) {
  const [q, setQ] = useState('')
  const ranked = useMemo(() => rankAdds(recs, base, exclude), [recs, base, exclude])
  const hits = useMemo(() => searchChars(recs, q, exclude), [recs, q, exclude])
  const total = (idx: number) => {
    const add = recs.chars[idx]!.k.filter((t) => !base.has(t)).length
    return title.startsWith('第 2') ? base.size + add : add
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" icon={<IconArrowLeft />} onClick={back.onClick}>
          {back.label}
        </Button>
        <h3 className="text-base font-medium text-fg-1">{title}</h3>
        <span className="ml-auto">{extra}</span>
      </div>
      <p className="text-sm text-fg-2">{hint}</p>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="也可以自己搜一个" leading={<IconSearch className="size-4" />} />
      <div className="flex flex-col gap-2">
        {q.trim()
          ? hits.length
            ? hits.map((h) => (
                <CharRow
                  key={h.idx}
                  recs={recs}
                  idx={h.idx}
                  shown={h.shown}
                  tags={recs.chars[h.idx]!.k}
                  highlight={(t) => !base.has(t)}
                  count={countLabel(total(h.idx))}
                  onPick={onPick}
                />
              ))
            : <p className="text-sm text-fg-3">没搜到。推荐数据里只有热度 100 以上的角色。</p>
          : ranked.map((r) => (
              <CharRow
                key={r.idx}
                recs={recs}
                idx={r.idx}
                tags={recs.chars[r.idx]!.k}
                highlight={(t) => !base.has(t)}
                count={countLabel(total(r.idx))}
                onPick={onPick}
              />
            ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- 小部件
function CharRow({
  recs,
  idx,
  shown,
  tags,
  highlight,
  count,
  onPick,
}: {
  recs: Recs
  idx: number
  shown?: FormulaChar
  tags: readonly number[]
  highlight?: (t: number) => boolean
  count?: string
  onPick: (s: Slot) => void
}) {
  const ch = recs.chars[idx]!
  const slot = slotOf(recs, idx, shown)
  const others = swapOptions(recs, slot)
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-1 p-3 transition-colors hover:border-border-strong">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <button type="button" onClick={() => onPick(slot)} className="font-medium text-fg-1 underline-offset-4 hover:underline">
          {slot.shown.name}
        </button>
        <span className="text-xs text-fg-3">{ch.work}</span>
        <Badge size="sm" className="ml-auto">
          {count ?? `${tags.length} 个`}
        </Badge>
        <Button variant="soft" size="sm" onClick={() => onPick(slot)}>
          选这个
        </Button>
      </div>
      <TagChips recs={recs} tags={tags} highlight={highlight} />
      {others.length > 0 && (
        <SwapLine options={others} onPick={(who) => onPick(slotOf(recs, idx, who))} label="标签一样的还有" />
      )}
    </div>
  )
}

/** 标签完全一样、可以互相替换的人：默认收起成一行小字，点开再列名字 */
function SwapLine({ options, onPick, label }: { options: FormulaChar[]; onPick: (who: FormulaChar) => void; label: string }) {
  const [open, setOpen] = useState(false)
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="self-start text-xs text-fg-2 underline decoration-dotted underline-offset-2 hover:text-fg-1">
        {label} {options.length} 人 ▸
      </button>
    )
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-fg-3">
      <button type="button" onClick={() => setOpen(false)} className="hover:text-fg-1">
        {label}（点名字替换）▾
      </button>
      {options.map((who) => (
        <button key={who.id} type="button" onClick={() => onPick(who)} className="text-fg-2 underline underline-offset-2 hover:text-fg-1">
          {who.name}
        </button>
      ))}
    </div>
  )
}

function TagChips({ recs, tags, highlight }: { recs: Recs; tags: readonly number[]; highlight?: (t: number) => boolean }) {
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <Badge key={t} size="sm" tone={highlight?.(t) ? 'accent' : 'neutral'}>
          {recs.tags[t]}
        </Badge>
      ))}
    </div>
  )
}

function FormulaSlot({
  recs,
  n,
  slot,
  empty,
  onSwap,
  onClear,
}: {
  recs: Recs
  n: number
  slot: Slot | null
  empty?: string
  onSwap: (who: FormulaChar) => void
  onClear: () => void
}) {
  if (!slot)
    return (
      <div className="rounded-lg border border-dashed border-border-strong px-3 py-2.5 text-sm text-fg-2">
        第 {n} 个：{empty ?? '从左边选'}
      </div>
    )
  const ch = recs.chars[slot.rep]!
  const others = swapOptions(recs, slot)
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border-strong bg-surface-1 p-3">
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-fg-3">第 {n} 个</span>
        <span className="min-w-0 truncate font-medium text-fg-1">{slot.shown.name}</span>
        <button type="button" onClick={onClear} aria-label={`去掉第 ${n} 个`} className="ml-auto grid size-6 place-items-center rounded text-fg-3 hover:bg-surface-2 hover:text-fg-1">
          <IconX className="size-3.5" />
        </button>
      </div>
      <span className="text-xs text-fg-3">
        {ch.work} · 带 {ch.k.length} 个分档标签
      </span>
      {others.length > 0 && <SwapLine options={others} onPick={onSwap} label="标签一样的还有" />}
    </div>
  )
}

function TierPreview({ tiers, compact }: { tiers: Tiers; compact?: boolean }) {
  return (
    <div className="flex w-full flex-col gap-2.5 rounded-lg bg-surface-2 p-3">
      <span className="text-sm font-medium text-fg-1">{compact ? '分档预览' : '分档'}</span>
      {TIER_KEYS.filter((k) => k !== 'G_4').map((k) => (
        <div key={k} className="flex flex-col gap-1">
          <span className="text-xs text-fg-2">
            {TIER_LABEL[k]} · {tiers[k].length} 个{k === 'G_1' ? '（公式两人的标签）' : k === 'G_2' ? '（第 3 个人新带来的）' : '（其余）'}
          </span>
          {compact && k !== 'G_1' ? null : tiers[k].length ? (
            <div className="flex flex-wrap gap-1">
              {tiers[k].map((t) => (
                <Badge key={t} size="sm" tone={k === 'G_1' ? 'primary' : 'neutral'} className={cn(k === 'G_3' && 'opacity-75')}>
                  {t}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="text-xs text-fg-3">{k === 'G_2' ? '没有第 3 个人，这一档空着' : '空'}</span>
          )}
        </div>
      ))}
    </div>
  )
}
