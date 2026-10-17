import { useNavigate } from 'react-router'
import { PageHeader } from '@/app/shell/PageHeader'
import { useThemeActions } from '@/app/themeActions'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Tooltip } from '@/components/ui/Overlay'
import { IconAlert, IconCheck, IconColumns, IconMinus, IconMoon, IconPalette, IconPlus, IconShuffle, IconSun } from '@/lib/icons'
import { cn } from '@/lib/cn'
import { THEME_LOAD_FAILURES, randomThemeId, visibleThemes } from '@/themes/registry'
import { ThemeScope } from '@/themes/ThemeProvider'
import { useThemeScope } from '@/themes/context'
import { WallpaperImage, listWallpapers } from '@/themes/kit'
import type { RegisteredTheme, ThemeLoadFailure } from '@/themes/types'
import { usePrefs } from '@/features/settings/store'
import { ThemeSlot } from '@/themes/ThemeSlot'

const SHELL_LABEL: Record<string, string> = { sidebar: '侧栏布局', topbar: '顶栏布局', dock: '底部胶囊', split: '分栏布局' }
const DENSITY_LABEL: Record<string, string> = { compact: '紧凑', comfortable: '舒适', spacious: '宽松' }
const SWATCHES = ['--primary', '--accent', '--include', '--exclude', '--chart-1', '--chart-2', '--chart-3', '--surface-1', '--text-1']

/** 卡片里的「迷你界面」：用这个主题自己的 token 画一小块，一眼看出气质 */
function MiniPreview({ t }: { t: RegisteredTheme }) {
  const slug = t.manifest.previewWallpaper ?? t.manifest.wallpapers[0]
  return (
    <div className="relative h-44 overflow-hidden border-b border-border bg-bg">
      {slug ? (
        <WallpaperImage slug={slug} size="thumb" position="center 35%" />
      ) : (
        <div
          className="absolute inset-0"
          style={{ background: 'radial-gradient(120% 90% at 100% 0%, var(--primary-100), transparent 60%), var(--bg)' }}
        />
      )}
      <div
        className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-lg border border-border p-3 shadow-2"
        style={{ background: 'var(--surface-glass)', backdropFilter: 'blur(var(--backdrop-blur))' }}
      >
        <ThemeSlot name="Logo" collapsed />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-1">
            <span className="inline-flex h-5 items-center gap-0.5 rounded-full px-2 text-xs" style={{ background: 'color-mix(in oklab, var(--include) 16%, transparent)', color: 'color-mix(in oklab, var(--include) 80%, var(--text-1))' }}>
              <IconPlus className="size-3" />
              纳入
            </span>
            <span className="inline-flex h-5 items-center gap-0.5 rounded-full px-2 text-xs" style={{ background: 'color-mix(in oklab, var(--exclude) 16%, transparent)', color: 'color-mix(in oklab, var(--exclude) 80%, var(--text-1))' }}>
              <IconMinus className="size-3" />
              排除
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-3/4 rounded-full bg-surface-3" />
        </div>
        <span data-action="draw" className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-on-primary shadow-1">
          抽一题
        </span>
      </div>
    </div>
  )
}

function ThemeCard({ t, current }: { t: RegisteredTheme; current: boolean }) {
  const { mode } = useThemeScope()
  const { setTheme } = useThemeActions()
  const navigate = useNavigate()
  const m = t.manifest
  const cov = Math.round(t.coverage * 100)
  return (
    // 卡片跟随现在的明暗（这套主题不支持的话，ThemeScope 会自动退回它支持的那种）
    <ThemeScope theme={m.id} mode={mode} className={cn('overflow-hidden rounded-xl border shadow-1', current ? 'border-primary ring-2 ring-primary' : 'border-border')}>
      <div className="flex h-full flex-col bg-surface-1 text-fg-1" data-theme-card={m.id}>
        <MiniPreview t={t} />
        <div className="flex h-7 w-full" aria-label="色板" role="img">
          {SWATCHES.map((v) => (
            <span key={v} className="flex-1" style={{ background: `var(${v})` }} title={v} />
          ))}
        </div>
        <div className="flex flex-1 flex-col gap-3 p-4">
          <div>
            <div className="flex items-baseline gap-2">
              <h3 className="text-lg" style={{ fontFamily: 'var(--font-display)' }}>
                {m.name}
              </h3>
              <span className="text-xs text-fg-3">{m.nameEn}</span>
              {current && (
                <Badge tone="primary" size="sm" className="ml-auto">
                  <IconCheck />
                  正在用
                </Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-fg-2">{m.tagline}</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge size="sm">{SHELL_LABEL[m.shell]}</Badge>
            <Badge size="sm">{DENSITY_LABEL[m.density]}</Badge>
            <Badge size="sm">
              {m.modes.includes('light') && <IconSun />}
              {m.modes.includes('dark') && <IconMoon />}
              {m.modes.length > 1 ? '浅 / 深' : m.modes[0] === 'dark' ? '只有深色' : '只有浅色'}
            </Badge>
            <Badge size="sm">{m.wallpapers.length ? `${m.wallpapers.length} 张壁纸` : '无壁纸'}</Badge>
            <Tooltip content={t.missingRequired.length ? `缺：${t.missingRequired.slice(0, 12).join(' ')}${t.missingRequired.length > 12 ? ' …' : ''}` : '必填 token 全部覆盖'}>
              <span>
                <Badge size="sm" tone={cov === 100 ? 'success' : 'warning'}>
                  token {cov}%
                </Badge>
              </span>
            </Tooltip>
          </div>
          {t.problems.length > 0 && <p className="text-xs text-danger-fg">manifest 有问题：{t.problems.join('；')}</p>}
          <p className="line-clamp-3 text-xs text-fg-3">{m.description}</p>
          <div className="mt-auto flex gap-2 pt-1">
            <Button variant={current ? 'secondary' : 'soft'} size="sm" disabled={current} onClick={() => setTheme(m.id)}>
              {current ? '正在用' : '用这个'}
            </Button>
            {current ? (
              // 正在用的这张卡：「和当前对比」就是自己比自己，所以这张卡比的是它自己的浅色和深色
              m.modes.length > 1 && (
                <Button variant="ghost" size="sm" icon={<IconColumns />} onClick={() => navigate(`/themes/compare?a=${m.id}&b=${m.id}&ma=light&mb=dark`)}>
                  浅色和深色对比
                </Button>
              )
            ) : (
              <Button
                variant="ghost"
                size="sm"
                icon={<IconColumns />}
                onClick={() => navigate(`/themes/compare?a=${usePrefs.getState().theme}&b=${m.id}`)}
              >
                和当前对比
              </Button>
            )}
          </div>
        </div>
      </div>
    </ThemeScope>
  )
}

/**
 * 加载失败的主题：这张卡**不**用那套主题画（它没加载成功），用当前主题的颜色。
 * 不能选；如果用户之前选的就是它，现在实际用的是 base（ThemeProvider 自动兜底），这里给一个「改回基础主题」把设置也改干净。
 */
function FailedThemeCard({ f, current }: { f: ThemeLoadFailure; current: boolean }) {
  const { setTheme } = useThemeActions()
  return (
    <div
      data-theme-card={f.id}
      data-load-failed=""
      className="flex flex-col gap-3 rounded-xl border border-dashed border-[color-mix(in_oklab,var(--danger)_55%,var(--border))] bg-surface-1 p-4 shadow-1"
    >
      <div className="flex items-baseline gap-2">
        <h3 className="text-lg">{f.name}</h3>
        {f.name !== f.id && <span className="text-xs text-fg-3">{f.id}</span>}
        <Badge tone="danger" size="sm" className="ml-auto">
          <IconAlert />
          加载失败
        </Badge>
      </div>
      <p className="text-sm text-fg-2">
        这套主题有文件没加载成功，已经自动跳过，其他主题不受影响。{current ? '你选的就是它，所以现在用的是基础主题。' : ''}
      </p>
      <ul className="flex flex-col gap-1 rounded-md bg-surface-2 p-3 font-mono text-xs text-danger-fg">
        {f.errors.map((e) => (
          <li key={e} className="break-all">
            {e}
          </li>
        ))}
      </ul>
      <p className="text-xs text-fg-3">修好 src/themes/{f.id}/ 里对应的文件后刷新页面；开发时终端和浏览器控制台里有完整报错。</p>
      <div className="mt-auto flex gap-2 pt-1">
        <Button variant="secondary" size="sm" disabled>
          不能用
        </Button>
        {current && (
          <Button variant="soft" size="sm" onClick={() => setTheme('base')}>
            改回基础主题
          </Button>
        )}
      </div>
    </div>
  )
}

export default function ThemesPage() {
  const navigate = useNavigate()
  const current = usePrefs((s) => s.theme)
  const { setTheme } = useThemeActions()
  const failed = THEME_LOAD_FAILURES.length
  const themes = visibleThemes()
  return (
    <>
      <PageHeader
        route="themes"
        title="主题"
        icon={<IconPalette />}
        description={`${themes.length} 套主题${failed ? `（另有 ${failed} 套加载失败，放在最后）` : ''}，点一下就换，不刷新页面、不丢正在编辑的方案。每张卡都是用那套主题自己的颜色和字体画的。`}
        actions={
          <>
            <Button variant="secondary" icon={<IconShuffle />} onClick={() => setTheme(randomThemeId(current))}>
              随机换一个
            </Button>
            <Button variant="secondary" icon={<IconColumns />} onClick={() => navigate(`/themes/compare?a=${current}&b=${randomThemeId(current)}`)}>
              分屏对比
            </Button>
          </>
        }
      />
      {listWallpapers().length === 0 && (
        <p className="mb-4 text-sm text-fg-3">还没有壁纸。把图片放进 assets/wallpapers 就会出现在主题里，做法见该目录的 README.md；没有壁纸时主题用纯色或渐变背景。</p>
      )}
      <div className="grid gap-4 @2xl/main:grid-cols-2 @6xl/main:grid-cols-3">
        {themes.map((t) => (
          <ThemeCard key={t.manifest.id} t={t} current={t.manifest.id === current} />
        ))}
        {THEME_LOAD_FAILURES.map((f) => (
          <FailedThemeCard key={f.id} f={f} current={f.id === current} />
        ))}
      </div>
    </>
  )
}
