/**
 * 导图一侧「跟随」的纯逻辑（不碰浏览器、store、计时器，好测）。副作用在 ./followController.ts。
 *
 * - 找目标图 / 匹配作品卡 / 猜错作品的挑选：一局结束后跳到哪张图、高亮哪几张卡
 * - 只在 Hard / Again 跳、改评级后的补跳
 * - 「返回」方式：记原处、什么时候回去、用户接管了没有
 * - 覆盖率重算、没覆盖的人
 * - 换方案、多个单人标签页只认最近的那个
 * - 提示和字幕的文案
 */
import type { Grade, WrongGuess } from '@/features/solo/api'
import { GRADE_LABEL } from '@/features/solo/grades'
import type { ViewKey, Viewport } from '@/vendor/tagnote/tagnote.esm.js'
import type { PoolChar, PreselectMap } from './api'
import type { LinkMsg, SoloRoundEndMsg } from './protocol'

// ---------------------------------------------------------------- 设置
/** 高亮方式：停留（一直亮到下一题的答案）/ 闪烁（闪几下就消失）/ 返回（亮够几秒、下一题开始后回到原处） */
export type HighlightMode = 'stay' | 'flash' | 'return'

export interface FollowSettings {
  mode: HighlightMode
  /** 「返回」：至少亮几秒（RETURN_SEC_MIN–RETURN_SEC_MAX） */
  returnSec: number
  /** 只在评级是 Hard / Again 的题跳 */
  hardOnly: boolean
  /** 标出猜错的作品（虚线框） */
  markWrong: boolean
  /** 图区左上角的「上一题」字幕 */
  caption: boolean
  /** 单人猜猜呗页显示「已联动」小灯 */
  showDot: boolean
}

export const RETURN_SEC_MIN = 2
export const RETURN_SEC_MAX = 15

export const DEFAULT_FOLLOW_SETTINGS: FollowSettings = {
  mode: 'stay',
  returnSec: 4,
  hardOnly: false,
  markWrong: true,
  caption: true,
  showDot: true,
}

export function clampReturnSec(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : DEFAULT_FOLLOW_SETTINGS.returnSec
  return Math.min(RETURN_SEC_MAX, Math.max(RETURN_SEC_MIN, n))
}

// ---------------------------------------------------------------- 作品卡匹配
/** 图里一张作品卡用到的字段（图数据 works[]） */
export interface WorkLite {
  id: string
  subject_id?: unknown
  char_id?: unknown
}

/** 正整数，或纯数字字符串 → 数字；别的 → null（手写卡没有 subject_id / char_id） */
function intOf(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
}

/**
 * 这张图里属于答案的作品卡 id：char_id 就是答案角色，或 subject_id 在答案的作品列表里。
 * 顺序：答案角色自己的卡 → 绑定作品（answer_work_ids[0]）的卡 → 其他登场作品的卡；同一档按图里的顺序。
 * 引擎 reveal 在外接矩形装不下时只保证 ids[0]，所以最像「答案」的排在最前。
 */
export function matchWorks(works: readonly WorkLite[], answerId: number, answerWorkIds: readonly number[]): string[] {
  const bound = answerWorkIds[0]
  const all = new Set(answerWorkIds)
  const ranked: { id: string; rank: number; i: number }[] = []
  works.forEach((w, i) => {
    const cid = intOf(w.char_id)
    const sid = intOf(w.subject_id)
    let rank = -1
    if (cid !== null && cid === answerId) rank = 0
    else if (sid !== null && sid === bound) rank = 1
    else if (sid !== null && all.has(sid)) rank = 2
    if (rank >= 0) ranked.push({ id: w.id, rank, i })
  })
  ranked.sort((a, b) => a.rank - b.rank || a.i - b.i)
  return ranked.map((r) => r.id)
}

export interface TargetPick {
  mapId: string
  /** 这张图里匹配上的作品卡 id（matchWorks 的顺序） */
  ids: string[]
}

/**
 * 找目标图：组里哪些图有答案。优先当前格正在显示的那张（它在组里、也有答案）；否则组里排在最前面的。
 * worksOf 返回 null / undefined = 这张图的数据没拿到，当作没有。组里都没有 → null。
 */
export function findTarget(
  group: readonly string[],
  worksOf: (mapId: string) => readonly WorkLite[] | null | undefined,
  shownMapId: string | null,
  answerId: number,
  answerWorkIds: readonly number[],
): TargetPick | null {
  const tryMap = (mapId: string): TargetPick | null => {
    const works = worksOf(mapId)
    if (!works) return null
    const ids = matchWorks(works, answerId, answerWorkIds)
    return ids.length ? { mapId, ids } : null
  }
  if (shownMapId && group.includes(shownMapId)) {
    const hit = tryMap(shownMapId)
    if (hit) return hit
  }
  for (const m of group) {
    if (m === shownMapId) continue
    const hit = tryMap(m)
    if (hit) return hit
  }
  return null
}

/**
 * 猜错的角色在这张图里的作品卡（次要高亮）：每个猜错的角色最多 1 张。
 * 先找 char_id 就是他的卡；没有再按他的作品列表（work_ids 的顺序，绑定作品在前）找 subject_id 对得上的卡。
 * 排除答案卡，也不重复用同一张卡。
 */
export function pickSecondary(works: readonly WorkLite[], wrong: readonly WrongGuess[], exclude: readonly string[]): string[] {
  const used = new Set(exclude)
  const out: string[] = []
  for (const g of wrong) {
    let hit = works.find((w) => !used.has(w.id) && intOf(w.char_id) === g.char_id)
    if (!hit) {
      for (const wid of g.work_ids) {
        hit = works.find((w) => !used.has(w.id) && intOf(w.subject_id) === wid)
        if (hit) break
      }
    }
    if (hit) {
      used.add(hit.id)
      out.push(hit.id)
    }
  }
  return out
}

// ---------------------------------------------------------------- 只在 Hard / Again 跳
export const isHardGrade = (g: Grade): boolean => g === 'hard' || g === 'again'

/** 这一局结束要不要跳：没开「只在 Hard / Again 跳」就都跳 */
export function shouldJump(grade: Grade, s: Pick<FollowSettings, 'hardOnly'>): boolean {
  return !s.hardOnly || isHardGrade(grade)
}

/** 最近结束的那一局 */
export interface LastEnd {
  roundId: string
  grade: Grade
  /** 已经处理过（跳了，或者提示了「不在联动的图里」） */
  handled: boolean
  /** 下一题已经开始 */
  nextStarted: boolean
}

/**
 * 收到 solo:grade（用户手动改了评级）：要不要补跳。
 * 只有「这一局当时因为评级没跳、现在改成了 Hard / Again、下一题还没开始」才补。
 */
export function needsCatchUp(last: LastEnd | null, roundId: string, grade: Grade, s: Pick<FollowSettings, 'hardOnly'>): boolean {
  return !!last && last.roundId === roundId && !last.handled && !last.nextStarted && shouldJump(grade, s)
}

// ---------------------------------------------------------------- 「返回」
/** 聚焦前的原处：哪个标签、它当时的视图、那个视图的视区（可能带 home:true） */
export interface ReturnOrigin {
  /** null = 跟随格当时是空的：回去时只清掉聚焦 */
  tabId: string | null
  view: ViewKey | null
  vp: Viewport | null
}

export interface ReturnPlan {
  origin: ReturnOrigin
  /** 聚焦的那个标签 */
  targetTab: string
  /** 最近一次聚焦的时间（毫秒） */
  focusedAt: number
  /** 聚焦之后下一题开始了 */
  nextStarted: boolean
}

/**
 * 又聚焦了一次：上一次的返回还没完成 → 沿用最早记下的原处（不把聚焦后的位置当成原处），时间从这次算。
 */
export function planReturn(prev: ReturnPlan | null, origin: ReturnOrigin, targetTab: string, now: number): ReturnPlan {
  return { origin: prev ? prev.origin : origin, targetTab, focusedAt: now, nextStarted: false }
}

/**
 * 还要等多久才回去（毫秒）。下一题还没开始 → null（还定不了）；条件都满足 → 0。
 */
export function returnWait(p: ReturnPlan, now: number, minSec: number): number | null {
  if (!p.nextStarted) return null
  return Math.max(0, p.focusedAt + clampReturnSec(minSec) * 1000 - now)
}

export function returnReady(p: ReturnPlan, now: number, minSec: number): boolean {
  return returnWait(p, now, minSec) === 0
}

/** 跳过去以后「应该是这样」：跟随格的当前标签和它的视图 */
export interface Expectation {
  tabId: string
  /** null = 还不知道（没定），不比 */
  view: string | null
}

/**
 * 用户接管了没有：跟随格的当前标签不是聚焦的那个（用户切了标签），或那个标签的视图变了（用户切了视图）。
 * 平移 / 缩放由引擎报 info.by === 'user'，调用方直接判断。
 */
export function takenOver(expect: Expectation, actual: { activeTab: string | null; view: string | null }): boolean {
  if (actual.activeTab !== expect.tabId) return true
  return expect.view !== null && actual.view !== null && actual.view !== expect.view
}

// ---------------------------------------------------------------- 覆盖率
export interface Coverage {
  covered: number
  total: number
  /** 0–1 */
  ratio: number
  ids: Set<number>
}

/** 勾选的图合起来覆盖了哪些题库角色（用预选结果里每张图的 covers 本地算，不用再请求） */
export function coverageOf(maps: readonly Pick<PreselectMap, 'id' | 'covers'>[], checked: readonly string[], total: number): Coverage {
  const on = new Set(checked)
  const ids = new Set<number>()
  for (const m of maps) if (on.has(m.id)) for (const c of m.covers) ids.add(c)
  const covered = ids.size
  return { covered, total, ratio: total > 0 ? Math.min(1, covered / total) : 0, ids }
}

export interface UncoveredView {
  /** 没覆盖的人（按热度降序） */
  list: (PoolChar & { noMap: boolean })[]
}

/**
 * 没覆盖的人 = 整个题库（pool）里不在已覆盖集合里的人。
 * noMapIds：所有图里都没有的人，列表里标一下。
 */
export function uncoveredOf(pool: readonly PoolChar[], cov: Coverage, noMapIds: readonly number[]): UncoveredView {
  const noMap = new Set(noMapIds)
  const list = pool.filter((c) => !cov.ids.has(c.char_id)).map((c) => ({ ...c, noMap: noMap.has(c.char_id) }))
  return { list }
}

// ---------------------------------------------------------------- 换方案
export interface GroupChoice {
  mapIds: string[]
  /** true = 用的是这个方案记住的图组；false = 预选结果（还没保存） */
  remembered: boolean
}

/** 一个方案该用哪组图：记住过就用记住的，否则用预选结果 */
export function groupForPlan(remembered: { map_ids: string[] } | null, picked: readonly string[]): GroupChoice {
  return remembered ? { mapIds: [...remembered.map_ids], remembered: true } : { mapIds: [...picked], remembered: false }
}

/**
 * 收到 solo:state：要不要换图组。跟随中、方案变了、而且不是用户刚撤销过的那个方案。
 */
export function isPlanSwitch(current: string | null, incoming: string, declined: string | null): boolean {
  return current !== null && incoming !== current && incoming !== declined
}

// ---------------------------------------------------------------- 设置面板
export const PANEL_W = 340

/** 面板在按钮下面至少要有这么高（头、尾固定，中间还能露出几行）；不够就往上挪 */
export const PANEL_MIN_H = 280

export interface PanelBox {
  left: number
  top: number
  width: number
  maxHeight: number
}

/** 工作区容器里的一块区域（容器坐标，左上 x0,y0、右下 x1,y1） */
export interface Area {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** 窗口坐标里的一块矩形 */
export interface ClipRect {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * 工作区容器此刻看得见的部分 = 容器和 clip 的交集（容器坐标）。
 * clip = 浏览器窗口和容器外面各层裁剪（overflow 不是 visible 的祖先）的交集；窗口很矮、外层滚动区往下滚了时，容器会有一部分看不见。
 * origin = 容器内容区左上角在窗口里的位置（getBoundingClientRect + 边框）。
 */
export function visibleArea(origin: { left: number; top: number }, root: { w: number; h: number }, clip: ClipRect): Area {
  const x0 = Math.max(0, clip.left - origin.left)
  const y0 = Math.max(0, clip.top - origin.top)
  const x1 = Math.min(root.w, clip.right - origin.left)
  const y1 = Math.min(root.h, clip.bottom - origin.top)
  return { x0, y0, x1: Math.max(x0, x1), y1: Math.max(y0, y1) }
}

/** 两块矩形的交集（没有交集时宽或高为 0，不倒过来） */
export function clipTo(a: ClipRect, b: ClipRect): ClipRect {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  return { left, top, right: Math.max(left, Math.min(a.right, b.right)), bottom: Math.max(top, Math.min(a.bottom, b.bottom)) }
}

/** 面板的头（连接状态）和尾（按钮）固定、中间滚动时，中间至少要露出这么高；不够就整个面板一起滚（尾巴贴在底下） */
export const PANEL_MIDDLE_MIN_H = 96

export function panelCompact(maxHeight: number, headH: number, footH: number): boolean {
  return maxHeight < headH + footH + PANEL_MIDDLE_MIN_H
}

/**
 * 面板放哪（相对工作区容器）：右边和按钮对齐、在按钮下面 4px；只在 area（容器里看得见的部分，默认整个容器）里放。
 * 左右夹进 area；按钮下面不到 PANEL_MIN_H 就往上挪（可以盖住按钮），最高挪到 area 顶上；高度装不下就在面板中间滚。
 * area 窄于 348px 时面板跟着变窄。
 */
export function panelBox(anchor: { right: number; bottom: number }, root: { w: number; h: number }, area?: Area): PanelBox {
  const a = area ?? { x0: 0, y0: 0, x1: root.w, y1: root.h }
  const width = Math.max(0, Math.min(PANEL_W, a.x1 - a.x0 - 8))
  const left = Math.max(a.x0 + 4, Math.min(anchor.right - width, a.x1 - width - 4))
  const lo = a.y0 + 4
  const hi = a.y1 - 8
  let top = Math.max(lo, anchor.bottom + 4)
  if (hi - top < PANEL_MIN_H) top = Math.max(lo, hi - PANEL_MIN_H)
  return { left, top, width, maxHeight: Math.max(0, hi - top) }
}

/** 方案标识里的方案名：plan:<名> → 名；workbench → null */
export function planNameOfKey(planKey: string): string | null {
  return planKey.startsWith('plan:') ? planKey.slice(5) || null : null
}

/**
 * 打开面板时图组先勾哪些：这一格正在跟随、而且是同一个方案 → 正在用的那组；
 * 否则这个方案记住的；都没有 → 预选的。
 */
export function initialGroup(p: {
  followingHere: boolean
  followPlanKey: string | null
  followIds: readonly string[]
  planKey: string
  remembered: { map_ids: string[] } | null
  picked: readonly string[]
}): string[] {
  if (p.followingHere && p.followPlanKey === p.planKey) return [...new Set(p.followIds)]
  return [...new Set(groupForPlan(p.remembered, p.picked).mapIds)]
}

/** 两组图一样吗（顺序也算：组里排前面的图优先当目标） */
export function sameGroup(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

// ---------------------------------------------------------------- 多个单人标签页
/**
 * 只认最近一次发 solo:state / solo:round-* 的那个单人标签页：
 * - solo:state、solo:round-start、solo:round-end：收下，以后认它
 * - solo:grade、solo:bye：只收认定的那个发的
 * - solo:ping：谁问都回（只是问「你还在吗」）
 * - map:*：别的导图标签页发的，不管
 */
export function acceptFrom(activeSrc: string | null, msg: LinkMsg): { accept: boolean; src: string | null } {
  switch (msg.type) {
    case 'solo:state':
    case 'solo:round-start':
    case 'solo:round-end':
      return { accept: true, src: msg.src }
    case 'solo:grade':
    case 'solo:bye':
      return { accept: activeSrc !== null && msg.src === activeSrc, src: activeSrc }
    case 'solo:ping':
      return { accept: true, src: activeSrc }
    default:
      return { accept: false, src: activeSrc }
  }
}

// ---------------------------------------------------------------- 角落的字幕和提示放在哪
interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** 拿不到图区位置时，格子主体往下让出引擎顶栏的大概高度 */
export const ENGINE_TOPBAR_GUESS = 40

/**
 * 图区在工作区容器里的位置。board = 引擎量出来的图区（页面坐标），origin = 容器内容区左上角（页面坐标）；
 * 图区量不到（没挂上 / 宽高为 0）就用格子主体去掉引擎顶栏。body 为 null（跟随格不在）→ null。
 */
export function boardInRoot(
  origin: { left: number; top: number },
  board: { left: number; top: number; width: number; height: number } | null,
  body: Box | null,
): Box | null {
  if (!body) return null
  if (board && board.width > 0 && board.height > 0) return { x: board.left - origin.left, y: board.top - origin.top, w: board.width, h: board.height }
  const top = Math.min(ENGINE_TOPBAR_GUESS, body.h)
  return { x: body.x, y: body.y + top, w: body.w, h: Math.max(0, body.h - top) }
}

/**
 * 图区右下角引擎的缩放百分比标签（right 10px、bottom 10px，约 45×22，不在初始位置时才显示）连同留白要让出来的宽和高。
 * 标签显示不显示都按它在算，提示不会因为标签出现而跳位置。
 */
export const ZOOM_BADGE_RESERVE_W = 72
export const ZOOM_BADGE_RESERVE_H = 40
/** 提示放在百分比标签左边时至少要这么宽，不够就挪到标签上面 */
export const NOTICE_MIN_W = 160
export const NOTICE_MAX_W = 420

/**
 * 角落提示放哪：左下角、右边不超过百分比标签左边（留出 ZOOM_BADGE_RESERVE_W）；
 * 格子太窄、左边放不下 NOTICE_MIN_W 时，挪到标签上面、占满整行。文字在 maxWidth 里换行。
 * bottom = 提示下边的 y（容器坐标，提示往上长）。
 */
export function noticeBox(board: Box): { left: number; bottom: number; maxWidth: number } {
  const beside = board.w - 8 - ZOOM_BADGE_RESERVE_W
  if (beside >= NOTICE_MIN_W) return { left: board.x + 8, bottom: board.y + board.h - 8, maxWidth: Math.min(NOTICE_MAX_W, beside) }
  return { left: board.x + 8, bottom: board.y + board.h - ZOOM_BADGE_RESERVE_H, maxWidth: Math.max(0, board.w - 16) }
}

// ---------------------------------------------------------------- 文案
type EndText = Pick<SoloRoundEndMsg, 'answer_name' | 'bound_work'>

/** 「上一题：角色名《作品名》· 评级」 */
export function captionText(end: EndText, grade: Grade): string {
  const work = end.bound_work ? `《${end.bound_work.name}》` : ''
  // 》自带留白，所以后面的 · 前面不加空格
  return `上一题：${end.answer_name}${work}${work ? '· ' : ' · '}${GRADE_LABEL[grade] ?? grade}`
}

/** 「《绑定作品名》不在联动的图里」；没有绑定作品用角色名 */
export function notInGroupText(end: EndText): string {
  return end.bound_work ? `《${end.bound_work.name}》不在联动的图里` : `「${end.answer_name}」不在联动的图里`
}

export function planLabel(planName: string | null): string {
  return planName && planName.trim() ? planName.trim() : '工作台方案'
}

/**
 * 换方案的提示。新方案的图组是空的：默认说「还没有联动图组」（提示里另给「选图组」打开面板）；
 * 只有预选结果确实说明题库里的人哪张图里都没有（allMissing）才那样说。
 */
export function planSwitchText(planName: string | null, groupSize = 1, allMissing = false): string {
  const name = planLabel(planName)
  if (groupSize > 0) return `单人猜猜呗换了方案『${name}』，已换用它的图组`
  if (allMissing) return `单人猜猜呗换了方案『${name}』；它题库里的人哪张图里都没有，图组先空着`
  return `单人猜猜呗换了方案：方案『${name}』还没有联动图组`
}

/** 预选结果说明「题库里的人哪张图里都没有」：题库不空、而且每个人都在所有图里都没有 */
export function allMissingOf(pre: { pool_total: number; no_map: number }): boolean {
  return pre.pool_total > 0 && pre.no_map >= pre.pool_total
}

// ---------------------------------------------------------------- 实例重挂后恢复聚焦
/** 引擎的闪烁：闪 3 下约 1.5 秒后高亮自动消失 */
export const FLASH_MS = 1500

/** 当前有效的聚焦记到哪一步了（重挂时照着恢复） */
export interface FocusRecord {
  mode: 'stay' | 'flash'
  /** reveal 已经做过（或排队的已经执行）：重挂时不移动视区 */
  revealed: boolean
  /** 闪烁结束的时刻（毫秒）；停留 = null；闪烁还排着、没开始 = null */
  flashEnd: number | null
}

/** 重挂后怎么恢复：focusWorks 的 mode / reveal；clearAfter = 过多久清掉（闪烁剩下的时间），null = 不清 */
export interface FocusRestore {
  mode: 'stay' | 'flash'
  reveal: boolean
  clearAfter: number | null
}

/**
 * 目标标签的实例换了（保活淘汰后重挂、开发时 StrictMode 挂两次）：要不要、怎么在新实例上恢复聚焦。
 * - 停留：恢复高亮；reveal 已经做过就不移动视区（视区由宿主按存下的还原）；题目进行中不移动视区
 * - 闪烁：还排着没开始 → 原样再来一次；正在闪 → 按剩下的时间亮着、到点清掉（不从头重闪）；闪完了 → 不恢复
 */
export function restoreFocus(rec: FocusRecord, now: number, roundActive: boolean): FocusRestore | null {
  const reveal = !rec.revealed && !roundActive
  if (rec.mode === 'stay') return { mode: 'stay', reveal, clearAfter: null }
  if (rec.flashEnd === null) return { mode: 'flash', reveal, clearAfter: null }
  const left = rec.flashEnd - now
  return left > 0 ? { mode: 'stay', reveal: false, clearAfter: left } : null
}
