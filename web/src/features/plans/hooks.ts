import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { errorText } from '@/lib/apiClient'
import { toast } from '@/components/ui/Toast'
import { confirm } from '@/components/ui/Confirm'
import { useDraft, useIsDirty } from '@/features/blocks/store'
import { usePrefs } from '@/features/settings/store'
import { getTheme } from '@/themes/registry'
import { plansApi, type PlanSaveBody } from './api'

export const PLANS_KEY = ['plans'] as const

export function usePlansList(enabled = true) {
  return useQuery({ queryKey: PLANS_KEY, queryFn: plansApi.list, enabled, staleTime: 15_000 })
}

/**
 * 加载方案：整体覆盖当前草稿。
 * 有没保存的改动时先问一句，不直接覆盖。
 */
export function useLoadPlan() {
  const loadPlan = useDraft((s) => s.loadPlan)
  const dirty = useIsDirty()
  const currentName = useDraft((s) => s.planName)
  const setPrefs = usePrefs((s) => s.set)
  const currentTheme = usePrefs((s) => s.theme)

  return useCallback(
    async (name: string): Promise<boolean> => {
      if (dirty) {
        const ok = await confirm({
          title: '当前方案有改动还没保存',
          description: `加载「${name}」会把它覆盖掉${currentName ? `（当前是「${currentName}」）` : ''}。继续吗？`,
          confirmLabel: '覆盖并加载',
          tone: 'danger',
        })
        if (!ok) return false
      }
      try {
        const plan = await plansApi.get(name)
        const warnings = loadPlan(name, plan)
        const t = plan.theme ? getTheme(plan.theme) : undefined
        toast.success(`已加载「${name}」`, {
          description: warnings.length
            ? `有 ${warnings.length} 处小问题已自动修正：${warnings.slice(0, 2).join('；')}${warnings.length > 2 ? '…' : ''}`
            : `${(plan.blocks ?? []).length} 个组块`,
          action:
            t && t.manifest.id !== currentTheme
              ? { label: `换成它保存时的主题「${t.manifest.name}」`, onClick: () => setPrefs({ theme: t.manifest.id }) }
              : undefined,
        })
        return true
      } catch (e) {
        toast.error(`加载「${name}」失败`, { description: errorText(e) })
        return false
      }
    },
    [dirty, currentName, loadPlan, setPrefs, currentTheme],
  )
}

/** 保存到指定名字（同名直接覆盖，是否确认由调用方决定） */
export function useSavePlan() {
  const qc = useQueryClient()
  const markSaved = useDraft((s) => s.markSaved)
  return useMutation({
    mutationFn: async (name: string) => {
      const s = useDraft.getState()
      const body: PlanSaveBody = {
        mode: s.mode,
        seed: s.seed,
        theme: usePrefs.getState().theme,
        blocks: s.blocks,
        include_extra_work_tags: s.includeExtraWorkTags,
      }
      await plansApi.save(name, body)
      return name
    },
    onSuccess: (name) => {
      markSaved(name)
      void qc.invalidateQueries({ queryKey: PLANS_KEY })
      toast.success(`已保存「${name}」`, { id: 'plan-save' })
    },
    onError: (e, name) => toast.error(`保存「${name}」失败`, { description: errorText(e) }),
  })
}

/** 复制一个已有方案到新名字（方案库里的「复制一份」） */
export function useDuplicatePlan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ from, to }: { from: string; to: string }) => {
      const plan = await plansApi.get(from)
      await plansApi.save(to, {
        mode: plan.mode === 'work-weight' ? 'work-weight' : 'char-weight',
        seed: typeof plan.seed === 'number' ? plan.seed : null,
        theme: plan.theme ?? null,
        blocks: (plan.blocks ?? []) as PlanSaveBody['blocks'],
        include_extra_work_tags: !!plan.include_extra_work_tags,
      })
      return to
    },
    onSuccess: (to) => {
      void qc.invalidateQueries({ queryKey: PLANS_KEY })
      toast.success(`已复制成「${to}」`)
    },
    onError: (e) => toast.error('复制失败', { description: errorText(e) }),
  })
}

/** 删除（先二次确认） */
export function useDeletePlan() {
  const qc = useQueryClient()
  return useCallback(
    async (name: string): Promise<boolean> => {
      const ok = await confirm({
        title: `删除方案「${name}」？`,
        description: '删了就找不回来了（后端直接删文件）。',
        confirmLabel: '删除',
        tone: 'danger',
      })
      if (!ok) return false
      try {
        await plansApi.remove(name)
        if (useDraft.getState().planName === name) useDraft.setState({ planName: null })
        await qc.invalidateQueries({ queryKey: PLANS_KEY })
        toast.success(`已删除「${name}」`)
        return true
      } catch (e) {
        toast.error(`删除「${name}」失败`, { description: errorText(e) })
        return false
      }
    },
    [qc],
  )
}
