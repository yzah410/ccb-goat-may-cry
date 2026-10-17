/**
 * 弹层的放大倍数。页面里某一块用了 CSS zoom（单人猜猜呗的「界面大小」）时，
 * 那一块里的 Tooltip 是 Portal 到主题的弹层容器里画的、不在 zoom 的范围内，字会比周围小一圈。
 * 用 OverlayZoomContext.Provider 把同样的倍数告诉弹层，Tooltip 自己再放大一次（位置由 floating-ui 按触发元素的实际位置算，不受影响）。
 * 默认 1 = 不放大。
 */
import { createContext } from 'react'

export const OverlayZoomContext = createContext(1)
