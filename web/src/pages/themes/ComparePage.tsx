/**
 * 分屏对比：/themes/compare?a=<主题>&b=<主题>&ma=light|dark&mb=light|dark&page=workbench
 *
 * 左右各一个 ThemeScope（嵌套主题作用域），里面各自是完整的外壳（按那套主题的布局）+ 同一个页面。
 * 数据是同一份（同一个草稿、同一个请求缓存），只有外观不同 —— 这就是「对比」的意义。
 * 格子里点导航只切换格子里的页面（不跳真正的路由）。
 */
import { Suspense, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Button } from '@/components/ui/Button'
import { Select, SegmentedControl } from '@/components/ui/Controls'
import { Tooltip } from '@/components/ui/Overlay'
import { Loading } from '@/components/data-display/Misc'
import { IconArrowLeft, IconArrowUpDown, IconMoon, IconShuffle, IconSun } from '@/lib/icons'
import { BASE_THEME, getTheme, randomThemeId, visibleThemes } from '@/themes/registry'
import { ThemeScope, autoModeOf, clampMode } from '@/themes/ThemeProvider'
import type { RouteId, ThemeMode } from '@/themes/types'
import { AppShell } from '@/app/shell/AppShell'
import { LocalShellNav } from '@/app/shell/nav'
import { PageById } from '@/app/RootLayout'
import { visibleRoutes } from '@/app/routes'
import { CommandPalette } from '@/app/shell/CommandPalette'
import { useClassicAvailable } from '@/features/classic/api'
import { PlanDialogs } from '@/features/plans/components/PlanDialogs'
import { usePrefs } from '@/features/settings/store'

type PageId = Exclude<RouteId, 'compare' | 'not-found'>
// 下拉只列出「不隐藏」的主题；?a=/?b= 指定的主题用 getTheme 查，所以隐藏的主题也能通过地址栏打开
const THEME_OPTIONS = visibleThemes().map((t) => ({ value: t.manifest.id, label: t.manifest.name }))

function Pane({ themeId, mode, page, setPage }: { themeId: string; mode: ThemeMode; page: PageId; setPage: (p: RouteId) => void }) {
  return (
    <ThemeScope theme={themeId} mode={mode} className="h-full min-w-0 overflow-hidden">
      <LocalShellNav current={page} go={setPage}>
        <AppShell route={page}>
          <Suspense fallback={<Loading label="正在打开页面…" className="py-24" />}>
            <PageById id={page} />
          </Suspense>
        </AppShell>
      </LocalShellNav>
    </ThemeScope>
  )
}

function Side({
  label,
  themeId,
  mode,
  onTheme,
  onMode,
}: {
  label: string
  themeId: string
  mode: ThemeMode
  onTheme: (id: string) => void
  onMode: (m: ThemeMode) => void
}) {
  const t = getTheme(themeId)
  const modes = t?.manifest.modes ?? ['light']
  return (
    <div className="flex items-center gap-2">
      <span className="grid size-6 place-items-center rounded-full bg-surface-3 text-xs font-semibold text-fg-1">{label}</span>
      <div className="w-40">
        <Select size="sm" value={themeId} onChange={onTheme} options={THEME_OPTIONS} aria-label={`${label} 侧主题`} />
      </div>
      <SegmentedControl<ThemeMode>
        size="sm"
        value={mode}
        onChange={onMode}
        aria-label={`${label} 侧明暗`}
        options={[
          { value: 'light', label: '浅', icon: <IconSun />, disabled: !modes.includes('light') },
          { value: 'dark', label: '深', icon: <IconMoon />, disabled: !modes.includes('dark') },
        ]}
      />
    </div>
  )
}

export default function ComparePage() {
  const [params, setParams] = useSearchParams()
  const current = usePrefs((s) => s.theme)
  // 地址栏里的主题不存在 / 加载失败 → 退回当前主题 → 再退回 base（不能直接 getTheme(a)!，主题不存在时会崩）
  const ta = getTheme(params.get('a')) ?? getTheme(current) ?? BASE_THEME
  const a = ta.manifest.id
  // b 缺省时的默认选择也从「不隐藏」的主题里挑，不会默认选中 preview 这类演示主题
  const tb = getTheme(params.get('b')) ?? visibleThemes().find((t) => t.manifest.id !== a) ?? ta
  const b = tb.manifest.id
  const modeParam = (k: 'ma' | 'mb'): ThemeMode | null => {
    const v = params.get(k)
    return v === 'light' || v === 'dark' ? v : null
  }
  const ma = clampMode(modeParam('ma') ?? autoModeOf(ta.manifest), ta.manifest.modes)
  const mb = clampMode(modeParam('mb') ?? autoModeOf(tb.manifest), tb.manifest.modes)
  const pageParam = params.get('page') as PageId | null
  const pageOptions = visibleRoutes(useClassicAvailable()).map((r) => ({ value: r.id as PageId, label: r.label }))
  const page: PageId = pageParam && pageOptions.some((o) => o.value === pageParam) ? pageParam : 'workbench'

  const patch = useCallback(
    (kv: Record<string, string | null>) => {
      const next = new URLSearchParams(params)
      for (const [k, v] of Object.entries(kv)) {
        if (v === null) next.delete(k)
        else next.set(k, v)
      }
      setParams(next, { replace: true })
    },
    [params, setParams],
  )
  const setPage = useCallback((p: RouteId) => patch({ page: p }), [patch])

  return (
    <div className="flex h-dvh flex-col bg-bg text-fg-1">
      <div className="z-30 flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-surface-1 px-4 py-2 shadow-1">
        <Button variant="ghost" size="sm" icon={<IconArrowLeft />} asChild>
          <Link to="/themes">回主题画廊</Link>
        </Button>
        <span className="h-5 w-px bg-border" aria-hidden />
        <Side label="A" themeId={a} mode={ma} onTheme={(id) => patch({ a: id, ma: null })} onMode={(m) => patch({ ma: m })} />
        <Tooltip content="左右交换">
          <Button size="icon-sm" variant="ghost" aria-label="左右交换" onClick={() => patch({ a: b, b: a, ma: mb, mb: ma })}>
            <IconArrowUpDown className="rotate-90" />
          </Button>
        </Tooltip>
        <Side label="B" themeId={b} mode={mb} onTheme={(id) => patch({ b: id, mb: null })} onMode={(m) => patch({ mb: m })} />
        <Tooltip content="B 侧随机换一个">
          <Button size="icon-sm" variant="ghost" aria-label="B 侧随机换一个" onClick={() => patch({ b: randomThemeId(a), mb: null })}>
            <IconShuffle />
          </Button>
        </Tooltip>
        <div className="ml-auto flex items-center gap-2 text-sm text-fg-2">
          两边都看
          <div className="w-32">
            <Select size="sm" value={page} onChange={(p) => setPage(p)} options={pageOptions} aria-label="对比哪个页面" />
          </div>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-px bg-border">
        <Pane themeId={a} mode={ma} page={page} setPage={setPage} />
        <Pane themeId={b} mode={mb} page={page} setPage={setPage} />
      </div>
      <CommandPalette />
      <PlanDialogs />
    </div>
  )
}
