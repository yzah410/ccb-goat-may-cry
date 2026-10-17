/**
 * 单人猜猜呗的头像框：设置里的「显示角色头像」关着（默认）时不画图（缓存里有地址也不画），
 * 框还在、里面是人像占位，也没有加载中的骨架；开着时才画图 / 骨架。
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const URL5 = 'https://lain.bgm.tv/pic/crt/g/5.jpg'

/**
 * 服务端渲染读的是 store 的初始状态（带持久化的设置 store 读不到 localStorage 里的值），
 * 所以这里换成一个只有 avatars 的普通 store；头像缓存写进 localStorage，再拿全新的模块。
 */
async function html(avatars: boolean, id: number | null): Promise<string> {
  localStorage.clear()
  localStorage.setItem('outsetter.avatars.v1', JSON.stringify({ '5': URL5, '6': '' }))
  vi.doMock('@/features/settings/store', async () => {
    const { create } = await import('zustand')
    return { usePrefs: create(() => ({ avatars })) }
  })
  vi.resetModules()
  const { SoloAvatar } = await import('./SoloAvatar')
  return renderToStaticMarkup(<SoloAvatar id={id} />)
}

describe('SoloAvatar：跟着头像开关', () => {
  afterEach(() => {
    vi.doUnmock('@/features/settings/store')
    localStorage.clear()
  })

  it('关着：缓存里有地址也不画图，框里是人像占位，没有骨架', async () => {
    for (const id of [5, 6, 7, null]) {
      const out = await html(false, id)
      expect(out).not.toContain('<img')
      expect(out).not.toContain(URL5)
      expect(out).not.toContain('skeleton')
      expect(out).toContain('<svg') // 占位的人像
      expect(out).toContain('size-11') // 框的大小不变，表格不错位
    }
  })

  it('开着：有地址画图；没头像画占位；还没结果画骨架', async () => {
    expect(await html(true, 5)).toContain(`<img src="${URL5}"`)
    const none = await html(true, 6)
    expect(none).not.toContain('<img')
    expect(none).toContain('<svg')
    const loading = await html(true, 7)
    expect(loading).toContain('skeleton')
    expect(loading).not.toContain('<svg')
  })
})
