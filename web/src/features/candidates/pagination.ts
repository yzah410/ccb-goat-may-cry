/** 分页计算（纯函数，有单测） */

export function totalPagesOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)))
}

/**
 * 页码窗口：最多 size 个页码。从 max(1, page-5) 开始；到末尾时往左补齐，始终尽量显示 size 个。
 */
export function pageWindow(page: number, totalPages: number, size = 10): number[] {
  const n = Math.max(1, totalPages)
  const p = Math.min(Math.max(1, page), n)
  const start = Math.max(1, Math.min(p - 5, n - size + 1))
  const end = Math.min(n, start + size - 1)
  const out: number[] = []
  for (let i = start; i <= end; i++) out.push(i)
  return out
}

/** 这一页是第几条到第几条（给「第 11–20 个，共 2,786 个」用） */
export function pageSpan(page: number, pageSize: number, total: number): [number, number] {
  if (total <= 0) return [0, 0]
  const a = (Math.max(1, page) - 1) * pageSize + 1
  return [Math.min(a, total), Math.min(total, a + pageSize - 1)]
}
