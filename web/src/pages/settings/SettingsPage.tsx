import { useEffect, useState } from 'react'
import { useLocation } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { PageHeader } from '@/app/shell/PageHeader'
import { useThemeActions } from '@/app/themeActions'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Input'
import { SegmentedControl, Select, SwitchRow } from '@/components/ui/Controls'
import { confirm } from '@/components/ui/Confirm'
import { toast } from '@/components/ui/Toast'
import { IconCheck, IconPlug, IconRotate, IconSettings, IconTrash } from '@/lib/icons'
import { DEFAULT_API_BASE, errorText } from '@/lib/apiClient'
import { THEMES } from '@/themes/registry'
import { useThemeScope } from '@/themes/context'
import { autoModeOf } from '@/themes/ThemeProvider'
import { usePrefs, DEFAULT_PREFS, type DensityPref, type ModePref, type MotionPref, type ShellPref } from '@/features/settings/store'
import { statusApi, STATUS_KEY } from '@/features/status/api'
import { useDraft } from '@/features/blocks/store'
import { useClassicAvailable } from '@/features/classic/api'
import { useCandidateView } from '@/features/candidates/store'
import { useAvatarStore } from '@/features/candidates/avatar'
import { TiersCard } from '@/features/tiers/TiersCard'
import { AiCard } from '@/features/ai/AiCard'

const SHELL_LABEL: Record<string, string> = { sidebar: '侧栏', topbar: '顶栏', dock: '底部胶囊', split: '分栏（右侧上下文面板）' }
const DENSITY_LABEL: Record<string, string> = { compact: '紧凑', comfortable: '舒适', spacious: '宽松' }

function BackendCard() {
  const qc = useQueryClient()
  const apiBase = usePrefs((s) => s.apiBase)
  const set = usePrefs((s) => s.set)
  const [draft, setDraft] = useState(apiBase)
  const [testing, setTesting] = useState(false)
  const valid = draft.trim() === '' || /^https?:\/\/[^\s]+$/.test(draft.trim())

  const test = async () => {
    setTesting(true)
    const prev = usePrefs.getState().apiBase
    set({ apiBase: draft.trim() })
    try {
      const s = await statusApi.status()
      toast.success('连上了', { description: s.phase === 'no_db' ? '但没找到出题器数据库 outsetter_v2.sqlite（见「数据」页）' : undefined })
      void qc.invalidateQueries()
      void qc.invalidateQueries({ queryKey: STATUS_KEY })
    } catch (e) {
      set({ apiBase: prev })
      toast.error('连不上，地址没改', { description: errorText(e) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card>
      <CardHeader icon={<IconPlug />} title="后端" description="网页连接哪个后端。用启动脚本在本机启动时，保持默认就行。" />
      <CardBody className="flex flex-col gap-3">
        <Field
          label="后端地址"
          hint={`留空 = 默认 ${DEFAULT_API_BASE}（可以用环境变量 VITE_API_BASE 改默认值）`}
          error={valid ? undefined : '要以 http:// 或 https:// 开头'}
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={DEFAULT_API_BASE}
              invalid={!valid}
              className="font-mono"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && valid) void test()
              }}
            />
          )}
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<IconCheck />} loading={testing} disabled={!valid} onClick={() => void test()}>
            测试并使用
          </Button>
          <Button
            variant="ghost"
            icon={<IconRotate />}
            onClick={() => {
              setDraft('')
              set({ apiBase: '' })
              void qc.invalidateQueries()
              toast.info('已恢复默认地址', { description: DEFAULT_API_BASE })
            }}
          >
            恢复默认
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}

function AppearanceCard() {
  const p = usePrefs()
  const { theme } = useThemeScope()
  const { setTheme, setModePref, setShellPref, setDensityPref } = useThemeActions()
  const m = theme.manifest
  const single = m.modes.length < 2
  return (
    <Card>
      <CardHeader title="外观" description="主题、明暗、布局、密度都能随时换，不会丢正在编辑的东西。" />
      <CardBody className="flex flex-col gap-5">
        <Field label="主题">
          {({ id }) => (
            <Select
              id={id}
              value={p.theme}
              onChange={setTheme}
              options={THEMES.map((t) => ({ value: t.manifest.id, label: `${t.manifest.name} · ${t.manifest.nameEn}`, hint: t.manifest.tagline }))}
            />
          )}
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-fg-2">明暗</span>
          <SegmentedControl<ModePref>
            value={p.modePref}
            onChange={setModePref}
            aria-label="明暗"
            options={[
              // 有 autoMode 的主题（例如按本机时间切换明暗的主题）按时间变：标签写「现在是深/浅」
              { value: 'auto', label: `跟随主题（${m.autoMode ? '现在' : ''}${autoModeOf(m) === 'dark' ? '深' : '浅'}）` },
              { value: 'light', label: '浅色', disabled: !m.modes.includes('light') },
              { value: 'dark', label: '深色', disabled: !m.modes.includes('dark') },
            ]}
          />
          {single && <p className="text-xs text-fg-3">「{m.name}」只有{m.modes[0] === 'dark' ? '深色' : '浅色'}，另一种会自动变回来。</p>}
        </div>
        <Field label="布局" hint="主题有自己默认的布局；这里可以强制换成别的。">
          {({ id }) => (
            <Select<ShellPref>
              id={id}
              value={p.shellPref}
              onChange={setShellPref}
              options={[
                { value: 'auto', label: `跟随主题（${SHELL_LABEL[m.shell]}）` },
                { value: 'sidebar', label: SHELL_LABEL.sidebar! },
                { value: 'topbar', label: SHELL_LABEL.topbar! },
                { value: 'dock', label: SHELL_LABEL.dock! },
                { value: 'split', label: SHELL_LABEL.split! },
              ]}
            />
          )}
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-fg-2">密度</span>
          <SegmentedControl<DensityPref>
            value={p.densityPref}
            onChange={setDensityPref}
            aria-label="密度"
            options={[
              { value: 'auto', label: `跟随主题（${DENSITY_LABEL[m.density]}）` },
              { value: 'compact', label: '紧凑' },
              { value: 'comfortable', label: '舒适' },
              { value: 'spacious', label: '宽松' },
            ]}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-fg-2">动效</span>
          <SegmentedControl<MotionPref>
            value={p.motionPref}
            onChange={(v) => p.set({ motionPref: v })}
            aria-label="动效"
            options={[
              { value: 'system', label: '跟随系统' },
              { value: 'reduce', label: '减少动效' },
              { value: 'full', label: '正常' },
            ]}
          />
        </div>
      </CardBody>
    </Card>
  )
}

function DisplayCard() {
  const avatars = usePrefs((s) => s.avatars)
  const autoPreview = usePrefs((s) => s.autoPreview)
  const classicAvailable = useClassicAvailable()
  const set = usePrefs((s) => s.set)
  return (
    <Card>
      <CardHeader title="候选展示" />
      <CardBody className="flex flex-col gap-3">
        <SwitchRow
          label="显示角色头像"
          description="从 Bangumi 拉头像：向 api.bgm.tv 查地址（每秒最多 2 次、会缓存在本机），图片来自 lain.bgm.tv。需要能上网；默认关，关着就不发任何头像请求。"
          checked={avatars}
          onChange={(v) => set({ avatars: v })}
        />
        {classicAvailable && (
          <SwitchRow
            label="改完组块自动预览人数"
            description="经典工作台里停手 0.7 秒后自动问一次后端有多少人。默认关，只有点按钮才请求后端。"
            checked={autoPreview}
            onChange={(v) => set({ autoPreview: v })}
          />
        )}
      </CardBody>
    </Card>
  )
}

function NetworkCard() {
  return (
    <Card>
      <CardHeader title="哪些功能会连网" description="出题器本身只在本机运行，只有下面这些会访问外部网络。" />
      <CardBody>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-fg-2">
          <li>角色头像：上面的开关打开后，向 api.bgm.tv 查头像地址，图片从 lain.bgm.tv 加载。</li>
          <li>导图里的作品封面：显示时从 api.bgm.tv 加载。不想加载，在导图顶栏的「封面」里选隐藏。</li>
          <li>自动点击：后端通过本机调试端口控制你自己启动的 Chrome，这个 Chrome 里的猜猜呗网页会联网；定位角色时后端也会请求 api.bgm.tv。</li>
          <li>AI 辅助会把你的话、当前方案或数据库表结构说明发到你在「AI」里填的接口地址；用本机命令行时，由 claude / codex 连各自的服务。</li>
          <li>单人猜猜呗的「搜 Bangumi 全库」：打开后，后端把你输入的名字发到 api.bgm.tv 搜索；关着时只搜本地。</li>
          <li>点作品名：在浏览器里打开 bgm.tv 的条目页（你点了才会打开）。</li>
        </ul>
      </CardBody>
    </Card>
  )
}

function CacheCard() {
  const qc = useQueryClient()
  const resetPrefs = usePrefs((s) => s.reset)
  const resetDraft = useDraft((s) => s.resetDraft)
  const classicAvailable = useClassicAvailable()
  const avatarCount = useAvatarStore((s) => Object.keys(s.urls).length)
  return (
    <Card>
      <CardHeader title="缓存与重置" description="出问题的时候再用。都会先问你。" />
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            icon={<IconTrash />}
            onClick={() => {
              qc.clear()
              toast.success('接口缓存清空了', { description: '页面会重新向后端要数据' })
            }}
          >
            清空接口缓存
          </Button>
          <Button
            variant="secondary"
            icon={<IconTrash />}
            onClick={() => {
              useAvatarStore.getState().clear()
              toast.success('头像缓存清空了')
            }}
          >
            清空头像缓存（{avatarCount}）
          </Button>
          <Button
            variant="danger-ghost"
            icon={<IconRotate />}
            onClick={async () => {
              if (!(await confirm({ title: '把界面设置恢复默认？', description: '主题、明暗、布局、后端地址等都会回到默认。正在编辑的方案不受影响。', confirmLabel: '恢复默认', tone: 'danger' })))
                return
              resetPrefs()
              useCandidateView.setState({ pageSize: 10, displayMode: 'card', showCharTags: false })
              toast.success('界面设置恢复默认了', { description: `主题：${DEFAULT_PREFS.theme}` })
            }}
          >
            界面设置恢复默认
          </Button>
          {classicAvailable && (
            <Button
              variant="danger-ghost"
              icon={<IconTrash />}
              onClick={async () => {
                if (!(await confirm({ title: '清空经典工作台正在编辑的方案？', description: '没保存的组块会丢掉，回到默认的一个「作品范围」组块。已保存到方案库的不受影响。', confirmLabel: '清空', tone: 'danger' })))
                  return
                resetDraft()
                toast.success('草稿清空了')
              }}
            >
              清空经典工作台草稿
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

export default function SettingsPage() {
  const { hash } = useLocation()
  // 从输入条的「去设置」进来（/settings#ai）：滚到对应的卡片
  useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/, ''))
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' })
  }, [hash])
  return (
    <>
      <PageHeader route="settings" title="设置" icon={<IconSettings />} description="后端地址、AI、外观、展示方式、标签分档、缓存。改完立刻生效。" />
      <div className="grid items-start gap-4 @4xl/main:grid-cols-2">
        <div className="flex flex-col gap-4">
          <BackendCard />
          <AiCard />
          <TiersCard />
        </div>
        {/* 「哪些功能会连网」里说的「上面的开关」是候选展示里的头像开关，两张卡要挨着 */}
        <div className="flex flex-col gap-4">
          <AppearanceCard />
          <DisplayCard />
          <NetworkCard />
          <CacheCard />
        </div>
      </div>
    </>
  )
}
