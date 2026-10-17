import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'motion/react'
import { ThemeProvider } from '@/themes/ThemeProvider'
import { TooltipProvider } from '@/components/ui/Overlay'
import { Toaster } from '@/components/ui/Toast'
import { ConfirmHost } from '@/components/ui/Confirm'
import { ClickerTaskWatcher } from '@/features/clicker/hooks'
import { usePrefs } from '@/features/settings/store'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 30_000 },
    mutations: { retry: 0 },
  },
})

export function AppProviders({ children }: { children: ReactNode }) {
  const motionPref = usePrefs((s) => s.motionPref)
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MotionConfig reducedMotion={motionPref === 'reduce' ? 'always' : motionPref === 'full' ? 'never' : 'user'}>
          <TooltipProvider delayDuration={350} skipDelayDuration={200}>
            {children}
            <Toaster />
            <ConfirmHost />
            <ClickerTaskWatcher />
          </TooltipProvider>
        </MotionConfig>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
