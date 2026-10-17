/**
 * 标签笔记（TagNote）在出题器里用到的类型。
 * 作品集 JSON 的类型来自引擎自带的 .d.ts（tagnote/build.py 生成，不手改）；这里只补方案库接口的类型。
 */
import type { LayoutCache, TagNoteData, TagNotePrefs, TagNoteWork } from '@/vendor/tagnote/tagnote.esm.js'

export type { LayoutCache, TagNoteData, TagNotePrefs, TagNoteWork }

/** 标签口径：map = 和导出的 .canvas 导图上显示的标签一样；full = 角色的全部标签 */
export type TagMode = 'map' | 'full'

/** 导图来源：manual = 手工整理的导图；batch = 批量生成的导图；outsetter = 在出题器里新建的导图 */
export type MapSource = 'manual' | 'batch' | 'outsetter'

/** GET /v2/maps 的一项 */
export interface MapSummary {
  id: string
  title: string
  source: MapSource | string | null
  /** 分组用的年份信息（如「2018」「1995-1999」）；在出题器里新建的为 null */
  group: string | null
  /** 导入的导图原来的文件路径；新建的为 null */
  origin: string | null
  n_works: number
  common_tags: string[]
  tags_from: string | null
  generated_at: string | null
  updated_at: string
  /**
   * 用户最近一次编辑（新建、改数据、改名）的时间；只改布局缓存不算。图里没有编辑记录时，后端回退成 generated_at
   * （只有日期）；两个都没有 = null。联动预选里「覆盖一样多时选更近编辑的」就看它。
   */
  edited_at?: string | null
}

/** GET /v2/maps/{id}：作品集 JSON，外加顶层 id、updated_at（图里没有编辑记录时没有 edited_at） */
export type MapDetail = TagNoteData & { id: string; updated_at: string; edited_at?: string }

/** GET /v2/map_samples：样例导图一共几张，方案库里还没有的有几张 */
export interface MapSamples {
  total: number
  remaining: number
}

/** POST /v2/map_samples/load：这次复制进来几张、因为方案库里已有同 id 的图而跳过几张，外加载入后的 total / remaining */
export interface MapSamplesLoaded extends MapSamples {
  loaded: number
  skipped: number
}

/** PATCH /v2/maps/{id} */
export interface MapPatch {
  title?: string
  layout_cache?: LayoutCache
}

/** POST /v2/tagnote 的请求体 */
export interface GenerateBody {
  spec: unknown
  title: string
  tag_mode: TagMode
}
