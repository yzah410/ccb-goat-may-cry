/**
 * 单人猜猜呗的头像：表格、搜索下拉。跟着设置里的「显示角色头像」开关：
 * 关着（默认）时不请求、不显示头像，框还在、里面是人像占位，表格和下拉的列宽不变。
 * 地址缓存、限速队列沿用 features/candidates/avatar.ts；priority = 插到队首（不用等后台预取题库的那几百个）。
 */
import { cn } from '@/lib/cn'
import { IconUser } from '@/lib/icons'
import { useBgmAvatar } from '@/features/candidates/avatar'
import { usePrefs } from '@/features/settings/store'

const SIZE = { sm: 'size-8 rounded-sm', md: 'size-11 rounded-md' } as const

export function SoloAvatar({ id, size = 'md', priority = true, className }: { id: number | null; size?: keyof typeof SIZE; priority?: boolean; className?: string }) {
  const avatarsOn = usePrefs((s) => s.avatars)
  const url = useBgmAvatar(id, id != null, priority)
  return (
    <span className={cn('block shrink-0 overflow-hidden bg-surface-2 ring-1 ring-inset ring-border', SIZE[size], className)} aria-hidden>
      {url ? (
        <img src={url} alt="" className="size-full object-cover object-top" loading="lazy" />
      ) : (
        <span className={cn('grid size-full place-items-center text-fg-3', avatarsOn && url === undefined && id != null && 'skeleton')}>
          {(!avatarsOn || url === '' || id == null) && <IconUser className="size-1/2" />}
        </span>
      )}
    </span>
  )
}
