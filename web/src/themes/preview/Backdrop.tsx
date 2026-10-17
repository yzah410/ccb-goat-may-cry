import type { BackdropProps } from '../types'

/**
 * 一层轻渐变（不用壁纸，所以没有壁纸也能用）：右上角一团强调色的光晕。
 * 主题画廊、分屏对比、?theme= 都会渲染它，用来验证 Backdrop 这条链路。
 */
export default function PreviewBackdrop(_props: BackdropProps) {
  return (
    <div
      className="absolute inset-0"
      style={{
        background:
          'radial-gradient(1100px 480px at 90% -10%, color-mix(in oklab, var(--accent) 14%, transparent), transparent 70%)',
      }}
    />
  )
}
