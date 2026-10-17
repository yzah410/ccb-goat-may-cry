import { useState, type CSSProperties } from 'react'
import { getWallpaper } from '@/lib/wallpapers'
import { cn } from '@/lib/cn'

export interface WallpaperImageProps {
  slug: string
  /** full = 1920 宽；thumb = 480 宽（缩略、分屏对比里用它省流量） */
  size?: 'full' | 'thumb'
  /** 对应 CSS object-position，例如 'center 30%'、'right top' */
  position?: string
  className?: string
  style?: CSSProperties
  /** 淡入时长（毫秒），默认读 --motion-duration 的两倍感觉；设 0 关掉 */
  fadeMs?: number
}

/**
 * 铺满父元素的壁纸图：先显示 16px 的模糊占位（立即可见），大图加载完再淡入。
 * 父元素需要是定位元素（Backdrop 的外壳已经是 absolute inset-0）。
 */
export function WallpaperImage(props: WallpaperImageProps) {
  // 换图时用 key 重置「是否加载完」的状态
  return <WallpaperImageInner key={`${props.slug}:${props.size ?? 'full'}`} {...props} />
}

function WallpaperImageInner({ slug, size = 'full', position = 'center', className, style, fadeMs = 400 }: WallpaperImageProps) {
  const w = getWallpaper(slug)
  const [loaded, setLoaded] = useState(false)
  if (!w) return null
  const src = size === 'full' ? w.full : w.thumb
  return (
    <div className={cn('absolute inset-0 overflow-hidden', className)} style={style} data-wallpaper={slug}>
      {w.blurDataURL && (
        <img
          src={w.blurDataURL}
          alt=""
          aria-hidden
          className="absolute inset-0 size-full object-cover"
          style={{ objectPosition: position, filter: 'blur(24px)', transform: 'scale(1.08)' }}
        />
      )}
      <img
        src={src}
        alt=""
        aria-hidden
        decoding="async"
        onLoad={() => setLoaded(true)}
        className="absolute inset-0 size-full object-cover"
        style={{
          objectPosition: position,
          opacity: loaded ? 1 : 0,
          transition: fadeMs ? `opacity ${fadeMs}ms ease-out` : undefined,
        }}
      />
    </div>
  )
}
