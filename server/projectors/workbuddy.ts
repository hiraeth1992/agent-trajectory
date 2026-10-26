import type {
  JsonObject,
  RecordKind,
  RecordStatus,
  TokenUsage,
  TrajectoryProjection,
  TrajectoryRecord,
  TrajectoryRelation,
  TrajectoryTurnSummary,
} from '../../src/types'
import {
  projectedSourceEventIds,
  projectionCoverage,
} from '../../src/projection-coverage'
import {
  asArray as array,
  asFiniteNumber as number,
  asJsonObject as object,
  asString as string,
  compactText,
  parseStructured,
  projectedRecord,
  redactSensitive,
} from '../../src/projector-utils'

export interface WorkBuddySessionRow {
  id: string
  cwd: string
  title: string | null
  customTitle: string | null
  status: string
  createdAt: number
  updatedAt: number
  lastActivityAt: number
  model: string | null
  permissionMode: string | null
  mode: string | null
}

export interface WorkBuddyRow {
  type?: string
  id?: string
  parentId?: string
  sessionId?: string
  timestamp?: number | string
  cwd?: string
  role?: string
  content?: unknown
  providerData?: unknown
  callId?: string
  name?: string
  arguments?: unknown
  output?: unknown
  status?: string
  [key: string]: unknown
}

export interface WorkBuddyProjectionInput {
  session: WorkBuddySessionRow
  rows: WorkBuddyRow[]
}

interface IndexedRow extends WorkBuddyRow {
  ordinal: number
}

const KNOWN_ROW_TYPES = new Set([
  'ai-title',
  'file-history-snapshot',
  'function_call',
  'function_call_result',
  'message',
  'reasoning',
  'session-meta',
])

function timestamp(value: unknown): number {
  const numeric = number(value)
  if (numeric !== undefined) return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizedContent(
  value: unknown,
  fallbackType: 'text' | 'reasoning' = 'text',
): unknown[] {
  if (typeof value === 'string') return [{ type: fallbackType, text: value }]
  return array(value).flatMap<unknown>((entry) => {
    if (typeof entry === 'string') return [{ type: fallbackType, text: entry }]
    const block = object(entry)
    const text = string(block.text)
      ?? string(block.input_text)
      ?? string(block.output_text)
    if (text !== undefined) {
      return [{
        type: fallbackType === 'reasoning' ? 'reasoning' : 'text',
        text,
      }]
    }
    if (string(block.type) === 'image') {
      return [{ type: 'image', source: block.source }]
    }
    return []
  })
}

function contentText(
  value: unknown,
  fallbackType: 'text' | 'reasoning' = 'text',
): string {
  return normalizedContent(value, fallbackType)
    .map(item => string(object(item).text) ?? '')
    .filter(Boolean)
    .join('\n')
}

function tokenUsage(value: unknown, rawValue: unknown): TokenUsage | undefined {
  const source = object(value)
  const raw = object(rawValue)
  const result: TokenUsage = {
    inputTokens: number(source.inputTokens) ?? number(raw.prompt_tokens),
    outputTokens: number(source.outputTokens) ?? number(raw.completion_tokens),
    cacheReadTokens: number(raw.cache_read_input_tokens)
      ?? number(raw.cached_tokens)
      ?? number(raw.prompt_cache_hit_tokens),
    cacheWriteTokens: number(raw.cache_creation_input_tokens)
      ?? number(raw.prompt_cache_write_tokens),
    reasoningTokens: number(raw.completion_thinking_tokens)
      ?? number(object(raw.completion_tokens_details).reasoning_tokens),
    totalTokens: number(source.totalTokens) ?? number(raw.total_tokens),
  }
  if (!Object.values(result).some(item => item !== undefined)) return undefined
  if (result.totalTokens === undefined) {
    result.totalTokens = (result.inputTokens ?? 0)
      + (result.outputTokens ?? 0)
      + (result.reasoningTokens ?? 0)
  }
  return result
}

function sumUsage(values: readonly TokenUsage[]): TokenUsage | undefined {
  if (values.length === 0) return undefined
  const keys: Array<keyof TokenUsage> = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'totalTokens',
  ]
  return Object.fromEntries(keys.flatMap((key) => {
    const selected = values.flatMap(value =>
      value[key] === undefined ? [] : [value[key]])
    return selected.length === 0
      ? []
      : [[key, selected.reduce((total, value) => total + value, 0)]]
  })) as TokenUsage
}

function recordStatus(value: unknown, fallback: RecordStatus): RecordStatus {
  const normalized = string(value)?.toLowerCase()
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'success') {
    return 'complete'
  }
  if (normalized === 'failed' || normalized === 'error') return 'error'
  if (normalized === 'interrupted' || normalized === 'cancelled') return 'interrupted'
  if (normalized === 'pending' || normalized === 'running' || normalized === 'started') {
    return 'running'
  }
  return fallback
}

function provider(row: IndexedRow): JsonObject {
  return object(row.providerData)
}

function sourceId(row: IndexedRow): string {
  return row.id ?? `${row.type ?? 'row'}:${row.ordinal}`
}

function safeRaw(row: IndexedRow): unknown {
  return redactSensitive(row)
}

function searchable(
  record: Omit<TrajectoryRecord, 'searchText' | 'source'>,
): TrajectoryRecord {
  return projectedRecord('workbuddy', record)
}

function primaryRecordId(row: IndexedRow): string | undefined {
  if (row.type === 'message' && row.id !== undefined) return `message:${row.id}`
  if (row.type === 'reasoning' && row.id !== undefined) return `reasoning:${row.id}`
  if (row.type === 'function_call' && row.callId !== undefined) return `tool:${row.callId}`
  return undefined
}

function rowUsage(row: IndexedRow): TokenUsage | undefined {
  const metadata = provider(row)
  return tokenUsage(metadata.usage, metadata.rawUsage)
}

export function projectWorkBuddyTrajectory(
  input: WorkBuddyProjectionInput,
): TrajectoryProjection {
  const rows: IndexedRow[] = input.rows.map((row, ordinal) => ({ ...row, ordinal }))
  const records: TrajectoryRecord[] = []
  const relations: TrajectoryRelation[] = []
  const turns = new Map<number, TrajectoryTurnSummary>()
  const rowTurns = new Map<number, number>()
  const results = new Map<string, IndexedRow>()
  let currentTurn = 0

  for (const row of rows) {
    if (row.type === 'message' && row.role === 'user') currentTurn++
    rowTurns.set(row.ordinal, currentTurn)
    if (row.type === 'function_call_result' && row.callId !== undefined) {
      results.set(row.callId, row)
    }
    if (currentTurn === 0) continue
    const time = timestamp(row.timestamp)
    const existing = turns.get(currentTurn)
    turns.set(currentTurn, existing === undefined
      ? {
          id: `turn:${currentTurn}`,
          number: currentTurn,
          startTime: time,
          endTime: time,
          status: 'complete',
        }
      : {
          ...existing,
          endTime: Math.max(existing.endTime ?? time, time),
        })
  }

  for (const row of rows) {
    const turn = rowTurns.get(row.ordinal) ?? 0
    const time = timestamp(row.timestamp)
    const metadata = provider(row)
    const traceId = string(metadata.traceId)
    const model = string(metadata.model)
      ?? string(metadata.requestModelId)
      ?? input.session.model
      ?? undefined
    if (row.type === 'message'
      && (row.role === 'user' || row.role === 'assistant')) {
      const content = normalizedContent(row.content)
      if (content.length === 0) continue
      const usage = row.role === 'assistant' ? rowUsage(row) : undefined
      records.push(searchable({
        id: `message:${sourceId(row)}`,
        sourceEventIds: [sourceId(row)],
        fidelity: 'exact',
        seq: row.ordinal,
        turn,
        step: row.role === 'user' ? 0 : number(metadata.stepSeq) ?? 1,
        kind: row.role,
        title: row.role === 'user' ? '用户' : '助手',
        summary: compactText(contentText(row.content)),
        startTime: time,
        endTime: time,
        status: recordStatus(row.status, 'complete'),
        depth: 0,
        traceId,
        input: row.role === 'user' ? content : undefined,
        output: row.role === 'assistant' ? content : undefined,
        usage,
        model: row.role === 'assistant' ? model : undefined,
        raw: [safeRaw(row)],
      }))
      const turnState = turns.get(turn)
      if (turnState !== undefined && row.role === 'assistant') {
        turns.set(turn, {
          ...turnState,
          usage: usage ?? turnState.usage,
          model: model ?? turnState.model,
          traceId: traceId ?? turnState.traceId,
          status: recordStatus(row.status, turnState.status),
        })
      }
      continue
    }
    if (row.type === 'reasoning') {
      const content = normalizedContent(row.content, 'reasoning')
      if (content.length === 0) continue
      records.push(searchable({
        id: `reasoning:${sourceId(row)}`,
        sourceEventIds: [sourceId(row)],
        fidelity: 'exact',
        seq: row.ordinal,
        turn,
        step: number(metadata.stepSeq) ?? 1,
        kind: 'model',
        title: '推理',
        summary: compactText(contentText(row.content, 'reasoning')),
        startTime: time,
        endTime: time,
        status: 'complete',
        depth: 0,
        traceId,
        output: content,
        model,
        raw: [safeRaw(row)],
      }))
      continue
    }
    if (row.type === 'function_call' && row.callId !== undefined) {
      const result = results.get(row.callId)
      const status = result === undefined
        ? 'running'
        : recordStatus(result.status, 'complete')
      const output = result?.output
      records.push(searchable({
        id: `tool:${row.callId}`,
        sourceEventIds: [
          sourceId(row),
          ...(result === undefined ? [] : [sourceId(result)]),
        ],
        fidelity: 'exact',
        seq: row.ordinal,
        endSeq: result?.ordinal,
        turn,
        step: number(metadata.stepSeq) ?? 1,
        kind: 'tool',
        title: row.name ?? result?.name ?? '工具',
        summary: compactText(
          `${typeof row.arguments === 'string'
            ? row.arguments
            : JSON.stringify(row.arguments) ?? ''}${
            result === undefined ? '' : ` → ${JSON.stringify(output) ?? ''}`
          }`,
        ),
        startTime: time,
        endTime: result === undefined ? null : timestamp(result.timestamp),
        status,
        depth: 0,
        traceId,
        callId: row.callId,
        input: parseStructured(row.arguments),
        output,
        error: status === 'error'
          ? { name: 'ToolError', reason: contentText(output) || undefined }
          : undefined,
        model,
        raw: [
          safeRaw(row),
          ...(result === undefined ? [] : [safeRaw(result)]),
        ],
      }))
    }
  }

  const recordByRowId = new Map<string, string>()
  for (const row of rows) {
    const recordId = primaryRecordId(row)
    if (recordId !== undefined && row.id !== undefined) recordByRowId.set(row.id, recordId)
    if (row.type === 'function_call_result'
      && row.id !== undefined
      && row.callId !== undefined) {
      recordByRowId.set(row.id, `tool:${row.callId}`)
    }
  }
  for (const row of rows) {
    if (row.parentId === undefined) continue
    const from = recordByRowId.get(row.parentId)
    const to = primaryRecordId(row)
    if (from === undefined || to === undefined || from === to) continue
    relations.push({
      type: 'parent-span',
      from,
      to,
      fidelity: 'exact',
      sourceEventIds: [row.parentId, sourceId(row)],
    })
  }

  const priority: Record<RecordKind, number> = {
    system: 0,
    user: 1,
    steering: 1,
    context: 1,
    assistant: 2,
    model: 2,
    tool: 3,
    subtool: 3,
    compaction: 4,
  }
  records.sort((left, right) =>
    left.seq - right.seq
    || priority[left.kind] - priority[right.kind]
    || left.id.localeCompare(right.id))
  const eventTypeCounts: Record<string, number> = {}
  for (const row of rows) {
    const type = row.type ?? 'unknown'
    eventTypeCounts[type] = (eventTypeCounts[type] ?? 0) + 1
  }
  const times = records.flatMap(record => [
    record.startTime,
    ...(record.endTime === null ? [] : [record.endTime]),
  ]).filter(value => value > 0)
  const requestUsage = new Map<string, TokenUsage>()
  for (const row of rows) {
    const usage = rowUsage(row)
    if (usage === undefined) continue
    const metadata = provider(row)
    requestUsage.set(
      string(metadata.conversationRequestId) ?? `row:${row.ordinal}`,
      usage,
    )
  }
  const latestMetadata = [...rows].reverse()
    .map(row => provider(row))
    .find(value => Object.keys(value).length > 0) ?? {}
  const traceId = string(latestMetadata.traceId)
    ?? rows.map(row => string(provider(row).traceId)).find(Boolean)
  const model = string(latestMetadata.model)
    ?? string(latestMetadata.requestModelId)
    ?? input.session.model
    ?? undefined
  const startTime = times.length === 0 ? input.session.createdAt : Math.min(...times)
  const endTime = times.length === 0 ? input.session.updatedAt : Math.max(...times)
  const projectedEvents = projectedSourceEventIds(records)
  const coverage = projectionCoverage(eventTypeCounts, rows.length, (type) => {
    if (type === 'message' || type === 'reasoning'
      || type === 'function_call' || type === 'function_call_result') {
      return {
        disposition: 'record',
        consumed: rows.filter(row =>
          (row.type ?? 'unknown') === type
          && projectedEvents.has(sourceId(row))).length,
      }
    }
    if (type === 'session-meta') return { disposition: 'folded-state' }
    if (KNOWN_ROW_TYPES.has(type)) {
      return {
        disposition: 'raw-only',
        reason: 'source metadata is retained for audit but has no semantic projector',
      }
    }
    return {
      disposition: 'unsupported',
      reason: 'row type is not supported by the WorkBuddy projector',
    }
  })
  return {
    header: {
      source: 'workbuddy',
      format: 'workbuddy-session-jsonl',
      id: input.session.id,
      createdAt: input.session.createdAt,
      cwd: input.session.cwd,
      traceId,
      model,
    },
    records,
    turns: [...turns.values()],
    lanes: [
      { id: 'input', label: '输入' },
      { id: 'model', label: '模型' },
      { id: 'tools', label: '工具' },
    ],
    startTime,
    endTime,
    eventCount: rows.length,
    eventTypeCounts,
    unknownEventTypes: [...new Set(rows.flatMap(row =>
      row.type === undefined || !KNOWN_ROW_TYPES.has(row.type)
        ? [row.type ?? 'unknown']
        : []))].sort(),
    ...coverage,
    relations,
    turnEnds: Object.fromEntries([...turns.values()].flatMap(turn =>
      turn.endTime === null ? [] : [[turn.number, {
        time: turn.endTime,
        reason: turn.status,
      }]])),
    usage: sumUsage([...requestUsage.values()]),
  }
}
