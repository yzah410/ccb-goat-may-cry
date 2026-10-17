/**
 * 做题联动（跟随格）用的树操作：开成标签但不抢当前格、切到某张图。
 */
import { describe, expect, it } from 'vitest'
import { emptyWorkspace, ensureTabs, findPane, openMap, showMap, showTab, splitTab } from './tree'
import type { Workspace } from './types'

/** 左格 p1：图 a、b（当前 b）；右格：图 c（当前格） */
function twoPanes(): Workspace {
  let ws = openMap(emptyWorkspace(), 'a')
  ws = openMap(ws, 'b', { newTab: true })
  ws = openMap(ws, 'c', { newTab: true })
  const c = findPane(ws, 'p1')!.tabs.at(-1)!
  ws = splitTab(ws, c, 'p1', 'right')
  return ws
}

describe('ensureTabs：把组里的图开成标签', () => {
  it('开在最后、不重复、当前标签和当前格都不变', () => {
    const ws = twoPanes()
    const right = ws.activePane
    const next = ensureTabs(ws, 'p1', ['b', 'x', 'y', 'x'])
    const p1 = findPane(next, 'p1')!
    expect(p1.tabs.map((t) => next.tabs[t].mapId)).toEqual(['a', 'b', 'x', 'y'])
    expect(next.tabs[p1.active!].mapId).toBe('b')
    expect(next.activePane).toBe(right)
  })

  it('都开着了 → 原样返回；格子不存在 → 原样返回', () => {
    const ws = twoPanes()
    expect(ensureTabs(ws, 'p1', ['a', 'b'])).toBe(ws)
    expect(ensureTabs(ws, 'nope', ['z'])).toBe(ws)
  })

  it('空格子：第一个新开的成为当前标签；新标签用给的视图', () => {
    const ws = ensureTabs(emptyWorkspace(), 'p1', ['m1', 'm2'], 'kmap')
    const p = findPane(ws, 'p1')!
    expect(ws.tabs[p.active!].mapId).toBe('m1')
    expect(Object.values(ws.tabs).map((t) => t.view)).toEqual(['kmap', 'kmap'])
    expect(ws.opened).toBe(true)
  })
})

describe('showMap / showTab：跟随格切到答案图', () => {
  it('开着的切过去，不改当前格', () => {
    const ws = twoPanes()
    const right = ws.activePane
    const { ws: next, tabId } = showMap(ws, 'p1', 'a')
    const p1 = findPane(next, 'p1')!
    expect(next.tabs[tabId!].mapId).toBe('a')
    expect(p1.active).toBe(tabId)
    expect(next.activePane).toBe(right)
  })

  it('没开 → 在最后新开再切过去', () => {
    const ws = twoPanes()
    const { ws: next, tabId } = showMap(ws, 'p1', 'z', 'canvas')
    const p1 = findPane(next, 'p1')!
    expect(p1.tabs.at(-1)).toBe(tabId)
    expect(p1.active).toBe(tabId)
    expect(next.tabs[tabId!]).toMatchObject({ mapId: 'z', view: 'canvas' })
  })

  it('已经是当前标签 → 原样返回；格子不存在 → tabId 为 null', () => {
    const ws = twoPanes()
    const b = findPane(ws, 'p1')!.active!
    expect(showTab(ws, b)).toBe(ws)
    expect(showMap(ws, 'p1', 'b').ws).toBe(ws)
    expect(showMap(ws, 'nope', 'b')).toEqual({ ws, tabId: null })
  })
})
