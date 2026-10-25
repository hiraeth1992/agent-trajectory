import {
  Activity,
  Code2,
  Layers3,
  SquareTerminal,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useState } from 'react'
import type { SourceIconToken, SourceId } from '../types'

const FALLBACK_ICONS: Record<SourceIconToken, LucideIcon> = {
  agent: Activity,
  code: Code2,
  terminal: SquareTerminal,
}

export function SourceIcon({
  source,
  iconToken,
  size = 16,
}: {
  source?: SourceId
  iconToken?: SourceIconToken
  size?: number
}) {
  const [nativeUnavailable, setNativeUnavailable] = useState(false)
  if (source !== undefined && source !== 'codex' && !nativeUnavailable) {
    return (
      <img
        className="source-app-icon"
        src={`/api/sources/${source}/icon`}
        alt=""
        width={size}
        height={size}
        onError={() => setNativeUnavailable(true)}
      />
    )
  }
  const Icon = iconToken === undefined
    ? Layers3
    : FALLBACK_ICONS[iconToken]
  return <Icon className="source-fallback-icon" size={size} aria-hidden="true" />
}
