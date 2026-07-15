import { Component, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'

interface Props {
  moduleId: string
  children: ReactNode
}

interface State {
  error: Error | null
}

/** One crashing module must not take down the shell or the other modules. */
export default class ModuleBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prev: Props): void {
    if (prev.moduleId !== this.props.moduleId && this.state.error) {
      this.setState({ error: null })
    }
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
          <TriangleAlert size={40} className="text-danger" />
          <div className="text-lg font-semibold">
            Module “{this.props.moduleId}” crashed
          </div>
          <pre className="max-w-xl overflow-auto rounded-lg bg-raised p-4 text-left text-xs text-muted">
            {this.state.error.message}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
          >
            Reload module
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
