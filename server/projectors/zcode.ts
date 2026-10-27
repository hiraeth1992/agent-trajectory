import type {
  JsonObject,
  RecordKind,
  RecordStatus,
  TokenUsage,
  TrajectoryProjection,
  TrajectoryRecord,
} from '../../src/types'
import {
  projectedSourceEventIds,
  projectionCoverage,
} from '../../src/projection-coverage'
import {
  asFiniteNumber as number,
  asJsonObject as object,
  asString as string,
  compactText,
  parseStructured,
  projectedRecord,
  redactSensitive,
} from '../../src/projector-utils'
import { recordTimeBounds } from './projection-rollup'

export interface ZcodeSessionRow {
  id: string
  directory: string
  title: string
  version: string
  time_created: number
  time_updated: number
  last_outcome?: string | null
  parent_id?: string | null
  trace_id?: string | null
}

export interface ZcodeMessageRow {
  id: string
  sequence: number | null
  time_created: number
  time_updated: number
  data: JsonObject
}

export interface ZcodePartRow {
  id: string
  message_id: string
  sequence: number | null
  time_created: number
  time_updated: number
  data: JsonObject
}

export interface ZcodeModelUsageRow {
  id: string
  turn_id: string | null
  assistant_message_id: string | null
  status: string
  provider_id: string
  model_id: string
  started_at: number
  first_token_at: number | null
  completed_at: number | null
  duration_ms: number | null
  time_to_first_token_ms: number | null
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  computed_total_tokens: number
  retry_count: number
  error_type: string | null
  error_code: string | null
  error_message: string | null
  logical_request_id?: string | null
  attempt_index?: number | null
  trace_id?: string | null
  span_id?: string | null
  query_source?: string | null
}

export interface ZcodeToolUsageRow {
  id: string
  turn_id: string | null
  tool_call_id: string
  tool_name: string
  status: string
  started_at: number
  first_output_at: number | null
  completed_at: number | null
  duration_ms: number | null
  time_to_first_output_ms: number | null
  exit_code: number | null
  output_bytes: number
  truncated: number
  retry_count: number
  error_type: string | null
  error_code: string | null
  error_message: string | null
  trace_id?: string | null
  side_effect_scope?: string | null
  read_only?: number | null
  destructive?: number | null
  approval_status?: string | null
}

export interface ZcodeTurnUsageRow {
  turn_id: string
  user_message_id: string | null
  status: string
  started_at: number
  completed_at: number | null
  duration_ms: number | null
  time_to_first_token_ms: number | null
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  computed_total_tokens: number
  error_type: string | null
  error_code: string | null
  trace_id?: string | null
  model_request_count?: number | null
  model_retry_count?: number | null
  tool_call_count?: number | null
  tool_error_count?: number | null
}

export interface ZcodeTargetRow {
  target_id: string
  objective: string
  status: string
  token_budget: number | null
  tokens_used: number
  time_used_seconds: number
  time_updated: number
}

export interface ZcodeTodoRow {
  content: string
  status: string
  priority: string
  position: number
  time_updated: number
}

export interface ZcodeFeatureSupport {
  trace: boolean
  lineage: boolean
  policy: boolean
  tasks: boolean
}

export interface ZcodeProjectionInput {
  session: ZcodeSessionRow
  messages: readonly ZcodeMessageRow[]
  parts: readonly ZcodePartRow[]
  modelUsage: readonly ZcodeModelUsageRow[]
  toolUsage: readonly ZcodeToolUsageRow[]
  turnUsage: readonly ZcodeTurnUsageRow[]
  target?: ZcodeTargetRow
  todos?: readonly ZcodeTodoRow[]
}

const KNOWN_PART_TYPES = new Set([
  'reasoning',
  'step-finish',
  'step-start',
  'text',
  'timeline',
  'tool',
])

function usageFrom(row: ZcodeModelUsageRow | ZcodeTurnUsageRow): TokenUsage {
  return {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_input_tokens,
    cacheWriteTokens: row.cache_creation_input_tokens,
    reasoningTokens: row.reasoning_tokens,
    totalTokens: row.computed_total_tokens,
  }
}

function recordStatus(status: string | undefined): RecordStatus {
  if (status === 'completed') return 'complete'
  if (status === 'error' || status === 'failed') return 'error'
  if (status === 'cancelled') return 'interrupted'
  return 'running'
}

function messageStatus(
  finish: unknown,
  startTime: number,
  endTime: number,
): RecordStatus {
  const value = string(finish)
  if (value === 'completed' || value === 'stop' || value === 'tool-calls') {
    return 'complete'
  }
  if (value === 'error' || value === 'failed') return 'error'
  if (value === 'cancelled' || value === 'interrupted') return 'interrupted'
  return endTime > startTime ? 'complete' : 'running'
}

function searchable(
  record: Omit<TrajectoryRecord, 'searchText' | 'source'>,
): TrajectoryRecord {
  return projectedRecord('zcode', record)
}

function visibleUserMessage(data: JsonObject): boolean {
  const semantics = object(data.semantics)
  return data.synthetic !== true
    && data.visibility !== 'model-only'
    && semantics.transcriptVisibility !== 'hidden'
}

function textBlocks(parts: readonly ZcodePartRow[]): Array<{ type: 'text' | 'reasoning'; text: string }> {
  return parts.flatMap((part) => {
    const type = string(part.data.type)
    const text = string(part.data.text)
    return (type === 'text' || type === 'reasoning') && text !== undefined
      ? [{ type, text }]
      : []
  })
}

function safeMessageRaw(message: ZcodeMessageRow): unknown {
  return redactSensitive({
    id: message.id,
    sequence: message.sequence,
    timeCreated: message.time_created,
    timeUpdated: message.time_updated,
    data: {
      role: message.data.role,
      parentID: message.data.parentID,
      providerId: message.data.providerId,
      modelId: message.data.modelId,
      source: message.data.source,
      synthetic: message.data.synthetic,
      visibility: message.data.visibility,
      semantics: message.data.semantics,
      finish: message.data.finish,
    },
  })
}

function safePartRaw(part: ZcodePartRow): unknown {
  const data = part.data.type === 'tool'
    ? {
        ...part.data,
        state: {
          ...object(part.data.state),
          input: parseStructured(object(part.data.state).input),
          output: parseStructured(object(part.data.state).output),
        },
      }
    : part.data
  return redactSensitive({
    id: part.id,
    messageId: part.message_id,
    sequence: part.sequence,
    timeCreated: part.time_created,
    timeUpdated: part.time_updated,
    data,
  })
}

export function projectZcodeTrajectory(input: ZcodeProjectionInput): TrajectoryProjection {
  const partsByMessage = new Map<string, ZcodePartRow[]>()
  for (const part of input.parts) {
    const grouped = partsByMessage.get(part.message_id) ?? []
    grouped.push(part)
    partsByMessage.set(part.message_id, grouped)
  }
  for (const grouped of partsByMessage.values()) {
    grouped.sort((a, b) =>
      (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER)
      || a.time_created - b.time_created
      || a.id.localeCompare(b.id))
  }

  const modelByMessage = new Map(input.modelUsage.flatMap(row =>
    row.assistant_message_id === null ? [] : [[row.assistant_message_id, row] as const]))
  const toolByCall = new Map(input.toolUsage.map(row => [row.tool_call_id, row]))
  const sortedTurns = [...input.turnUsage].sort((a, b) => a.started_at - b.started_at)
  const turnNumberById = new Map(sortedTurns.map((turn, index) => [turn.turn_id, index + 1]))
  const turnNumberByUserMessage = new Map(sortedTurns.flatMap((turn, index) =>
    turn.user_message_id === null ? [] : [[turn.user_message_id, index + 1] as const]))
  const records: TrajectoryRecord[] = []
  const stepByTurn = new Map<number, number>()
  let latestTurn = 0

  const sortedMessages = [...input.messages].sort((a, b) =>
    (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER)
    || a.time_created - b.time_created
    || a.id.localeCompare(b.id))

  for (const message of sortedMessages) {
    const data = message.data
    const role = string(data.role)
    const parts = partsByMessage.get(message.id) ?? []
    const content = textBlocks(parts)
    const combinedText = content.map(block => block.text).join('\n')
    if (role === 'user') {
      const isVisible = visibleUserMessage(data)
      const mappedTurn = turnNumberByUserMessage.get(message.id)
      if (mappedTurn !== undefined) latestTurn = mappedTurn
      const turn = mappedTurn ?? latestTurn
      const source = string(data.source)
      records.push(searchable({
        id: `message:${message.id}`,
        sourceEventIds: [message.id, ...parts.map(part => part.id)],
        fidelity: 'exact',
        seq: 0,
        turn,
        step: 0,
        kind: isVisible ? 'user' : 'context',
        title: isVisible ? '用户消息' : source ?? '运行时上下文',
        summary: compactText(combinedText) || (isVisible ? '空用户消息' : '上下文更新'),
        startTime: number(object(data.time).created) ?? message.time_created,
        endTime: number(object(data.time).completed) ?? message.time_updated,
        status: 'complete',
        depth: 0,
        input: content,
        raw: [safeMessageRaw(message), ...parts.map(safePartRaw)],
      }))
      continue
    }
    if (role !== 'assistant') continue

    const modelUsage = modelByMessage.get(message.id)
    const turn = modelUsage?.turn_id === null || modelUsage?.turn_id === undefined
      ? latestTurn
      : turnNumberById.get(modelUsage.turn_id) ?? latestTurn
    latestTurn = Math.max(latestTurn, turn)
    const step = (stepByTurn.get(turn) ?? 0) + 1
    stepByTurn.set(turn, step)
    const messageTime = object(data.time)
    const startTime = modelUsage?.started_at
      ?? number(messageTime.created)
      ?? message.time_created
    const endTime = modelUsage?.completed_at
      ?? number(messageTime.completed)
      ?? message.time_updated
    const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const reasoning = content.filter(block => block.type === 'reasoning').map(block => block.text).join('\n')
    const toolParts = parts.filter(part => part.data.type === 'tool')
    const status = modelUsage === undefined
      ? messageStatus(data.finish, startTime, endTime)
      : recordStatus(modelUsage.status)
    records.push(searchable({
      id: `message:${message.id}`,
      sourceEventIds: [
        message.id,
        ...parts.filter(part => part.data.type !== 'tool').map(part => part.id),
        ...(modelUsage === undefined ? [] : [modelUsage.id]),
      ],
      fidelity: 'exact',
      seq: 0,
      turn,
      step,
      kind: 'assistant',
      title: toolParts.length > 0 && text === '' ? '模型步骤' : '助手回复',
      summary: compactText(text || reasoning) || `调用 ${toolParts.length} 个工具`,
      startTime,
      endTime: status === 'running' ? null : endTime,
      status,
      depth: 0,
      output: content,
      usage: modelUsage === undefined ? undefined : usageFrom(modelUsage),
      metrics: modelUsage === undefined ? undefined : {
        ttftMs: modelUsage.time_to_first_token_ms ?? undefined,
        decodeMs: modelUsage.first_token_at !== null && modelUsage.completed_at !== null
          ? modelUsage.completed_at - modelUsage.first_token_at
          : undefined,
        throughput: modelUsage.first_token_at !== null
          && modelUsage.completed_at !== null
          && modelUsage.output_tokens > 0
          && modelUsage.completed_at > modelUsage.first_token_at
          ? modelUsage.output_tokens / ((modelUsage.completed_at - modelUsage.first_token_at) / 1000)
          : undefined,
      },
      provider: modelUsage?.provider_id ?? string(data.providerId),
      model: modelUsage?.model_id ?? string(data.modelId),
      traceId: modelUsage?.trace_id ?? undefined,
      spanId: modelUsage?.span_id ?? undefined,
      retry: modelUsage !== undefined && modelUsage.retry_count > 0
        ? { count: modelUsage.retry_count, message: modelUsage.error_message ?? undefined }
        : undefined,
      error: modelUsage !== undefined && status === 'error'
        ? {
            name: modelUsage.error_type ?? undefined,
            code: modelUsage.error_code ?? undefined,
            reason: modelUsage.error_message ?? undefined,
          }
        : undefined,
      raw: [
        safeMessageRaw(message),
        ...parts.filter(part => part.data.type !== 'tool').map(safePartRaw),
        ...(modelUsage === undefined ? [] : [redactSensitive(modelUsage)]),
      ],
    }))

    for (const part of toolParts) {
      const state = object(part.data.state)
      const callId = string(part.data.callID) ?? part.id
      const usage = toolByCall.get(callId)
      const toolStatus = recordStatus(usage?.status ?? string(state.status))
      const stateTime = object(state.time)
      const toolStart = usage?.started_at
        ?? number(stateTime.start)
        ?? part.time_created
      const toolEnd = usage?.completed_at
        ?? number(stateTime.end)
        ?? part.time_updated
      const toolName = string(part.data.tool) ?? usage?.tool_name ?? '工具'
      const toolInput = redactSensitive(parseStructured(state.input))
      const toolOutput = redactSensitive(parseStructured(state.output))
      const hasPolicy = usage !== undefined && [
        usage.side_effect_scope,
        usage.read_only,
        usage.destructive,
        usage.approval_status,
      ].some(value => value !== null && value !== undefined)
      records.push(searchable({
        id: `tool:${part.id}`,
        sourceEventIds: [part.id, ...(usage === undefined ? [] : [usage.id])],
        fidelity: 'exact',
        seq: 0,
        turn,
        step,
        kind: 'tool',
        title: toolName,
        summary: compactText(string(state.title) ?? toolName),
        startTime: toolStart,
        endTime: toolStatus === 'running' ? null : toolEnd,
        status: toolStatus,
        depth: 0,
        callId,
        traceId: usage?.trace_id ?? undefined,
        policy: !hasPolicy || usage === undefined ? undefined : {
          sideEffectScope: usage.side_effect_scope ?? undefined,
          readOnly: usage.read_only === null || usage.read_only === undefined
            ? undefined
            : usage.read_only === 1,
          destructive: usage.destructive === null || usage.destructive === undefined
            ? undefined
            : usage.destructive === 1,
          approvalStatus: usage.approval_status ?? undefined,
        },
        input: toolInput,
        output: toolOutput,
        error: toolStatus === 'error'
          ? {
              name: usage?.error_type ?? undefined,
              code: usage?.error_code ?? undefined,
              reason: usage?.error_message ?? string(state.error),
            }
          : undefined,
        retry: usage !== undefined && usage.retry_count > 0
          ? { count: usage.retry_count, message: usage.error_message ?? undefined }
          : undefined,
        raw: [safePartRaw(part), ...(usage === undefined ? [] : [usage])],
      }))
    }
  }

  const kindPriority: Record<RecordKind, number> = {
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
  records.sort((a, b) =>
    a.startTime - b.startTime
    || kindPriority[a.kind] - kindPriority[b.kind]
    || a.id.localeCompare(b.id))
  records.forEach((record, index) => {
    record.seq = index
  })

  const { startTime, endTime } = recordTimeBounds(
    records,
    input.session.time_created,
    input.session.time_updated,
  )
  const eventTypeCounts: Record<string, number> = {}
  const count = (name: string) => {
    eventTypeCounts[name] = (eventTypeCounts[name] ?? 0) + 1
  }
  input.messages.forEach(message => count(`message/${string(message.data.role) ?? 'unknown'}`))
  input.parts.forEach(part => count(`part/${string(part.data.type) ?? 'unknown'}`))
  input.modelUsage.forEach(usage => count(`model_usage/${usage.status}`))
  input.toolUsage.forEach(usage => count(`tool_usage/${usage.status}`))
  input.turnUsage.forEach(usage => count(`turn_usage/${usage.status}`))
  if (input.target !== undefined) count('session_target')
  ;(input.todos ?? []).forEach(() => count('todo'))
  const unknownEventTypes = [...new Set(input.parts.flatMap((part) => {
    const type = string(part.data.type) ?? 'unknown'
    return KNOWN_PART_TYPES.has(type) ? [] : [type]
  }))].sort()
  const sessionUsage = input.turnUsage.reduce<TokenUsage>((total, turn) => ({
    inputTokens: (total.inputTokens ?? 0) + turn.input_tokens,
    outputTokens: (total.outputTokens ?? 0) + turn.output_tokens,
    cacheReadTokens: (total.cacheReadTokens ?? 0) + turn.cache_read_input_tokens,
    cacheWriteTokens: (total.cacheWriteTokens ?? 0) + turn.cache_creation_input_tokens,
    reasoningTokens: (total.reasoningTokens ?? 0) + turn.reasoning_tokens,
    totalTokens: (total.totalTokens ?? 0) + turn.computed_total_tokens,
  }), {})
  const turnSummaries = sortedTurns.map((turn, index) => {
    const status = recordStatus(turn.status)
    const completedAt = turn.completed_at
      ?? (turn.duration_ms === null ? null : turn.started_at + turn.duration_ms)
    const model = input.modelUsage.find(usage =>
      usage.turn_id === turn.turn_id && usage.model_id !== '')?.model_id
    return {
      id: turn.turn_id,
      number: index + 1,
      startTime: turn.started_at,
      endTime: status === 'running' ? null : completedAt ?? turn.started_at,
      status,
      usage: usageFrom(turn),
      metrics: turn.time_to_first_token_ms === null
        ? undefined
        : { ttftMs: turn.time_to_first_token_ms },
      model,
      traceId: turn.trace_id ?? undefined,
      reliability: [
        turn.model_request_count,
        turn.model_retry_count,
        turn.tool_call_count,
        turn.tool_error_count,
      ].some(value => value !== null && value !== undefined)
        ? {
            modelRequests: turn.model_request_count ?? undefined,
            modelRetries: turn.model_retry_count ?? undefined,
            toolCalls: turn.tool_call_count ?? undefined,
            toolErrors: turn.tool_error_count ?? undefined,
          }
        : undefined,
    }
  })

  const latestModelUsage = [...input.modelUsage]
    .sort((left, right) =>
      right.started_at - left.started_at
      || right.id.localeCompare(left.id))
  const latestModelRecord = latestModelUsage.find(row => row.model_id !== '')
  const latestProviderRecord = latestModelRecord
    ?? latestModelUsage.find(row => row.provider_id !== '')
  const eventCount = input.messages.length
    + input.parts.length
    + input.modelUsage.length
    + input.toolUsage.length
    + input.turnUsage.length
    + (input.target === undefined ? 0 : 1)
    + (input.todos?.length ?? 0)
  const projectedEvents = projectedSourceEventIds(records)
  const coverage = projectionCoverage(eventTypeCounts, eventCount, (type) => {
    if (type === 'message/user' || type === 'message/assistant') {
      return {
        disposition: 'record',
        consumed: input.messages.filter(message =>
          `message/${string(message.data.role) ?? 'unknown'}` === type
          && projectedEvents.has(message.id)).length,
      }
    }
    if (type === 'part/text' || type === 'part/reasoning' || type === 'part/tool') {
      return {
        disposition: 'record',
        consumed: input.parts.filter(part =>
          `part/${string(part.data.type) ?? 'unknown'}` === type
          && projectedEvents.has(part.id)).length,
      }
    }
    if (type.startsWith('model_usage/')) {
      return {
        disposition: 'folded-state',
        consumed: input.modelUsage.filter(usage =>
          `model_usage/${usage.status}` === type
          && projectedEvents.has(usage.id)).length,
      }
    }
    if (type.startsWith('tool_usage/')) {
      return {
        disposition: 'folded-state',
        consumed: input.toolUsage.filter(usage =>
          `tool_usage/${usage.status}` === type
          && projectedEvents.has(usage.id)).length,
      }
    }
    if (type.startsWith('turn_usage/')
      || type === 'session_target' || type === 'todo') {
      return { disposition: 'folded-state' }
    }
    if (type === 'part/step-start' || type === 'part/step-finish'
      || type === 'part/timeline') {
      return {
        disposition: 'raw-only',
        reason: 'timeline metadata is retained for audit but has no visible record',
      }
    }
    return {
      disposition: 'unsupported',
      reason: 'ZCode fact type does not have a semantic projector',
    }
  })
  return {
    header: {
      source: 'zcode',
      format: 'zcode-session-sqlite',
      id: input.session.id,
      createdAt: input.session.time_created,
      cwd: input.session.directory,
      parentSessionId: input.session.parent_id ?? undefined,
      traceId: input.session.trace_id ?? undefined,
      model: latestModelRecord?.model_id,
      provider: latestProviderRecord?.provider_id || undefined,
      rawVersion: input.session.version,
    },
    records,
    turns: turnSummaries,
    lanes: [
      { id: 'input', label: '输入' },
      { id: 'model', label: '模型' },
      { id: 'tools', label: '工具' },
    ],
    startTime,
    endTime,
    eventCount,
    eventTypeCounts,
    unknownEventTypes,
    ...coverage,
    taskState: input.target === undefined && (input.todos?.length ?? 0) === 0
      ? undefined
      : {
          target: input.target === undefined
            ? undefined
            : {
                id: input.target.target_id,
                objective: input.target.objective,
                status: input.target.status,
                tokenBudget: input.target.token_budget ?? undefined,
                tokensUsed: input.target.tokens_used,
                timeUsedSeconds: input.target.time_used_seconds,
                updatedAt: input.target.time_updated,
              },
          todos: (input.todos ?? []).map(todo => ({
            content: todo.content,
            status: todo.status,
            priority: todo.priority,
            position: todo.position,
            updatedAt: todo.time_updated,
          })),
        },
    turnEnds: Object.fromEntries(sortedTurns.flatMap((turn, index) =>
      turn.completed_at === null
        ? []
        : [[index + 1, {
            time: turn.completed_at,
            reason: turn.error_code ?? turn.status,
          }]])),
    usage: Object.values(sessionUsage).some(value => value !== 0) ? sessionUsage : undefined,
  }
}
