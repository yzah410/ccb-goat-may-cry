/**
 * 二次确认：const ok = await confirm({ title: '删除方案「x」？', tone: 'danger', confirmLabel: '删除' })
 * 替代浏览器自带的 window.confirm()（不阻塞页面、跟主题走、Esc 取消、Enter 确认）。
 */
import { create } from 'zustand'
import { AlertDialog as A } from 'radix-ui'
import type { ReactNode } from 'react'
import { buttonVariants } from './Button'
import { cn } from '@/lib/cn'

export interface ConfirmOptions {
  title: ReactNode
  description?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'primary'
}

interface ConfirmStore {
  current: (ConfirmOptions & { resolve: (v: boolean) => void }) | null
  open: (o: ConfirmOptions) => Promise<boolean>
  settle: (v: boolean) => void
}

const useConfirmStore = create<ConfirmStore>((set, get) => ({
  current: null,
  open: (o) =>
    new Promise<boolean>((resolve) => {
      get().current?.resolve(false)
      set({ current: { ...o, resolve } })
    }),
  settle: (v) => {
    get().current?.resolve(v)
    set({ current: null })
  },
}))

export function confirm(o: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().open(o)
}

export function ConfirmHost() {
  const cur = useConfirmStore((s) => s.current)
  const settle = useConfirmStore((s) => s.settle)
  return (
    <A.Root open={!!cur} onOpenChange={(o) => !o && settle(false)}>
      <A.Portal>
        <A.Overlay className="fixed inset-0 z-[90] bg-overlay data-[state=open]:animate-[fade-in_var(--motion-duration)_var(--motion-ease)]" />
        <A.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[90] w-[calc(100%-32px)] max-w-md -translate-x-1/2 -translate-y-1/2',
            'rounded-xl border border-border bg-surface-1 p-6 text-fg-1 shadow-3 outline-none',
            'data-[state=open]:animate-[dialog-in_var(--motion-duration)_var(--motion-ease)]',
          )}
        >
          <A.Title className="text-lg text-fg-1">{cur?.title}</A.Title>
          {cur?.description ? (
            <A.Description className="mt-2 text-base text-fg-2">{cur.description}</A.Description>
          ) : (
            <A.Description className="sr-only">请确认</A.Description>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <A.Cancel className={buttonVariants({ variant: 'secondary' })}>{cur?.cancelLabel ?? '取消'}</A.Cancel>
            <A.Action
              className={buttonVariants({ variant: cur?.tone === 'danger' ? 'danger' : 'primary' })}
              onClick={() => settle(true)}
            >
              {cur?.confirmLabel ?? '确定'}
            </A.Action>
          </div>
        </A.Content>
      </A.Portal>
    </A.Root>
  )
}
