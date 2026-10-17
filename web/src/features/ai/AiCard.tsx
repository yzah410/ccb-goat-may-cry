/**
 * 设置页的「AI」卡片：选服务商、填接口地址 / 模型 / API key，可以先「测试」（用还没保存的值）再「保存」。
 * API key 只往后端发、不从后端读：已保存时输入框显示「已保存（…后 4 位）」，留空就不改。
 */
import { useState, type ReactNode } from 'react'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Controls'
import { toast } from '@/components/ui/Toast'
import { IconCheck, IconExternal, IconList, IconSave, IconSparkles, IconTrash } from '@/lib/icons'
import { cn } from '@/lib/cn'
import { fmtMs } from '@/lib/format'
import { errorText, isApiError } from '@/lib/apiClient'
import { isV2Missing } from '@/features/v2/hooks'
import { aiConfigApi, useAiConfig, useSaveAiConfig, type AiApiConfig, type AiTestResp } from './api'
import { applyPreset, bodyFromForm, formDirty, formFromConfig, formIssues, keyFieldState, saveNotice, testResultText, type AiForm } from './form'
import { AI_PROVIDERS, CUSTOM_PROVIDER, modelPlaceholder, providerById } from './providers'
import { AI_CARD_ID } from './paths'

const PROVIDER_OPTIONS = [...AI_PROVIDERS, CUSTOM_PROVIDER].map((p) => ({ value: p.id, label: p.label }))

function Shell({ children }: { children: ReactNode }) {
  return (
    <Card id={AI_CARD_ID} className="scroll-mt-4">
      <CardHeader icon={<IconSparkles />} title="AI" description="「一句话填工作台」和「问数据」用这里填的 AI 接口。" />
      <CardBody className="flex flex-col gap-4">{children}</CardBody>
    </Card>
  )
}

export function AiCard() {
  const q = useAiConfig()
  if (q.isPending)
    return (
      <Shell>
        <p className="text-sm text-fg-3">正在读 AI 设置…</p>
      </Shell>
    )
  if (q.isError)
    return (
      <Shell>
        <p className="text-sm text-danger-fg">{configErrorText(q.error)}</p>
      </Shell>
    )
  // 保存后设置变了：表单按保存后的设置重新开始（清掉输入框里的 key）
  return <AiConfigForm key={JSON.stringify(q.data)} config={q.data} />
}

/** 读设置出错时的说明。config.json 读不出来（config_invalid）时后端的话已经说清楚了文件和怎么办，直接显示 */
function configErrorText(e: unknown): string {
  if (isV2Missing(e)) return '后端没有 AI 设置接口：后端可能是更新代码之前启动的，重新运行启动脚本。'
  const code = isApiError(e) ? (e.detail as { error?: unknown } | undefined)?.error : undefined
  return code === 'config_invalid' ? errorText(e) : `读不到 AI 设置：${errorText(e)}`
}

export function AiConfigForm({ config }: { config: AiApiConfig }) {
  const [form, setForm] = useState<AiForm>(() => formFromConfig(config))
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<AiTestResp | null>(null)
  /** 最近一次测试通过时发的内容；保存时内容一样 = 这组值已经测过能用 */
  const [passed, setPassed] = useState<string | null>(null)
  const [listing, setListing] = useState(false)
  const [models, setModels] = useState<string[] | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const save = useSaveAiConfig()

  const provider = providerById(form.preset)
  const issues = formIssues(form)
  const blocked = Object.keys(issues).length > 0
  const dirty = formDirty(config, form)
  const edit = (patch: Partial<AiForm>) => {
    setForm((f) => ({ ...f, ...patch }))
    setResult(null)
  }
  const body = () => bodyFromForm(form, { keyFromEnv: config.key_from_env })

  const runTest = async () => {
    setTesting(true)
    setResult(null)
    const sent = body()
    try {
      const r = await aiConfigApi.test(sent)
      setResult(r)
      setPassed(r.ok ? JSON.stringify(sent) : null)
    } catch (e) {
      setResult({ ok: false, ms: 0, reply: null, error: errorText(e), error_code: 'request' })
      setPassed(null)
    } finally {
      setTesting(false)
    }
  }

  const listModels = async () => {
    setListing(true)
    setModelsError(null)
    try {
      const r = await aiConfigApi.models(body())
      if (r.ok) setModels(r.models)
      else {
        setModels(null)
        setModelsError(r.error ?? '列不出模型')
      }
    } catch (e) {
      setModels(null)
      setModelsError(errorText(e))
    } finally {
      setListing(false)
    }
  }

  const onSave = () => {
    const sent = body()
    const testedSame = passed !== null && passed === JSON.stringify(sent)
    save.mutate(sent, {
      onSuccess: (r) => {
        setForm(formFromConfig(r.config))
        const n = saveNotice(r.config, { message: r.message, testedSame })
        if (n.kind === 'warning') toast.warning(n.title, { description: n.description })
        else toast.success(n.title, { description: n.description })
      },
      onError: (e) => toast.error('没保存', { description: errorText(e) }),
    })
  }

  return (
    <Shell>
      <Field
        label="服务商"
        hint={
          provider?.docs ? (
            <a href={provider.docs} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-link hover:underline">
              {provider.label} 的接口文档
              <IconExternal className="size-3.5" aria-hidden />
            </a>
          ) : provider ? (
            '自己填接口地址（OpenAI 兼容的 /chat/completions 接口）'
          ) : (
            '选一个服务商，接口地址会自动填好'
          )
        }
      >
        {({ id, describedBy }) => (
          <div aria-describedby={describedBy}>
            <Select id={id} value={form.preset ?? undefined} onChange={(v) => edit(applyPreset(form, v))} options={PROVIDER_OPTIONS} placeholder="选一个服务商" />
          </div>
        )}
      </Field>

      <Field label="接口地址" hint="选了服务商会自动填好；不用带 /chat/completions。" error={form.base_url.trim() ? issues.base_url : undefined}>
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={form.base_url}
            onChange={(e) => edit({ base_url: e.target.value })}
            placeholder={form.protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://…'}
            invalid={!!form.base_url.trim() && !!issues.base_url}
            className="font-mono"
            spellCheck={false}
            autoComplete="off"
          />
        )}
      </Field>

      <Field
        label="模型"
        hint="模型名以服务商文档为准。"
        error={form.model.trim() ? issues.model : undefined}
        aside={
          <Button
            size="sm"
            variant="ghost"
            icon={<IconList />}
            loading={listing}
            disabled={form.protocol !== 'openai' || !!issues.base_url || !!issues.api_key}
            title={form.protocol !== 'openai' ? 'Anthropic 协议不能列出模型，模型名看服务商文档' : '向接口要可用的模型名'}
            onClick={() => void listModels()}
          >
            列出模型
          </Button>
        }
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={form.model}
            onChange={(e) => edit({ model: e.target.value })}
            placeholder={modelPlaceholder(provider)}
            invalid={!!form.model.trim() && !!issues.model}
            className="font-mono"
            spellCheck={false}
            autoComplete="off"
          />
        )}
      </Field>
      {modelsError && <p className="-mt-2 text-xs text-danger-fg">列不出模型：{modelsError}</p>}
      {models && (
        <div className="-mt-2 flex flex-col gap-1.5" data-slot="ai-models">
          <p className="text-xs text-fg-3">{models.length ? `接口给了 ${models.length} 个模型，点一个填进去：` : '接口没给出任何模型名'}</p>
          {models.length > 0 && (
            <div className="flex max-h-40 flex-wrap gap-1.5 overflow-auto scroll-thin">
              {models.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => edit({ model: m })}
                  className={cn(
                    'rounded-full px-2 py-0.5 font-mono text-xs ring-1 ring-inset ring-border hover:bg-surface-2 hover:text-fg-1',
                    m === form.model.trim() ? 'bg-primary-100 text-primary-800' : 'text-fg-2',
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <KeyField form={form} config={config} error={issues.api_key} onChange={(v) => edit({ api_key: v, clear_key: false })} onClear={(clear) => edit({ api_key: '', clear_key: clear })} />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" icon={<IconCheck />} loading={testing} disabled={blocked} onClick={() => void runTest()}>
          测试
        </Button>
        <Button variant="soft" icon={<IconSave />} loading={save.isPending} disabled={blocked || !dirty} onClick={onSave}>
          保存
        </Button>
        {dirty && <span className="text-xs text-fg-3">有改动还没保存</span>}
      </div>
      {result && (
        <p className={cn('rounded-md px-3 py-2 text-sm', result.ok ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg')} role="status" data-slot="ai-test-result">
          {testResultText(result, fmtMs)}
        </p>
      )}

      <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-fg-3">
        <li>API key 只存在本机的 backend/config.json 里：这个文件不进 git，网页也读不到 key 本身。</li>
        <li>每次请求会把你的话，和当前方案或数据库表结构说明（大约 6–7 千字）发到上面的接口地址，按服务商的价格计费。</li>
      </ul>
    </Shell>
  )
}

/** API key 输入框：来自环境变量（不能改）/ 已保存（留空不改，可以清除）/ 没有 key */
export function KeyField({
  form,
  config,
  error,
  onChange,
  onClear,
}: {
  form: AiForm
  config: AiApiConfig
  error?: string
  onChange: (v: string) => void
  onClear: (clear: boolean) => void
}) {
  const s = keyFieldState(config, form)
  return (
    <Field
      label="API key"
      hint={s.note ?? undefined}
      error={error}
      aside={
        s.canClear ? (
          <Button size="sm" variant="danger-ghost" icon={<IconTrash />} onClick={() => onClear(true)}>
            清除
          </Button>
        ) : s.mode === 'cleared' ? (
          <Button size="sm" variant="ghost" onClick={() => onClear(false)}>
            不清除了
          </Button>
        ) : undefined
      }
    >
      {({ id, describedBy }) => (
        <Input
          id={id}
          aria-describedby={describedBy}
          type="password"
          value={form.api_key}
          onChange={(e) => onChange(e.target.value)}
          placeholder={s.placeholder}
          disabled={s.disabled}
          invalid={!!error}
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
          data-key-mode={s.mode}
        />
      )}
    </Field>
  )
}
