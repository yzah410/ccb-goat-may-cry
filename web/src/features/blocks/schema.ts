/**
 * 组块 / 方案配置的前端 schema —— 镜像 backend/schemas.py（以后端的定义为准）。
 *
 * 约定：
 * - tag_groups 在前端统一用「列表的列表」形态：[[TagItem, ...], ...]（和方案文件一致）
 * - params / block 都是 looseObject：方案文件里有额外字段也原样保留，保存回去不丢
 * - 可选字段（char-range 的年份/评分区间等）没设置时就**不出现**，而不是 null（保证方案文件原样往返）
 */
import { z } from 'zod'

export const BLOCK_KINDS = ['work-range', 'work-list', 'char-list', 'char-range'] as const
export type BlockKind = (typeof BLOCK_KINDS)[number]

export const TagKindSchema = z.enum(['work', 'char', 'va', 'source'])
export type TagKind = z.infer<typeof TagKindSchema>

export const ColorSchema = z.enum(['red', 'blue'])
/** red = 纳入（并进候选池）；blue = 排除（从候选池剔除） */
export type BlockColor = z.infer<typeof ColorSchema>

export const TagItemSchema = z.object({
  name: z.string().trim().min(1, '标签名不能为空'),
  kind: TagKindSchema,
  color: ColorSchema,
})
export type TagItem = z.infer<typeof TagItemSchema>

/** 组之间是「或」，组内：纳入标签「都要有」，排除标签「一个都不能有」 */
export const TagGroupsSchema = z.array(z.array(TagItemSchema))
export type TagGroups = z.infer<typeof TagGroupsSchema>

const Int = z.number().int()
const Num = z.number().finite()
const IntPair = z.tuple([Int, Int])
const NumPair = z.tuple([Num, Num])
export const RankKindSchema = z.enum(['rank', 'percent'])
export const RolesScopeSchema = z.enum(['main', 'all'])
export const RankBasisSchema = z.enum(['per_year', 'merged'])
export const GenderSchema = z.enum(['?', '♂', '♀'])
export type Gender = z.infer<typeof GenderSchema>

export const WorkRangeParamsSchema = z.looseObject({
  years: IntPair,
  tag_groups: TagGroupsSchema,
  rank_basis: RankBasisSchema,
  rank_value_kind: RankKindSchema,
  rank_lo: Num,
  rank_hi: Num,
  roles_scope: RolesScopeSchema,
  role_rank_kind: RankKindSchema,
  role_rank_lo: Num,
  role_rank_hi: Num,
})

export const WorkListParamsSchema = z.looseObject({
  work_lines: z.string(),
  roles_scope: RolesScopeSchema.optional(),
  role_rank_kind: RankKindSchema.optional(),
  role_rank_lo: Num.optional(),
  role_rank_hi: Num.optional(),
})

export const CharListParamsSchema = z.looseObject({
  char_lines: z.string(),
})

export const CharRangeParamsSchema = z.looseObject({
  earliest_year: IntPair.optional(),
  latest_year: IntPair.optional(),
  genders: z.array(GenderSchema).optional(),
  max_score: NumPair.optional(),
  tag_groups: TagGroupsSchema,
  appear_works: z.array(Int).optional(),
})

export type WorkRangeParams = z.infer<typeof WorkRangeParamsSchema>
export type WorkListParams = z.infer<typeof WorkListParamsSchema>
export type CharListParams = z.infer<typeof CharListParamsSchema>
export type CharRangeParams = z.infer<typeof CharRangeParamsSchema>

const blockBase = {
  id: z.string().min(1),
  color: ColorSchema,
  /** 只有纳入块生效：同一角色被多个纳入块命中时取最大值 */
  weight: Num.min(0),
  enabled: z.boolean(),
}

export const BlockSchema = z.discriminatedUnion('kind', [
  z.looseObject({ ...blockBase, kind: z.literal('work-range'), params: WorkRangeParamsSchema }),
  z.looseObject({ ...blockBase, kind: z.literal('work-list'), params: WorkListParamsSchema }),
  z.looseObject({ ...blockBase, kind: z.literal('char-list'), params: CharListParamsSchema }),
  z.looseObject({ ...blockBase, kind: z.literal('char-range'), params: CharRangeParamsSchema }),
])
export type Block = z.infer<typeof BlockSchema>
export type BlockOf<K extends BlockKind> = Extract<Block, { kind: K }>
export type ParamsOf<K extends BlockKind> = BlockOf<K>['params']

export const DrawModeSchema = z.enum(['char-weight', 'work-weight'])
/** char-weight = 按角色权重抽；work-weight = 先按作品权重抽作品，再在作品里均匀抽角色 */
export type DrawMode = z.infer<typeof DrawModeSchema>

/** 发给 /preview /draw /candidates /generate_canvas /autoclick/auto/start 的配置（= backend ConfigPayload） */
export const ConfigPayloadSchema = z.object({
  mode: DrawModeSchema,
  seed: Int.nullable(),
  theme: z.string().nullable().optional(),
  blocks: z.array(BlockSchema),
  include_extra_work_tags: z.boolean(),
})
export type ConfigPayload = z.infer<typeof ConfigPayloadSchema>

/** 方案文件（data/plans/<name>.json） */
export const PlanFileSchema = z.looseObject({
  name: z.string().optional(),
  mode: z.string().optional(),
  seed: z.number().nullable().optional(),
  theme: z.string().nullable().optional(),
  blocks: z.array(z.unknown()).optional(),
  include_extra_work_tags: z.boolean().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})
export type PlanFile = z.infer<typeof PlanFileSchema>

export const KIND_LABEL: Record<BlockKind, string> = {
  'work-range': '作品范围',
  'work-list': '作品列',
  'char-list': '角色列',
  'char-range': '角色范围',
}

export const KIND_DESC: Record<BlockKind, string> = {
  'work-range': '按年份、作品标签、收藏排名圈出一批作品，再从每部作品里取热度靠前的角色',
  'work-list': '手写一份作品清单（每行一部），取这些作品里的角色',
  'char-list': '手写一份角色清单（每行一个），直接就是这些角色',
  'char-range': '直接按角色的属性筛：登场年份、性别、评分、标签、登场作品',
}

export const TAG_KIND_LABEL: Record<TagKind, string> = {
  work: '作品标签',
  char: '角色标签',
  va: '声优',
  source: '原作来源',
}

export const COLOR_LABEL: Record<BlockColor, string> = { red: '纳入', blue: '排除' }
export const MODE_LABEL: Record<DrawMode, string> = { 'char-weight': '按角色权重', 'work-weight': '按作品权重' }
