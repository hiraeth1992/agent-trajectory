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
  claude: { label: 'Claude Code', colorToken: 'amber', iconToken: 'code' },
  'doubao-work': { label: '豆包工作', colorToken: 'blue', iconToken: 'agent' },
  workbuddy: { label: 'WorkBuddy', colorToken: 'green', iconToken: 'agent' },
  qoder: { label: 'Qoder', colorToken: 'amber', iconToken: 'code' },
  opencode: { label: 'OpenCode', colorToken: 'green', iconToken: 'terminal' },
}

const SOURCE_APPLICATION_ICONS: Partial<
  Record<SourceId, Partial<Record<NodeJS.Platform, string[]>>>
> = {
  dsh: {
    darwin: [
      '/Applications/DeepSeek Harness.app/Contents/Resources/icon.png',
      '/Applications/DeepSeek Harness.app/Contents/Resources/icon.icns',
    ],
  },
  codex: {
    darwin: [
      '/Applications/Codex.app/Contents/Resources/AppIcon.icns',
      '/Applications/Codex.app/Contents/Resources/icon.icns',
    ],
  },
  claude: {
    darwin: [
      '/Applications/Claude.app/Contents/Resources/electron.icns',
      '/Applications/Claude.app/Contents/Resources/icon.icns',
      '/Applications/Claude Code.app/Contents/Resources/icon.icns',
    ],
  },
  'doubao-work': {
    darwin: ['/Applications/DoubaoWork.app/Contents/Resources/app.icns'],
  },
  workbuddy: {
    darwin: [
      '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/renderer/assets/workbuddy-app-icon-BRLoOH8-.svg',
      '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/resources/icon.png',
      '/Applications/WorkBuddy.app/Contents/Resources/icon.icns',
    ],
  },
  qoder: {
    darwin: [
      '/Applications/Qoder CN.app/Contents/Resources/icon.icns',
      '/Applications/Qoder.app/Contents/Resources/icon.icns',
    ],
  },
  opencode: {
    darwin: [
      '/Applications/OpenCode.app/Contents/Resources/icon.icns',
      '/Applications/opencode.app/Contents/Resources/icon.icns',
    ],
  },
  zcode: {
    darwin: [
      '/Applications/ZCode.app/Contents/Resources/icon.png',
      '/Applications/ZCode.app/Contents/Resources/icon.icns',
    ],
  },
}

export interface SourceSessionRef {
  source: SourceId
  sourceSessionId: string
  locator: string
  locators?: readonly string[]
  summary: SessionSummary
}

export interface SourceListFailure {
  locator: string
  reason: string
}

export interface SourceListDiagnostics {
  scanned: number
  loaded: number
  failed: number
  failures: SourceListFailure[]
}

export interface SourceListResult {
  refs: readonly SourceSessionRef[]
  diagnostics: SourceListDiagnostics
}

export interface SourceAuditBundle {
  completeness: 'complete' | 'partial'
  events: readonly unknown[]
  reconstruction?: unknown
  omitted?: string[]
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
  listDetailed?(): Promise<SourceListResult>
  load(ref: SourceSessionRef): Promise<SessionDetail>
  audit(ref: SourceSessionRef): Promise<SourceAuditBundle>
  fingerprint(ref: SourceSessionRef): Promise<string>
  metrics?(): unknown
  close?(): Promise<void>
}

export function completeAudit(
  events: readonly unknown[],
  reconstruction: unknown,
): SourceAuditBundle {
  return {
    completeness: 'complete',
    events,
    reconstruction,
  }
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
