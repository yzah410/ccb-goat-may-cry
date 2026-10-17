/** 出题器界面上用到的中文名字（放在单独的文件：组件文件只导出组件，热更新才不会退化成整页刷新） */
import type { ListKind, SuggestKind } from './types'

export const SUGGEST_KIND_LABEL: Record<SuggestKind, string> = {
  game_tag: '作品标签',
  work_tag: '作品本身的标签',
  meta_tag: '公共标签',
  char_tag: '角色标签',
  va: '声优',
  work: '作品',
  character: '角色',
}

export const LIST_KIND_LABEL: Record<ListKind, string> = { character: '角色清单', work: '作品清单', tag: '标签清单' }
