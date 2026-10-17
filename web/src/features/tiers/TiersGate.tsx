/**
 * 启动时读一次分档（GET /v2/tiers）：
 * - 让候选卡片 / 人数统计的「加粗标签」跟着分档走（分档和默认一样时不设置覆盖，直接用默认规则）；
 * - 还没选过公式（configured = false）→ 弹开局问卷。后端连不上、或者没有 /v2/tiers 接口，就不弹。
 */
import { lazy, Suspense, useEffect } from 'react'
import { setAnimeTierOverride } from '@/lib/tags'
import { sameTiers, useTiers } from './api'
import { useFormulaWizard } from './store'

const FormulaWizard = lazy(() => import('./FormulaWizard'))

export function TiersGate() {
  const { data } = useTiers()
  const open = useFormulaWizard((s) => s.open)

  useEffect(() => {
    if (!data) return
    const t = data.tiers
    setAnimeTierOverride(sameTiers(t, data.defaults) ? null : { primary: t.G_1, secondary: [...t.G_2, ...t.G_3, ...t.G_4] })
  }, [data])

  const configured = data?.configured
  useEffect(() => {
    if (configured === false) useFormulaWizard.getState().show('first')
  }, [configured])

  if (!open) return null
  return (
    <Suspense fallback={null}>
      <FormulaWizard />
    </Suspense>
  )
}
