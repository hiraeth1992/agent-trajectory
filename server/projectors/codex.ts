import type {
  JsonObject,
  RecordKind,
  RecordStatus,
  TokenUsage,
  TrajectoryProjection,
  TrajectoryRecord,
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
import { recordTimeBounds } from './projection-rollup'

export interface CodexEnvelope {
  timestamp?: string
  ordinal?: number
  type?: string
  payload?: unknown
  metadata?: unknown
}

interface IndexedEnvelope extends CodexEnvelope {
  fileOrder: number
  ordinal: number
  payload: JsonObject
}

interface TurnState {
  id: string
  number: number
  rootTurnId?: string
  model?: string
  startedAt?: number
  completedAt?: number
  durationMs?: number
  ttftMs?: number
  status: RecordStatus
  reason?: unknown
  usage?: TokenUsage
}

interface ItemTiming {
  envelope: IndexedEnvelope
  item: JsonObject
  startTime?: number
  endTime?: number
}

const KNOWN_TOP_LEVEL_TYPES = new Set([
  'compacted',
  'event_msg',
  'response_item',
  'session_meta',
  'token_usage_record',
  'turn_context',
  'world_state',
])

const RUNTIME_STATE_KEYS = new Set([
  'agents_md', 'apps_instructions', 'collaboration_mode',
  'context_window_guidance', 'environments', 'environments_instructions',
  'git_attribution', 'host_skills', 'managed_developer_instructions',
  'model', 'model_catalog', 'multi_agent_mode', 'permissions',
  'persistent_mode', 'plugins_instructions', 'realtime', 'skills',
])

const THREAD_SETTINGS_KEYS = new Set([
  'model', 'model_provider_id', 'service_tier', 'approval_policy',
  'approvals_reviewer', 'permission_profile', 'active_permission_profile',
  'cwd', 'runtime_workspace_roots', 'reasoning_effort', 'reasoning_summary',
  'personality', 'collaboration_mode', 'disabled_plugin_ids',
])

const COMPACTED_KEYS = new Set([
  'message', 'replacement_history', 'replacement_history_metadata',
  'retained_context', 'window_number', 'first_window_id',
  'previous_window_id', 'window_id', 'compaction_response_id',
  'latest_token_usage_record', 'resume_metadata',
])

const COMPACTION_MATCH_MAX_EVENT_DISTANCE = 8
const COMPACTION_MATCH_MAX_TIME_MS = 1_000

function recognizedConfiguration(value: unknown, keys: ReadonlySet<string>): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const names = Object.keys(value)
  return names.length > 0 && names.every(key => keys.has(key))
}

function recognizedCompactedPayload(payload: JsonObject): boolean {
  const names = Object.keys(payload)
  const windowNumber = number(payload.window_number)
  return names.length > 0
    && names.every(key => COMPACTED_KEYS.has(key))
    && windowNumber !== undefined
    && Number.isInteger(windowNumber)
    && windowNumber > 0
    && string(payload.window_id) !== undefined
    && [
      payload.first_window_id,
      payload.previous_window_id,
      payload.compaction_response_id,
    ].every(value => value === undefined || string(value) !== undefined)
}

function compactedPayload(payload: JsonObject): JsonObject {
  return Object.fromEntries([
    ['type', 'compacted'],
    ['window_number', number(payload.window_number)],
    ['first_window_id', string(payload.first_window_id)],
    ['previous_window_id', string(payload.previous_window_id)],
    ['window_id', string(payload.window_id)],
    ['compaction_response_id', string(payload.compaction_response_id)],
  ].filter((entry): entry is [string, string | number] => entry[1] !== undefined))
}

function timestamp(value: unknown): number | undefined {
  const numeric = number(value)
  if (numeric !== undefined) return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

function milliseconds(value: unknown): number | undefined {
  return number(value)
}

function envelopeTime(envelope: CodexEnvelope): number {
  return timestamp(envelope.timestamp) ?? 0
}

function turnIdFor(envelope: IndexedEnvelope): string | undefined {
  const direct = string(envelope.payload.turn_id)
  if (direct !== undefined) return direct
  const passthrough = object(envelope.payload.internal_chat_message_metadata_passthrough)
  return string(passthrough.turn_id)
    ?? string(object(envelope.payload.turn_attribution).turn_id)
    ?? string(envelope.payload.root_turn_id)
}

function normalizeContent(value: unknown, fallbackType: 'text' | 'reasoning' = 'text'): unknown[] {
  if (typeof value === 'string') return [{ type: fallbackType, text: value }]
  return array(value).flatMap((entry) => {
    if (typeof entry === 'string') return [{ type: fallbackType, text: entry }]
    const item = object(entry)
    const text = string(item.text)
      ?? string(item.input_text)
      ?? string(item.output_text)
      ?? string(item.summary_text)
    if (text !== undefined) {
      const itemType = string(item.type)?.toLowerCase()
      return [{
        type: itemType?.includes('reason') === true ? 'reasoning' : fallbackType,
        text,
      }]
    }
    return []
  })
}

function textFromContent(value: unknown): string {
  return normalizeContent(value)
    .map(entry => string(object(entry).text) ?? '')
    .filter(Boolean)
    .join('\n')
}

function messageClassification(
  role: string | undefined,
  text: string,
): {
  kind: 'system' | 'user' | 'context' | 'assistant'
  title: string
  status?: RecordStatus
} | undefined {
  if (role === 'assistant') return { kind: 'assistant', title: '助手' }
  if (role === 'developer') return { kind: 'context', title: '开发者上下文' }
  if (role === 'system') return { kind: 'system', title: '系统上下文' }
  if (role !== 'user') return undefined
  const tag = text.trimStart().match(/^<([a-z][a-z0-9_-]*)\b/i)?.[1]?.toLowerCase()
  if (tag === 'environment_context') return { kind: 'context', title: '环境上下文' }
  if (tag === 'skill') return { kind: 'context', title: '技能上下文' }
  if (tag === 'turn_aborted') {
    return { kind: 'context', title: '轮次中断', status: 'interrupted' }
  }
  return { kind: 'user', title: '用户' }
}

function parseArguments(value: unknown, encrypted: unknown): unknown {
  if (typeof value === 'string') {
    return parseStructured(value)
  }
  if (value !== undefined && value !== null) return value
  const encryptedValues = array(encrypted)
  return encryptedValues.length > 0 ? { encrypted: true, itemCount: encryptedValues.length } : undefined
}

function tokenUsage(value: unknown): TokenUsage | undefined {
  const usage = object(value)
  const result: TokenUsage = {
    inputTokens: number(usage.input_tokens),
    outputTokens: number(usage.output_tokens),
    cacheReadTokens: number(usage.cached_input_tokens),
    cacheWriteTokens: number(usage.cache_write_input_tokens),
    reasoningTokens: number(usage.reasoning_output_tokens),
    totalTokens: number(usage.total_tokens),
  }
  return Object.values(result).some(item => item !== undefined) ? result : undefined
}

function sumTokenUsage(values: readonly (TokenUsage | undefined)[]): TokenUsage | undefined {
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

function acceptedRaw(envelope: IndexedEnvelope, payload: unknown = envelope.payload): unknown {
  const metadata = object(envelope.metadata)
  return redactSensitive({
    timestamp: envelope.timestamp,
    ordinal: envelope.ordinal,
    sourceEventId: string(metadata.source_event_id),
    originalOrdinal: number(metadata.original_ordinal),
    page: number(metadata.page),
    line: number(metadata.line),
    type: envelope.type,
    payload,
  })
}

function envelopeSourceId(envelope: IndexedEnvelope): string {
  return string(object(envelope.metadata).source_event_id) ?? String(envelope.ordinal)
}

function searchable(
  record: Omit<TrajectoryRecord, 'searchText' | 'source'>,
): TrajectoryRecord {
  return projectedRecord('codex', record)
}

function itemName(item: JsonObject): string {
  const type = string(item.type)
  if (type === 'CommandExecution') return 'exec_command'
  if (type === 'FileChange') return 'apply_patch'
  if (type === 'McpToolCall') {
    return [string(item.server), string(item.tool)].filter(Boolean).join('.') || 'MCP'
  }
  return string(item.name) ?? type ?? '工具'
}

function itemInput(item: JsonObject): unknown {
  const type = string(item.type)
  if (type === 'CommandExecution') {
    return {
      command: item.command,
      cwd: item.cwd,
      parsedCommand: item.parsed_cmd,
    }
  }
  if (type === 'FileChange') return item.changes
  if (type === 'McpToolCall') return item.arguments
  return item.arguments ?? item.input
}

function itemOutput(item: JsonObject): unknown {
  const type = string(item.type)
  if (type === 'CommandExecution') {
    return {
      output: item.aggregated_output,
      exitCode: item.exit_code,
    }
  }
  if (type === 'FileChange') return { stdout: item.stdout, stderr: item.stderr }
  if (type === 'McpToolCall') return item.result
  return item.output ?? item.result
}

function itemIsError(item: JsonObject): boolean {
  const result = object(item.result)
  const status = string(item.status)
  return item.is_error === true
    || result.isError === true
    || (number(item.exit_code) ?? 0) !== 0
    || status === 'failed'
    || status === 'error'
}

function processExitCode(name: string, output: unknown): number | undefined {
  if (name !== 'write_stdin') return undefined
  const match = (typeof output === 'string' ? output : JSON.stringify(output))
    ?.match(/\bProcess exited with code (-?\d+)\b/i)
  if (match === null || match === undefined) return undefined
  const code = Number(match[1])
  return Number.isFinite(code) ? code : undefined
}

function assignLogicalSteps(records: TrajectoryRecord[]): void {
  let activeTurn: number | undefined
  let step = 0
  for (const record of records) {
    if (record.turn !== activeTurn) {
      activeTurn = record.turn
      step = 0
    }
    if (record.kind === 'system'
      || record.kind === 'user'
      || record.kind === 'steering'
      || record.kind === 'context') {
      record.step = 0
      continue
    }
    if (step === 0) step = 1
    record.step = step
    if (record.kind === 'model') step++
  }
}

function contentPayload(payload: JsonObject): JsonObject {
  return {
    type: payload.type,
    id: payload.id,
    role: payload.role,
    content: payload.content,
    summary: payload.summary,
    encrypted_content: payload.encrypted_content,
    internal_chat_message_metadata_passthrough: {
      turn_id: object(payload.internal_chat_message_metadata_passthrough).turn_id,
      create_time: object(payload.internal_chat_message_metadata_passthrough).create_time,
    },
  }
}

function completedContentPayload(item: JsonObject): JsonObject | undefined {
  if (item.type === 'UserMessage' || item.type === 'AgentMessage') {
    const content = normalizeContent(item.content)
    if (content.length === 0) return undefined
    return {
      type: 'message',
      id: item.id,
      role: item.type === 'UserMessage' ? 'user' : 'assistant',
      content,
    }
  }
  if (item.type === 'Reasoning') {
    const summary = normalizeContent(item.summary_text, 'reasoning')
    if (summary.length === 0) return undefined
    return { type: 'reasoning', id: item.id, summary }
  }
  return undefined
}

function completedContentRaw(timing: ItemTiming): unknown {
  return acceptedRaw(timing.envelope, {
    type: 'item_completed',
    turn_id: timing.envelope.payload.turn_id,
    item: {
      type: timing.item.type,
      id: timing.item.id,
      content: timing.item.content,
      summary_text: timing.item.summary_text,
      phase: timing.item.phase,
    },
    started_at_ms: timing.envelope.payload.started_at_ms,
    completed_at_ms: timing.envelope.payload.completed_at_ms,
  })
}

function toolPayload(payload: JsonObject): JsonObject {
  return {
    type: payload.type,
    id: payload.id,
    name: payload.name,
    status: payload.status,
    call_id: payload.call_id,
    arguments: payload.arguments,
    input: payload.input,
    encrypted_function_args: payload.encrypted_function_args,
    output: payload.output,
    internal_chat_message_metadata_passthrough: {
      turn_id: object(payload.internal_chat_message_metadata_passthrough).turn_id,
      create_time: object(payload.internal_chat_message_metadata_passthrough).create_time,
    },
  }
}

export function projectCodexTrajectory(rows: readonly CodexEnvelope[]): TrajectoryProjection {
  const sorted: IndexedEnvelope[] = rows
    .map((row, fileOrder) => ({
      ...row,
      fileOrder,
      ordinal: number(row.ordinal) ?? fileOrder,
      payload: object(row.payload),
    }))
    .sort((a, b) => a.ordinal - b.ordinal || a.fileOrder - b.fileOrder)

  const sessionMeta = sorted.find(row => row.type === 'session_meta')
  const sessionPayload = sessionMeta?.payload ?? {}
  const sessionId = string(sessionPayload.id) ?? string(sessionPayload.session_id) ?? 'unknown'
  const createdAt = timestamp(sessionPayload.timestamp)
    ?? (sessionMeta === undefined ? undefined : envelopeTime(sessionMeta))
    ?? 0

  const turns = new Map<string, TurnState>()
  const ensureTurn = (id: string): TurnState => {
    const existing = turns.get(id)
    if (existing !== undefined) return existing
    const created: TurnState = {
      id,
      number: turns.size + 1,
      status: 'running',
    }
    turns.set(id, created)
    return created
  }

  const itemTimings = new Map<string, ItemTiming>()
  const responseItems = new Map<string, IndexedEnvelope>()
  const toolCalls = new Map<string, IndexedEnvelope>()
  const toolOutputs = new Map<string, IndexedEnvelope>()
  const modelCalls: IndexedEnvelope[] = []
  let threadUsage: TokenUsage | undefined
  let countedThreadUsage: TokenUsage | undefined
  const foldedTokenEvents = new Set<string>()

  for (const envelope of sorted) {
    const payloadType = string(envelope.payload.type)
    const turnId = turnIdFor(envelope)
    if (turnId !== undefined) {
      const turn = ensureTurn(turnId)
      turn.rootTurnId = string(envelope.payload.root_turn_id) ?? turn.rootTurnId
    }
    if (envelope.type === 'turn_context' && turnId !== undefined) {
      ensureTurn(turnId).model = string(envelope.payload.model)
        ?? string(object(envelope.payload.collaboration_mode).model)
    }
    if (envelope.type === 'event_msg' && payloadType === 'task_started' && turnId !== undefined) {
      const turn = ensureTurn(turnId)
      turn.startedAt = timestamp(envelope.payload.started_at)
        ?? milliseconds(envelope.payload.started_at_ms)
        ?? envelopeTime(envelope)
      turn.status = 'running'
    }
    if (envelope.type === 'event_msg'
      && (payloadType === 'task_complete' || payloadType === 'turn_aborted')
      && turnId !== undefined) {
      const turn = ensureTurn(turnId)
      turn.completedAt = timestamp(envelope.payload.completed_at)
        ?? milliseconds(envelope.payload.completed_at_ms)
        ?? envelopeTime(envelope)
      turn.startedAt ??= timestamp(envelope.payload.started_at)
      turn.durationMs = number(envelope.payload.duration_ms)
      turn.ttftMs = number(envelope.payload.time_to_first_token_ms)
      turn.status = payloadType === 'turn_aborted' ? 'interrupted' : 'complete'
      turn.reason = payloadType === 'turn_aborted' ? envelope.payload.reason : 'completed'
    }
    if (envelope.type === 'event_msg' && payloadType === 'item_completed') {
      const item = object(envelope.payload.item)
      const id = string(item.id)
      if (id !== undefined) {
        itemTimings.set(id, {
          envelope,
          item,
          startTime: milliseconds(envelope.payload.started_at_ms),
          endTime: milliseconds(envelope.payload.completed_at_ms),
        })
      }
    }
    if (envelope.type === 'response_item') {
      const id = string(envelope.payload.id)
      if (id !== undefined) responseItems.set(id, envelope)
      if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
        const callId = string(envelope.payload.call_id)
        if (callId !== undefined) toolCalls.set(callId, envelope)
      } else if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
        const callId = string(envelope.payload.call_id)
        if (callId !== undefined) toolOutputs.set(callId, envelope)
      }
    }
    if (envelope.type === 'token_usage_record' && turnId !== undefined) {
      const usage = tokenUsage(envelope.payload.turn_token_usage ?? envelope.payload.usage)
      if (usage !== undefined) ensureTurn(turnId).usage = usage
      threadUsage = tokenUsage(envelope.payload.thread_token_usage) ?? threadUsage
      if (string(envelope.payload.response_id) !== undefined
        && tokenUsage(envelope.payload.usage) !== undefined) {
        modelCalls.push(envelope)
      }
    }
    if (envelope.type === 'event_msg' && payloadType === 'token_count') {
      const usage = tokenUsage(object(envelope.payload.info).total_token_usage)
      if (usage !== undefined) {
        countedThreadUsage = usage
        foldedTokenEvents.add(envelopeSourceId(envelope))
      }
    }
  }

  const contentEnvelopes = sorted.filter(envelope =>
    envelope.type === 'response_item')
  const contentTimings = new Map(itemTimings)
  const messageCandidates = new Map<string, IndexedEnvelope[]>()
  const messageKey = (envelope: IndexedEnvelope, payload = envelope.payload) => {
    const turnId = turnIdFor(envelope)
    if (turnId === undefined || payload.type !== 'message') return undefined
    const content = normalizeContent(payload.content)
    if (content.length === 0) return undefined
    return JSON.stringify([turnId, payload.role, content])
  }
  for (const envelope of contentEnvelopes) {
    if (string(envelope.payload.id) === undefined) continue
    const key = messageKey(envelope)
    if (key !== undefined) {
      const candidates = messageCandidates.get(key) ?? []
      candidates.push(envelope)
      messageCandidates.set(key, candidates)
    }
  }
  for (const [id, timing] of itemTimings) {
    if (responseItems.has(id)) continue
    const payload = completedContentPayload(timing.item)
    if (payload === undefined) continue
    const key = messageKey(timing.envelope, payload)
    const candidates = key === undefined ? [] : messageCandidates.get(key) ?? []
    const candidateId = candidates.length === 1
      ? string(candidates[0].payload.id)
      : undefined
    // Client message IDs may differ from response IDs. Only pair a unique
    // same-turn, same-role, same-content candidate; never guess across turns.
    if (candidateId !== undefined && !contentTimings.has(candidateId)) {
      contentTimings.set(candidateId, timing)
      continue
    }
    contentEnvelopes.push({
      ...timing.envelope,
      type: 'response_item',
      payload: { ...payload, turn_id: turnIdFor(timing.envelope) },
    })
  }
  contentEnvelopes.sort((a, b) => a.ordinal - b.ordinal || a.fileOrder - b.fileOrder)

  const lastAssistantByTurn = new Map<string, number>()
  for (const envelope of contentEnvelopes) {
    if (envelope.type !== 'response_item'
      || string(envelope.payload.type) !== 'message'
      || string(envelope.payload.role) !== 'assistant') continue
    const turnId = turnIdFor(envelope)
    if (turnId !== undefined) lastAssistantByTurn.set(turnId, envelope.ordinal)
  }

  const records: TrajectoryRecord[] = []
  for (const envelope of contentEnvelopes) {
    const payloadType = string(envelope.payload.type)
    const sourceId = string(envelope.payload.id) ?? `${envelope.ordinal}:${envelope.fileOrder}`
    const timing = contentTimings.get(sourceId)
    const turnId = turnIdFor(envelope)
      ?? (timing === undefined ? undefined : turnIdFor(timing.envelope))
    const turn = turnId === undefined ? undefined : ensureTurn(turnId)
    const turnNumber = turn?.number ?? 0
    const sourceEventIds = [...new Set([
      sourceId,
      envelopeSourceId(envelope),
      ...(timing === undefined ? [] : [
        string(timing.item.id) ?? sourceId,
        envelopeSourceId(timing.envelope),
      ]),
    ])]
    const raw = [
      ...(timing !== undefined && envelopeSourceId(envelope) === envelopeSourceId(timing.envelope)
        ? []
        : [acceptedRaw(envelope, contentPayload(envelope.payload))]),
      ...(timing === undefined ? [] : [completedContentRaw(timing)]),
    ]

    if (payloadType === 'message') {
      const role = string(envelope.payload.role)
      const content = normalizeContent(envelope.payload.content)
      const text = textFromContent(content)
      const classification = messageClassification(role, text)
      if (classification === undefined) continue
      const isLastAssistant = classification.kind === 'assistant'
        && turnId !== undefined
        && lastAssistantByTurn.get(turnId) === envelope.ordinal
      const startTime = timing?.startTime ?? envelopeTime(envelope)
      const messageCompletedAt = timing?.endTime ?? timing?.startTime ?? envelopeTime(envelope)
      const status: RecordStatus = classification.status
        ?? (classification.kind !== 'assistant'
          ? 'complete'
          : timing !== undefined
          ? 'complete'
          : isLastAssistant && turn?.status === 'interrupted'
            ? 'interrupted'
            : isLastAssistant && turn?.status === 'running'
              ? 'running'
              : 'complete')
      const endTime = status === 'running' ? null : messageCompletedAt
      records.push(searchable({
        id: `${classification.kind}:${sourceId}`,
        sourceEventIds,
        fidelity: timing !== undefined && timing.item.id !== sourceId
          ? 'derived'
          : 'exact',
        seq: envelope.ordinal,
        turn: turnNumber,
        step: 1,
        kind: classification.kind,
        title: classification.title,
        summary: compactText(text) || '空消息',
        startTime,
        endTime,
        status,
        depth: 0,
        input: classification.kind === 'assistant' ? undefined : content,
        output: classification.kind === 'assistant' ? content : undefined,
        provider: string(sessionPayload.model_provider),
        model: turn?.model,
        raw,
      }))
      continue
    }

    if (payloadType === 'reasoning') {
      const content = normalizeContent(
        envelope.payload.summary ?? envelope.payload.content,
        'reasoning',
      )
      const encryptedPresent = envelope.payload.encrypted_content !== null
        && envelope.payload.encrypted_content !== undefined
      if (content.length === 0 && encryptedPresent) {
        content.push({ type: 'reasoning', encrypted: true })
      }
      records.push(searchable({
        id: `reasoning:${sourceId}`,
        sourceEventIds,
        fidelity: 'exact',
        seq: envelope.ordinal,
        turn: turnNumber,
        step: 1,
        kind: 'assistant',
        title: '推理',
        summary: compactText(textFromContent(content)) || (encryptedPresent ? '加密推理内容' : '推理摘要'),
        startTime: timing?.startTime ?? envelopeTime(envelope),
        endTime: timing?.endTime ?? envelopeTime(envelope),
        status: 'complete',
        depth: 0,
        output: content,
        provider: string(sessionPayload.model_provider),
        model: turn?.model,
        raw,
      }))
    }
  }

  for (const envelope of modelCalls) {
    const responseId = string(envelope.payload.response_id)!
    const turnId = turnIdFor(envelope)
    const turn = turnId === undefined ? undefined : ensureTurn(turnId)
    const usage = tokenUsage(envelope.payload.usage)!
    const completedAt = envelopeTime(envelope)
    records.push(searchable({
      id: `model:${responseId}`,
      sourceEventIds: [responseId, envelopeSourceId(envelope)],
      fidelity: 'exact',
      seq: envelope.ordinal,
      turn: turn?.number ?? 0,
      step: 1,
      kind: 'model',
      title: '模型调用',
      summary: `${usage.inputTokens ?? 0} 输入 / ${usage.outputTokens ?? 0} 输出 tokens`,
      startTime: completedAt,
      endTime: completedAt,
      status: 'complete',
      depth: 0,
      callId: responseId,
      usage,
      provider: string(sessionPayload.model_provider),
      model: turn?.model,
      raw: [acceptedRaw(envelope, {
        type: 'token_usage_record',
        turn_id: envelope.payload.turn_id,
        response_id: responseId,
        usage: envelope.payload.usage,
      })],
    }))
  }

  const allCallIds = new Set([...toolCalls.keys(), ...toolOutputs.keys()])
  for (const [id, timing] of itemTimings) {
    const type = string(timing.item.type)
    if (type === 'CommandExecution' || type === 'McpToolCall' || type === 'FileChange') {
      allCallIds.add(id)
    }
  }
  for (const callId of allCallIds) {
    const call = toolCalls.get(callId)
    const output = toolOutputs.get(callId)
    const timing = itemTimings.get(callId)
    const item = timing?.item ?? {}
    const turnId = call === undefined
      ? output === undefined ? turnIdFor(timing!.envelope) : turnIdFor(output)
      : turnIdFor(call)
    const turn = turnId === undefined ? undefined : ensureTurn(turnId)
    const callPayload = call?.payload ?? {}
    const name = string(callPayload.name) ?? itemName(item)
    const input = call === undefined
      ? itemInput(item)
      : parseArguments(
          callPayload.arguments ?? callPayload.input,
          callPayload.encrypted_function_args,
        )
    const outputValue = output?.payload.output ?? itemOutput(item)
    const inferredExitCode = processExitCode(name, outputValue)
    const isError = itemIsError(item) || (inferredExitCode !== undefined && inferredExitCode !== 0)
    const hasCompletedResult = output !== undefined
      || timing !== undefined
      || string(callPayload.status) === 'completed'
    const status: RecordStatus = isError
      ? 'error'
      : hasCompletedResult
        ? 'complete'
        : turn !== undefined && turn.status !== 'running'
          ? 'interrupted'
          : 'running'
    const startTime = timing?.startTime
      ?? (call === undefined ? undefined : envelopeTime(call))
      ?? (output === undefined ? 0 : envelopeTime(output))
    const endTime = status === 'running'
      ? null
      : timing?.endTime
        ?? (output === undefined ? startTime : envelopeTime(output))
    const raw = [
      ...(call === undefined ? [] : [acceptedRaw(call, toolPayload(call.payload))]),
      ...(output === undefined ? [] : [acceptedRaw(output, toolPayload(output.payload))]),
      ...(timing === undefined
        ? []
        : [acceptedRaw(timing.envelope, {
            type: 'item_completed',
            turn_id: timing.envelope.payload.turn_id,
            item: timing.item,
            started_at_ms: timing.envelope.payload.started_at_ms,
            completed_at_ms: timing.envelope.payload.completed_at_ms,
          })]),
    ]
    records.push(searchable({
      id: `tool:${callId}`,
      sourceEventIds: [
        callId,
        ...[
          ...(call === undefined ? [] : [call]),
          ...(output === undefined ? [] : [output]),
          ...(timing === undefined ? [] : [timing.envelope]),
        ].map(envelopeSourceId),
      ],
      fidelity: call === undefined || inferredExitCode !== undefined ? 'derived' : 'exact',
      seq: call?.ordinal ?? timing?.envelope.ordinal ?? output?.ordinal ?? 0,
      endSeq: output?.ordinal ?? timing?.envelope.ordinal,
      turn: turn?.number ?? 0,
      step: 1,
      kind: 'tool',
      title: name,
      summary: compactText(`${JSON.stringify(input) ?? ''}${outputValue === undefined ? '' : ` → ${typeof outputValue === 'string' ? outputValue : JSON.stringify(outputValue)}`}`),
      startTime,
      endTime,
      status,
      depth: 0,
      callId,
      input,
      output: outputValue,
      error: isError
        ? {
            name: 'ToolError',
            code: number(item.exit_code)?.toString()
              ?? inferredExitCode?.toString()
              ?? string(item.status),
            reason: string(object(item.result).error) ?? string(item.stderr),
          }
        : status === 'interrupted'
          ? { name: 'Interrupted', code: 'interrupted' }
          : undefined,
      raw,
    }))
  }

  const validCompacted = sorted.filter(envelope =>
    envelope.type === 'compacted' && recognizedCompactedPayload(envelope.payload))
  const compactedByItemId = new Map<string, IndexedEnvelope>()
  const matchedCompacted = new Set<string>()
  const usedCompactionItems = new Set<string>()
  const isCompactionBridge = (envelope: IndexedEnvelope): boolean => {
    if (envelope.type === 'world_state'
      || envelope.type === 'turn_context'
      || envelope.type === 'token_usage_record') return true
    return envelope.type === 'event_msg'
      && (envelope.payload.type === 'thread_settings_applied'
        || envelope.payload.type === 'token_count')
  }
  for (const compacted of validCompacted) {
    const compactedIndex = sorted.indexOf(compacted)
    for (
      let index = compactedIndex + 1;
      index < sorted.length
        && index - compactedIndex <= COMPACTION_MATCH_MAX_EVENT_DISTANCE;
      index += 1
    ) {
      const candidate = sorted[index]
      const compactedTime = envelopeTime(compacted)
      const candidateTime = envelopeTime(candidate)
      if (compactedTime > 0
        && candidateTime > 0
        && candidateTime - compactedTime > COMPACTION_MATCH_MAX_TIME_MS) break
      const item = object(candidate.payload.item)
      const itemId = string(item.id)
      if (candidate.type === 'event_msg'
        && candidate.payload.type === 'item_completed'
        && item.type === 'ContextCompaction'
        && itemId !== undefined
        && !usedCompactionItems.has(itemId)) {
        compactedByItemId.set(itemId, compacted)
        matchedCompacted.add(envelopeSourceId(compacted))
        usedCompactionItems.add(itemId)
        break
      }
      if (!isCompactionBridge(candidate)) break
    }
  }

  const neighboringTurnId = (compacted: IndexedEnvelope): string | undefined => {
    const compactedIndex = sorted.indexOf(compacted)
    const candidates = new Set<string>()
    for (const direction of [-1, 1]) {
      for (
        let distance = 1;
        distance <= COMPACTION_MATCH_MAX_EVENT_DISTANCE;
        distance += 1
      ) {
        const neighbor = sorted[compactedIndex + direction * distance]
        if (neighbor === undefined) break
        const compactedTime = envelopeTime(compacted)
        const neighborTime = envelopeTime(neighbor)
        if (compactedTime > 0
          && neighborTime > 0
          && Math.abs(neighborTime - compactedTime) > COMPACTION_MATCH_MAX_TIME_MS) break
        const turnId = turnIdFor(neighbor)
        if (turnId !== undefined) {
          candidates.add(turnId)
          break
        }
      }
    }
    return candidates.size === 1 ? [...candidates][0] : undefined
  }

  for (const [id, timing] of itemTimings) {
    if (string(timing.item.type) !== 'ContextCompaction') continue
    const turnId = turnIdFor(timing.envelope)
    const compacted = compactedByItemId.get(id)
    records.push(searchable({
      id: `compaction:${id}`,
      sourceEventIds: [
        id,
        envelopeSourceId(timing.envelope),
        ...(compacted === undefined ? [] : [envelopeSourceId(compacted)]),
      ],
      fidelity: compacted === undefined ? 'exact' : 'derived',
      seq: timing.envelope.ordinal,
      turn: turnId === undefined ? 0 : ensureTurn(turnId).number,
      step: 1,
      kind: 'compaction',
      title: '上下文压缩',
      summary: 'Codex 上下文压缩',
      startTime: timing.startTime ?? envelopeTime(timing.envelope),
      endTime: timing.endTime ?? envelopeTime(timing.envelope),
      status: 'complete',
      depth: 0,
      raw: [
        ...(compacted === undefined
          ? []
          : [acceptedRaw(compacted, compactedPayload(compacted.payload))]),
        acceptedRaw(timing.envelope, {
          type: 'item_completed',
          turn_id: timing.envelope.payload.turn_id,
          item: timing.item,
          started_at_ms: timing.envelope.payload.started_at_ms,
          completed_at_ms: timing.envelope.payload.completed_at_ms,
        }),
      ],
    }))
  }
  for (const compacted of validCompacted) {
    const sourceEventId = envelopeSourceId(compacted)
    if (matchedCompacted.has(sourceEventId)) continue
    const windowId = string(compacted.payload.window_id)!
    const turnId = neighboringTurnId(compacted)
    records.push(searchable({
      id: `compaction:${windowId}`,
      sourceEventIds: [sourceEventId],
      fidelity: 'derived',
      seq: compacted.ordinal,
      turn: turnId === undefined ? 0 : ensureTurn(turnId).number,
      step: 1,
      kind: 'compaction',
      title: '上下文压缩',
      summary: 'Codex 上下文压缩',
      startTime: envelopeTime(compacted),
      endTime: envelopeTime(compacted),
      status: 'complete',
      depth: 0,
      raw: [acceptedRaw(compacted, compactedPayload(compacted.payload))],
    }))
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
  records.sort((a, b) =>
    a.turn - b.turn
    || a.seq - b.seq
    || priority[a.kind] - priority[b.kind]
    || a.id.localeCompare(b.id))
  assignLogicalSteps(records)

  const { startTime, endTime } = recordTimeBounds(records, createdAt)
  const eventTypeCounts: Record<string, number> = {}
  const unknownEventTypes = new Set<string>()
  for (const envelope of sorted) {
    const name = `${envelope.type ?? 'unknown'}${typeof envelope.payload.type === 'string' ? `/${envelope.payload.type}` : ''}`
    eventTypeCounts[name] = (eventTypeCounts[name] ?? 0) + 1
    if (envelope.type === undefined || !KNOWN_TOP_LEVEL_TYPES.has(envelope.type)) {
      unknownEventTypes.add(envelope.type ?? 'unknown')
    }
  }

  const turnSummaries: TrajectoryTurnSummary[] = [...turns.values()].map((turn) => {
    const completedAt = turn.completedAt
      ?? (turn.startedAt === undefined || turn.durationMs === undefined
        ? undefined
        : turn.startedAt + turn.durationMs)
    const startedAt = turn.startedAt
      ?? (completedAt === undefined || turn.durationMs === undefined
        ? createdAt
        : completedAt - turn.durationMs)
    return {
      id: turn.id,
      number: turn.number,
      startTime: startedAt,
      endTime: turn.status === 'running' ? null : completedAt ?? startedAt,
      status: turn.status,
      reason: turn.reason,
      usage: turn.usage,
      metrics: turn.ttftMs === undefined ? undefined : { ttftMs: turn.ttftMs },
      model: turn.model,
    }
  })
  const latestModel = [...turns.values()]
    .reverse()
    .find(turn => turn.model !== undefined)?.model
  const projectedEvents = projectedSourceEventIds(records)
  const coverage = projectionCoverage(eventTypeCounts, sorted.length, (type) => {
    if (type === 'session_meta' || type === 'turn_context'
      || type === 'token_usage_record') {
      return { disposition: 'folded-state' }
    }
    if (type === 'event_msg/token_count') {
      return {
        disposition: 'folded-state',
        consumed: foldedTokenEvents.size,
        reason: '累计 Token 快照折叠为会话用量；缺少有效用量的事件仍未消费。',
      }
    }
    if (type === 'event_msg/thread_settings_applied'
      && sorted.filter(envelope => envelope.type === 'event_msg'
        && envelope.payload.type === 'thread_settings_applied')
        .every(envelope => recognizedConfiguration(
          envelope.payload.thread_settings,
          THREAD_SETTINGS_KEYS,
        ))) {
      return {
        disposition: 'raw-only',
        reason: '已识别的线程运行配置保留在原始审计中，不作为任务执行结果。',
      }
    }
    if (type === 'world_state'
      && sorted.filter(envelope => envelope.type === 'world_state')
        .every(envelope => typeof envelope.payload.full === 'boolean'
          && recognizedConfiguration(envelope.payload.state, RUNTIME_STATE_KEYS))) {
      return {
        disposition: 'raw-only',
        reason: '已识别的运行上下文快照保留在原始审计中，不作为工作区变更结果。',
      }
    }
    if (type === 'compacted'
      || type === 'response_item/message'
      || type === 'response_item/reasoning'
      || type === 'response_item/function_call'
      || type === 'response_item/function_call_output'
      || type === 'response_item/custom_tool_call'
      || type === 'response_item/custom_tool_call_output'
      || type === 'event_msg/item_completed') {
      return {
        disposition: 'record',
        consumed: sorted.filter((envelope) => {
          const selected = `${envelope.type ?? 'unknown'}${
            typeof envelope.payload.type === 'string'
              ? `/${envelope.payload.type}`
              : ''
          }`
          return selected === type
            && projectedEvents.has(envelopeSourceId(envelope))
        }).length,
      }
    }
    if (type === 'event_msg/task_started'
      || type === 'event_msg/task_complete'
      || type === 'event_msg/turn_aborted') {
      return { disposition: 'folded-state' }
    }
    return {
      disposition: 'unsupported',
      reason: 'Codex event or payload type does not have a semantic projector',
    }
  })

  return {
    header: {
      source: 'codex',
      format: 'codex-rollout-jsonl',
      id: sessionId,
      createdAt,
      cwd: string(sessionPayload.cwd),
      model: latestModel,
      provider: string(sessionPayload.model_provider),
      rawVersion: string(sessionPayload.cli_version),
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
    eventCount: sorted.length,
    eventTypeCounts,
    unknownEventTypes: [...unknownEventTypes].sort(),
    ...coverage,
    turnEnds: Object.fromEntries([...turns.values()]
      .filter(turn => turn.completedAt !== undefined)
      .map(turn => [turn.number, {
        time: turn.completedAt!,
        reason: turn.reason,
      }])),
    usage: threadUsage ?? countedThreadUsage
      ?? sumTokenUsage([...turns.values()].map(turn => turn.usage)),
  }
}
