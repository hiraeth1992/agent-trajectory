import type {
  SessionDetail,
  SessionSummary,
  SourceCapabilities,
  SourceCapability,
  SourceColorToken,
  SourceIconToken,
  SourceId,
  SourceStatus,
} from '../../src/types'

export interface SourceMetadata {
  label: string
  colorToken: SourceColorToken
  iconToken: SourceIconToken
}

const SOURCE_METADATA: Record<SourceId, SourceMetadata> = {
  dsh: { label: 'DSH', colorToken: 'blue', iconToken: 'agent' },
  codex: { label: 'Codex', colorToken: 'green', iconToken: 'code' },
  zcode: { label: 'ZCode', colorToken: 'amber', iconToken: 'terminal' },
}

const SOURCE_APPLICATION_ICONS: Partial<
  Record<SourceId, Partial<Record<NodeJS.Platform, string[]>>>
> = {
  dsh: {
    darwin: ['/Applications/DeepSeek Harness.app/Contents/Resources/icon.png'],
  },
  zcode: {
    darwin: ['/Applications/ZCode.app/Contents/Resources/icon.png'],
  },
}

export interface SourceSessionRef {
  source: SourceId
  sourceSessionId: string
  locator: string
  locators?: readonly string[]
  summary: SessionSummary
}

export class SessionFormatError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'session_migration_required'
      | 'session_protocol_unsupported'
      | 'session_corrupt',
  ) {
    super(message)
    this.name = 'SessionFormatError'
  }
}

export interface SessionSource {
  readonly id: SourceId
  probe(): Promise<SourceStatus>
  list(): Promise<readonly SourceSessionRef[]>
  load(ref: SourceSessionRef): Promise<SessionDetail>
  audit(ref: SourceSessionRef): Promise<readonly unknown[]>
  fingerprint(ref: SourceSessionRef): Promise<string>
  metrics?(): unknown
  close?(): Promise<void>
}

export function sessionKey(source: SourceId, sourceSessionId: string): string {
  return `${source}:${sourceSessionId}`
}

export function sourceMetadata(source: SourceId): SourceMetadata {
  return SOURCE_METADATA[source]
}

export function sourceApplicationIcons(
  source: SourceId,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [...(SOURCE_APPLICATION_ICONS[source]?.[platform] ?? [])]
}

export function capabilities(...enabled: SourceCapability[]): SourceCapabilities {
  const selected = new Set(enabled)
  return {
    messages: selected.has('messages'),
    tools: selected.has('tools'),
    nestedTools: selected.has('nestedTools'),
    timing: selected.has('timing'),
    usage: selected.has('usage'),
    live: selected.has('live'),
    attachments: selected.has('attachments'),
    trace: selected.has('trace'),
    lineage: selected.has('lineage'),
    policy: selected.has('policy'),
    tasks: selected.has('tasks'),
  }
}
