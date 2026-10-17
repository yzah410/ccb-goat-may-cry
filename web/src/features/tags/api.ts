/**
 * 标签自动补全：GET /tags?kind=work|char|va|source&q=&limit=20（backend/api_ext.py）。
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/apiClient'
import type { TagKind } from '@/features/blocks/schema'

export interface TagSuggestion {
  name: string
  count: number
}

export interface TagsResp {
  kind: TagKind
  q: string
  items: TagSuggestion[]
  total_matched?: number
}

export const tagsApi = {
  search: (kind: TagKind, q: string, limit = 20, signal?: AbortSignal) =>
    api.get<TagsResp>('/tags', { query: { kind, q, limit }, signal, timeoutMs: 8000 }),
}

export function useTagSuggestions(kind: TagKind, q: string, enabled: boolean) {
  return useQuery({
    queryKey: ['tags', kind, q],
    queryFn: ({ signal }) => tagsApi.search(kind, q, 20, signal),
    enabled,
    staleTime: 10 * 60_000,
    retry: false,
  })
}
