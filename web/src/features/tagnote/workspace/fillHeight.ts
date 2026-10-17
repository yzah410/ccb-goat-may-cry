/**
 * 让一个元素占满 <main> 剩下的可见高度：方案库不靠整页滚动，左边列表和工作区每一格各自滚。
 *
 * 高度 = main 的可见高度 − 元素在 main 内容里的位置 − 底部留白。
 * 元素下面原本的空白（页面的下内边距）用负的 margin-bottom 抵掉，只剩「底部留白」，整页正好不用滚：
 * 底部胶囊布局（[data-layout=dock]）的导航胶囊浮在内容上，留 20 个间距单位让开它；其余布局留 4 个。
 * 太矮的窗口不压到 MIN 以下（那时整页可以滚）。
 *
 * 直接写 style（命令式），不进 React 状态：窗口、外壳变化时不重渲染整个方案库。
 */
import { useLayoutEffect, type RefObject } from 'react'
import { scrollParent, spaceBelow } from '../binding'

export const FILL_MIN_H = 400

export function useFillHeight(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    const el = ref.current
    const main = enabled ? scrollParent(el) : null
    if (!el || !main || typeof ResizeObserver === 'undefined') return
    const apply = () => {
      const cs = getComputedStyle(el)
      const unit = parseFloat(cs.getPropertyValue('--space-unit')) || 4
      const reserve = unit * (el.closest('[data-layout=dock]') ? 20 : 4)
      const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top - main.clientTop + main.scrollTop
      // spaceBelow 里含元素自己的 margin-bottom（上一轮设的），去掉
      const below = spaceBelow(el, main) - (parseFloat(cs.marginBottom) || 0)
      const h = `${Math.max(FILL_MIN_H, Math.floor(main.clientHeight - top - reserve))}px`
      const mb = `${Math.round(reserve - below)}px`
      if (el.style.height !== h) el.style.height = h
      if (el.style.marginBottom !== mb) el.style.marginBottom = mb
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(main)
    return () => {
      ro.disconnect()
      el.style.height = ''
      el.style.marginBottom = ''
    }
  }, [ref, enabled])
}
