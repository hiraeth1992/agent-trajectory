import type {
  EventDisposition,
  JsonObject,
  ModelContextRecordOverride,
  RecordKind,
  SessionEvent,
  SessionHeader,
  TokenUsage,
  TrajectoryProjection,
  TrajectoryRecord,
  TrajectoryRelation,
  TrajectoryTaskState,
  TrajectoryTurnSummary,
} from './types'
import {
  asArray,
  asFiniteNumber as number,
  asJsonObject as object,
  asString as string,
  compactText,
  jsonText,
  parseStructured as parseRawArgs,
  projectedRecord,
  redactSensitive,
} from './projector-utils'

export const KNOWN_EVENT_TYPES = new Set([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'assistant/attempt',
  'assistant/message',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  'deliverables/presented',
  'developer/message',
  'feedback/message-delete',
  'feedback/message-put',
  'feedback/record',
  'goal/change',
  'hook/invoked',
  'hook/result',
  'image/offload',
  'job/registered',
  'job/settled',
  'llm/retry',
  'llm/retry-started',
  'model/selection',
  'permission/preset',
  'plan/mode',
  'request/context',
  'request/header',
  'sandbox/mode',
  'schedule/change',
  'session-log-deepseek/delivery-accepted',
  'session/end-seed',
  'session/title',
  'session/title-llm-request',
  'step/end',
  'step/start',
  'subagent/catalog',
  'subagent/descriptor',
  'subagent/model-selection-policy',
  'system/message',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  'team/task',
  'todo/write',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/call',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  'tool/result',
  'turn/end',
  'turn/start',
  'user/message',
  'web/deepseek-search-llm-request',
  'working-directory/change',
  'workspace/changes',
])

export const MESSAGE_PROJECTION_EVENT_TYPES = new Set([
  'image/offload',
])

interface StepState {
  turn: number
  step: number
  startEvent?: SessionEvent
  endEvent?: SessionEvent
  requestHeader?: SessionEvent
  requestContext?: SessionEvent
  messages: SessionEvent[]
  attempts: SessionEvent[]
  retries: SessionEvent[]
}

interface ToolState {
  start?: SessionEvent
  end?: SessionEvent
  rootCallId?: string
  parentCallId?: string
  subCallId?: string
  name: string
  args: unknown
  turn: number
  step: number
  nested: boolean
}

interface CompactionState {
  start?: SessionEvent
  summary?: SessionEvent
  end?: SessionEvent
}

const SURFACE_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

const RECORD_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'tool/ptc-dispatch-start',
  'tool/ptc-dispatch',
  'compaction/start',
  'compaction/summary',
  'compaction/end',
])

const FOLDED_EVENT_TYPES = new Set([
  'agent/inbox/spliced',
  'assistant/attempt',
  'goal/change',
  'llm/retry',
  'request/context',
  'request/header',
  'step/end',
  'step/start',
  'todo/write',
  'turn/end',
  'turn/start',
  ...MESSAGE_PROJECTION_EVENT_TYPES,
])

function eventDisposition(type: string): EventDisposition {
  if (RECORD_EVENT_TYPES.has(type)) return 'record'
  if (FOLDED_EVENT_TYPES.has(type)) return 'folded-state'
  if (KNOWN_EVENT_TYPES.has(type)) return 'raw-only'
  return 'unsupported'
}

const GOAL_OPERATIONS = new Set([
  'create',
  'edit',
  'pause',
  'resume',
  'complete',
  'block',
])

const GOAL_PHASES = new Set(['active', 'paused', 'blocked', 'complete'])
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])

type GoalChange = {
  kind: 'clear'
  id: string
  revision: number
  clearedAt: number
} | {
  kind: 'snapshot'
  operation: string
  createdAt: number
  blockedReason?: JsonObject
  target: NonNullable<TrajectoryTaskState['target']>
}

function safeInteger(value: unknown, minimum: number): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= minimum
    ? value
    : undefined
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

function blockedReason(value: unknown): JsonObject | undefined {
  const reason = object(value)
  const code = string(reason.code)
  const message = string(reason.message)
  return hasExactKeys(reason, ['code', 'message'])
    && code !== undefined
    && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(code)
    && message !== undefined
    && message.trim() !== ''
    && message === message.trim()
    ? { code, message }
    : undefined
}

function goalChange(event: SessionEvent): GoalChange | undefined {
  const data = event.data
  if (data.kind !== 'goal/change' || data.version !== 1) return undefined
  if (data.operation === 'clear') {
    const cleared = object(data.cleared)
    const id = string(cleared.id)
    const revision = safeInteger(cleared.revision, 1)
    const clearedAt = safeInteger(data.clearedAt, 0)
    if (!hasExactKeys(data, ['kind', 'version', 'operation', 'cleared', 'clearedAt'])
      || !hasExactKeys(cleared, ['id', 'revision'])
      || id === undefined
      || id === ''
      || revision === undefined
      || clearedAt === undefined) {
      return undefined
    }
    return { kind: 'clear', id, revision, clearedAt }
  }
  if (typeof data.operation !== 'string' || !GOAL_OPERATIONS.has(data.operation)) {
    return undefined
  }
  if (!hasExactKeys(data, [
    'kind',
    'version',
    'operation',
    'goal',
    'roundsStarted',
    'createdAt',
    'updatedAt',
  ])) {
    return undefined
  }
  const goal = object(data.goal)
  const id = string(goal.id)
  const revision = safeInteger(goal.revision, 1)
  const objective = string(goal.objective)
  const status = string(goal.phase)
  const maxRounds = safeInteger(goal.maxGoalRounds, 1)
  const roundsStarted = safeInteger(data.roundsStarted, 0)
  const createdAt = safeInteger(data.createdAt, 0)
  const updatedAt = safeInteger(data.updatedAt, 0)
  const reason = status === 'blocked' ? blockedReason(goal.blockedReason) : undefined
  const expectedGoalKeys = status === 'blocked'
    ? ['id', 'revision', 'objective', 'phase', 'maxGoalRounds', 'blockedReason']
    : ['id', 'revision', 'objective', 'phase', 'maxGoalRounds']
  if (id === undefined
    || id === ''
    || revision === undefined
    || objective === undefined
    || objective.trim() === ''
    || objective !== objective.trim()
    || status === undefined
    || !GOAL_PHASES.has(status)
    || maxRounds === undefined
    || roundsStarted === undefined
    || createdAt === undefined
    || updatedAt === undefined
    || updatedAt < createdAt
    || !hasExactKeys(goal, expectedGoalKeys)
    || (status === 'blocked' && reason === undefined)) {
    return undefined
  }
  return {
    kind: 'snapshot',
    operation: data.operation,
    createdAt,
    blockedReason: reason,
    target: {
      id,
      revision,
      objective,
      status,
      maxRounds,
      roundsStarted,
      updatedAt,
    },
  }
}

function todoSnapshot(event: SessionEvent): TrajectoryTaskState['todos'] | undefined {
  if (!hasExactKeys(event.data, ['todos']) || !Array.isArray(event.data.todos)) return undefined
  const todos: TrajectoryTaskState['todos'] = []
  for (const [position, value] of event.data.todos.entries()) {
    const todo = object(value)
    const content = string(todo.content)
    const status = string(todo.status)
    if (!hasExactKeys(todo, ['content', 'status'])
      || content === undefined
      || status === undefined
      || !TODO_STATUSES.has(status)) {
      return undefined
    }
    todos.push({
      content,
      status,
      position,
      updatedAt: event.time,
    })
  }
  return todos
}

interface GoalFoldState {
  createdAt?: number
  blockedReason?: JsonObject
  seenIds: Set<string>
  failed: boolean
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function applyGoalChange(
  state: GoalFoldState,
  current: TrajectoryTaskState['target'],
  change: GoalChange,
): TrajectoryTaskState['target'] | undefined | false {
  if (change.kind === 'clear') {
    if (current === undefined
      || change.id !== current.id
      || change.revision !== (current.revision ?? 0) + 1
      || change.clearedAt < current.updatedAt) {
      return false
    }
    state.createdAt = undefined
    state.blockedReason = undefined
    return undefined
  }
  const next = change.target
  if (change.operation === 'create') {
    if (next.revision !== 1
      || next.status !== 'active'
      || next.roundsStarted !== 0
      || (current !== undefined && current.status !== 'complete')
      || state.seenIds.has(next.id)) {
      return false
    }
    state.seenIds.add(next.id)
    state.createdAt = change.createdAt
    state.blockedReason = change.blockedReason
    return next
  }
  if (current === undefined
    || next.id !== current.id
    || next.revision !== (current.revision ?? 0) + 1
    || change.createdAt !== state.createdAt
    || next.updatedAt < current.updatedAt
    || next.roundsStarted !== current.roundsStarted) {
    return false
  }
  const sameDefinition = next.objective === current.objective
    && next.maxRounds === current.maxRounds
  if (change.operation === 'edit') {
    if (next.status !== current.status
      || !sameJson(change.blockedReason, state.blockedReason)) {
      return false
    }
  } else if (change.operation === 'pause') {
    if (!sameDefinition || current.status !== 'active' || next.status !== 'paused') return false
  } else if (change.operation === 'resume') {
    if (!sameDefinition
      || !['active', 'paused', 'blocked'].includes(current.status)
      || next.status !== 'active'
      || (current.roundsStarted ?? 0) >= (next.maxRounds ?? 0)) {
      return false
    }
  } else if (change.operation === 'complete') {
    if (!sameDefinition || current.status === 'complete' || next.status !== 'complete') return false
  } else if (change.operation === 'block') {
    if (!sameDefinition || current.status !== 'active' || next.status !== 'blocked') return false
  } else {
    return false
  }
  state.blockedReason = change.blockedReason
  return next
}

function advanceGoalRound(
  current: TrajectoryTaskState['target'],
  event: SessionEvent,
): TrajectoryTaskState['target'] | undefined {
  const source = object(event.data.source)
  if (source.kind !== 'goal') return current
  const round = safeInteger(source.round, 1)
  if (current === undefined
    || current.status !== 'active'
    || source.goalId !== current.id
    || source.revision !== current.revision
    || round !== (current.roundsStarted ?? 0) + 1
    || round > (current.maxRounds ?? 0)) {
    return undefined
  }
  return { ...current, roundsStarted: round }
}

interface SurfaceFold {
  currentSeqs: Set<number>
  shadowedSeqs: Set<number>
  transcriptSeqs: Set<number>
  relations: TrajectoryRelation[]
  hasReplacement: boolean
  projectedMessages: Map<number, JsonObject>
}

function canonicalIndex(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0)
}

function offloadMessageImages(messageValue: unknown, indexes: readonly number[]): JsonObject {
  const message = object(messageValue)
  if (!Array.isArray(message.content)) {
    throw new Error(`image/offload: image index ${indexes[0]} does not exist`)
  }
  let imageIndex = 0
  let selected = 0
  const content = message.content.map((value) => {
    const block = object(value)
    if (block.type !== 'image') return value
    const current = imageIndex++
    if (current !== indexes[selected]) return value
    if (block.offloaded === true) {
      throw new Error(`image/offload: image index ${current} is already offloaded`)
    }
    selected++
    return { ...block, offloaded: true }
  })
  if (selected !== indexes.length) {
    throw new Error(`image/offload: image index ${indexes[selected]} does not exist`)
  }
  return { ...message, content }
}

function messageFromSurfaceEvent(event: SessionEvent): JsonObject {
  return event.type === 'user/message' ? event.data : eventMessage(event)
}

function applyImageOffload(
  event: SessionEvent,
  nodes: readonly number[],
  eventsBySeq: ReadonlyMap<number, SessionEvent>,
  projectedMessages: Map<number, JsonObject>,
): void {
  const data = event.data
  if (!hasExactKeys(data, ['targets'])
    || !Array.isArray(data.targets)
    || data.targets.length === 0) {
    throw new Error('image/offload: data must contain a nonempty targets array')
  }
  const current = new Set(nodes)
  const next = new Map<number, JsonObject>()
  for (const targetValue of data.targets) {
    const target = object(targetValue)
    if (!hasExactKeys(target, ['seq', 'imageIndexes'])
      || !canonicalIndex(target.seq)
      || !Array.isArray(target.imageIndexes)
      || target.imageIndexes.length === 0) {
      throw new Error(
        'image/offload: each target must contain a seq and nonempty imageIndexes',
      )
    }
    const seq = target.seq
    if (next.has(seq)) {
      throw new Error(`image/offload: duplicate target seq ${seq}`)
    }
    if (!current.has(seq)) {
      throw new Error(`image/offload: target seq ${seq} is not a current surface node`)
    }
    const source = eventsBySeq.get(seq)
    if (source?.type !== 'user/message' && source?.type !== 'tool/result') {
      throw new Error(
        `image/offload: target seq ${seq} must be user/message or tool/result`,
      )
    }
    let previous = -1
    for (const index of target.imageIndexes) {
      if (!canonicalIndex(index) || index <= previous) {
        throw new Error(
          'image/offload: imageIndexes must be strictly increasing non-negative safe integers',
        )
      }
      previous = index
    }
    next.set(
      seq,
      offloadMessageImages(
        projectedMessages.get(seq) ?? messageFromSurfaceEvent(source),
        target.imageIndexes as number[],
      ),
    )
  }
  for (const [seq, message] of next) projectedMessages.set(seq, message)
}

function sourceRelations(event: SessionEvent): TrajectoryRelation[] {
  const sourceEventSeqs = event.sourceEventSeqs ?? []
  if (event.sourceEventSeqs !== undefined && sourceEventSeqs.length === 0) {
    throw new Error(
      `invalid surface event at seq ${event.seq}: sourceEventSeqs must not be empty`,
    )
  }
  if (event.type === 'assistant/message' && event.sourceEventSeqs !== undefined) {
    throw new Error(
      `invalid surface event at seq ${event.seq}: `
      + 'assistant/message cannot carry sourceEventSeqs',
    )
  }
  const sources = new Set(sourceEventSeqs)
  if (sources.size !== sourceEventSeqs.length) {
    throw new Error(
      `invalid surface event at seq ${event.seq}: `
      + 'sourceEventSeqs must not contain duplicates',
    )
  }
  const nonEarlierSource = sourceEventSeqs.find(seq =>
    !Number.isSafeInteger(seq) || seq < 0 || seq >= event.seq)
  if (nonEarlierSource !== undefined) {
    throw new Error(
      `invalid surface event at seq ${event.seq}: `
      + `sourceEventSeqs must reference earlier events (${nonEarlierSource})`,
    )
  }
  return sourceEventSeqs.map(sourceSeq => ({
    type: 'derived-from',
    from: `event:${event.seq}`,
    to: `event:${sourceSeq}`,
    fidelity: 'exact',
    sourceEventIds: [String(event.seq), String(sourceSeq)],
  }))
}

function foldSurface(events: readonly SessionEvent[]): SurfaceFold {
  const nodes: number[] = []
  const shadowedSeqs = new Set<number>()
  const transcriptSeqs = new Set<number>()
  const relations: TrajectoryRelation[] = []
  const projectedMessages = new Map<number, JsonObject>()
  const eventsBySeq = new Map(events.map(event => [event.seq, event]))
  let hasReplacement = false

  for (const event of events) {
    if (event.type === 'image/offload') {
      applyImageOffload(event, nodes, eventsBySeq, projectedMessages)
      continue
    }
    if (!SURFACE_EVENT_TYPES.has(event.type)) continue
    const derivedRelations = sourceRelations(event)
    if (event.surfaceOp === undefined || event.surfaceOp === 'append') {
      nodes.push(event.seq)
      transcriptSeqs.add(event.seq)
      relations.push(...derivedRelations)
      continue
    }

    const startIndex = nodes.indexOf(event.surfaceOp.startSeq)
    const endIndex = nodes.indexOf(event.surfaceOp.endSeq)
    if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) {
      throw new Error(
        `invalid surface replacement at seq ${event.seq}: `
        + `${event.surfaceOp.startSeq}..${event.surfaceOp.endSeq} is not current`,
      )
    }
    const replaced = nodes.slice(startIndex, endIndex + 1)
    const sources = new Set(event.sourceEventSeqs ?? [])
    const missingSources = replaced.filter(seq => !sources.has(seq))
    if (missingSources.length > 0) {
      throw new Error(
        `invalid surface replacement at seq ${event.seq}: `
        + `sourceEventSeqs misses ${missingSources.join(', ')}`,
      )
    }
    nodes.splice(startIndex, endIndex - startIndex + 1, event.seq)
    hasReplacement = true
    replaced.forEach(seq => {
      shadowedSeqs.add(seq)
      relations.push({
        type: 'replaces',
        from: `event:${event.seq}`,
        to: `event:${seq}`,
        fidelity: 'exact',
        sourceEventIds: [String(event.seq), String(seq)],
      })
    })
    relations.push(...derivedRelations)
  }

  return {
    currentSeqs: new Set(nodes),
    shadowedSeqs,
    transcriptSeqs,
    relations,
    hasReplacement,
    projectedMessages,
  }
}

function recordSurface(
  record: TrajectoryRecord,
  currentSeqs: ReadonlySet<number>,
  shadowedSeqs: ReadonlySet<number>,
): TrajectoryRecord {
  const surfaceSeqs = record.sourceEventIds
    .map(value => Number(value))
    .filter(value => Number.isSafeInteger(value))
    .filter(seq => currentSeqs.has(seq) || shadowedSeqs.has(seq))
  if (surfaceSeqs.length === 0) return record
  return {
    ...record,
    surface: surfaceSeqs.some(seq => currentSeqs.has(seq)) ? 'current' : 'shadowed',
  }
}

function bool(value: unknown): boolean {
  return value === true
}

function key(turn: number, step: number): string {
  return `${turn}:${step}`
}

export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  return asArray(content)
    .flatMap((entry) => {
      const block = object(entry)
      if (typeof block.text === 'string') return [block.text]
      if (block.type === 'tool-call') {
        const name = string(block.name) ?? 'tool'
        return [`${name} ${typeof block.arguments === 'string' ? block.arguments : jsonText(block.arguments)}`]
      }
      if (block.type === 'image') {
        return [block.offloaded === true ? '[offloaded image]' : '[image]']
      }
      if (block.type === 'file') return [`[file ${string(block.name) ?? ''}]`]
      return []
    })
    .join('\n')
}

function eventTurn(event: SessionEvent): number {
  return number(event.data.turn) ?? 0
}

function eventStep(event: SessionEvent): number {
  return number(event.data.step) ?? 0
}

function eventMessage(event: SessionEvent): JsonObject {
  return object(event.data.message)
}

function eventContent(event: SessionEvent): unknown {
  const message = eventMessage(event)
  return message.content ?? event.data.content
}

function usageFrom(value: unknown): TokenUsage | undefined {
  const source = object(value)
  const result: TokenUsage = {
    inputTokens: number(source.inputTokens),
    outputTokens: number(source.outputTokens),
    cacheReadTokens: number(source.cacheReadTokens),
    cacheWriteTokens: number(source.cacheWriteTokens),
    reasoningTokens: number(source.reasoningTokens),
    totalTokens: number(source.totalTokens),
  }
  return Object.values(result).some(entry => entry !== undefined) ? result : undefined
}

function sumUsage(values: readonly (TokenUsage | undefined)[]): TokenUsage | undefined {
  const totals: TokenUsage = {}
  for (const usage of values) {
    if (usage === undefined) continue
    for (const key of Object.keys(usage) as (keyof TokenUsage)[]) {
      const value = usage[key]
      if (value !== undefined) totals[key] = (totals[key] ?? 0) + value
    }
  }
  return Object.keys(totals).length === 0 ? undefined : totals
}

function turnStatus(end: SessionEvent | undefined): TrajectoryTurnSummary['status'] {
  if (end === undefined) return 'running'
  const kind = string(object(end.data.reason).kind)
  if (kind === 'aborted' || kind === 'cancelled' || kind === 'interrupted') return 'interrupted'
  if (kind === 'error' || kind === 'failed') return 'error'
  return 'complete'
}

function failureFrom(value: unknown): {
  name?: string
  code?: string
  reason?: string
} | undefined {
  const source = object(value)
  const message = string(source.message)
  const reason = string(source.reason) ?? message
  const name = string(source.name)
  const code = string(source.code)
  return name === undefined && code === undefined && reason === undefined
    ? undefined
    : { name, code, reason }
}

function firstTokenTime(stream: unknown): number | undefined {
  for (const itemValue of asArray(stream)) {
    const item = object(itemValue)
    const type = string(item.type)
    if (type === 'text-chunks' || type === 'reasoning-chunks' || type === 'tool-call-chunks') {
      return number(item.time0) ?? number(item.time)
    }
    const chunk = object(item.chunk)
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
      return number(item.time)
    }
  }
  return undefined
}

function lastStreamTime(stream: unknown): number | undefined {
  let latest: number | undefined
  for (const itemValue of asArray(stream)) {
    const item = object(itemValue)
    let value = number(item.time)
    const time0 = number(item.time0)
    if (time0 !== undefined) {
      let elapsed = 0
      for (const delta of asArray(item.dt)) elapsed += number(delta) ?? 0
      value = time0 + elapsed
    }
    if (value !== undefined) latest = Math.max(latest ?? value, value)
  }
  return latest
}

function sourceLabel(sourceValue: unknown): string {
  const source = object(sourceValue)
  const kind = string(source.kind) ?? 'context'
  const plugin = string(source.plugin)
  const name = string(source.name)
  return [plugin, name, kind].find(value => value !== undefined && value !== '') ?? kind
}

type DshRecord = Omit<
  TrajectoryRecord,
  'fidelity' | 'searchText' | 'source' | 'sourceEventIds'
>

function searchable(record: DshRecord): TrajectoryRecord {
  const sourceEventIds = (record.raw ?? []).flatMap((value) => {
    const event = value as Partial<SessionEvent>
    return typeof event.seq === 'number' ? [String(event.seq)] : []
  })
  return projectedRecord('dsh', {
    ...record,
    sourceEventIds,
    fidelity: 'exact',
  })
}

function messageRecord(
  event: SessionEvent,
  steeringIds: ReadonlySet<string>,
  location: { turn: number; step: number },
): TrajectoryRecord | undefined {
  const { turn, step } = location
  const content = eventContent(event)
  const text = textFromContent(content)
  if (event.type === 'system/message') {
    return searchable({
      id: `system:${event.seq}`,
      seq: event.seq,
      turn,
      step,
      kind: 'system',
      title: '系统提示词',
      summary: compactText(text) || '空系统提示词',
      startTime: event.time,
      endTime: event.time,
      status: 'complete',
      depth: 0,
      input: content,
      raw: [event],
    })
  }
  if (event.type === 'developer/message') {
    const message = eventMessage(event)
    const label = sourceLabel(message.source)
    return searchable({
      id: `context:${event.seq}`,
      seq: event.seq,
      turn,
      step,
      kind: 'context',
      title: label,
      summary: compactText(text) || '上下文更新',
      startTime: event.time,
      endTime: event.time,
      status: 'complete',
      depth: 0,
      input: content,
      raw: [event],
    })
  }
  if (event.type !== 'user/message') return undefined
  const source = object(event.data.source)
  const messageId = string(event.data.id)
  const isUser = source.kind === 'user'
  const isSteering = isUser && messageId !== undefined && steeringIds.has(messageId)
  const kind = !isUser ? 'context' : isSteering ? 'steering' : 'user'
  return searchable({
    id: `${kind}:${event.seq}`,
    seq: event.seq,
    turn,
    step,
    kind,
    title: kind === 'user' ? '用户' : kind === 'steering' ? '中途引导' : sourceLabel(source),
    summary: compactText(text) || '仅附件消息',
    startTime: event.time,
    endTime: event.time,
    status: 'complete',
    depth: 0,
    input: content,
    raw: [event],
  })
}

function assistantRecord(state: StepState, turnEnd?: SessionEvent): TrajectoryRecord | undefined {
  const final = state.messages.at(-1)
  const raw = [
    ...(state.startEvent === undefined ? [] : [state.startEvent]),
    ...(state.requestHeader === undefined ? [] : [state.requestHeader]),
    ...(state.requestContext === undefined ? [] : [state.requestContext]),
    ...state.attempts,
    ...state.retries,
    ...state.messages,
    ...(state.endEvent === undefined ? [] : [state.endEvent]),
  ]
  if (raw.length === 0 || (final === undefined && state.startEvent === undefined)) return undefined

  const startTime = state.startEvent?.time ?? final?.time ?? raw[0].time
  const boundary = state.endEvent ?? turnEnd
  const message = final === undefined ? {} : eventMessage(final)
  const blocks = message.content
  const outputText = textFromContent(blocks)
  const stream = final?.data.stream ?? state.attempts.at(-1)?.data.stream
  const firstToken = firstTokenTime(stream)
  const completedAt = final?.time ?? boundary?.time ?? null
  const interrupted = bool(final?.data.interrupted)
    || (final === undefined && boundary !== undefined)
  const status = interrupted ? 'interrupted' : final === undefined ? 'running' : 'complete'
  const usage = usageFrom(final?.data.usage)
  const retryEvent = state.retries.at(-1)
  const retryData = object(retryEvent?.data)
  const retryFailure = object(retryData.failure)
  const outputTokens = usage?.outputTokens
  const decodeMs = firstToken === undefined || completedAt === null
    ? undefined
    : Math.max(0, completedAt - firstToken)
  const throughput = outputTokens === undefined || decodeMs === undefined || decodeMs <= 0
    ? undefined
    : outputTokens / (decodeMs / 1000)
  const source = object(message.source)
  const requestHeader = object(state.requestHeader?.data.header)
  const requestConfig = object(requestHeader.config)
  const requestContext = state.requestContext?.data

  return searchable({
    id: `assistant:${state.turn}:${state.step}`,
    seq: state.startEvent?.seq ?? final?.seq ?? raw[0].seq,
    endSeq: final?.seq ?? boundary?.seq,
    turn: state.turn,
    step: state.step,
    kind: 'assistant',
    title: state.retries.length > 0 ? `助手 · 重试 ${state.retries.length} 次` : '助手',
    summary: compactText(outputText) || (status === 'running' ? '等待模型输出' : '仅工具调用'),
    startTime,
    endTime: completedAt,
    status,
    depth: 0,
    input: state.requestHeader === undefined && state.requestContext === undefined
      ? undefined
      : {
          config: requestConfig,
          tools: requestHeader.tools,
          context: requestContext,
        },
    output: blocks,
    usage,
    metrics: {
      ttftMs: firstToken === undefined ? undefined : Math.max(0, firstToken - startTime),
      decodeMs,
      throughput,
    },
    provider: string(source.provider) ?? string(requestConfig.provider),
    model: string(source.model) ?? string(requestConfig.model),
    retry: state.retries.length === 0
      ? undefined
      : {
          count: number(retryData.retry) ?? state.retries.length,
          maxRetries: number(retryData.maxRetries),
          delayMs: number(retryData.delayMs),
          message: string(retryFailure.message),
          code: string(retryFailure.code),
        },
    raw,
  })
}

function toolCallIdFromResult(event: SessionEvent | undefined): string | undefined {
  if (event === undefined) return undefined
  const message = eventMessage(event)
  const source = object(message.source)
  return string(source.callId) ?? string(message.toolCallId)
}

function toolDepth(tool: ToolState, tools: ReadonlyMap<string, ToolState>): number {
  if (!tool.nested) return 0
  let depth = 1
  let parent = tool.parentCallId
  const visited = new Set<string>()
  while (parent !== undefined && !visited.has(parent) && depth < 256) {
    visited.add(parent)
    const candidate = tools.get(parent)
    if (candidate === undefined || !candidate.nested) break
    depth++
    parent = candidate.parentCallId
  }
  return depth
}

function toolRecord(tool: ToolState, tools: ReadonlyMap<string, ToolState>, steps: ReadonlyMap<string, StepState>): TrajectoryRecord | undefined {
  const anchor = tool.start ?? tool.end
  if (anchor === undefined) return undefined
  const callId = tool.subCallId
    ?? string(tool.start?.data.callId)
    ?? toolCallIdFromResult(tool.end)
    ?? `seq-${anchor.seq}`
  const endData = object(tool.end?.data)
  const resultMessage = object(endData.message)
  const isError = bool(endData.isError) || bool(resultMessage.isError)
  const step = steps.get(key(tool.turn, tool.step))
  const interruptedAt = tool.end === undefined ? step?.endEvent : undefined
  const status = isError ? 'error' : tool.end !== undefined ? 'complete' : interruptedAt !== undefined ? 'interrupted' : 'running'
  const output = tool.nested ? endData.content : resultMessage.content
  const error = failureFrom(endData.error)
    ?? (status === 'interrupted' ? { name: 'Interrupted', code: 'interrupted' } : undefined)
  const raw = [tool.start, tool.end].filter((event): event is SessionEvent => event !== undefined)

  return searchable({
    id: `${tool.nested ? 'subtool' : 'tool'}:${callId}`,
    seq: anchor.seq,
    endSeq: tool.end?.seq ?? interruptedAt?.seq,
    turn: tool.turn,
    step: tool.step,
    kind: tool.nested ? 'subtool' : 'tool',
    title: tool.name || '未知工具',
    summary: compactText(`${jsonText(tool.args)}${output === undefined ? '' : ` → ${textFromContent(output) || jsonText(output)}`}`),
    startTime: tool.start?.time ?? anchor.time,
    endTime: tool.end?.time ?? interruptedAt?.time ?? null,
    status,
    depth: toolDepth(tool, tools),
    callId,
    parentCallId: tool.parentCallId,
    input: tool.args,
    output,
    error,
    raw,
  })
}

function compactionRecord(id: string, state: CompactionState): TrajectoryRecord | undefined {
  const start = state.start
  if (start === undefined) return undefined
  const summary = state.summary
  const end = state.end
  const errorMessage = string(end?.data.error)
  const status = end === undefined ? 'running' : errorMessage === undefined ? 'complete' : 'error'
  const usage = usageFrom(summary?.data.usage)
  return searchable({
    id: `compaction:${id}`,
    seq: start.seq,
    endSeq: end?.seq,
    turn: eventTurn(start),
    step: 0,
    kind: 'compaction',
    title: '上下文压缩',
    summary: compactText(string(summary?.data.summary) ?? errorMessage ?? '正在压缩上下文'),
    startTime: start.time,
    endTime: end?.time ?? null,
    status,
    depth: 0,
    output: summary?.data.summary,
    error: errorMessage === undefined ? undefined : { reason: errorMessage },
    usage,
    provider: string(summary?.data.provider),
    model: string(summary?.data.model),
    raw: [start, summary, end].filter((event): event is SessionEvent => event !== undefined),
  })
}

function steeringMessageIds(events: readonly SessionEvent[]): Set<string> {
  const pending: string[] = []
  const claimed = new Set<string>()
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced' || event.data.target !== 'next-step') continue
    const start = number(event.data.start) ?? 0
    const removedCount = number(event.data.removedCount) ?? 0
    const inserted = asArray(event.data.inserted)
      .map(value => string(object(value).id))
      .filter((value): value is string => value !== undefined)
    if (removedCount > 0 && event.data.outcome !== 'canceled') {
      for (const id of pending.splice(start, removedCount, ...inserted)) claimed.add(id)
    } else {
      pending.splice(start, removedCount, ...inserted)
      for (const id of inserted) claimed.delete(id)
    }
  }
  return claimed
}

function finalizeBounds(header: SessionHeader, events: readonly SessionEvent[]): [number, number] {
  const headerTime = typeof header.createdAt === 'number'
    ? header.createdAt
    : Date.parse(header.createdAt)
  const start = events[0]?.time ?? (Number.isFinite(headerTime) ? headerTime : Date.now())
  return [start, events.at(-1)?.time ?? start]
}

export function projectTrajectory(header: SessionHeader, events: readonly SessionEvent[]): TrajectoryProjection {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  const surface = foldSurface(sorted)
  const locations = new Map<number, { turn: number; step: number }>()
  const steps = new Map<string, StepState>()
  const turnStarts = new Map<number, SessionEvent>()
  const turnEnds = new Map<number, SessionEvent>()
  const tools = new Map<string, ToolState>()
  const compactions = new Map<string, CompactionState>()
  const messageEvents: SessionEvent[] = []
  const eventTypeCounts: Record<string, number> = {}
  const unknown = new Set<string>()
  const semanticFailures = new Map<string, number>()
  let latestRequestHeader: SessionEvent | undefined
  let latestRequestContext: SessionEvent | undefined
  let taskTarget: TrajectoryTaskState['target']
  let taskTodos: TrajectoryTaskState['todos'] | undefined
  const goalState: GoalFoldState = { seenIds: new Set(), failed: false }

  const ensureStep = (turn: number, step: number): StepState => {
    const stepKey = key(turn, step)
    const existing = steps.get(stepKey)
    if (existing !== undefined) return existing
    const created: StepState = { turn, step, messages: [], attempts: [], retries: [] }
    steps.set(stepKey, created)
    return created
  }

  let activeTurn = 0
  let activeStep = 0
  for (const event of sorted) {
    if (event.type === 'turn/start') activeTurn = eventTurn(event)
    if (event.type === 'step/start') {
      activeTurn = eventTurn(event) || activeTurn
      activeStep = eventStep(event)
    }
    locations.set(event.seq, {
      turn: eventTurn(event) || activeTurn,
      step: eventStep(event) || activeStep,
    })
    if (event.type === 'step/end') activeStep = 0
    if (event.type === 'turn/end') {
      activeTurn = 0
      activeStep = 0
    }
  }

  for (const event of sorted) {
    eventTypeCounts[event.type] = (eventTypeCounts[event.type] ?? 0) + 1
    if (!KNOWN_EVENT_TYPES.has(event.type)) unknown.add(event.type)
    const location = locations.get(event.seq) ?? { turn: 0, step: 0 }
    const { turn, step } = location

    if (event.type === 'system/message' || event.type === 'user/message' || event.type === 'developer/message') {
      messageEvents.push(event)
      if (event.type === 'user/message' && object(event.data.source).kind === 'goal') {
        if (goalState.failed) {
          semanticFailures.set(event.type, (semanticFailures.get(event.type) ?? 0) + 1)
        } else {
          const advanced = advanceGoalRound(taskTarget, event)
          if (advanced === undefined) {
            goalState.failed = true
            semanticFailures.set(event.type, (semanticFailures.get(event.type) ?? 0) + 1)
          } else {
            taskTarget = advanced
          }
        }
      }
    } else if (event.type === 'goal/change') {
      if (goalState.failed) {
        semanticFailures.set(event.type, (semanticFailures.get(event.type) ?? 0) + 1)
      } else {
        const change = goalChange(event)
        if (change === undefined) {
          goalState.failed = true
          semanticFailures.set(event.type, (semanticFailures.get(event.type) ?? 0) + 1)
        } else {
          const next = applyGoalChange(goalState, taskTarget, change)
          if (next === false) {
            goalState.failed = true
            semanticFailures.set(event.type, (semanticFailures.get(event.type) ?? 0) + 1)
          } else {
            taskTarget = next
          }
        }
      }
    } else if (event.type === 'todo/write') {
      const todos = todoSnapshot(event)
      if (todos === undefined) {
        semanticFailures.set(event.type, (semanticFailures.get(event.type) ?? 0) + 1)
      } else {
        taskTodos = todos
      }
    } else if (event.type === 'turn/start') {
      taskTodos = undefined
      turnStarts.set(turn, event)
    } else if (event.type === 'step/start') {
      const state = ensureStep(turn, step)
      state.startEvent = event
      state.requestHeader = latestRequestHeader
      state.requestContext = latestRequestContext
    } else if (event.type === 'step/end') {
      ensureStep(turn, step).endEvent = event
    } else if (event.type === 'assistant/message') {
      ensureStep(turn, step).messages.push(event)
    } else if (event.type === 'assistant/attempt') {
      ensureStep(turn, step).attempts.push(event)
    } else if (event.type === 'llm/retry') {
      ensureStep(turn, step).retries.push(event)
    } else if (event.type === 'request/header') {
      latestRequestHeader = event
      ensureStep(turn, step).requestHeader = event
    } else if (event.type === 'request/context') {
      latestRequestContext = event
      ensureStep(turn, step).requestContext = event
    } else if (event.type === 'turn/end') {
      turnEnds.set(turn, event)
    } else if (event.type === 'tool/call') {
      const callId = string(event.data.callId) ?? `seq-${event.seq}`
      tools.set(callId, {
        ...tools.get(callId),
        start: event,
        name: string(event.data.name) ?? '',
        args: parseRawArgs(event.data.arguments),
        turn,
        step,
        nested: false,
      })
    } else if (event.type === 'tool/result') {
      const callId = toolCallIdFromResult(event) ?? `seq-${event.seq}`
      const previous = tools.get(callId)
      tools.set(callId, {
        ...previous,
        end: event,
        name: previous?.name ?? '',
        args: previous?.args,
        turn: previous?.turn ?? turn,
        step: previous?.step ?? step,
        nested: false,
      })
    } else if (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') {
      const subCallId = string(event.data.subCallId) ?? `seq-${event.seq}`
      const rootCallId = string(event.data.rootCallId)
      const root = rootCallId === undefined ? undefined : tools.get(rootCallId)
      const previous = tools.get(subCallId)
      tools.set(subCallId, {
        ...previous,
        ...(event.type === 'tool/ptc-dispatch-start' ? { start: event } : { end: event }),
        rootCallId,
        parentCallId: string(event.data.parentCallId),
        subCallId,
        name: string(event.data.name) ?? previous?.name ?? '',
        args: event.data.arguments,
        turn: previous?.turn ?? root?.turn ?? turn,
        step: previous?.step ?? root?.step ?? step,
        nested: true,
      })
    } else if (event.type === 'compaction/start' || event.type === 'compaction/summary' || event.type === 'compaction/end') {
      const id = string(event.data.compactionId) ?? `seq-${event.seq}`
      const previous = compactions.get(id) ?? {}
      compactions.set(id, {
        ...previous,
        ...(event.type === 'compaction/start' ? { start: event } : {}),
        ...(event.type === 'compaction/summary' ? { summary: event } : {}),
        ...(event.type === 'compaction/end' ? { end: event } : {}),
      })
    }
  }

  const steeringIds = steeringMessageIds(sorted)
  const records = [
    ...messageEvents.map(event => messageRecord(
      event,
      steeringIds,
      locations.get(event.seq) ?? { turn: 0, step: 0 },
    )),
    ...[...steps.values()].map(state => assistantRecord(state, turnEnds.get(state.turn))),
    ...[...tools.values()].map(tool => toolRecord(tool, tools, steps)),
    ...[...compactions].map(([id, state]) => compactionRecord(id, state)),
  ]
    .filter((record): record is TrajectoryRecord => record !== undefined)
    .map(record => recordSurface(record, surface.currentSeqs, surface.shadowedSeqs))
    .sort((a, b) => {
      if (a.turn !== b.turn) return a.turn - b.turn
      if (a.step !== b.step) return a.step - b.step
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
      return priority[a.kind] - priority[b.kind]
        || a.seq - b.seq
        || a.depth - b.depth
        || a.id.localeCompare(b.id)
    })

  const [startTime, endTime] = finalizeBounds(header, sorted)
  const recordIdBySurfaceSeq = new Map<number, string>()
  for (const record of records) {
    for (const sourceEventId of record.sourceEventIds) {
      const seq = Number(sourceEventId)
      if (Number.isSafeInteger(seq)
        && (surface.currentSeqs.has(seq) || surface.shadowedSeqs.has(seq))) {
        recordIdBySurfaceSeq.set(seq, record.id)
      }
    }
  }
  const transcriptRecordIds = [...new Set(
    [...surface.transcriptSeqs]
      .map(seq => recordIdBySurfaceSeq.get(seq))
      .filter((id): id is string => id !== undefined),
  )]
  const modelContextRecordIds = surface.hasReplacement
    || surface.projectedMessages.size > 0
    ? [...new Set(
        sorted
          .filter(event => surface.currentSeqs.has(event.seq))
          .map(event => recordIdBySurfaceSeq.get(event.seq))
          .filter((id): id is string => id !== undefined),
      )]
    : undefined
  const recordsById = new Map(records.map(record => [record.id, record]))
  const modelContextRecordOverrides = Object.fromEntries(
    [...surface.projectedMessages].flatMap(([seq, message]) => {
      const recordId = recordIdBySurfaceSeq.get(seq)
      const record = recordId === undefined ? undefined : recordsById.get(recordId)
      if (record === undefined) return []
      const content = redactSensitive(message.content)
      const override = redactSensitive({
        ...(record.kind === 'tool' || record.kind === 'subtool'
          ? { output: content }
          : { input: content }),
        summary: record.kind === 'tool' || record.kind === 'subtool'
          ? compactText(`${jsonText(record.input)} → ${textFromContent(content)}`)
          : compactText(textFromContent(content)),
      }) as ModelContextRecordOverride
      return [[record.id, override] as const]
    }),
  )
  const coverage = Object.entries(eventTypeCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, total]) => {
      const disposition = eventDisposition(type)
      const failed = disposition === 'folded-state'
        ? semanticFailures.get(type) ?? 0
        : 0
      const consumed = disposition === 'raw-only' || disposition === 'unsupported'
        ? 0
        : total - failed
      return {
        type,
        total,
        consumed,
        disposition,
        ...(failed > 0
          ? {
              reason: `${failed} event${failed === 1 ? '' : 's'} failed semantic validation and ${
                failed === 1 ? 'remains' : 'remain'
              } audit-only`,
            }
          : disposition === 'raw-only'
          ? { reason: 'known event is retained for audit but has no semantic projector' }
          : disposition === 'unsupported'
            ? { reason: 'event type is not supported by this projector' }
            : {}),
      }
    })
  const coverageConsumed = coverage.reduce((total, item) => total + item.consumed, 0)
  const turnNumbers = new Set<number>([
    ...turnStarts.keys(),
    ...turnEnds.keys(),
    ...records.map(record => record.turn),
  ])
  turnNumbers.delete(0)
  const recordsByTurn = new Map<number, TrajectoryRecord[]>()
  for (const record of records) {
    const grouped = recordsByTurn.get(record.turn) ?? []
    grouped.push(record)
    recordsByTurn.set(record.turn, grouped)
  }
  const turns: TrajectoryTurnSummary[] = [...turnNumbers]
    .sort((a, b) => a - b)
    .map((turn) => {
      const start = turnStarts.get(turn)
      const end = turnEnds.get(turn)
      const turnRecords = recordsByTurn.get(turn) ?? []
      const usage = sumUsage(turnRecords.map(record => record.usage))
      const firstRecordTime = turnRecords[0]?.startTime
      const startAt = start?.time ?? firstRecordTime ?? end?.time ?? startTime
      const model = turnRecords.find(record =>
        record.kind === 'assistant' && record.model !== undefined)?.model
      const ttftMs = turnRecords.find(record =>
        record.kind === 'assistant' && record.metrics?.ttftMs !== undefined)
        ?.metrics?.ttftMs
      return {
        id: String(turn),
        number: turn,
        startTime: startAt,
        endTime: end?.time ?? null,
        status: turnStatus(end),
        reason: end?.data.reason,
        usage,
        metrics: ttftMs === undefined ? undefined : { ttftMs },
        model,
      }
    })
  const currentModelRecord = [...records]
    .reverse()
    .find(record => record.model !== undefined)
  return {
    header: {
      source: 'dsh',
      format: 'session-v4',
      id: header.id,
      createdAt: header.createdAt,
      cwd: header.cwd,
      parentSessionId: header.parentSession,
      origin: header.origin,
      delegationDepth: header.delegationDepth,
      provider: currentModelRecord?.provider,
      model: currentModelRecord?.model,
      rawVersion: header.version,
    },
    records,
    turns,
    lanes: [
      { id: 'input', label: '输入' },
      { id: 'model', label: '模型' },
      { id: 'tools', label: '工具' },
    ],
    startTime,
    endTime,
    eventCount: sorted.length,
    eventTypeCounts,
    unknownEventTypes: [...unknown].sort(),
    transcriptRecordIds,
    modelContextRecordIds,
    ...(Object.keys(modelContextRecordOverrides).length === 0
      ? {}
      : { modelContextRecordOverrides }),
    relations: surface.relations,
    coverage,
    coverageSummary: {
      total: sorted.length,
      consumed: coverageConsumed,
      gap: sorted.length - coverageConsumed,
    },
    taskState: taskTarget === undefined && taskTodos === undefined
      ? undefined
      : {
          target: taskTarget,
          todos: taskTodos ?? [],
        },
    turnEnds: Object.fromEntries(
      [...turnEnds].map(([turn, event]) => [turn, { time: event.time, reason: event.data.reason }]),
    ),
    usage: sumUsage(turns.map(turn => turn.usage)),
  }
}
