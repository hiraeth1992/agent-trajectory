import type { ReactNode } from 'react'
import { type AppWorkspace, WorkspaceNav } from './WorkspaceNav'

export function AppHeader({
  workspace,
  onWorkspaceChange,
  context,
  actions,
}: {
  workspace: AppWorkspace
  onWorkspaceChange: (value: AppWorkspace) => void
  context?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className={`app-header${context === undefined ? '' : ' with-context'}`}>
      <WorkspaceNav value={workspace} onChange={onWorkspaceChange} />
      {context !== undefined && (
        <div className="app-header-context">{context}</div>
      )}
      {actions !== undefined && (
        <div className="app-header-actions">{actions}</div>
      )}
    </header>
  )
}
