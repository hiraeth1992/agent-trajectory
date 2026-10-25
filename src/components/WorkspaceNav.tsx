import { Activity, FlaskConical } from 'lucide-react'

export type AppWorkspace = 'sessions' | 'evaluation'

export function WorkspaceNav({
  value,
  onChange,
}: {
  value: AppWorkspace
  onChange: (value: AppWorkspace) => void
}) {
  return (
    <div className="workspace-brand-nav">
      <div className="brand">
        <span>Agent Trajectory</span>
      </div>
      <nav className="workspace-tabs" aria-label="顶层工作区">
        <button
          type="button"
          className={value === 'sessions' ? 'active' : ''}
          aria-current={value === 'sessions' ? 'page' : undefined}
          onClick={() => onChange('sessions')}
        >
          <Activity size={15} />
          <span>会话分析</span>
        </button>
        <button
          type="button"
          className={value === 'evaluation' ? 'active' : ''}
          aria-current={value === 'evaluation' ? 'page' : undefined}
          onClick={() => onChange('evaluation')}
        >
          <FlaskConical size={15} />
          <span>评测中心</span>
        </button>
      </nav>
    </div>
  )
}
