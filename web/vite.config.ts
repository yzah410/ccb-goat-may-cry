/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import Icons from 'unplugin-icons/vite'
import { getIcons } from '@iconify/utils'
import type { IconifyJSON } from '@iconify/types'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { EMOJI_ICON_NAMES } from './src/lib/emoji-names'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
/** 壁纸素材包：assets/wallpapers（web/ 的兄弟目录），可以没有或为空，见该目录的 README.md */
const WALLPAPER_DIR = path.resolve(ROOT, '../assets/wallpapers')
const require = createRequire(import.meta.url)

const MIME: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
}

/**
 * 壁纸静态资源：
 * - 开发：中间件把 /wallpapers/* 映射到 ../assets/wallpapers/*
 * - 构建：把 full/ thumb/ palette.json 复制进 dist/wallpapers/
 */
function wallpapersPlugin(): Plugin {
  let outDir = path.resolve(ROOT, 'dist')
  return {
    name: 'outsetter:wallpapers',
    configResolved(cfg) {
      outDir = path.resolve(cfg.root, cfg.build.outDir)
    },
    configureServer(server) {
      server.middlewares.use('/wallpapers', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
        const file = path.normalize(path.join(WALLPAPER_DIR, rel))
        if (!file.startsWith(WALLPAPER_DIR)) {
          res.statusCode = 403
          res.end()
          return
        }
        fs.stat(file, (err, st) => {
          if (err || !st.isFile()) return next()
          res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream')
          res.setHeader('Cache-Control', 'public, max-age=3600')
          fs.createReadStream(file).pipe(res)
        })
      })
    },
    closeBundle() {
      // 没有壁纸目录、或目录里没有图片 / palette.json：什么都不复制，也不生成 dist/wallpapers/
      const dest = path.join(outDir, 'wallpapers')
      for (const sub of ['full', 'thumb']) {
        const src = path.join(WALLPAPER_DIR, sub)
        if (!fs.existsSync(src) || fs.readdirSync(src).length === 0) continue
        fs.mkdirSync(dest, { recursive: true })
        fs.cpSync(src, path.join(dest, sub), { recursive: true })
      }
      const pal = path.join(WALLPAPER_DIR, 'palette.json')
      if (fs.existsSync(pal)) {
        fs.mkdirSync(dest, { recursive: true })
        fs.copyFileSync(pal, path.join(dest, 'palette.json'))
      }
    },
  }
}

/**
 * 矢量 emoji 离线子集：只把 src/lib/emoji-names.ts 里列出的 fluent-emoji-flat 图标打进包，
 * 供 @iconify/react 按「名字」动态渲染（例如 标签名 → emoji）。
 */
function emojiSubsetPlugin(): Plugin {
  const VIRTUAL = 'virtual:emoji-subset'
  const RESOLVED = '\0' + VIRTUAL
  return {
    name: 'outsetter:emoji-subset',
    resolveId(id) {
      if (id === VIRTUAL) return RESOLVED
      return null
    },
    load(id) {
      if (id !== RESOLVED) return null
      const full = JSON.parse(
        fs.readFileSync(require.resolve('@iconify-json/fluent-emoji-flat/icons.json'), 'utf8'),
      ) as IconifyJSON
      const names = Array.from(new Set(EMOJI_ICON_NAMES))
      const subset = getIcons(full, names, true)
      const missing = names.filter((n) => !subset?.icons[n] && !subset?.aliases?.[n])
      if (missing.length) this.warn(`fluent-emoji-flat 里找不到这些图标：${missing.join(', ')}`)
      return `export default ${JSON.stringify(subset)}`
    },
  }
}

export default defineConfig(({ mode }) => {
  // 端口默认 5175（和 start-all.bat、后端 8099 配套）；想临时换端口，在 web/.env.development.local 写 WEB_PORT=xxxx（*.local 不进 git）
  const env = loadEnv(mode, ROOT, '')
  const port = Number(env.WEB_PORT) || 5175
  return {
    plugins: [
      react(),
      tailwindcss(),
      Icons({ compiler: 'jsx', jsx: 'react', scale: 1, autoInstall: false }),
      wallpapersPlugin(),
      emojiSubsetPlugin(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(ROOT, 'src'),
        '@assets': path.resolve(ROOT, '../assets'),
      },
    },
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      fs: { allow: [ROOT, path.resolve(ROOT, '../assets')] },
    },
    preview: { host: '127.0.0.1', port, strictPort: true },
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router'],
            radix: ['radix-ui'],
            charts: ['recharts'],
            motion: ['motion'],
            query: ['@tanstack/react-query', 'zustand', 'zod'],
          },
        },
      },
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      setupFiles: ['src/test/setup.ts'],
      // 主题的 tokens.css 要以 ?raw 读原文算覆盖率；vitest 默认把 CSS 全替换成空串
      css: { include: [/themes\/[^/]+\/tokens\.css/] },
    },
  }
})
