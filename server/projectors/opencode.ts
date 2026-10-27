import type {
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
  projectedRecord,
  redactSensitive,
} from '../../src/projector-utils'
import {
  recordTimeBounds,
  rollupTurns,
} from './projection-rollup'

export interface OpenCodeSessionRow {
  id: string
  parent_id: string | null
  directory: string
  title: string
  version: string
  model: unknown
  cost: number
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
  time_created: number
  time_updated: number
}

export interface OpenCodeMessageRow {
  id: string
  type: string
  seq: number
  time_created: number
  time_updated: number
  data: Record<string, unknown>
}

export interface OpenCodeProjectionInput {
  session: OpenCodeSessionRow
  messages: OpenCodeMessageRow[]
}

const KNOWN_MESSAGE_TYPES = new Set([
  'agent-switched',
  'assistant',
  'compaction',
  'idle',
  'location-switched',
  'model-switched',
  'shell',
  'skill',
  'synthetic',
  'system',
  'user',
])

function timestamp(value: unknown, fallback: number): number {
  const selected = number(value)
  if (selected !== undefined) {
    return selected < 10_000_000_000 ? selected * 1000 : selected
  }
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

function time(data: Record<string, unknown>, key: string, fallback: number): number {
  return timestamp(object(data.time)[key], fallback)
}

function usage(value: unknown): TokenUsage | undefined {
  const source = object(value)
  const cache = object(source.cache)
  const result: TokenUsage = {
    inputTokens: number(source.input) ?? number(source.input_tokens),
    outputTokens: number(source.output) ?? number(source.output_tokens),
    reasoningTokens: number(source.reasoning) ?? number(source.reasoning_tokens),
    cacheReadTokens: number(cache.read) ?? number(source.cache_read),
    cacheWriteTokens: number(cache.write) ?? number(source.cache_write),
  }
  if (!Object.values(result).some(item => item !== undefined)) return undefined
  result.totalTokens = (result.inputTokens ?? 0)
    + (result.outputTokens ?? 0)
    + (result.reasoningTokens ?? 0)
    + (result.cacheReadTokens ?? 0)
    + (result.cacheWriteTokens ?? 0)
  return result
}

function sumUsage(values: readonly (TokenUsage | undefined)[]): TokenUsage | undefined {
  const present = values.filter((value): value is TokenUsage => value !== undefined)
  if (present.length === 0) return undefined
  const keys: Array<keyof TokenUsage> = [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
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

function modelRef(value: unknown): { model?: string; provider?: string } {
  const source = object(value)
  return {
    model: string(source.id) ?? string(source.modelID),
    provider: string(source.providerID) ?? string(source.provider),
  }
}

function status(value: unknown, fallback: RecordStatus = 'complete'): RecordStatus {
  const selected = string(value)?.toLowerCase()
  if (selected === 'complete' || selected === 'completed' || selected === 'success') {
    return 'complete'
  }
  if (selected === 'error' || selected === 'failed') return 'error'
  if (selected === 'pending' || selected === 'running' || selected === 'streaming') {
    return 'running'
  }
  if (selected === 'interrupted' || selected === 'cancelled') return 'interrupted'
  return fallback
}

function searchable(
  record: Omit<TrajectoryRecord, 'searchText' | 'source'>,
): TrajectoryRecord {
  return projectedRecord('opencode', record)
}

function safeRaw(row: OpenCodeMessageRow): unknown {
  return redactSensitive(row)
}

export function projectOpenCodeTrajectory(
  input: OpenCodeProjectionInput,
): TrajectoryProjection {
  const messages = [...input.messages].sort((left, right) =>
    left.seq - right.seq || left.id.localeCompare(right.id))
  const records: TrajectoryRecord[] = []
  const turns = new Map<number, TrajectoryTurnSummary>()
  const messageTurns = new Map<string, number>()
  let currentTurn = 0

  for (const message of messages) {
    if (message.type === 'user') currentTurn++
    messageTurns.set(message.id, currentTurn)
    if (currentTurn === 0) continue
    const start = time(message.data, 'created', message.time_created)
    const end = time(message.data, 'completed', message.time_updated)
    const existing = turns.get(currentTurn)
    turns.set(currentTurn, existing === undefined
      ? {
          id: `turn:${currentTurn}`,
          number: currentTurn,
          startTime: start,
          endTime: end,
          status: 'complete',
        }
      : { ...existing, endTime: Math.max(existing.endTime ?? end, end) })
  }

  const messageUsages: Array<TokenUsage | undefined> = []
  for (const message of messages) {
    const data = message.data
    const turn = messageTurns.get(message.id) ?? 0
    const created = time(data, 'created', message.time_created)
    if (message.type === 'user') {
      const text = string(data.text) ?? ''
      records.push(searchable({
        id: `message:${message.id}`,
        sourceEventIds: [message.id],
        fidelity: 'exact',
        seq: message.seq,
        turn,
        step: 0,
        kind: 'user',
        title: '用户',
        summary: compactText(text),
        startTime: created,
        endTime: created,
        status: 'complete',
        depth: 0,
        input: [{ type: 'text', text }],
        raw: [safeRaw(message)],
      }))
      continue
    }
    if (message.type === 'assistant') {
      const selectedModel = modelRef(data.model)
      const assistantUsage = usage(data.tokens)
      messageUsages.push(assistantUsage)
      const content = array(data.content)
      const textBlocks = content.flatMap((value) => {
        const block = object(value)
        return string(block.type) === 'text'
          ? [{ type: 'text', text: string(block.text) ?? '' }]
          : []
      })
      const assistantStatus = data.error === undefined ? 'complete' : 'error'
      records.push(searchable({
        id: `message:${message.id}`,
        sourceEventIds: [message.id],
        fidelity: 'exact',
        seq: message.seq,
        turn,
        step: 1,
        kind: 'assistant',
        title: '助手',
        summary: compactText(textBlocks.map(block => block.text).join('\n')),
        startTime: created,
        endTime: time(data, 'completed', message.time_updated),
        status: assistantStatus,
        depth: 0,
        output: textBlocks,
        usage: assistantUsage,
        model: selectedModel.model,
        provider: selectedModel.provider,
        error: assistantStatus === 'error'
          ? {
              name: string(object(data.error).name) ?? 'AssistantError',
              reason: string(object(data.error).message),
            }
          : undefined,
        raw: [safeRaw(message)],
      }))
      content.forEach((value, index) => {
        const block = object(value)
        const type = string(block.type)
        if (type === 'reasoning') {
          const text = string(block.text) ?? ''
          records.push(searchable({
            id: `reasoning:${message.id}:${index}`,
            sourceEventIds: [message.id],
            fidelity: 'exact',
            seq: message.seq,
            turn,
            step: 1,
            kind: 'model',
            title: '推理',
            summary: compactText(text),
            startTime: timestamp(object(block.time).created, created),
            endTime: timestamp(
              object(block.time).completed,
              time(data, 'completed', message.time_updated),
            ),
            status: 'complete',
            depth: 0,
            output: [{ type: 'reasoning', text }],
            model: selectedModel.model,
            provider: selectedModel.provider,
            raw: [safeRaw(message)],
          }))
        }
        if (type === 'tool') {
          const state = object(block.state)
          const toolStatus = status(state.status, 'running')
          const error = object(state.error)
          const callId = string(block.id) ?? `${message.id}:${index}`
          records.push(searchable({
            id: `tool:${callId}`,
            sourceEventIds: [message.id],
            fidelity: 'exact',
            seq: message.seq,
            turn,
            step: 1,
            kind: 'tool',
            title: string(block.name) ?? '工具',
            summary: compactText(
              `${JSON.stringify(state.input) ?? ''} → ${
                JSON.stringify(state.content ?? state.result) ?? ''
              }`,
            ),
            startTime: timestamp(object(block.time).created, created),
            endTime: toolStatus === 'running'
              ? null
              : timestamp(
                  object(block.time).completed,
                  time(data, 'completed', message.time_updated),
                ),
            status: toolStatus,
            depth: 0,
            callId,
            input: state.input,
            output: state.content ?? state.result,
            error: toolStatus === 'error'
              ? {
                  name: string(error.name) ?? 'ToolError',
                  reason: string(error.message),
                }
              : undefined,
            model: selectedModel.model,
            provider: selectedModel.provider,
            raw: [safeRaw(message)],
          }))
        }
      })
      const turnState = turns.get(turn)
      if (turnState !== undefined && selectedModel.model !== undefined) {
        turns.set(turn, { ...turnState, model: selectedModel.model })
      }
      continue
    }
    if (message.type === 'compaction') {
      const compactionUsage = usage(data.tokens)
      messageUsages.push(compactionUsage)
      const compactionStatus = status(data.status)
      const selectedModel = modelRef(data.model)
      records.push(searchable({
        id: `compaction:${message.id}`,
        sourceEventIds: [message.id],
        fidelity: 'exact',
        seq: message.seq,
        turn,
        step: 1,
        kind: 'compaction',
        title: '上下文压缩',
        summary: compactText(string(data.summary) ?? 'OpenCode 上下文压缩'),
        startTime: created,
        endTime: compactionStatus === 'running'
          ? null
          : time(data, 'completed', message.time_updated),
        status: compactionStatus,
        depth: 0,
        output: string(data.summary),
        usage: compactionUsage,
        model: selectedModel.model,
        provider: selectedModel.provider,
        raw: [safeRaw(message)],
      }))
    }
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
  for (const message of messages) {
    eventTypeCounts[message.type] = (eventTypeCounts[message.type] ?? 0) + 1
  }
  const model = modelRef(input.session.model)
  const bounds = recordTimeBounds(
    records,
    input.session.time_created,
    input.session.time_updated,
  )
  const turnSummaries = rollupTurns([...turns.values()], records)
  const projectedEvents = projectedSourceEventIds(records)
  const coverage = projectionCoverage(eventTypeCounts, messages.length, (type) => {
    if (type === 'user' || type === 'assistant' || type === 'compaction') {
      return {
        disposition: 'record',
        consumed: messages.filter(message =>
          message.type === type && projectedEvents.has(message.id)).length,
      }
    }
    return {
      disposition: 'unsupported',
      reason: KNOWN_MESSAGE_TYPES.has(type)
        ? 'known message type does not yet have a semantic projector'
        : 'message type is not supported by the OpenCode projector',
    }
  })
  return {
    header: {
      source: 'opencode',
      format: 'opencode-sqlite-v1',
      id: input.session.id,
      createdAt: input.session.time_created,
      cwd: input.session.directory,
      parentSessionId: input.session.parent_id ?? undefined,
      model: model.model,
      provider: model.provider,
      rawVersion: input.session.version,
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
    eventCount: messages.length,
    eventTypeCounts,
    unknownEventTypes: [...new Set(messages.flatMap(message =>
      KNOWN_MESSAGE_TYPES.has(message.type) ? [] : [message.type]))].sort(),
    ...coverage,
    turnEnds: Object.fromEntries(turnSummaries.flatMap(turn =>
      turn.endTime === null ? [] : [[turn.number, {
        time: turn.endTime,
        reason: turn.status,
      }]])),
    usage: sumUsage(messageUsages),
  }
}
