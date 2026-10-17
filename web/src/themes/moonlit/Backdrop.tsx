import type { CSSProperties } from 'react'
// 直接从 kit 的叶子模块引入，不经过 kit/index（少引入一层间接依赖，热更新时也不容易出现重复实例）
import { WallpaperImage } from '../kit/WallpaperImage'
import { Veil } from '../kit/Veil'
import type { BackdropProps } from '../types'
import { hasWallpaper } from '@/lib/wallpapers'
import { SHOWCASE, sceneFor, type Scene } from './scenes'
import { Fireflies } from './Fireflies'
import { MoonCrescent } from './MoonCrescent'

/**
 * 月夜·萤火的背景层（从下到上）：
 *   1. 夜空：靛蓝竖向渐变 + 右上角一团偏紫的天光
 *   2. 壁纸（可选；没有壁纸时跳过这一层，画廊 / 404 换成纯 CSS / SVG 画的星空和一弯月牙，见 MoonCrescent.tsx）：
 *      - 工作页：只在右上角开一扇「起雾的窗」（椭圆渐隐遮罩），强度 = --backdrop-opacity × 这张图的系数，
 *        画面压得很淡，只留下颜色和大致轮廓；卡片是半透明玻璃，透过去只剩一点颜色
 *      - 画廊 / 404：画面整张打开，只在放文字的一侧用渐变压暗
 *   3. 月晕：右上角一圈很淡的金光（光源在这里，所以卡片顶沿那道细亮边是合理的）。
 *      画廊 / 404 没有壁纸时不加：那时的光来自月牙自己的柔光
 *   4. 萤火：十几个会慢慢飘、慢慢闪的小光点（纯 CSS 动画，「减少动效」时自动停）
 *   5. 细颗粒：防止深色渐变出现色带
 *
 * compact（分屏对比格子）：用 480 宽小图，不做动画、不做模糊、不加颗粒。
 * 永远 absolute inset-0，不用 fixed（分屏对比里只铺满自己那一格）。
 */
export default function MoonlitBackdrop({ route, compact }: BackdropProps) {
  const scene = sceneFor(route)
  const showcase = SHOWCASE.has(route)
  const crescent = showcase && !hasWallpaper(scene.slug)
  return (
    <div className="absolute inset-0 overflow-hidden" data-moonlit-scene={scene.slug}>
      <NightSky />
      {showcase ? <ShowcaseWallpaper scene={scene} compact={compact} route={route} /> : <WindowWallpaper scene={scene} compact={compact} />}
      {!crescent && <MoonGlow strong={showcase} />}
      <Fireflies seed={route} count={compact ? 5 : showcase ? 18 : 14} still={compact} />
      {!compact && <Grain />}
    </div>
  )
}

function NightSky() {
  return (
    <div
      className="absolute inset-0"
      style={{
        background: [
          // 右上角偏紫的天光（月亮所在的那片天）
          'radial-gradient(1100px 620px at 88% -12%, rgb(92 80 158 / 0.26), transparent 68%)',
          // 左下角：一点暖光，再外面一圈深青色，底部不是死黑
          'radial-gradient(520px 340px at 6% 104%, rgb(214 168 92 / 0.10), transparent 70%)',
          'radial-gradient(900px 520px at -8% 108%, rgb(40 64 80 / 0.22), transparent 70%)',
          'linear-gradient(180deg, #12152c 0%, var(--bg) 42%, #080a16 100%)',
        ].join(', '),
      }}
    />
  )
}

/** 工作页：右上角的一扇起雾的窗 */
function WindowWallpaper({ scene, compact }: { scene: Scene; compact?: boolean }) {
  if (!hasWallpaper(scene.slug)) return null
  const mask =
    'radial-gradient(ellipse 78% 72% at 70% 24%, #000 0%, rgb(0 0 0 / 0.72) 30%, rgb(0 0 0 / 0.28) 55%, transparent 76%)'
  const frame: CSSProperties = {
    opacity: `calc(var(--backdrop-opacity) * ${scene.strength})`,
    maskImage: mask,
    WebkitMaskImage: mask,
  }
  // 至少放大 1.08：模糊会在图片边缘留一圈透明的毛边，放大把毛边推到窗外
  const zoom = Math.max(scene.zoom ?? 1, 1.08)
  const img: CSSProperties = {
    transform: `scale(${zoom})`,
    transformOrigin: scene.origin ?? '60% 40%',
    // 模糊 5px + 压一点亮度和饱和度：图像只剩轮廓和颜色，不抢内容。
    // 这是静态图，浏览器只算一次；compact 里不加滤镜（省）
    filter: compact ? undefined : 'blur(5px) saturate(0.9) brightness(0.9)',
  }
  return (
    <div className="absolute right-0 top-0 h-[94%] w-[66%]" style={frame}>
      <WallpaperImage slug={scene.slug} size={compact ? 'thumb' : 'full'} position={scene.pos} style={img} />
    </div>
  )
}

/** 画廊 / 404：整张打开 */
function ShowcaseWallpaper({ scene, compact, route }: { scene: Scene; compact?: boolean; route: string }) {
  const gallery = route === 'themes'
  if (!hasWallpaper(scene.slug)) return <MoonCrescent gallery={gallery} compact={compact} />
  return (
    <>
      {/* 画廊：月亮放在右侧 62% 的窗里（左侧留给页头文字）；404：整屏 */}
      <div className={gallery ? 'absolute right-0 top-0 h-full w-[62%]' : 'absolute inset-0'}>
        <WallpaperImage
          slug={scene.slug}
          size={compact ? 'thumb' : 'full'}
          position={scene.pos}
          style={{ transform: scene.zoom ? `scale(${scene.zoom})` : undefined, transformOrigin: scene.origin }}
        />
      </div>
      {gallery ? (
        <>
          {/* 从左往右：左侧是纯夜色（放页头文字），往右慢慢把月亮让出来 */}
          <Veil direction="to left" from={10} to={62} minOpacity={0.18} blur={compact ? 0 : 10} />
          {/* 从上往下：卡片网格那一片压回夜色 */}
          <Veil direction="to bottom" from={30} to={78} minOpacity={0} />
        </>
      ) : (
        // 404：文字在正中间 → 中间压暗成一圈「夜的空地」，画面从四周露出来；四角再压一点，别让画面抢戏
        <div
          className="absolute inset-0"
          style={{
            background: [
              'radial-gradient(ellipse 46% 52% at 50% 50%, color-mix(in oklab, var(--bg) 92%, transparent) 0%, color-mix(in oklab, var(--bg) 68%, transparent) 55%, color-mix(in oklab, var(--bg) 30%, transparent) 100%)',
              'radial-gradient(ellipse 90% 90% at 50% 50%, transparent 55%, color-mix(in oklab, var(--bg) 55%, transparent) 100%)',
            ].join(', '),
          }}
        />
      )}
    </>
  )
}

/** 月晕：右上角很淡的一圈金光 */
function MoonGlow({ strong }: { strong?: boolean }) {
  return (
    <div
      className="absolute inset-0"
      style={{
        background: `radial-gradient(420px 360px at 94% -6%, rgb(242 213 133 / ${strong ? 0.22 : 0.16}), rgb(242 213 133 / 0.05) 48%, transparent 72%)`,
      }}
    />
  )
}

/** 细颗粒（SVG 噪点，静态，只画一次）：防止大面积深色渐变出现一圈一圈的色带 */
const GRAIN = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.55 0'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E")`

function Grain() {
  return <div className="absolute inset-0" style={{ backgroundImage: GRAIN, opacity: 0.035, mixBlendMode: 'overlay' }} />
}
