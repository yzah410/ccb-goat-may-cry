/**
 * 出题器主题 token → 引擎的 --tn-* 变量。
 *
 * 为什么分两层（外框 --tnv-*，挂载元素 --tn-*）：
 * 引擎 setTheme('light'|'dark') 会在挂载元素上写 data-theme="light|dark"。出题器的 tokens.base.css 用 [data-theme]
 * 给「每个主题作用域」铺一整套默认 token，于是挂载元素上的 --surface-1、--text-1 … 会被重置成 base 主题的值。
 * 所以先在外框（没有 data-theme）上把出题器的主题 token 解析成 --tnv-*（自定义属性继承的是解析后的值），
 * 挂载元素上再写 --tn-*: var(--tnv-*)。外部样式比引擎 Shadow DOM 里的 :host 默认值优先。
 *
 * 只映射中性色、字体、吸顶偏移。标签的色相和写法（荧光笔 --tn-hl*、字色 --tn-tg*、领地线 --tn-ln*）
 * 保留引擎自带的（深浅两套由 setTheme 切换）。
 * 全部是 var() 引用，没有写死的颜色，任何主题都能用。
 */
import type { CSSProperties } from 'react'

export interface TnTokenDef {
  /** 引擎变量 */
  tn: string
  /** 出题器这边的取值（只用 token） */
  value: string
  /** 用在哪 */
  usage: string
}

export const TN_TOKEN_MAP: readonly TnTokenDef[] = [
  { tn: '--tn-paper', value: 'var(--bg-elevated)', usage: '画板外及全屏布局的底色；按下的按钮上的字色' },
  { tn: '--tn-paper-2', value: 'var(--bg)', usage: '画板底色' },
  { tn: '--tn-dot', value: 'var(--border-strong)', usage: '画板点阵' },
  { tn: '--tn-card', value: 'var(--surface-1)', usage: '作品卡片、侧栏' },
  { tn: '--tn-ink', value: 'var(--text-1)', usage: '主文字' },
  { tn: '--tn-ink-2', value: 'var(--text-2)', usage: '次文字' },
  { tn: '--tn-ink-3', value: 'var(--text-3)', usage: '弱文字' },
  { tn: '--tn-line', value: 'var(--border)', usage: '细线' },
  { tn: '--tn-line-2', value: 'var(--border-strong)', usage: '较明显的线' },
  { tn: '--tn-accent', value: 'var(--primary)', usage: '焦点、悬停、选中' },
  { tn: '--tn-accent-2', value: 'var(--primary-100)', usage: '悬停行底色' },
  { tn: '--tn-edge', value: 'color-mix(in oklab, var(--text-3) 60%, var(--border-strong))', usage: '连线' },
  { tn: '--tn-shadow', value: 'var(--shadow-1)', usage: '卡片阴影' },
  { tn: '--tn-f-body', value: 'var(--font-body)', usage: '正文字体' },
  { tn: '--tn-f-display', value: 'var(--font-display)', usage: '视图标题字体' },
  { tn: '--tn-f-mono', value: 'var(--font-mono)', usage: '年份、评分' },
  { tn: '--tn-sticky-top', value: 'var(--shell-sticky-top, 0px)', usage: 'page 布局里侧栏吸顶时的顶部偏移，避开外壳自己的吸顶栏（只有底部胶囊布局有，其余为 0）' },
]

/** 引擎自带、宿主不许改的变量（标签色相 / 写法相关） */
export const TN_ENGINE_OWNED = ['--tn-hlL', '--tn-hlC', '--tn-tgL', '--tn-tgC', '--tn-lnL', '--tn-lnC', '--tn-z'] as const

/** --tn-foo → --tnv-foo（外框上的中转变量） */
export const relayName = (tn: string): string => tn.replace(/^--tn-/, '--tnv-')

/** 外框变量：滚动容器高度（侧栏最大高度用），由 TagNoteView 量出来写上；量不到时按 100vh */
export const SCROLL_H_VAR = '--tnv-scroll-h'

/**
 * 外框变量：滚动区域底部被外壳盖住的高度（侧栏下沿要让开）。
 * 只有底部胶囊布局有（胶囊浮在内容上面），由 TagNoteView 的 class 在 [data-layout=dock] 里设上；其余为 0。
 */
export const STICKY_BOTTOM_VAR = '--tnv-sticky-bottom'

/** 外框变量：引擎下方一定空着的高度（滚到底时侧栏可以伸进去），由 TagNoteView 量出来写上；量不到时为 0 */
export const SPACE_BELOW_VAR = '--tnv-space-below'

type Vars = CSSProperties & Record<`--${string}`, string>

/** 外框（没有 data-theme 的那层）：出题器主题 token → --tnv-* */
export function frameVars(): Vars {
  const out: Record<string, string> = {}
  for (const d of TN_TOKEN_MAP) out[relayName(d.tn)] = d.value
  return out as Vars
}

/**
 * 挂载元素：--tn-* ← --tnv-*；外加侧栏的两个高度：
 * - 最大高度：按真正的滚动区域高度算，不按整个窗口；底部被外壳盖住的部分让开
 * - 下方空白：滚到底时侧栏可以伸进去，不会被推到顶栏下面
 */
export function hostVars(): Vars {
  const out: Record<string, string> = {}
  for (const d of TN_TOKEN_MAP) out[d.tn] = `var(${relayName(d.tn)})`
  out['--tn-drawer-max'] = `calc(var(${SCROLL_H_VAR}, 100vh) - var(--tn-sticky-top) - var(${STICKY_BOTTOM_VAR}, 0px) - 24px)`
  out['--tn-space-below'] = `var(${SPACE_BELOW_VAR}, 0px)`
  return out as Vars
}

/** 算一次就够（纯常量），组件里直接用 */
export const FRAME_VARS = frameVars()
export const HOST_VARS = hostVars()
