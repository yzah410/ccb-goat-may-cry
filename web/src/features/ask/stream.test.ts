/**
 * AI 流式接口相关的纯逻辑：
 * - SSE 解析（features/v2/aiStream.ts）：事件可能在任意位置被切开、CRLF、keep-alive 注释、多行 data
 * - 问数据的边写边解析（features/ask/draft.ts）：任何一个前缀都能解析、不报错，SQL 只增不乱
 * - 标签替换（features/workbench2/ai.ts 的 replaceNameInSpec）：只换同一类、去重、不动原方案
 */
import { describe, expect, it } from 'vitest'
import { SseParser, parseSseBlock, runAiStream } from '@/features/v2/aiStream'
import { replaceNameInSpec } from '@/features/workbench2/ai'
import type { SpecV2 } from '@/features/v2/types'
import { parseAskDraft } from './draft'

const STREAM = [
  'event: open\ndata: {"job_id": "a1", "kind": "ask"}\n\n',
  ': keep-alive\n\n',
  'event: status\ndata: {"stage": "writing", "message": "AI 在写", "ms": 1200}\n\n',
  'event: delta\ndata: {"text": "说明：统计\\n"}\n\n',
  'event: delta\ndata: {"text": "范围：动画"}\n\n',
  'event: result\ndata: {"ok": true, "rows": [[1]]}\n\n',
].join('')

describe('SSE 解析', () => {
  it('一次给全', () => {
    const p = new SseParser()
    const evs = p.push(STREAM)
    expect(evs.map((e) => e.event)).toEqual(['open', 'status', 'delta', 'delta', 'result'])
    expect((evs[2]!.data as { text: string }).text).toBe('说明：统计\n')
    expect(p.flush()).toEqual([])
  })

  it('在任意位置被切开（包括切在多字节字符的中间之后重新拼）都一样', () => {
    const whole = new SseParser().push(STREAM)
    for (let cut = 1; cut < STREAM.length; cut += 3) {
      const p = new SseParser()
      const evs = [...p.push(STREAM.slice(0, cut)), ...p.push(STREAM.slice(cut)), ...p.flush()]
      expect(evs).toEqual(whole)
    }
  })

  it('CRLF、多行 data、非 JSON data、没有空行结尾的最后一块', () => {
    const p = new SseParser()
    const evs = p.push('event: a\r\ndata: {"x":\r\ndata: 1}\r\n\r\nevent: b\ndata: 纯文字')
    expect(evs).toEqual([{ event: 'a', data: { x: 1 } }])
    expect(p.flush()).toEqual([{ event: 'b', data: '纯文字' }])
    expect(parseSseBlock(': 只有注释')).toBeNull()
    expect(parseSseBlock('data: {"a":1}')).toEqual({ event: 'message', data: { a: 1 } })
  })

  it('runAiStream：把 delta 拼成全文、status 回调、拿到 result 就结束', async () => {
    const enc = new TextEncoder()
    const chunks = [STREAM.slice(0, 50), STREAM.slice(50, 140), STREAM.slice(140)]
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch))
        c.close()
      },
    })
    const orig = globalThis.fetch
    globalThis.fetch = (async () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch
    try {
      const seen: string[] = []
      let full = ''
      let job = ''
      const r = await runAiStream<{ ok: boolean }>('/v2/ai/ask/stream', {}, {
        onOpen: (id) => (job = id),
        onStatus: (s) => seen.push(s.stage),
        onDelta: (_t, f) => (full = f),
      })
      expect(r.ok).toBe(true)
      expect(job).toBe('a1')
      expect(seen).toEqual(['writing'])
      expect(full).toBe('说明：统计\n范围：动画')
    } finally {
      globalThis.fetch = orig
    }
  })

  it('流式请求也带 X-Outsetter: 1', async () => {
    const orig = globalThis.fetch
    let init: RequestInit | undefined
    globalThis.fetch = (async (_url: unknown, i?: RequestInit) => {
      init = i
      const sse = 'event: result\ndata: {"ok": true}\n\n'
      return new Response(new TextEncoder().encode(sse), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }) as typeof fetch
    try {
      await runAiStream('/v2/ai/ask/stream', { question: 'x' })
      expect(init?.method).toBe('POST')
      expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-Outsetter': '1' })
    } finally {
      globalThis.fetch = orig
    }
  })

  it('runAiStream：error 事件变成异常；cancelled 当成取消', async () => {
    const orig = globalThis.fetch
    const mk = (s: string) =>
      (async () => new Response(new TextEncoder().encode(s), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch
    try {
      globalThis.fetch = mk('event: error\ndata: {"code": "no_db", "message": "没找到出题器数据库"}\n\n')
      await expect(runAiStream('/x', {})).rejects.toMatchObject({ message: '没找到出题器数据库', status: 503 })
      globalThis.fetch = mk('event: error\ndata: {"code": "cancelled", "message": "已取消"}\n\n')
      await expect(runAiStream('/x', {})).rejects.toMatchObject({ kind: 'aborted' })
      globalThis.fetch = mk('event: open\ndata: {}\n\n')
      await expect(runAiStream('/x', {})).rejects.toMatchObject({ kind: 'parse' })
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ ok: false, error: 'bad_spec', message: '方案格式不对：xx' }), { status: 422 })) as typeof fetch
      await expect(runAiStream('/x', {})).rejects.toMatchObject({ status: 422, message: '方案格式不对：xx' })
    } finally {
      globalThis.fetch = orig
    }
  })
})

const ANSWER = '说明：按作品标签统计。\n两种口径。\n范围：只算匿名能搜到的动画。\n```sql\nSELECT COUNT(*) AS 部数\nFROM subject s\nWHERE s.type = 2\n```\n存为：无'

describe('问数据：边写边解析', () => {
  it('完整回答', () => {
    const d = parseAskDraft(ANSWER)
    expect(d.explanation).toBe('按作品标签统计。\n两种口径。')
    expect(d.scope).toBe('只算匿名能搜到的动画。')
    expect(d.sql).toBe('SELECT COUNT(*) AS 部数\nFROM subject s\nWHERE s.type = 2')
    expect(d.sqlOpen).toBe(false)
    expect(d.save).toBe('无')
    expect(d.unstructured).toBe(false)
  })

  it('任何一个前缀都能解析：不报错、不把标记和代码块符号漏进正文、SQL 只增不乱', () => {
    let lastSql = ''
    for (let i = 0; i <= ANSWER.length; i++) {
      const d = parseAskDraft(ANSWER.slice(0, i))
      expect(d.explanation).not.toMatch(/范围|```|`$/)
      expect(d.scope).not.toMatch(/```|`$/)
      expect(d.sql).not.toContain('`')
      expect(ANSWER.includes(d.sql)).toBe(true)
      if (d.sql) {
        expect(d.sql.startsWith(lastSql.trimEnd()) || lastSql.startsWith(d.sql)).toBe(true)
        lastSql = d.sql
      }
    }
  })

  it('写到一半的状态', () => {
    expect(parseAskDraft('说明：按作品').explanation).toBe('按作品')
    expect(parseAskDraft('说明：按作品\n范').explanation).toBe('按作品')
    expect(parseAskDraft('说明：按作品\n统计范围：动').scope).toBe('动')
    const mid = parseAskDraft('说明：x\n范围：y\n```sql\nSELECT a\nFR')
    expect(mid.sql).toBe('SELECT a\nFR')
    expect(mid.sqlOpen).toBe(true)
    expect(parseAskDraft('说明：x\n范围：y\n``').scope).toBe('y')
    expect(parseAskDraft('{"sql": "SELECT 1"').unstructured).toBe(true)
  })
})

describe('标签替换（结果卡上的按钮）', () => {
  const spec = {
    version: 2,
    game: { mode: 'anime', tag_count: 6 },
    ranges: [
      {
        id: 'r1',
        enabled: true,
        source: { kind: 'rank', subject_types: [2], year_from: 2024, year_to: 2024, rank_from: 1, rank_to: 50, rank_scope: 'merged',
          work_filter: { quant: 'any', tags: ['后宫番'], tag_mode: 'main' } },
        pick: { roles: ['主角'], per_work: null, order: 'heat' },
        conditions: [
          { id: 'c1', enabled: true, negate: false, type: 'game_tags', quant: 'any', tags: ['后宫番', '后宫'] },
          { id: 'c2', enabled: true, negate: false, type: 'va', names: ['花泽 香菜'] },
          { id: 'c3', enabled: true, negate: false, type: 'appearance', work_tags: { quant: 'any', tags: ['后宫番'], tag_mode: 'meta' } },
        ],
      },
    ],
    excludes: [],
    draw: { method: 'per_character', seed: null },
  } as unknown as SpecV2

  it('只换同一类，同类里去重，不动原方案', () => {
    const out = replaceNameInSpec(spec, 'game', '后宫番', '后宫')
    const conds = out.ranges[0]!.conditions as unknown as { tags?: string[]; work_tags?: { tags: string[] } }[]
    expect(conds[0]!.tags).toEqual(['后宫'])
    expect((out.ranges[0]!.source as { work_filter: { tags: string[] } }).work_filter.tags).toEqual(['后宫番'])
    expect(conds[2]!.work_tags!.tags).toEqual(['后宫番'])
    expect((spec.ranges[0]!.conditions[0] as unknown as { tags: string[] }).tags).toEqual(['后宫番', '后宫'])
    const w = replaceNameInSpec(spec, 'work', '后宫番', '后宫')
    expect((w.ranges[0]!.source as { work_filter: { tags: string[] } }).work_filter.tags).toEqual(['后宫'])
    const m = replaceNameInSpec(spec, 'meta', '后宫番', '后宫')
    expect((m.ranges[0]!.conditions[2] as unknown as { work_tags: { tags: string[] } }).work_tags.tags).toEqual(['后宫'])
    const v = replaceNameInSpec(spec, 'va', '花泽 香菜', '花澤香菜')
    expect((v.ranges[0]!.conditions[1] as unknown as { names: string[] }).names).toEqual(['花澤香菜'])
  })
})
