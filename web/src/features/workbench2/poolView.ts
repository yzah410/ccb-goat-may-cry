/**
 * 候选池页（/pool）自己的显示设置：排序（持久化 `outsetter.pool-v2.v1`）。
 * 卡片 / 列表、每页几个、「显示角色标签」用 features/candidates/store.ts 的 useCandidateView（同一个人的界面偏好）。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { z } from 'zod'
import { localJSONStorage, makeMigrate, validatedMerge } from '@/lib/persist'
import type { CandidateSort } from '@/features/v2/types'

export const POOL_SORTS: { value: CandidateSort; label: string }[] = [
  { value: 'heat', label: '按角色热度（高 → 低）' },
  { value: 'name', label: '按名字' },
  { value: 'random', label: '随机打乱' },
]

interface PoolViewState {
  sort: CandidateSort
  setSort: (s: CandidateSort) => void
}

export const usePoolView = create<PoolViewState>()(
  persist(
    (set) => ({
      sort: 'heat',
      setSort: (sort) => set({ sort }),
    }),
    {
      name: 'outsetter.pool-v2.v1',
      version: 1,
      storage: localJSONStorage(),
      migrate: makeMigrate('pool-v2', 1),
      merge: validatedMerge<PoolViewState>('pool-v2', { sort: z.enum(['heat', 'name', 'random']) }),
    },
  ),
)
