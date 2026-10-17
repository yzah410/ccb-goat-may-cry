/**
 * 持久化 store（zustand 的 persist 中间件）的两道保险：
 *
 * 1. migrate —— 版本迁移骨架。
 *    zustand 只在「localStorage 里存的版本号 ≠ 代码里的 version」时调用它。
 *    以后改了某个 store 的存储结构：把它的 version +1，并在 steps 里加一条「版本 n 的数据 → 版本 n+1」的函数。
 *
 * 2. merge —— 读回来先校验。
 *    每次从 localStorage 读回来都会调用（版本号变没变都会）。逐个字段用 zod 检查：
 *    - 不合法的字段 → 用默认值；缺的字段 → 用默认值；两种都 console.warn 一行，写明是哪个 store 的哪些字段；
 *    - 合法的字段保留**原值**（不用 zod 解析后的新对象：它会调换对象键的顺序，草稿的「有没有改动」指纹是按 JSON 文本比的，
 *      方案文件也要求字节级往返不变）；
 *    - 存储里有、但代码里没有的字段 → 直接丢掉，不混进新状态；state 里有、但 fields 里没写校验的字段 → 原样保留（不丢用户数据）；
 *    - 整个存储不是对象（被别的程序写坏了）→ 全部用默认值。
 *    可选的 fix(next, persisted) 用来做跨字段的修补（例如「一个字段引用的另一项必须存在」）。
 */
import type { ZodType } from 'zod'
import { createJSONStorage, type PersistStorage } from 'zustand/middleware'

type Obj = Record<string, unknown>

/**
 * 存到 localStorage（JSON）。显式写出来，而不是用 zustand 的默认值：zustand 默认读的是 window.localStorage，
 * 测试环境（node）没有 window，persist 会静默失效（连 store.persist 都没有），迁移和校验就测不到了。浏览器里两者是同一个对象。
 */
export function localJSONStorage<S>(): PersistStorage<S> | undefined {
  return createJSONStorage<S>(() => localStorage)
}
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** steps[n]：把「版本 n 的数据」升级成「版本 n+1」 */
export type MigrationSteps = Record<number, (state: Obj) => Obj>

export function makeMigrate(storeName: string, currentVersion: number, steps: MigrationSteps = {}) {
  return (persisted: unknown, fromVersion: number): unknown => {
    let state: unknown = persisted
    let v = fromVersion
    while (v < currentVersion) {
      const step = steps[v]
      if (!step) break
      state = step(isObj(state) ? state : {})
      v++
    }
    if (v !== currentVersion)
      console.warn(
        `[store:${storeName}] 本地存的是第 ${fromVersion} 版的数据，没有升级到第 ${currentVersion} 版的办法；读回来的字段会逐个检查，不合法的用默认值`,
      )
    return state
  }
}

/** 字段 → 校验它的 zod schema（只写需要持久化、需要检查的字段） */
export type FieldSchemas<S> = { [K in keyof S]?: ZodType }

export function validatedMerge<S extends object>(storeName: string, fields: FieldSchemas<S>, fix?: (next: S, persisted: Obj) => S) {
  return (persisted: unknown, current: S): S => {
    if (persisted === undefined || persisted === null) return current
    if (!isObj(persisted)) {
      console.warn(`[store:${storeName}] 本地存的数据格式不对（不是对象），已全部用默认值`)
      return current
    }
    const cur = current as Obj
    const next: Obj = { ...cur }
    for (const [key, value] of Object.entries(persisted)) {
      if (key in fields) continue // 下面逐个校验
      if (key in cur && typeof cur[key] !== 'function') next[key] = value // 没写校验的已知字段：原样保留
    }
    const problems: string[] = []
    for (const [key, schema] of Object.entries(fields) as [string, ZodType | undefined][]) {
      if (!schema) continue
      if (!(key in persisted)) {
        problems.push(`${key}（缺）`)
        continue
      }
      if (schema.safeParse(persisted[key]).success) next[key] = persisted[key]
      else problems.push(`${key}（不合法）`)
    }
    if (problems.length) console.warn(`[store:${storeName}] 本地存的数据有问题，这些字段已用默认值：${problems.join('、')}`)
    return fix ? fix(next as S, persisted) : (next as S)
  }
}
