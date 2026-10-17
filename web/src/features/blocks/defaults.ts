import type { Block, BlockKind, CharRangeParams, WorkRangeParams } from './schema'

/** 随机 36 进制串（后端不校验唯一性，只用来当 React key） */
export function newBlockId(): string {
  return Math.random().toString(36).slice(2)
}

export const DEFAULT_WORK_RANGE: WorkRangeParams = {
  years: [1980, 2025],
  tag_groups: [],
  rank_basis: 'per_year',
  rank_value_kind: 'rank',
  rank_lo: 1,
  rank_hi: 20,
  roles_scope: 'all',
  role_rank_kind: 'rank',
  role_rank_lo: 1,
  role_rank_hi: 5,
}

export const DEFAULT_ROLE_RANK = {
  roles_scope: 'all' as const,
  role_rank_kind: 'rank' as const,
  role_rank_lo: 1,
  role_rank_hi: 5,
}

/** char-range 的「不限」切成「限定」时填进去的初值 */
export const CHAR_RANGE_PRESETS: Required<Pick<CharRangeParams, 'earliest_year' | 'latest_year' | 'max_score'>> = {
  earliest_year: [1980, 2025],
  latest_year: [1980, 2025],
  max_score: [0, 10],
}

/** 新组块的默认参数（红色、权重 1、启用） */
export function newBlock(kind: BlockKind): Block {
  const base = { id: newBlockId(), color: 'red' as const, weight: 1, enabled: true }
  switch (kind) {
    case 'work-range':
      return { ...base, kind, params: { ...DEFAULT_WORK_RANGE, years: [...DEFAULT_WORK_RANGE.years], tag_groups: [] } }
    case 'work-list':
      return { ...base, kind, params: { work_lines: '', ...DEFAULT_ROLE_RANK } }
    case 'char-list':
      return { ...base, kind, params: { char_lines: '' } }
    case 'char-range':
      return { ...base, kind, params: { tag_groups: [] } }
  }
}

/** 复制一个组块（新 id，深拷贝参数） */
export function cloneBlock(b: Block): Block {
  return { ...(JSON.parse(JSON.stringify(b)) as Block), id: newBlockId() }
}
