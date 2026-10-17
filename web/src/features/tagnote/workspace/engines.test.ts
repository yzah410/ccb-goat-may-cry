/**
 * 引擎句柄登记：等到手的句柄要跟着重新挂载走（开发时 StrictMode 挂两次、保活淘汰后重挂）。
 * 用户接管：只转发引擎的 onFocusTakeover 回调（假引擎记下挂载参数，测试替引擎调它）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { MountOptions, TagNoteData, TagNoteInstance } from '@/vendor/tagnote/tagnote.esm.js'
import { TagNoteBinding, type EngineLike } from '../binding'
import { emitUserFocus, engineOf, focusTakeoverFor, onEngineMount, onUserFocus, registerEngine, waitEngine, type EngineHandle } from './engines'

function fake(tabId: string, mapId: string, name: string) {
  const calls: string[] = []
  const h: EngineHandle = {
    tabId,
    mapId,
    view: 'canvas',
    setView: () => calls.push(`${name}:setView`),
    getViewport: () => null,
    setViewport: () => calls.push(`${name}:setViewport`),
    focusWorks: (ids) => {
      calls.push(`${name}:focus:${ids.join(',')}`)
      return { found: ids, secondaryFound: [], queued: false }
    },
    clearFocus: () => calls.push(`${name}:clear`),
    drawnWorkIds: () => [name],
    boardRect: () => null,
  }
  return { h, calls }
}

describe('engines', () => {
  it('waitEngine 等到实例挂上；之后实例换了，句柄跟着走', async () => {
    const p = waitEngine('t-a', 'm1', 1000)
    const a = fake('t-a', 'm1', 'A')
    const offA = registerEngine(a.h)
    const h = await p
    expect(h).not.toBeNull()
    // StrictMode：A 卸载，B 挂上
    offA()
    const b = fake('t-a', 'm1', 'B')
    const offB = registerEngine(b.h)
    h!.focusWorks(['w1'], { mode: 'stay' })
    expect(b.calls).toEqual(['B:focus:w1'])
    expect(a.calls).toEqual([])
    expect(h!.drawnWorkIds()).toEqual(['B'])
    offB()
    // 都卸掉了：退回原来那个（销毁了的实例自己什么都不做）
    h!.clearFocus()
    expect(a.calls).toEqual(['A:clear'])
  })

  it('标签换了图：只认画这张图的实例', async () => {
    const a = fake('t-b', 'm1', 'A')
    const off = registerEngine(a.h)
    expect(engineOf('t-b', 'm2')).toBeNull()
    expect(await waitEngine('t-b', 'm2', 20)).toBeNull()
    off()
  })

  it('onEngineMount：每次有实例挂上都告诉订阅者', () => {
    const fn = vi.fn()
    const unsub = onEngineMount(fn)
    const a = fake('t-c', 'm1', 'A')
    const offA = registerEngine(a.h)
    offA()
    const offB = registerEngine(fake('t-c', 'm1', 'B').h)
    expect(fn).toHaveBeenCalledTimes(2)
    unsub()
    offB()
    registerEngine(fake('t-c', 'm1', 'C').h)()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('onUserFocus：按标签和原因报出去；退订后不再收到', () => {
    const fn = vi.fn()
    const off = onUserFocus(fn)
    emitUserFocus('t-x', 'esc')
    expect(fn).toHaveBeenCalledWith('t-x', 'esc')
    off()
    emitUserFocus('t-y', 'pin')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('用户接管：只转发引擎的 onFocusTakeover', () => {
  /** 假引擎：记下挂载参数，测试替引擎调回调 */
  function mountWith(onFocusTakeover?: (reason: 'pin' | 'esc') => void) {
    let opts: MountOptions = {}
    const engine: EngineLike = {
      mount: (_el, _data, o) => {
        opts = o ?? {}
        return { destroy: () => {}, getPrefs: () => ({}), setPrefs: () => {} } as unknown as TagNoteInstance
      },
    }
    new TagNoteBinding(engine, {} as HTMLElement, { data: {} as TagNoteData, theme: 'light', layout: 'pane', fullscreen: 'host', onFocusTakeover })
    return opts
  }

  it('引擎回调 → 带着标签 id 和原因报到 onUserFocus；只有回调了的那个实例报', () => {
    const got: [string, string][] = []
    const off = onUserFocus((tabId, reason) => got.push([tabId, reason]))
    const a = mountWith(focusTakeoverFor('t-a', () => true))
    const b = mountWith(focusTakeoverFor('t-b', () => true))
    // 焦点在 A、鼠标在 B 时按 Esc：引擎只清了 B，只有 B 回调
    b.onFocusTakeover?.('esc')
    a.onFocusTakeover?.('pin')
    expect(got).toEqual([
      ['t-b', 'esc'],
      ['t-a', 'pin'],
    ])
    off()
  })

  it('引擎不回调（被吞掉的点击、flash 结束、宿主 clearFocus）：什么都不报', () => {
    const fn = vi.fn()
    const off = onUserFocus(fn)
    const opts = mountWith(focusTakeoverFor('t-a', () => true))
    expect(typeof opts.onFocusTakeover).toBe('function')
    expect(fn).not.toHaveBeenCalled()
    off()
  })

  it('标签已经换成别的图（旧实例还没卸）：旧实例报的不转发', () => {
    const fn = vi.fn()
    const off = onUserFocus(fn)
    let mine = true
    const opts = mountWith(focusTakeoverFor('t-a', () => mine))
    mine = false
    opts.onFocusTakeover?.('pin')
    expect(fn).not.toHaveBeenCalled()
    off()
  })
})
