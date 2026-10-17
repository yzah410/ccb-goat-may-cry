import './styles/tailwind.css'
import { themesReady } from './themes/registry'

/**
 * 启动顺序：
 * 1. 先等主题注册表建好（每个主题单独动态加载、各自隔离：坏一个主题只跳过它，不会整站白屏）；
 * 2. 再加载并挂载整个应用（app/mount.tsx）。应用里所有代码拿到的 THEMES / BASE_THEME 都是建好的。
 * 只有 base 主题本身坏了（或应用代码加载失败）才会走到下面的「网站没能启动」。
 */
const root = document.getElementById('root')!

themesReady
  .then(() => import('./app/mount'))
  .then((m) => m.mountApp(root))
  .catch((e: unknown) => showBootError(root, e))

/** 应用都没挂上时的兜底提示：纯 DOM，不依赖 React 和主题系统 */
function showBootError(el: HTMLElement, e: unknown): void {
  console.error(e)
  const msg = e instanceof Error ? e.message : String(e)
  const box = document.createElement('div')
  box.setAttribute('role', 'alert')
  box.style.cssText =
    'max-width:640px;margin:15vh auto;padding:24px;border:1px solid var(--border);border-radius:12px;background:var(--surface-1);color:var(--text-1);font:14px/1.6 system-ui,sans-serif'
  const title = document.createElement('h1')
  title.textContent = '网站没能启动'
  title.style.cssText = 'margin:0 0 8px;font-size:20px'
  const hint = document.createElement('p')
  hint.textContent = '下面是出错原因。修好对应的文件后刷新页面；开发时终端和浏览器控制台里有完整报错。'
  hint.style.cssText = 'margin:0 0 12px;color:var(--text-2)'
  const detail = document.createElement('pre')
  detail.textContent = msg
  detail.style.cssText = 'margin:0;white-space:pre-wrap;font:12px/1.5 ui-monospace,Consolas,monospace;color:var(--danger-fg)'
  box.append(title, hint, detail)
  el.replaceChildren(box)
}
