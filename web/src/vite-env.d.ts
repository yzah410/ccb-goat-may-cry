/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端地址，默认 http://127.0.0.1:8099（设置页可在运行时覆盖） */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module 'virtual:emoji-subset' {
  import type { IconifyJSON } from '@iconify/types'
  const data: IconifyJSON
  export default data
}
