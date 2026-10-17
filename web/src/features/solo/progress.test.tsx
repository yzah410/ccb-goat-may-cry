/**
 * 左上角进度条（纯色）：两段宽度怎么分、total 和 parts 对不上时以 total 为准、
 * 「本次 +x%」、学习中人数、饱和提示，以及服务端渲染出来的结构（只用主题 token、没有常驻动画）。
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/Overlay'
import { ThemeScopeContext, type ThemeScopeValue } from '@/themes/context'
import { normalizeProgress, type Progress } from './api'
import { SoloProgress } from './components/SoloProgress'
import { deltaText, fmtPct, progressBarView, progressLegend, splitBar } from './progressView'

const prog = (p: Partial<Progress> & { stable?: number; consolidating?: number } = {}): Progress => {
  const { stable = 0, consolidating = 0, ...rest } = p
  return {
    total: stable + consolidating,
    segments: [
      { id: 'stable', label: '已稳定', count: 3 },
      { id: 'consolidating', label: '巩固中', count: 5 },
      { id: 'learning', label: '学习中', count: 2 },
      { id: 'unseen', label: '未出现', count: 30 },
    ],
    parts: [
      { id: 'stable', label: '已稳定', pct: stable },
      { id: 'consolidating', label: '巩固中', pct: consolidating },
      { id: 'learning', label: '学习中', pct: 0 },
      { id: 'unseen', label: '未出现', pct: 0 },
    ],
    stable_gap: 10,
    saturated: false,
    events: [],
    session_delta: null,
    ...rest,
  }
}

describe('进度条：两段宽度', () => {
  it('按 parts 的比例分 total，两段相加 = total', () => {
    expect(splitBar(prog({ stable: 7.5, consolidating: 12.5 }))).toEqual({ total: 20, stable: 7.5, consolidating: 12.5 })
    expect(splitBar(prog({ stable: 0, consolidating: 4.17 }))).toEqual({ total: 4.17, stable: 0, consolidating: 4.17 })
    expect(splitBar(prog({ stable: 100, consolidating: 0 }))).toEqual({ total: 100, stable: 100, consolidating: 0 })
    expect(splitBar(prog())).toEqual({ total: 0, stable: 0, consolidating: 0 })
  })

  it('parts 相加和 total 差 0.01（各自四舍五入）：以 total 为准，按比例缩放', () => {
    // 后端：total 33.33，parts 11.11 + 22.23 = 33.34
    const v = splitBar(prog({ total: 33.33, stable: 11.11, consolidating: 22.23 }))
    expect(v.total).toBe(33.33)
    expect(v.stable + v.consolidating).toBeCloseTo(33.33, 10)
    expect(v.stable).toBe(11.11)
    expect(v.consolidating).toBe(22.22)
  })

  it('学习中、未出现的 pct 不占长度；total 越界夹到 0–100', () => {
    const p = prog({ total: 30, stable: 10, consolidating: 20 })
    p.parts[2]!.pct = 5 // 不该有，有也不画
    expect(splitBar(p)).toEqual({ total: 30, stable: 10, consolidating: 20 })
    expect(splitBar(prog({ total: 120, stable: 60, consolidating: 60 }))).toEqual({ total: 100, stable: 50, consolidating: 50 })
    expect(splitBar(prog({ total: -3 })).total).toBe(0)
  })

  it('total > 0 但两个 part 都是 0（数据不完整）：整条画成「已稳定」的颜色，不猜比例', () => {
    expect(splitBar(prog({ total: 12 }))).toEqual({ total: 12, stable: 12, consolidating: 0 })
    expect(splitBar({ total: 12, parts: [] })).toEqual({ total: 12, stable: 12, consolidating: 0 })
  })
})

describe('进度条：文字', () => {
  it('百分比：≥ 1 保留 1 位、< 1 保留 2 位，去掉末尾的 0', () => {
    expect(fmtPct(42.5)).toBe('42.5')
    expect(fmtPct(42.46)).toBe('42.5')
    expect(fmtPct(3)).toBe('3')
    expect(fmtPct(0.04)).toBe('0.04')
    expect(fmtPct(0.004)).toBe('0')
    expect(fmtPct(99.96)).toBe('100')
  })

  it('本次涨跌：正数带 +，负数带 −；0、太小、没有这个数 → 不显示', () => {
    expect(deltaText(1.25)).toBe('本次 +1.3%')
    expect(deltaText(0.05)).toBe('本次 +0.05%')
    expect(deltaText(-0.4)).toBe('本次 −0.4%')
    expect(deltaText(0)).toBeNull()
    expect(deltaText(0.001)).toBeNull()
    expect(deltaText(null)).toBeNull()
    expect(deltaText(Number.NaN)).toBeNull()
  })

  it('四类人数和说明；稳定线取整；后端没给的类按 0', () => {
    const v = progressBarView(prog({ stable: 7.5, consolidating: 12.5, session_delta: 2, stable_gap: 8.0 }))
    expect(v.totalText).toBe('20%')
    expect(v.delta).toBe('本次 +2%')
    expect(v.counts).toEqual({ stable: 3, consolidating: 5, learning: 2, unseen: 30 })
    expect(v.stableGap).toBe(8)
    const legend = progressLegend(v)
    expect(legend.map((l) => l.kind)).toEqual(['stable', 'consolidating', 'learning', 'unseen'])
    expect(legend[0]!.text).toContain('已稳定 3 人：隔 8 局以上再出仍然记得')
    expect(legend[1]!.text).toContain('巩固中 5 人')
    expect(legend[2]!.text).toContain('学习中 2 人')
    expect(legend[2]!.text).toContain('不占条的长度')
    expect(legend[3]!.text).toBe('未出现 30 人：还没出过题')

    const bare = progressBarView(normalizeProgress({ total: 5 })!)
    expect(bare.counts).toEqual({ stable: 0, consolidating: 0, learning: 0, unseen: 0 })
    expect(bare.stableGap).toBeNull()
    expect(progressLegend(bare)[0]!.text).toContain('到稳定线')
  })
})

describe('进度条：渲染出来的结构', () => {
  const scope = { theme: { manifest: { id: 'moonlit' } }, mode: 'dark', portalContainer: null } as unknown as ThemeScopeValue
  const render = (p: Progress | null) =>
    renderToStaticMarkup(
      <ThemeScopeContext.Provider value={scope}>
        <TooltipProvider>
          <SoloProgress progress={p} />
        </TooltipProvider>
      </ThemeScopeContext.Provider>,
    )

  it('两段纯色、宽度照算；旁边是百分比、本次涨跌、学习中人数', () => {
    const html = render(prog({ stable: 7.5, consolidating: 12.5, session_delta: 1.25 }))
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuenow="20"')
    expect(html).toMatch(/class="[^"]*bg-primary[ "][^"]*" style="width:7.5%" data-part="stable"/)
    expect(html).toMatch(/class="[^"]*bg-primary-400[^"]*" style="width:12.5%" data-part="consolidating"/)
    expect(html).toContain('>20%<')
    expect(html).toContain('>本次 +1.3%<')
    expect(html).toContain('>学习中 2<')
    expect(html).not.toContain('本组暂时练到饱和')
    // 只有条宽过渡，没有常驻动画、渐变、发光
    expect(html).toContain('transition-[width]')
    expect(html).not.toMatch(/animate-|gradient|shadow-|blur/)
  })

  it('本次 0 不显示涨跌；学习中 0 人不显示人数；saturated 时多一行小字', () => {
    const p = prog({ stable: 50, consolidating: 0, session_delta: 0, saturated: true })
    p.segments[2]!.count = 0
    const html = render(p)
    expect(html).not.toContain('本次')
    expect(html).not.toContain('>学习中')
    expect(html).toContain('本组暂时练到饱和，可以休息或换组')
    expect(html).toContain('style="width:0%" data-part="consolidating"')
  })

  it('还没有进度（会话没建好）：只占位，不画条', () => {
    const html = render(null)
    expect(html).not.toContain('progressbar')
    expect(html).toContain('aria-hidden="true"')
  })
})
