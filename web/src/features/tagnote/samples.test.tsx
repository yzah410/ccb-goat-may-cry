/**
 * 样例导图：接口（路径、方法、写保护头）、「载入全部样例导图」按钮的显示 / 隐藏、点了以后刷新方案库列表。
 * node 环境没有 DOM：按钮用服务端渲染看结构，点击直接调按钮元素上的 onClick。
 */
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tagnoteApi } from './api'
import { SampleLoadButton, SampleLoader } from './components/SampleLoader'
import { MAP_KEYS, makeLoadSamples } from './hooks'
import type { MapSamples, MapSamplesLoaded, MapSummary } from './types'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
}

function mockFetch(respond: (c: Call) => Response) {
  const calls: Call[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const c = { url: String(url), method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()) }
    calls.push(c)
    return respond(c)
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = orig) }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const loaded = (p: Partial<MapSamplesLoaded> = {}): MapSamplesLoaded => ({ loaded: 3, skipped: 2, total: 5, remaining: 0, ...p })

const LABEL = (n: number) => `载入全部样例导图（还有 ${n} 张）`

describe('样例导图接口', () => {
  let m: ReturnType<typeof mockFetch>
  afterEach(() => m?.restore())

  it('GET /v2/map_samples；POST /v2/map_samples/load 带写保护头', async () => {
    m = mockFetch((c) => (c.method === 'GET' ? json({ total: 5, remaining: 3 }) : json(loaded())))
    expect(await tagnoteApi.samples()).toEqual({ total: 5, remaining: 3 })
    expect(m.calls[0].url).toMatch(/\/v2\/map_samples$/)
    expect(m.calls[0].headers['x-outsetter']).toBeUndefined()
    expect(await tagnoteApi.loadSamples()).toEqual(loaded())
    expect(m.calls[1]).toMatchObject({ method: 'POST' })
    expect(m.calls[1].url).toMatch(/\/v2\/map_samples\/load$/)
    expect(m.calls[1].headers['x-outsetter']).toBe('1')
  })
})

describe('「载入全部样例导图」按钮', () => {
  const noop = () => {}

  it('还有没载入的：显示按钮和剩下的张数', () => {
    const html = renderToStaticMarkup(<SampleLoadButton remaining={300} loading={false} onLoad={noop} />)
    expect(html).toContain(LABEL(300))
    expect(html).toContain('data-load-samples=""')
    expect(html).not.toContain('aria-busy="true"')
    expect(html).not.toContain('disabled=""')
  })

  it('全部载入了、或还不知道（还没读到、读取失败）：不显示', () => {
    for (const remaining of [0, undefined]) expect(renderToStaticMarkup(<SampleLoadButton remaining={remaining} loading={false} onLoad={noop} />)).toBe('')
  })

  it('点击调 onLoad；载入中转圈、不能再点', () => {
    const onLoad = vi.fn()
    const el = SampleLoadButton({ remaining: 2, loading: false, onLoad }) as ReactElement<{ onClick: () => void }>
    el.props.onClick()
    expect(onLoad).toHaveBeenCalledTimes(1)
    const busy = renderToStaticMarkup(<SampleLoadButton remaining={2} loading onLoad={onLoad} />)
    expect(busy).toContain('aria-busy="true"')
    expect(busy).toContain('disabled=""')
  })

  it('接上方案库的缓存：按缓存里的 remaining 显示 / 不显示', () => {
    const render = (samples: MapSamples) => {
      const qc = new QueryClient()
      qc.setQueryData(MAP_KEYS.samples, samples)
      return renderToStaticMarkup(
        <QueryClientProvider client={qc}>
          <SampleLoader />
        </QueryClientProvider>,
      )
    }
    expect(render({ total: 306, remaining: 300 })).toContain(LABEL(300))
    expect(render({ total: 306, remaining: 0 })).toBe('')
  })
})

describe('点了以后', () => {
  it('按钮上的数换成后端给的（全部载入 → 按钮不显示），方案库列表重新读取', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData<MapSamples>(MAP_KEYS.samples, { total: 5, remaining: 3 })
    let listReads = 0
    const list = new QueryObserver<MapSummary[]>(qc, {
      queryKey: MAP_KEYS.list,
      queryFn: async () => {
        listReads++
        return []
      },
      staleTime: Infinity,
    })
    const unsubscribe = list.subscribe(() => {})
    try {
      await vi.waitFor(() => expect(listReads).toBe(1))
      const load = vi.fn(async () => loaded())
      expect(await makeLoadSamples(qc, load)()).toEqual(loaded())
      expect(load).toHaveBeenCalledTimes(1)
      expect(listReads).toBe(2) // 列表刷新完才返回
      expect(qc.getQueryData(MAP_KEYS.samples)).toEqual({ total: 5, remaining: 0 })
      const html = renderToStaticMarkup(
        <QueryClientProvider client={qc}>
          <SampleLoader />
        </QueryClientProvider>,
      )
      expect(html).toBe('')
    } finally {
      unsubscribe()
      qc.clear()
    }
  })

  it('还有剩下的：按钮显示新的张数', async () => {
    const qc = new QueryClient()
    qc.setQueryData<MapSamples>(MAP_KEYS.samples, { total: 5, remaining: 3 })
    await makeLoadSamples(qc, async () => loaded({ loaded: 1, remaining: 2 }))()
    expect(qc.getQueryData(MAP_KEYS.samples)).toEqual({ total: 5, remaining: 2 })
  })

  it('载入失败：不动按钮上的数，也不刷新列表', async () => {
    const qc = new QueryClient()
    qc.setQueryData<MapSamples>(MAP_KEYS.samples, { total: 5, remaining: 3 })
    qc.setQueryData<MapSummary[]>(MAP_KEYS.list, [])
    await expect(makeLoadSamples(qc, async () => Promise.reject(new Error('连不上后端')))()).rejects.toThrow('连不上后端')
    expect(qc.getQueryData(MAP_KEYS.samples)).toEqual({ total: 5, remaining: 3 })
    expect(qc.getQueryState(MAP_KEYS.list)?.isInvalidated).toBe(false)
  })
})
