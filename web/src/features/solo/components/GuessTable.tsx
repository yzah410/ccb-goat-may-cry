/**
 * 反馈表：8 列，新的一行加在最下面。版式和猜猜呗游戏一致，颜色用主题 token（view.ts）。
 * 列：头像 | 名字 | 性别 | 热度 | 作品数 / 最高分 | 最晚 / 最早登场 | 标签 | 共同出演
 * 超时的行写「超时」；宽免的行在名字旁边标「不计次数」，鼠标移上去有说明。
 * 从作品的角色列表里选的那次猜测（via = work），名字旁边有个不显眼的小「作品」。
 * 和猜猜呗游戏有两处不同：猜中那一行照常显示标签（游戏里只剩声优）；第一个共同作品是特殊游戏时也显示名字（游戏里是空绿块）。
 *
 * 列宽（性别紧贴名字，标签列占剩下的全部宽度）：表格是自动布局，只有「标签」列不写宽度，
 * 所以表格多出来的宽度全给标签列；其余列写的宽度是下限，内容放不下才撑宽。
 * - 名字列：下限 w-24，随最长的名字撑宽，到上限（max-w，窄区域 11rem / 宽区域 12rem，约等于猜猜呗游戏里名字列的 200px）就截断，鼠标移上去看全名。性别列因此紧跟名字。
 * - 标签：横排，放不下才换行；格子有最小宽度（窄 10rem / 宽 14rem），区域再窄时由表格外框横向滚动。
 * - 共同出演：比猜猜呗游戏里窄（窄 w-32 / 宽 w-44），作品名长了就换行；内容至少 7rem 宽，表格被挤到要横向滚动时也不会缩成一条竖线。
 * 「宽区域」= @container/solo 至少 64rem（例如 1920 宽的窗口：界面 125% 时算宽区域，150% 时算窄区域）。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/components/ui/Overlay'
import { IconClock } from '@/lib/icons'
import type { FeedbackSym, GuessRow, Row } from '../api'
import { arrowMeaning, arrowOf, fmtRating, mergeTags, nameLines, orNone, sharedWorkView, TONE_CLASS, toneOf } from '../view'
import { SoloAvatar } from './SoloAvatar'

const FORGIVEN_TIP = '这个人按已亮信息和答案区分不了，不计入次数'
const VIA_WORK_TIP = '这次是从作品的角色列表里选的'

function FbCell({ sym, value, label }: { sym: FeedbackSym | 'yes' | 'no' | undefined; value: ReactNode; label: string }) {
  const tone = toneOf(sym)
  const arrow = sym === 'yes' || sym === 'no' ? '' : arrowOf(sym)
  const meaning = sym === 'yes' || sym === 'no' ? (sym === 'yes' ? '和答案一样' : '和答案不一样') : arrowMeaning(sym)
  return (
    <span
      className={cn('inline-flex min-w-[80%] items-center justify-center gap-1 rounded-md px-2.5 py-1 font-medium tabular', TONE_CLASS[tone])}
      title={meaning ? `${label}：${meaning}` : label}
    >
      {value}
      {arrow && <span aria-hidden>{arrow}</span>}
    </span>
  )
}

function Stack({ children }: { children: ReactNode }) {
  return <div className="flex flex-col items-center gap-1">{children}</div>
}

function GuessRowView({ row }: { row: GuessRow }) {
  const fb = row.feedback
  const d = fb?.display
  const tags = mergeTags(d)
  const sw = sharedWorkView(fb)
  const nm = nameLines({ name: row.name || d?.name || `#${row.guess_id}`, name_original: row.name_original, name_cn: row.name_cn })
  return (
    <tr className="border-t border-border align-middle" data-seq={row.seq}>
      <td className="px-2 py-2">
        <SoloAvatar id={row.guess_id} className="mx-auto" />
      </td>
      <td className="px-3 py-2 text-left">
        <div className="flex max-w-[11rem] items-center gap-2 @5xl/solo:max-w-[12rem]">
          <div className={cn('flex min-w-0 flex-col rounded-md px-2 py-1', row.hit && TONE_CLASS.hit)}>
            {nm.top && (
              <span className={cn('truncate text-xs', row.hit ? 'text-success-fg' : 'text-fg-3')} title={nm.top} lang="ja">
                {nm.top}
              </span>
            )}
            <span className={cn('truncate font-medium', row.hit ? 'text-success-fg' : 'text-fg-1')} title={nm.main}>
              {nm.main}
            </span>
            {row.hit && <span className="text-xs">{row.exact ? '答案本人' : '同一部作品的角色，算猜对'}</span>}
          </div>
          {row.forgiven && (
            <Tooltip content={FORGIVEN_TIP}>
              <span
                tabIndex={0}
                aria-label={FORGIVEN_TIP}
                className="shrink-0 cursor-help rounded-sm bg-info-bg px-1.5 py-0.5 text-xs text-info-fg"
              >
                不计次数
              </span>
            </Tooltip>
          )}
          {row.via === 'work' && (
            <span
              title={VIA_WORK_TIP}
              aria-label={VIA_WORK_TIP}
              data-via="work"
              className="shrink-0 rounded-sm px-1 py-px text-xs text-fg-3 ring-1 ring-inset ring-border"
            >
              作品
            </span>
          )}
        </div>
      </td>
      <td className="px-2 py-2">
        <FbCell sym={fb?.gender?.feedback} value={d?.gender_symbol ?? '?'} label="性别" />
      </td>
      <td className="px-2 py-2">
        <FbCell sym={fb?.popularity?.feedback} value={fb?.popularity?.guess ?? d?.popularity ?? '—'} label="热度" />
      </td>
      <td className="px-2 py-2">
        <Stack>
          <FbCell sym={fb?.appearancesCount?.feedback} value={fb?.appearancesCount?.guess ?? d?.n_app ?? '—'} label="作品数" />
          <FbCell sym={fb?.rating?.feedback} value={orNone(fb?.rating?.guess, fmtRating)} label="最高分" />
        </Stack>
      </td>
      <td className="px-2 py-2">
        <Stack>
          <FbCell sym={fb?.latestAppearance?.feedback} value={orNone(fb?.latestAppearance?.guess)} label="最晚登场" />
          <FbCell sym={fb?.earliestAppearance?.feedback} value={orNone(fb?.earliestAppearance?.guess)} label="最早登场" />
        </Stack>
      </td>
      <td className="px-2 py-2">
        <div className="flex min-w-[10rem] flex-wrap justify-center gap-1 @5xl/solo:min-w-[14rem]">
          {tags.map((t) => (
            <span
              key={t.text}
              title={t.kind === 'va' ? '声优' : t.kind === 'char' ? '角色标签' : '作品标签'}
              className={cn('whitespace-nowrap rounded-sm px-2 py-0.5 text-xs', t.shared ? TONE_CLASS.hit : 'bg-surface-2 text-fg-2')}
            >
              {t.text}
            </span>
          ))}
        </div>
      </td>
      <td className="px-2 py-2">
        <div className="min-w-28">
          {sw.has ? (
            <span className={cn('inline-block min-w-[80%] rounded-md px-3 py-1 font-medium [overflow-wrap:anywhere]', TONE_CLASS.hit)}>{sw.text}</span>
          ) : (
            <span className="text-fg-3" aria-label="没有共同出演">
              —
            </span>
          )}
        </div>
      </td>
    </tr>
  )
}

function TimeoutRowView({ row }: { row: Row }) {
  return (
    <tr className="border-t border-border align-middle" data-seq={row.seq}>
      <td className="px-2 py-2">
        <span className="mx-auto grid size-11 place-items-center rounded-md bg-surface-2 text-fg-3 ring-1 ring-inset ring-border">
          <IconClock className="size-5" aria-hidden />
        </span>
      </td>
      <td className="px-3 py-2 text-left">
        <span className="rounded-md bg-warning-bg px-2 py-1 font-medium text-warning-fg">超时</span>
      </td>
      <td colSpan={6} className="px-3 py-2 text-left text-sm text-fg-3">
        时间到了，算一次没猜中
      </td>
    </tr>
  )
}

/** follow=false 时新行不自动滚进视野（手动结算时让上面的答案卡片留在视野里） */
export function GuessTable({ rows, follow = true, className }: { rows: Row[]; follow?: boolean; className?: string }) {
  // 新的一行出现时，把它滚进视野（表格很长时）
  const endRef = useRef<HTMLTableRowElement>(null)
  const count = rows.length
  // 只在行数变化时滚；follow 本身变了不滚（下一局开始前表格还在，follow 变回 true 时不该跳到表格底部）
  const followRef = useRef(follow)
  useEffect(() => {
    followRef.current = follow
  }, [follow])
  useEffect(() => {
    if (count > 0 && followRef.current) endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [count])

  return (
    <div className={cn('overflow-x-auto rounded-lg bg-surface-1 ring-1 ring-inset ring-border', className)}>
      <table className="w-full border-collapse text-center text-sm text-fg-2">
        <thead className="bg-surface-2 text-fg-1">
          <tr className="[&>th]:whitespace-nowrap [&>th]:px-2 [&>th]:py-2 [&>th]:font-semibold">
            <th className="w-15">
              <span className="sr-only">头像</span>
            </th>
            <th className="w-24 text-left">名字</th>
            <th className="w-14">性别</th>
            <th className="w-24">热度</th>
            <th className="w-20">
              作品数
              <br />
              最高分
            </th>
            <th className="w-22">
              最晚登场
              <br />
              最早登场
            </th>
            <th>标签</th>
            <th className="w-32 @5xl/solo:w-44">共同出演</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-4 py-10 text-fg-3">
                还没猜。在上面的搜索框里输入角色名；也可以按 → 或点「作品」，从作品里挑。
              </td>
            </tr>
          ) : (
            rows.map((r) => (r.kind === 'guess' ? <GuessRowView key={r.seq} row={r} /> : <TimeoutRowView key={r.seq} row={r} />))
          )}
          <tr ref={endRef} aria-hidden />
        </tbody>
      </table>
    </div>
  )
}
