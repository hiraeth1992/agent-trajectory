import {
  Activity,
  Code2,
  Layers3,
  SquareTerminal,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SourceIconToken, SourceId } from '../types'

const FALLBACK_ICONS: Record<SourceIconToken, LucideIcon> = {
  agent: Activity,
  code: Code2,
  terminal: SquareTerminal,
}

function SourceBrandIcon({
  source,
  size,
}: {
  source: SourceId
  size: number
}) {
  const labels: Record<SourceId, string> = {
    dsh: 'D',
    codex: '',
    zcode: 'Z',
    claude: '',
    'doubao-work': '豆',
    workbuddy: 'W',
    qoder: 'Q',
    opencode: 'OC',
  }
  return (
    <svg
      className={`source-brand-icon source-brand-${source}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <rect width="24" height="24" rx="5" />
      {source === 'claude'
        ? (
            <g className="source-brand-mark" strokeWidth="2.2">
              <path d="M12 4v16M4 12h16M6.3 6.3l11.4 11.4M17.7 6.3 6.3 17.7" />
            </g>
          )
        : source === 'codex'
          ? (
              <g className="source-brand-mark" fill="none" strokeWidth="1.7">
                <path d="M12 5.1 16 7.4v4.7L12 14.4 8 12.1V7.4Z" />
                <path d="m8 7.4-3 1.8v5.2l4.5 2.5 4-2.3" />
                <path d="m16 7.4 3 1.8v5.2l-4.5 2.5-4-2.3" />
              </g>
            )
          : (
              <text
                x="12"
                y="12.5"
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {labels[source]}
              </text>
            )}
    </svg>
  )
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
  useEffect(() => setNativeUnavailable(false), [source])
  if (source !== undefined && !nativeUnavailable) {
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
  if (source !== undefined) return <SourceBrandIcon source={source} size={size} />
  const Icon = iconToken === undefined
    ? Layers3
    : FALLBACK_ICONS[iconToken]
  return <Icon className="source-fallback-icon" size={size} aria-hidden="true" />
}
