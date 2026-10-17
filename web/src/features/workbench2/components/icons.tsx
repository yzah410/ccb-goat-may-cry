/** 每种条件一个图标（chip、菜单里用） */
import type { ConditionType } from '@/features/v2/types'
import {
  IconBraces,
  IconCalendar,
  IconCalendarRange,
  IconFilm,
  IconFlame,
  IconHash,
  IconListChecks,
  IconMic,
  IconStar,
  IconTag,
  IconTags,
  IconUser,
  IconVenusMars,
  IconBookOpen,
} from '@/lib/icons'

export function CondIcon({ type }: { type: ConditionType | string }) {
  switch (type) {
    case 'gender':
      return <IconVenusMars aria-hidden />
    case 'char_heat':
      return <IconFlame aria-hidden />
    case 'char_tags':
      return <IconUser aria-hidden />
    case 'va':
      return <IconMic aria-hidden />
    case 'game_tags':
      return <IconTags aria-hidden />
    case 'source_tag':
      return <IconBookOpen aria-hidden />
    case 'n_app':
      return <IconHash aria-hidden />
    case 'earliest_year':
      return <IconCalendar aria-hidden />
    case 'latest_year':
      return <IconCalendarRange aria-hidden />
    case 'rating':
      return <IconStar aria-hidden />
    case 'appearance':
      return <IconFilm aria-hidden />
    case 'char_list':
      return <IconListChecks aria-hidden />
    case 'sql':
      return <IconBraces aria-hidden />
    default:
      return <IconTag aria-hidden />
  }
}
