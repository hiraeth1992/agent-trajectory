import type {
  RecordKind,
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
  projectedRecord,
  redactSensitive,
} from '../../src/projector-utils'
import {
  recordTimeBounds,
  rollupTurns,
} from './projection-rollup'

export interface ClaudeCodeEnvelope {
  type?: string
  uuid?: string
  parentUuid?: string | null
  sessionId?: string
  timestamp?: string
  cwd?: string
  gitBranch?: string
  version?: string
  isSidechain?: boolean
  message?: unknown
  [key: string]: unknown
}

interface IndexedEnvelope extends ClaudeCodeEnvelope {
  ordinal: number
}

const KNOWN_ROW_TYPES = new Set([
  'assistant',
  'file-history-snapshot',
  'last-prompt',
  'queue-operation',
  'summary',
  'system',
  'user',
])

function timestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value
  }
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function sourceId(row: IndexedEnvelope): string {
  return row.uuid ?? `row:${row.ordinal}`
}

function raw(row: IndexedEnvelope): unknown {
  return redactSensitive(row)
}

function normalizedContent(value: unknown): unknown[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  return array(value).flatMap<unknown>((entry) => {
    if (typeof entry === 'string') return [{ type: 'text', text: entry }]
    const block = object(entry)
    const type = string(block.type)
    if (type === 'text') return [{ type: 'text', text: string(block.text) ?? '' }]
    if (type === 'thinking') {
      return [{ type: 'reasoning', text: string(block.thinking) ?? string(block.text) ?? '' }]
    }
    if (type === 'image') return [{ type: 'image', source: block.source }]
    return []
  })
}

function contentText(value: unknown): string {
  return normalizedContent(value)
    .map(item => string(object(item).text) ?? '')
    .filter(Boolean)
    .join('\n')
}

function usage(value: unknown): TokenUsage | undefined {
  const source = object(value)
  const result: TokenUsage = {
    inputTokens: number(source.input_tokens),
    outputTokens: number(source.output_tokens),
    cacheReadTokens: number(source.cache_read_input_tokens),
    cacheWriteTokens: number(source.cache_creation_input_tokens),
  }
  const present = Object.values(result).some(item => item !== undefined)
  if (!present) return undefined
  result.totalTokens = Object.values(result)
    .filter((item): item is number => item !== undefined)
    .reduce((total, item) => total + item, 0)
  return result
}

function sumUsage(values: readonly (TokenUsage | undefined)[]): TokenUsage | undefined {
  const present = values.filter((value): value is TokenUsage => value !== undefined)
  if (present.length === 0) return undefined
  const keys: Array<keyof TokenUsage> = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'totalTokens',
  ]
  return Object.fromEntries(keys.flatMap((key) => {
    const selected = present.flatMap(value =>
      value[key] === undefined ? [] : [value[key]])
    return selected.length === 0
      ? []
      : [[key, selected.reduce((total, value) => total + value, 0)]]
  })) as TokenUsage
}

function searchable(
  record: Omit<TrajectoryRecord, 'searchText' | 'source'>,
): TrajectoryRecord {
  return projectedRecord('claude', record)
}

function primaryRecordId(row: IndexedEnvelope): string | undefined {
  const message = object(row.message)
  const blocks = array(message.content)
  if (row.type === 'assistant') {
    const visible = normalizedContent(message.content)
    return visible.length > 0
      ? `message:${sourceId(row)}`
      : usage(message.usage) === undefined ? undefined : `model:${sourceId(row)}`
  }
  if (row.type === 'user' && blocks.some(block =>
    string(object(block).type) !== 'tool_result')) {
    return `message:${sourceId(row)}`
  }
  if (row.type === 'user' && typeof message.content === 'string') {
    return `message:${sourceId(row)}`
  }
  return undefined
}

export function projectClaudeCodeTrajectory(
  envelopes: readonly ClaudeCodeEnvelope[],
): TrajectoryProjection {
  const rows: IndexedEnvelope[] = envelopes.map((row, ordinal) => ({
    ...row,
    ordinal,
  }))
  const firstSessionRow = rows.find(row => typeof row.sessionId === 'string')
  const sessionId = firstSessionRow?.sessionId ?? 'unknown'
  const createdAt = rows.map(row => timestamp(row.timestamp))
    .find(value => value > 0) ?? 0
  const records: TrajectoryRecord[] = []
  const relations: TrajectoryRelation[] = []
  const tools = new Map<string, {
    row: IndexedEnvelope
    name: string
    input: unknown
  }>()
  const toolResults = new Map<string, {
    row: IndexedEnvelope
    output: unknown
    isError: boolean
  }>()
  const turns = new Map<number, TrajectoryTurnSummary>()
  const rowTurns = new Map<string, number>()
  let currentTurn = 0

  for (const row of rows) {
    const message = object(row.message)
    const blocks = array(message.content)
    const humanContent = row.type === 'user'
      && (typeof message.content === 'string'
        || blocks.some(block => string(object(block).type) !== 'tool_result'))
    if (humanContent) currentTurn++
    const rowId = sourceId(row)
    rowTurns.set(rowId, currentTurn)
    const rowTime = timestamp(row.timestamp)
    if (currentTurn > 0) {
      const existing = turns.get(currentTurn)
      turns.set(currentTurn, existing === undefined
        ? {
            id: `turn:${currentTurn}`,
            number: currentTurn,
            startTime: rowTime,
            endTime: rowTime,
            status: 'complete',
          }
        : {
            ...existing,
            endTime: Math.max(existing.endTime ?? rowTime, rowTime),
          })
    }
    for (const blockValue of blocks) {
      const block = object(blockValue)
      const type = string(block.type)
      if (type === 'tool_use') {
        const id = string(block.id)
        if (id !== undefined) {
          tools.set(id, {
            row,
            name: string(block.name) ?? '工具',
            input: block.input,
          })
        }
      } else if (type === 'tool_result') {
        const id = string(block.tool_use_id)
        if (id !== undefined) {
          toolResults.set(id, {
            row,
            output: block.content,
            isError: block.is_error === true,
          })
        }
      }
    }
  }

  for (const row of rows) {
    const message = object(row.message)
    const role = string(message.role)
    const visibleContent = normalizedContent(message.content)
    if ((role !== 'user' && role !== 'assistant') || visibleContent.length === 0) continue
    const text = contentText(message.content)
    const recordUsage = role === 'assistant' ? usage(message.usage) : undefined
    records.push(searchable({
      id: `message:${sourceId(row)}`,
      sourceEventIds: [sourceId(row)],
      fidelity: 'exact',
      seq: row.ordinal,
      turn: rowTurns.get(sourceId(row)) ?? 0,
      step: role === 'user' ? 0 : 1,
      kind: role as 'user' | 'assistant',
      title: role === 'user' ? '用户' : '助手',
      summary: compactText(text || (role === 'assistant' ? 'Claude Code 助手消息' : '用户消息')),
      startTime: timestamp(row.timestamp),
      endTime: timestamp(row.timestamp),
      status: row.isApiErrorMessage === true ? 'error' : 'complete',
      depth: row.isSidechain === true ? 1 : 0,
      input: role === 'user' ? visibleContent : undefined,
      output: role === 'assistant' ? visibleContent : undefined,
      usage: recordUsage,
      provider: role === 'assistant' ? 'anthropic' : undefined,
      model: role === 'assistant' ? string(message.model) : undefined,
      error: row.isApiErrorMessage === true
        ? { name: 'ApiError', reason: string(row.error) }
        : undefined,
      raw: [raw(row)],
    }))
  }

  for (const row of rows) {
    if (row.type !== 'assistant') continue
    const message = object(row.message)
    if (normalizedContent(message.content).length > 0) continue
    const recordUsage = usage(message.usage)
    if (recordUsage === undefined) continue
    records.push(searchable({
      id: `model:${sourceId(row)}`,
      sourceEventIds: [sourceId(row)],
      fidelity: 'exact',
      seq: row.ordinal,
      turn: rowTurns.get(sourceId(row)) ?? 0,
      step: 1,
      kind: 'model',
      title: '模型调用',
      summary: 'Claude Code 模型调用',
      startTime: timestamp(row.timestamp),
      endTime: timestamp(row.timestamp),
      status: row.isApiErrorMessage === true ? 'error' : 'complete',
      depth: row.isSidechain === true ? 1 : 0,
      usage: recordUsage,
      provider: 'anthropic',
      model: string(message.model),
      error: row.isApiErrorMessage === true
        ? { name: 'ApiError', reason: string(row.error) }
        : undefined,
      raw: [raw(row)],
    }))
  }

  for (const [callId, call] of tools) {
    const result = toolResults.get(callId)
    const startTime = timestamp(call.row.timestamp)
    const endTime = result === undefined ? null : timestamp(result.row.timestamp)
    records.push(searchable({
      id: `tool:${callId}`,
      sourceEventIds: [
        sourceId(call.row),
        ...(result === undefined ? [] : [sourceId(result.row)]),
      ],
      fidelity: 'exact',
      seq: call.row.ordinal,
      endSeq: result?.row.ordinal,
      turn: rowTurns.get(sourceId(call.row)) ?? 0,
      step: 1,
      kind: 'tool',
      title: call.name,
      summary: compactText(
        `${JSON.stringify(call.input) ?? ''}${
          result === undefined ? '' : ` → ${typeof result.output === 'string'
            ? result.output
            : JSON.stringify(result.output)}`
        }`,
      ),
      startTime,
      endTime,
      status: result === undefined ? 'running' : result.isError ? 'error' : 'complete',
      depth: call.row.isSidechain === true ? 1 : 0,
      callId,
      input: call.input,
      output: result?.output,
      error: result?.isError === true
        ? { name: 'ToolError', reason: typeof result.output === 'string' ? result.output : undefined }
        : undefined,
      raw: [raw(call.row), ...(result === undefined ? [] : [raw(result.row)])],
    }))
  }

  const primaryByUuid = new Map(rows.flatMap(row => {
    const id = primaryRecordId(row)
    return id === undefined || row.uuid === undefined ? [] : [[row.uuid, id] as const]
  }))
  for (const row of rows) {
    if (row.uuid === undefined || row.parentUuid === null || row.parentUuid === undefined) continue
    const from = primaryByUuid.get(row.parentUuid)
    const to = primaryByUuid.get(row.uuid)
    if (from === undefined || to === undefined) continue
    relations.push({
      type: 'parent-span',
      from,
      to,
      fidelity: 'exact',
      sourceEventIds: [row.parentUuid, row.uuid],
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
  const bounds = recordTimeBounds(records, createdAt)
  const turnSummaries = rollupTurns([...turns.values()], records)
  const eventTypeCounts: Record<string, number> = {}
  for (const row of rows) {
    const type = row.type ?? 'unknown'
    eventTypeCounts[type] = (eventTypeCounts[type] ?? 0) + 1
  }
  const latestAssistant = [...rows].reverse().find(row =>
    row.type === 'assistant' && typeof object(row.message).model === 'string')
  const latestVersion = [...rows].reverse().find(row =>
    typeof row.version === 'string')?.version
  const latestCwd = [...rows].reverse().find(row =>
    typeof row.cwd === 'string')?.cwd
  const projectedEvents = projectedSourceEventIds(records)
  const coverage = projectionCoverage(eventTypeCounts, rows.length, (type) => {
    if (type === 'user' || type === 'assistant') {
      return {
        disposition: 'record',
        consumed: rows.filter(row =>
          (row.type ?? 'unknown') === type
          && projectedEvents.has(sourceId(row))).length,
      }
    }
    if (KNOWN_ROW_TYPES.has(type)) {
      return {
        disposition: 'raw-only',
        reason: 'source metadata is retained for audit but does not form a trajectory fact',
      }
    }
    return {
      disposition: 'unsupported',
      reason: 'row type is not supported by the Claude Code projector',
    }
  })
  return {
    header: {
      source: 'claude',
      format: 'claude-code-jsonl',
      id: sessionId,
      createdAt,
      cwd: latestCwd,
      model: string(object(latestAssistant?.message).model),
      provider: 'anthropic',
      rawVersion: latestVersion,
    },
    records,
    turns: turnSummaries,
    lanes: [
      { id: 'input', label: '输入' },
      { id: 'model', label: '模型' },
      { id: 'tools', label: '工具' },
    ],
    startTime: bounds.startTime,
    endTime: bounds.endTime,
    eventCount: rows.length,
    eventTypeCounts,
    unknownEventTypes: [...new Set(rows.flatMap(row =>
      row.type === undefined || !KNOWN_ROW_TYPES.has(row.type)
        ? [row.type ?? 'unknown']
        : []))].sort(),
    ...coverage,
    relations,
    turnEnds: Object.fromEntries(turnSummaries.flatMap(turn =>
      turn.endTime === null ? [] : [[turn.number, {
        time: turn.endTime,
        reason: turn.status,
      }]])),
    usage: sumUsage(rows.map(row => usage(object(row.message).usage))),
  }
}
