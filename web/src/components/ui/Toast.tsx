/**
 * 轻提示（右下角，自动消失，可滑走）。所有异步操作的结果都用它反馈，不要用 alert()。
 *
 *   toast.success('已保存', { description: '方案「plan1」' })
 *   toast.error('保存失败', { description: errorText(e) })
 *   toast.info('已加载', { action: { label: '去工作台', onClick: () => navigate('/') } })
 */
import { create } from 'zustand'
import { Toast as T } from 'radix-ui'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { IconAlert, IconCircleCheck, IconCircleX, IconInfo, IconX } from '@/lib/icons'

export type ToastTone = 'success' | 'error' | 'info' | 'warning'

export interface ToastOptions {
  description?: ReactNode
  action?: { label: string; onClick: () => void }
  /** 毫秒；默认成功/信息 3.5 秒，警告 5 秒，错误 7 秒 */
  duration?: number
  /** 同 id 的提示会被替换（避免连点刷屏） */
  id?: string
}

interface ToastItem extends ToastOptions {
  id: string
  tone: ToastTone
  title: ReactNode
  open: boolean
}

interface ToastStore {
  items: ToastItem[]
  push: (t: Omit<ToastItem, 'open'>) => void
  close: (id: string) => void
  remove: (id: string) => void
}

const useToastStore = create<ToastStore>((set) => ({
  items: [],
  push: (t) =>
    set((s) => ({
      items: [...s.items.filter((x) => x.id !== t.id), { ...t, open: true }].slice(-5),
    })),
  close: (id) => set((s) => ({ items: s.items.map((x) => (x.id === id ? { ...x, open: false } : x)) })),
  remove: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}))

let seq = 0
function show(tone: ToastTone, title: ReactNode, opts: ToastOptions = {}): string {
  const id = opts.id ?? `t${Date.now()}-${seq++}`
  const duration = opts.duration ?? (tone === 'error' ? 7000 : tone === 'warning' ? 5000 : 3500)
  useToastStore.getState().push({ ...opts, id, tone, title, duration })
  return id
}

export const toast = {
  success: (title: ReactNode, opts?: ToastOptions) => show('success', title, opts),
  error: (title: ReactNode, opts?: ToastOptions) => show('error', title, opts),
  info: (title: ReactNode, opts?: ToastOptions) => show('info', title, opts),
  warning: (title: ReactNode, opts?: ToastOptions) => show('warning', title, opts),
  dismiss: (id: string) => useToastStore.getState().close(id),
}

const TONE_ICON = {
  success: <IconCircleCheck className="size-5 text-success" aria-hidden />,
  error: <IconCircleX className="size-5 text-danger" aria-hidden />,
  info: <IconInfo className="size-5 text-info" aria-hidden />,
  warning: <IconAlert className="size-5 text-warning" aria-hidden />,
}

export function Toaster() {
  const items = useToastStore((s) => s.items)
  const close = useToastStore((s) => s.close)
  const remove = useToastStore((s) => s.remove)
  return (
    <T.Provider swipeDirection="right" label="通知">
      {items.map((t) => (
        <T.Root
          key={t.id}
          open={t.open}
          duration={t.duration}
          type={t.tone === 'error' ? 'foreground' : 'background'}
          onOpenChange={(o) => {
            if (!o) {
              close(t.id)
              window.setTimeout(() => remove(t.id), 220)
            }
          }}
          className={cn(
            'pointer-events-auto relative flex w-full items-start gap-3 rounded-lg border border-border bg-surface-1 p-3 pr-9 text-fg-1 shadow-3',
            'data-[state=open]:animate-[toast-in_var(--motion-duration)_var(--motion-ease)]',
            'data-[state=closed]:animate-[toast-out_180ms_ease-in_forwards]',
            'data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=cancel]:translate-x-0 data-[swipe=end]:animate-[toast-out_150ms_ease-out_forwards]',
          )}
          data-tone={t.tone}
        >
          <span className="mt-0.5">{TONE_ICON[t.tone]}</span>
          <div className="min-w-0 flex-1">
            <T.Title className="text-base font-medium leading-snug text-fg-1">{t.title}</T.Title>
            {t.description && (
              <T.Description className="mt-0.5 break-words text-sm text-fg-2">{t.description}</T.Description>
            )}
            {t.action && (
              <T.Action
                altText={t.action.label}
                onClick={t.action.onClick}
                className="mt-2 inline-flex h-7 items-center rounded-md bg-primary-100 px-2.5 text-sm font-medium text-primary-800 transition-colors hover:bg-primary-200"
              >
                {t.action.label}
              </T.Action>
            )}
          </div>
          <T.Close
            aria-label="关闭提示"
            className="absolute right-2 top-2 grid size-6 place-items-center rounded-sm text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg-1"
          >
            <IconX className="size-3.5" />
          </T.Close>
        </T.Root>
      ))}
      <T.Viewport className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[380px] max-w-[calc(100vw-32px)] flex-col gap-2 outline-none" />
    </T.Provider>
  )
}
