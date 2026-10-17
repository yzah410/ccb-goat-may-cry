// vitest 运行在 node 环境：给持久化的 zustand store 一个内存版 localStorage
class MemoryStorage {
  private m = new Map<string, string>()
  get length() {
    return this.m.size
  }
  clear() {
    this.m.clear()
  }
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v))
  }
}

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true })
}
