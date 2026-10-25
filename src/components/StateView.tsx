import type { ReactNode } from 'react'

export type StateViewTone = 'neutral' | 'danger'

export function StateView({
  icon,
  title,
  description,
  children,
  action,
  tone = 'neutral',
  compact = false,
  className = '',
}: {
  icon?: ReactNode
  title?: ReactNode
  description?: ReactNode
  children?: ReactNode
  action?: ReactNode
  tone?: StateViewTone
  compact?: boolean
  className?: string
}) {
  return (
    <section
      className={[
        'state-view',
        `state-view-${tone}`,
        compact ? 'state-view-compact' : '',
        className,
      ].filter(Boolean).join(' ')}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      {icon !== undefined && <div className="state-view-icon">{icon}</div>}
      <div className="state-view-copy">
        {title !== undefined && <strong>{title}</strong>}
        {description !== undefined && <span>{description}</span>}
        {children}
      </div>
      {action !== undefined && <div className="state-view-action">{action}</div>}
    </section>
  )
}
