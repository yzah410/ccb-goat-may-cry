import { Link } from 'react-router'
import { Button } from '@/components/ui/Button'
import { IconSettings } from '@/lib/icons'
import { AI_SETTINGS_PATH } from './paths'

/** 「去设置」：AI 用不了时放在原因旁边，跳到设置页的 AI 卡片 */
export function GoSettings() {
  return (
    <Button asChild size="sm" variant="ghost" icon={<IconSettings />}>
      <Link to={AI_SETTINGS_PATH}>去设置</Link>
    </Button>
  )
}
