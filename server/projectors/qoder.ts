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
import { recordTimeBounds, rollupTurns } from './projection-rollup'

export interface QoderEnvelope {
  type?: string
  uuid?: string
  parentUuid?: string | null
  sessionId?: string
  session_id?: string
  agentId?: string
  parent_tool_use_id?: string
  timestamp?: number | string
  cwd?: string
  version?: string
  model?: string
  isSidechain?: boolean
  message?: unknown
  toolUseResult?: unknown
  [key: string]: unknown
}

export interface QoderSubagentMeta {
  agentType?: string
  description?: string
  invocationName?: string
  toolUseId?: string
}

export interface QoderSubagentInput {
  id: string
  meta?: QoderSubagentMeta
  rows: QoderEnvelope[]
}

export interface QoderProjectionInput {
  sessionId: string
  main: QoderEnvelope[]
  subagents: QoderSubagentInput[]
}

interface IndexedRow extends QoderEnvelope {
  namespace: string
  ordinal: number
  streamOrdinal: number
}

interface ToolCall {
  block: Record<string, unknown>
  row: IndexedRow
}

interface ToolResult {
  block: Record<string, unknown>
  row: IndexedRow
}

const KNOWN_ROW_TYPES = new Set([
  'active-leaf',
  'assistant',
  'attachment',
  'last-prompt',
  'runtime-config',
  'user',
  'workspace-directories',
])

function timestamp(value: unknown): number {
  const numeric = number(value)
  if (numeric !== undefined) return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function sourceId(row: IndexedRow): string {
  return row.uuid ?? `${row.type ?? 'row'}:${row.streamOrdinal}`
}

function recordId(row: IndexedRow, suffix: string): string {
  return `${row.namespace}:${suffix}`
}

function normalizedText(value: unknown): unknown[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  return array(value).flatMap<unknown>((entry) => {
    if (typeof entry === 'string') return [{ type: 'text', text: entry }]
    const block = object(entry)
    if (string(block.type) !== 'text') return []
    return [{ type: 'text', text: string(block.text) ?? '' }]
  })
}

function text(value: unknown): string {
  return normalizedText(value)
    .map(entry => string(object(entry).text) ?? '')
    .filter(Boolean)
    .join('\n')
}

function rowUsage(row: IndexedRow): TokenUsage | undefined {
  const usage = object(object(row.message).usage)
  const result: TokenUsage = {
    inputTokens: number(usage.input_tokens),
    outputTokens: number(usage.output_tokens),
    cacheReadTokens: number(usage.cache_read_input_tokens),
    cacheWriteTokens: number(usage.cache_creation_input_tokens),
    reasoningTokens: number(usage.reasoning_tokens),
  }
  if (!Object.values(result).some(value => value !== undefined)) return undefined
  result.totalTokens = (result.inputTokens ?? 0)
    + (result.outputTokens ?? 0)
    + (result.cacheReadTokens ?? 0)
    + (result.cacheWriteTokens ?? 0)
    + (result.reasoningTokens ?? 0)
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
  return projectedRecord('qoder', record)
}

function safeRaw(row: IndexedRow): unknown {
  const { namespace: _namespace, ordinal: _ordinal, streamOrdinal: _streamOrdinal, ...raw } = row
  return redactSensitive(raw)
}

function primaryRecord(
  row: IndexedRow,
  reasoning: readonly TrajectoryRecord[],
  tools: readonly TrajectoryRecord[],
): string | undefined {
  const message = object(row.message)
  const role = string(message.role)
  if (role === 'user') {
    const content = message.content
    const hasHumanContent = typeof content === 'string'
      || array(content).some(value => string(object(value).type) !== 'tool_result')
    if (hasHumanContent) return recordId(row, `message:${sourceId(row)}`)
  }
  if (role === 'assistant' && normalizedText(message.content).length > 0) {
    return recordId(row, `message:${sourceId(row)}`)
  }
  return reasoning.find(record => record.sourceEventIds.includes(sourceId(row)))?.id
    ?? tools.find(record => record.sourceEventIds.includes(sourceId(row)))?.id
}

export function projectQoderTrajectory(
  input: QoderProjectionInput,
): TrajectoryProjection {
  const subagentById = new Map(input.subagents.map(agent => [agent.id, agent]))
  const subagentByTool = new Map(input.subagents.flatMap(agent => {
    const toolUseId = agent.meta?.toolUseId
      ?? agent.rows.map(row => row.parent_tool_use_id).find(Boolean)
    return toolUseId === undefined ? [] : [[toolUseId, agent] as const]
  }))
  let ordinal = 0
  const main = input.main.map((row, streamOrdinal): IndexedRow => ({
    ...row,
    namespace: 'main',
    ordinal: ordinal++,
    streamOrdinal,
  }))
  const subagents = input.subagents.flatMap(agent =>
    agent.rows.map((row, streamOrdinal): IndexedRow => ({
      ...row,
      namespace: agent.id,
      ordinal: ordinal++,
      streamOrdinal,
    })))
  const rows = [...main, ...subagents]
  const records: TrajectoryRecord[] = []
  const relations: TrajectoryRelation[] = []
  const tools = new Map<string, ToolCall>()
  const results = new Map<string, ToolResult>()
  const turns = new Map<number, TrajectoryTurnSummary>()
  const rowTurns = new Map<IndexedRow, number>()
  const toolTurns = new Map<string, number>()
  let currentTurn = 0

  for (const row of main) {
    const message = object(row.message)
    const content = message.content
    const humanInput = row.type === 'user'
      && (typeof content === 'string'
        || array(content).some(value => string(object(value).type) !== 'tool_result'))
    if (humanInput) currentTurn++
    rowTurns.set(row, currentTurn)
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
        : { ...existing, endTime: Math.max(existing.endTime ?? rowTime, rowTime) })
    }
    for (const value of array(message.content)) {
      const block = object(value)
      const type = string(block.type)
      const callId = type === 'tool_use' ? string(block.id) : undefined
      const resultId = type === 'tool_result' ? string(block.tool_use_id) : undefined
      if (callId !== undefined) {
        tools.set(callId, { block, row })
        toolTurns.set(callId, currentTurn)
      }
      if (resultId !== undefined) results.set(resultId, { block, row })
    }
  }

  for (const row of subagents) {
    const parentCallId = row.parent_tool_use_id
      ?? subagentById.get(row.namespace)?.meta?.toolUseId
    const turn = parentCallId === undefined ? 0 : toolTurns.get(parentCallId) ?? 0
    rowTurns.set(row, turn)
    const message = object(row.message)
    for (const value of array(message.content)) {
      const block = object(value)
      const type = string(block.type)
      const callId = type === 'tool_use' ? string(block.id) : undefined
      const resultId = type === 'tool_result' ? string(block.tool_use_id) : undefined
      if (callId !== undefined) tools.set(callId, { block, row })
      if (resultId !== undefined) results.set(resultId, { block, row })
    }
    const turnState = turns.get(turn)
    const rowTime = timestamp(row.timestamp)
    if (turnState !== undefined) {
      turns.set(turn, {
        ...turnState,
        endTime: Math.max(turnState.endTime ?? rowTime, rowTime),
      })
    }
  }

  const reasoningRecords: TrajectoryRecord[] = []
  for (const row of rows) {
    const message = object(row.message)
    const role = string(message.role)
    const depth = row.namespace === 'main' ? 0 : 1
    const parentCallId = depth === 0
      ? undefined
      : row.parent_tool_use_id ?? subagentById.get(row.namespace)?.meta?.toolUseId
    const turn = rowTurns.get(row) ?? 0
    const rowTime = timestamp(row.timestamp)
    const visible = normalizedText(message.content)
    if ((role === 'user' || role === 'assistant') && visible.length > 0) {
      const usage = role === 'assistant' ? rowUsage(row) : undefined
      records.push(searchable({
        id: recordId(row, `message:${sourceId(row)}`),
        sourceEventIds: [sourceId(row)],
        fidelity: 'exact',
        seq: row.ordinal,
        turn,
        step: role === 'user' ? 0 : 1,
        kind: role,
        title: role === 'user' ? '用户' : '助手',
        summary: compactText(text(message.content)),
        startTime: rowTime,
        endTime: rowTime,
        status: row.isApiErrorMessage === true ? 'error' : 'complete',
        depth,
        parentCallId,
        input: role === 'user' ? visible : undefined,
        output: role === 'assistant' ? visible : undefined,
        usage,
        model: role === 'assistant' ? string(message.model) : undefined,
        raw: [safeRaw(row)],
      }))
    }
    array(message.content).forEach((value, blockIndex) => {
      const block = object(value)
      if (string(block.type) !== 'thinking') return
      const thinking = string(block.thinking) ?? string(block.text) ?? ''
      const reasoning = searchable({
        id: recordId(row, `reasoning:${sourceId(row)}:${blockIndex}`),
        sourceEventIds: [sourceId(row)],
        fidelity: 'exact',
        seq: row.ordinal,
        turn,
        step: 1,
        kind: 'model',
        title: '推理',
        summary: compactText(thinking),
        startTime: rowTime,
        endTime: rowTime,
        status: 'complete',
        depth,
        parentCallId,
        output: [{ type: 'reasoning', text: thinking }],
        model: string(message.model),
        raw: [safeRaw(row)],
      })
      reasoningRecords.push(reasoning)
      records.push(reasoning)
    })
  }

  const toolRecords: TrajectoryRecord[] = []
  for (const [callId, call] of tools) {
    const result = results.get(callId)
    const subagent = subagentByTool.get(callId)
    const depth = call.row.namespace === 'main' ? 0 : 1
    const parentCallId = depth === 0
      ? undefined
      : call.row.parent_tool_use_id
        ?? subagentById.get(call.row.namespace)?.meta?.toolUseId
    const output = result?.block.content ?? result?.row.toolUseResult
    const isError = result?.block.is_error === true
    const tool = searchable({
      id: recordId(call.row, `tool:${callId}`),
      sourceEventIds: [
        sourceId(call.row),
        ...(result === undefined ? [] : [sourceId(result.row)]),
      ],
      fidelity: 'exact',
      seq: call.row.ordinal,
      endSeq: result?.row.ordinal,
      turn: rowTurns.get(call.row) ?? 0,
      step: 1,
      kind: depth === 0 ? 'tool' : 'subtool',
      title: string(call.block.name) ?? '工具',
      summary: compactText(
        `${JSON.stringify(call.block.input) ?? ''}${
          result === undefined ? '' : ` → ${
            typeof output === 'string' ? output : JSON.stringify(output) ?? ''
          }`
        }`,
      ),
      startTime: timestamp(call.row.timestamp),
      endTime: result === undefined ? null : timestamp(result.row.timestamp),
      status: result === undefined ? 'running' : isError ? 'error' : 'complete',
      depth,
      callId,
      parentCallId,
      childSessionId: subagent?.id,
      input: call.block.input,
      output,
      error: isError
        ? {
            name: 'ToolError',
            reason: typeof output === 'string' ? output : undefined,
          }
        : undefined,
      model: string(object(call.row.message).model),
      raw: [
        safeRaw(call.row),
        ...(result === undefined ? [] : [safeRaw(result.row)]),
      ],
    })
    toolRecords.push(tool)
    records.push(tool)
  }

  const primaryByRow = new Map<IndexedRow, string>()
  for (const row of rows) {
    const primary = primaryRecord(row, reasoningRecords, toolRecords)
    if (primary !== undefined) primaryByRow.set(row, primary)
  }
  const rowByUuid = new Map(rows.flatMap(row =>
    row.uuid === undefined
      ? []
      : [[`${row.namespace}:${row.uuid}`, row] as const]))
  for (const row of rows) {
    if (row.parentUuid === undefined || row.parentUuid === null) continue
    const parent = rowByUuid.get(`${row.namespace}:${row.parentUuid}`)
    const from = parent === undefined ? undefined : primaryByRow.get(parent)
    const to = primaryByRow.get(row)
    if (from === undefined || to === undefined || from === to) continue
    relations.push({
      type: 'parent-span',
      from,
      to,
      fidelity: 'exact',
      sourceEventIds: [row.parentUuid, sourceId(row)],
    })
  }
  for (const [toolUseId, agent] of subagentByTool) {
    const tool = toolRecords.find(record => record.callId === toolUseId)
    const first = rows.find(row => row.namespace === agent.id && primaryByRow.has(row))
    const target = first === undefined ? undefined : primaryByRow.get(first)
    if (tool === undefined || first === undefined || target === undefined) continue
    relations.push({
      type: 'spawned',
      from: tool.id,
      to: target,
      fidelity: 'exact',
      sourceEventIds: [toolUseId, sourceId(first)],
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
  const createdAt = input.main.map(row => timestamp(row.timestamp))
    .find(value => value > 0) ?? 0
  const bounds = recordTimeBounds(records, createdAt)
  const turnSummaries = rollupTurns([...turns.values()], records)
  const latestCwd = [...rows].reverse().find(row => typeof row.cwd === 'string')?.cwd
  const latestVersion = [...input.main].reverse()
    .find(row => typeof row.version === 'string')?.version
  const runtime = [...input.main].reverse().find(row => row.type === 'runtime-config')
  const latestAssistant = [...rows].reverse().find(row =>
    typeof object(row.message).model === 'string')
  const usage = sumUsage(rows.map(row => rowUsage(row)))
  for (const turn of turns.values()) {
    const turnRows = rows.filter(row => rowTurns.get(row) === turn.number)
    const turnUsage = sumUsage(turnRows.map(row => rowUsage(row)))
    const model = [...turnRows].reverse()
      .map(row => string(object(row.message).model))
      .find(Boolean)
    turns.set(turn.number, { ...turn, usage: turnUsage, model })
  }
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
    if (type === 'runtime-config' || type === 'workspace-directories') {
      return { disposition: 'folded-state' }
    }
    if (KNOWN_ROW_TYPES.has(type)) {
      return {
        disposition: 'raw-only',
        reason: 'source metadata is retained for audit but has no semantic projector',
      }
    }
    return {
      disposition: 'unsupported',
      reason: 'row type is not supported by the Qoder projector',
    }
  })
  return {
    header: {
      source: 'qoder',
      format: 'qoder-jsonl-v1',
      id: input.sessionId,
      createdAt,
      cwd: latestCwd,
      model: string(object(latestAssistant?.message).model)
        ?? string(runtime?.model),
      rawVersion: latestVersion ?? string(runtime?.version),
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
    usage,
  }
}
