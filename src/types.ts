export type JsonObject = Record<string, unknown>

export type SourceId = 'dsh' | 'codex' | 'zcode'

export type SourceAvailability = 'available' | 'degraded' | 'blocked'

export type SourceColorToken = 'blue' | 'green' | 'amber'

export type SourceIconToken = 'agent' | 'code' | 'terminal'

export type SourceCapability =
  | 'messages'
  | 'tools'
  | 'nestedTools'
  | 'timing'
  | 'usage'
  | 'live'
  | 'attachments'
  | 'trace'
  | 'lineage'
  | 'policy'
  | 'tasks'

export type SourceCapabilities = Record<SourceCapability, boolean>

export interface SourceProtocolDiagnostic {
  detected: string
  supported: string[]
  fingerprint: string
}

export interface SourceStatus {
  source: SourceId
  availability: SourceAvailability
  label: string
  colorToken: SourceColorToken
  iconToken: SourceIconToken
  version?: string
  sessionCount: number
  sessionCountState?: 'pending' | 'ready'
  capabilities: SourceCapabilities
  reason?: string
  detail?: string
  protocol?: SourceProtocolDiagnostic
}

export interface SessionHeader {
  type: 'session'
  version: number
  id: string
  createdAt: number | string
  cwd: string
  isSeeded?: boolean
  parentSession?: string
  origin?: 'subagent'
  delegationDepth?: number
  agentPreset?: string
}

export interface SessionEvent {
  type: string
  seq: number
  time: number
  data: JsonObject
  surfaceOp?: 'append' | {
    op: 'replace'
    startSeq: number
    endSeq: number
  }
  sourceEventSeqs?: number[]
  ignorable?: true
}

export interface TrajectorySessionHeader {
  source: SourceId
  format: string
  id: string
  createdAt: number | string
  cwd?: string
  parentSessionId?: string
  origin?: 'subagent'
  delegationDepth?: number
  traceId?: string
  model?: string
  provider?: string
  rawVersion?: number | string
}

export type RecordKind =
  | 'system'
  | 'user'
  | 'steering'
  | 'context'
  | 'assistant'
  | 'model'
  | 'tool'
  | 'subtool'
  | 'compaction'

export type RecordStatus = 'complete' | 'running' | 'error' | 'interrupted'

export type SurfacePlacement = 'current' | 'shadowed' | 'log-only'

export type TrajectoryRelationType =
  | 'parent-span'
  | 'replaces'
  | 'derived-from'
  | 'approved-by'
  | 'spawned'
  | 'mirrors'

export interface TrajectoryRelation {
  type: TrajectoryRelationType
  from: string
  to: string
  fidelity: 'exact' | 'derived'
  sourceEventIds: string[]
}

export type EventDisposition =
  | 'record'
  | 'folded-state'
  | 'relation-only'
  | 'raw-only'
  | 'unsupported'

export interface ProjectionCoverage {
  type: string
  total: number
  consumed: number
  disposition: EventDisposition
  reason?: string
}

export interface ProjectionCoverageSummary {
  total: number
  consumed: number
  gap: number
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

export interface TrajectoryMetrics {
  ttftMs?: number
  decodeMs?: number
  throughput?: number
}

export interface TrajectoryRecord {
  id: string
  source: SourceId
  sourceEventIds: string[]
  fidelity: 'exact' | 'derived'
  seq: number
  endSeq?: number
  turn: number
  step: number
  kind: RecordKind
  title: string
  summary: string
  startTime: number
  endTime: number | null
  status: RecordStatus
  depth: number
  surface?: SurfacePlacement
  traceId?: string
  spanId?: string
  parentSpanId?: string
  childSessionId?: string
  callId?: string
  parentCallId?: string
  input?: unknown
  output?: unknown
  error?: {
    name?: string
    code?: string
    reason?: string
  }
  usage?: TokenUsage
  metrics?: TrajectoryMetrics
  provider?: string
  model?: string
  policy?: {
    sideEffectScope?: string
    readOnly?: boolean
    destructive?: boolean
    approvalStatus?: string
  }
  retry?: {
    count: number
    maxRetries?: number
    delayMs?: number
    message?: string
    code?: string
  }
  raw?: unknown[]
  searchText: string
}

export interface TimelineLane {
  id: 'input' | 'model' | 'tools'
  label: string
}

export interface TrajectoryTurnSummary {
  id: string
  number: number
  startTime: number
  endTime: number | null
  status: RecordStatus
  reason?: unknown
  usage?: TokenUsage
  metrics?: TrajectoryMetrics
  model?: string
  traceId?: string
  reliability?: {
    modelRequests?: number
    modelRetries?: number
    toolCalls?: number
    toolErrors?: number
  }
}

export interface TrajectoryTaskState {
  target?: {
    id: string
    revision?: number
    objective: string
    status: string
    maxRounds?: number
    roundsStarted?: number
    tokenBudget?: number
    tokensUsed?: number
    timeUsedSeconds?: number
    updatedAt: number
  }
  todos: Array<{
    content: string
    status: string
    priority?: string
    position: number
    updatedAt?: number
  }>
}

export interface ModelContextRecordOverride {
  input?: unknown
  output?: unknown
  summary: string
}

export interface TrajectoryProjection {
  header: TrajectorySessionHeader
  records: TrajectoryRecord[]
  turns: TrajectoryTurnSummary[]
  lanes: TimelineLane[]
  startTime: number
  endTime: number
  eventCount: number
  eventTypeCounts: Record<string, number>
  unknownEventTypes: string[]
  transcriptRecordIds?: string[]
  modelContextRecordIds?: string[]
  modelContextRecordOverrides?: Record<string, ModelContextRecordOverride>
  relations?: TrajectoryRelation[]
  coverage?: ProjectionCoverage[]
  coverageSummary?: ProjectionCoverageSummary
  taskState?: TrajectoryTaskState
  turnEnds: Record<number, {
    time: number
    reason: unknown
  }>
  usage?: TokenUsage
}

export interface SessionSummary {
  id: string
  source: SourceId
  sourceSessionId: string
  format: string
  capabilities: SourceCapabilities
  cwd: string
  title: string
  createdAt: number
  updatedAt: number
  size: number
  rawVersion?: number | string
  eventCount?: number
}

export interface SessionDetail {
  summary: SessionSummary
  projection: TrajectoryProjection
}

export type TransportTrajectoryRecord = Omit<TrajectoryRecord, 'raw' | 'searchText'>

export interface TransportSessionDetail {
  summary: SessionSummary
  projection: Omit<TrajectoryProjection, 'records'> & {
    records: TransportTrajectoryRecord[]
  }
}

export interface SessionDetailSnapshot {
  kind: 'snapshot'
  revision: string
  detail: TransportSessionDetail
}

export interface SessionDetailDelta {
  kind: 'delta'
  baseRevision: string
  revision: string
  summary: SessionSummary
  projection: Omit<TrajectoryProjection, 'records'>
  upserts: TransportTrajectoryRecord[]
  removedIds: string[]
  recordOrder: string[]
}

export type SessionDetailResponse = SessionDetailSnapshot | SessionDetailDelta
