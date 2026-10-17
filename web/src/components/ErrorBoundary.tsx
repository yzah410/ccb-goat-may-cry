import { Component, type ErrorInfo, type ReactNode } from 'react'

export interface ErrorBoundaryProps {
  /** 出错后渲染什么；函数形式能拿到错误和「清掉错误重试」 */
  fallback: ReactNode | ((error: Error, reset: () => void) => ReactNode)
  /** 这个值一变就自动清掉错误、重新渲染子树（例如换了主题） */
  resetKey?: unknown
  /** 捕获到错误时调用（写日志用） */
  onError?: (error: Error, info: ErrorInfo) => void
  children?: ReactNode
}

interface State {
  error: Error | null
  key: unknown
}

/**
 * 通用错误边界：子树渲染时抛错 → 显示 fallback，而不是整个 React 树卸载成白屏。
 * 用在三处：应用最外层（AppErrorBoundary）、主题的 slot（坏了退回 base 的实现）、主题的 Backdrop（坏了就不画背景）。
 * 注意：它只接得住「渲染 / 生命周期」里的错误；事件处理函数、异步代码里的错误要自己 try/catch。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { error: null, key: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: State): Partial<State> | null {
    return Object.is(props.resetKey, state.key) ? null : { key: props.resetKey, error: null }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info)
  }

  private reset = (): void => this.setState({ error: null })

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    const f = this.props.fallback
    return typeof f === 'function' ? f(error, this.reset) : f
  }
}
