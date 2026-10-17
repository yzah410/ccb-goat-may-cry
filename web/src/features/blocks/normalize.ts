/**
 * 把「方案文件里的组块」规整成前端能编辑的形态。
 *
 * 原则：宽进严出、不丢字段、不凭空加字段。
 * - 合法的方案原样通过（测试用 examples/classic-plans/ 里的全部方案验证：加载 → 保存 = 字节级不变）
 * - tag_groups 的三种形态（列表的列表 / [{items:[...]}] / 单组平铺）统一成列表的列表
 * - 必填字段缺了才补默认值，并返回一条中文警告
 * - 额外字段（schema 里没有的）原样保留
 */
import { DEFAULT_WORK_RANGE, newBlockId } from './defaults'
import {
  BLOCK_KINDS,
  KIND_LABEL,
  type Block,
  type BlockColor,
  type BlockKind,
  type TagGroups,
  type TagItem,
  type TagKind,
} from './schema'

const TAG_KINDS: TagKind[] = ['work', 'char', 'va', 'source']
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

function toIntPair(v: unknown): [number, number] | undefined {
  if (!Array.isArray(v) || v.length < 2) return undefined
  const a = toNum(v[0])
  const b = toNum(v[1])
  if (a === undefined || b === undefined) return undefined
  return [Math.round(a), Math.round(b)]
}

function toNumPair(v: unknown): [number, number] | undefined {
  if (!Array.isArray(v) || v.length < 2) return undefined
  const a = toNum(v[0])
  const b = toNum(v[1])
  if (a === undefined || b === undefined) return undefined
  return [a, b]
}

function normTagItem(v: unknown, where: string, warnings: string[]): TagItem | null {
  if (!isObj(v)) {
    warnings.push(`${where}：有一个标签格式不对，已跳过`)
    return null
  }
  const name = typeof v.name === 'string' ? v.name.trim() : ''
  if (!name) {
    warnings.push(`${where}：有一个标签没有名字，已跳过`)
    return null
  }
  let kind = v.kind as TagKind
  if (!TAG_KINDS.includes(kind)) {
    warnings.push(`${where}：标签「${name}」的类型「${String(v.kind)}」不认识，按作品标签处理`)
    kind = 'work'
  }
  let color = v.color as BlockColor
  if (color !== 'red' && color !== 'blue') {
    warnings.push(`${where}：标签「${name}」的颜色「${String(v.color)}」不认识，按纳入处理`)
    color = 'red'
  }
  // 保留额外字段（极少见）
  return { ...v, name, kind, color } as TagItem
}

/** 三种形态 → 列表的列表 */
export function normalizeTagGroups(v: unknown, where = '标签组', warnings: string[] = []): TagGroups {
  if (v === null || v === undefined) return []
  if (!Array.isArray(v)) {
    warnings.push(`${where}：格式不对，已清空`)
    return []
  }
  if (v.length === 0) return []
  let groups: unknown[][]
  if (Array.isArray(v[0])) groups = v as unknown[][]
  else if (isObj(v[0]) && 'items' in v[0])
    groups = (v as Record<string, unknown>[]).map((g) => (Array.isArray(g.items) ? g.items : []))
  else groups = [v]
  return groups.map((g, gi) =>
    (Array.isArray(g) ? g : [])
      .map((it) => normTagItem(it, `${where} 第 ${gi + 1} 组`, warnings))
      .filter((x): x is TagItem => x !== null),
  )
}

export interface NormalizedBlock {
  block: Block | null
  warnings: string[]
}

export function normalizeBlock(raw: unknown, index: number): NormalizedBlock {
  const warnings: string[] = []
  const at = `第 ${index + 1} 个组块`
  if (!isObj(raw)) return { block: null, warnings: [`${at}格式不对，已跳过`] }
  const kind = raw.kind as BlockKind
  if (!BLOCK_KINDS.includes(kind)) return { block: null, warnings: [`${at}的类型「${String(raw.kind)}」不认识，已跳过`] }
  const where = `${at}（${KIND_LABEL[kind]}）`

  const id = typeof raw.id === 'string' && raw.id ? raw.id : newBlockId()
  let color = raw.color as BlockColor
  if (color !== 'red' && color !== 'blue') {
    warnings.push(`${where}：颜色「${String(raw.color)}」不认识，按纳入处理`)
    color = 'red'
  }
  // 没写权重 → 1（后端 schemas.py 的默认值）；写了但不是数字或是负数 → 0（和编辑框的规则一样）
  const w = toNum(raw.weight)
  const missing = raw.weight === undefined || raw.weight === null
  const weight = missing ? 1 : w === undefined || w < 0 ? 0 : w
  if (!missing && w === undefined) warnings.push(`${where}：权重「${String(raw.weight)}」不是数字，按 0 处理`)
  else if (w !== undefined && w < 0) warnings.push(`${where}：权重是负数（${w}），按 0 处理`)
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : true
  const p: Record<string, unknown> = isObj(raw.params) ? { ...raw.params } : {}

  const fill = (key: string, value: unknown) => {
    p[key] = value
    warnings.push(`${where}：缺少「${key}」，已补默认值`)
  }

  if (kind === 'work-range') {
    const years = toIntPair(p.years)
    if (years) p.years = years
    else fill('years', [...DEFAULT_WORK_RANGE.years])
    p.tag_groups = normalizeTagGroups(p.tag_groups, `${where} 的标签组`, warnings)
    for (const key of ['rank_lo', 'rank_hi', 'role_rank_lo', 'role_rank_hi'] as const) {
      const n = toNum(p[key])
      if (n === undefined) fill(key, DEFAULT_WORK_RANGE[key])
      else p[key] = n
    }
    if (p.rank_basis !== 'per_year' && p.rank_basis !== 'merged') fill('rank_basis', DEFAULT_WORK_RANGE.rank_basis)
    if (p.rank_value_kind !== 'rank' && p.rank_value_kind !== 'percent') fill('rank_value_kind', 'rank')
    if (p.roles_scope !== 'main' && p.roles_scope !== 'all') fill('roles_scope', 'all')
    if (p.role_rank_kind !== 'rank' && p.role_rank_kind !== 'percent') fill('role_rank_kind', 'rank')
  } else if (kind === 'work-list') {
    if (typeof p.work_lines !== 'string') fill('work_lines', '')
    for (const key of ['role_rank_lo', 'role_rank_hi'] as const) {
      if (p[key] === undefined || p[key] === null) delete p[key]
      else {
        const n = toNum(p[key])
        if (n === undefined) delete p[key]
        else p[key] = n
      }
    }
    if (p.roles_scope !== undefined && p.roles_scope !== 'main' && p.roles_scope !== 'all') delete p.roles_scope
    if (p.role_rank_kind !== undefined && p.role_rank_kind !== 'rank' && p.role_rank_kind !== 'percent') delete p.role_rank_kind
  } else if (kind === 'char-list') {
    if (typeof p.char_lines !== 'string') fill('char_lines', '')
  } else {
    // char-range：可选字段只在合法时保留，null 视为「不限」直接去掉
    for (const key of ['earliest_year', 'latest_year'] as const) {
      if (p[key] === undefined) continue
      const pair = toIntPair(p[key])
      if (pair) p[key] = pair
      else {
        if (p[key] !== null) warnings.push(`${where}：「${key}」格式不对，按不限处理`)
        delete p[key]
      }
    }
    if (p.max_score !== undefined) {
      const pair = toNumPair(p.max_score)
      if (pair) p.max_score = pair
      else {
        if (p.max_score !== null) warnings.push(`${where}：「max_score」格式不对，按不限处理`)
        delete p.max_score
      }
    }
    if (p.genders !== undefined) {
      if (Array.isArray(p.genders)) p.genders = p.genders.filter((g) => g === '?' || g === '♂' || g === '♀')
      else delete p.genders
    }
    if (p.appear_works !== undefined) {
      if (Array.isArray(p.appear_works))
        p.appear_works = p.appear_works.map((x) => toNum(x)).filter((x): x is number => x !== undefined).map(Math.round)
      else delete p.appear_works
    }
    p.tag_groups = normalizeTagGroups(p.tag_groups, `${where} 的标签组`, warnings)
  }

  // 保留 block 顶层的额外字段
  const block = { ...raw, id, kind, color, weight, enabled, params: p } as Block
  return { block, warnings }
}

export function normalizeBlocks(raw: unknown): { blocks: Block[]; warnings: string[] } {
  if (!Array.isArray(raw)) return { blocks: [], warnings: raw === undefined ? [] : ['blocks 不是列表，已清空'] }
  const blocks: Block[] = []
  const warnings: string[] = []
  raw.forEach((r, i) => {
    const res = normalizeBlock(r, i)
    if (res.block) blocks.push(res.block)
    warnings.push(...res.warnings)
  })
  return { blocks, warnings }
}
