import type {
  RecordKind,
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
  asJsonObject as object,
  asString as string,
  compactText,
  projectedRecord,
  redactSensitive,
} from '../../src/projector-utils'

export interface DoubaoWorkRow {
  role?: string
  content?: unknown
  tool_calls?: unknown
  tool_call_id?: string
  image_link_list?: unknown
  [key: string]: unknown
}

export interface DoubaoWorkAgentInput {
  agentId: string
  rows: DoubaoWorkRow[]
}

export interface DoubaoWorkProjectionInput {
  sessionId: string
  createdAt: number
  agents: DoubaoWorkAgentInput[]
}

interface AgentState extends DoubaoWorkAgentInput {
  depth: number
  parentAgentId?: string
  spawnToolId?: string
}

interface ToolCall {
  agent: AgentState
  callId: string
  name: string
  input: unknown
  row: DoubaoWorkRow
  rowIndex: number
  seq: number
}

interface ToolResult {
  row: DoubaoWorkRow
  rowIndex: number
  seq: number
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap((entry) => {
    if (typeof entry === 'string') return [entry]
    const block = object(entry)
    return [string(block.text) ?? string(block.content) ?? '']
  }).filter(Boolean).join('\n')
}

function messageContent(value: unknown): unknown[] {
  const text = textContent(value)
  return text === '' ? [] : [{ type: 'text', text }]
}

function safeRaw(
  agentId: string,
  rowIndex: number,
  row: DoubaoWorkRow,
): unknown {
  return redactSensitive({ agentId, row: rowIndex + 1, ...row })
}

function searchable(
  record: Omit<TrajectoryRecord, 'searchText' | 'source'>,
): TrajectoryRecord {
  return projectedRecord('doubao-work', record)
}

function isRootAgent(agentId: string): boolean {
  return agentId.startsWith('m_')
}

function callRows(agent: AgentState): ToolCall[] {
  return agent.rows.flatMap((row, rowIndex) =>
    array(row.tool_calls).flatMap((candidate, callIndex) => {
      const call = object(candidate)
      const fn = object(call.function)
      const callId = string(call.id)
      if (callId === undefined) return []
      return [{
        agent,
        callId,
        name: string(fn.name) ?? '工具',
        input: fn.arguments,
        row,
        rowIndex,
        seq: rowIndex * 10 + callIndex + 1,
      }]
    }))
}

function resultRows(agent: AgentState): Map<string, ToolResult> {
  return new Map(agent.rows.flatMap((row, rowIndex) => {
    if (row.role !== 'tool' || typeof row.tool_call_id !== 'string') return []
    return [[row.tool_call_id, {
      row,
      rowIndex,
      seq: rowIndex * 10,
    }] as const]
  }))
}

function deriveAgents(input: DoubaoWorkProjectionInput): AgentState[] {
  const base = input.agents.map(agent => ({
    ...agent,
    depth: isRootAgent(agent.agentId) ? 0 : 1,
  }))
  const spawnLinks = new Map<string, {
    parentAgentId: string
    spawnToolId: string
  }>()
  for (const agent of base) {
    const calls = new Map(callRows(agent).map(call => [call.callId, call]))
    for (const [callId, result] of resultRows(agent)) {
      const call = calls.get(callId)
      if (call?.name !== 'create_agent') continue
      const output = textContent(result.row.content)
      for (const candidate of base) {
        if (candidate.agentId !== agent.agentId
          && output.includes(candidate.agentId)) {
          spawnLinks.set(candidate.agentId, {
            parentAgentId: agent.agentId,
            spawnToolId: `tool:${agent.agentId}:${callId}`,
          })
        }
      }
    }
  }
  const depth = (agentId: string, seen = new Set<string>()): number => {
    if (seen.has(agentId)) return isRootAgent(agentId) ? 0 : 1
    const link = spawnLinks.get(agentId)
    if (link === undefined) return isRootAgent(agentId) ? 0 : 1
    seen.add(agentId)
    return depth(link.parentAgentId, seen) + 1
  }
  return base.map(agent => {
    const link = spawnLinks.get(agent.agentId)
    return {
      ...agent,
      depth: depth(agent.agentId),
      parentAgentId: link?.parentAgentId,
      spawnToolId: link?.spawnToolId,
    }
  }).sort((left, right) =>
    left.depth - right.depth
    || left.agentId.localeCompare(right.agentId))
}

export function projectDoubaoWorkTrajectory(
  input: DoubaoWorkProjectionInput,
): TrajectoryProjection {
  const agents = deriveAgents(input)
  const records: TrajectoryRecord[] = []
  const relations: TrajectoryRelation[] = []
  const turns = new Map<number, TrajectoryTurnSummary>()
  let globalSeq = 0
  let currentTurn = 0
  const firstRecordByAgent = new Map<string, string>()

  for (const agent of agents) {
    const results = resultRows(agent)
    for (let rowIndex = 0; rowIndex < agent.rows.length; rowIndex++) {
      const row = agent.rows[rowIndex]!
      const logicalTime = input.createdAt + globalSeq
      if (row.role === 'user' && textContent(row.content) !== '') currentTurn++
      const turn = Math.max(1, currentTurn)
      const existingTurn = turns.get(turn)
      turns.set(turn, existingTurn === undefined
        ? {
            id: `turn:${turn}`,
            number: turn,
            startTime: logicalTime,
            endTime: logicalTime,
            status: 'complete',
          }
        : { ...existingTurn, endTime: logicalTime })

      const content = messageContent(row.content)
      if ((row.role === 'user' || row.role === 'assistant') && content.length > 0) {
        const id = `message:${agent.agentId}:${rowIndex}`
        firstRecordByAgent.set(agent.agentId, firstRecordByAgent.get(agent.agentId) ?? id)
        records.push(searchable({
          id,
          sourceEventIds: [`${agent.agentId}:${rowIndex}`],
          fidelity: 'derived',
          seq: globalSeq++,
          turn,
          step: row.role === 'user' ? 0 : 1,
          kind: row.role,
          title: row.role === 'user' ? '用户' : '助手',
          summary: compactText(textContent(row.content)),
          startTime: logicalTime,
          endTime: logicalTime,
          status: 'complete',
          depth: agent.depth,
          spanId: `agent:${agent.agentId}`,
          parentSpanId: agent.parentAgentId === undefined
            ? undefined
            : `agent:${agent.parentAgentId}`,
          input: row.role === 'user' ? content : undefined,
          output: row.role === 'assistant' ? content : undefined,
          raw: [safeRaw(agent.agentId, rowIndex, row)],
        }))
      }

      for (const call of callRows(agent).filter(call =>
        call.rowIndex === rowIndex)) {
        const result = results.get(call.callId)
        const output = result?.row.content
        const resultText = textContent(output)
        const isError = resultText !== ''
          && /"isError"\s*:\s*true|error_msg|error_code/i.test(resultText)
        const id = `tool:${agent.agentId}:${call.callId}`
        firstRecordByAgent.set(agent.agentId, firstRecordByAgent.get(agent.agentId) ?? id)
        records.push(searchable({
          id,
          sourceEventIds: [
            `${agent.agentId}:${call.rowIndex}:call:${call.callId}`,
            ...(result === undefined
              ? []
              : [`${agent.agentId}:${result.rowIndex}:result:${call.callId}`]),
          ],
          fidelity: 'derived',
          seq: globalSeq++,
          endSeq: result === undefined ? undefined : globalSeq,
          turn,
          step: 1,
          kind: 'tool',
          title: call.name,
          summary: compactText(
            `${JSON.stringify(call.input) ?? ''}${
              result === undefined ? '' : ` → ${resultText}`
            }`,
          ),
          startTime: logicalTime,
          endTime: result === undefined
            ? null
            : input.createdAt + globalSeq,
          status: result === undefined ? 'running' : isError ? 'error' : 'complete',
          depth: agent.depth,
          spanId: `agent:${agent.agentId}`,
          parentSpanId: agent.parentAgentId === undefined
            ? undefined
            : `agent:${agent.parentAgentId}`,
          callId: call.callId,
          input: call.input,
          output,
          error: isError ? { name: 'ToolError', reason: resultText } : undefined,
          raw: [
            safeRaw(agent.agentId, call.rowIndex, call.row),
            ...(result === undefined
              ? []
              : [safeRaw(agent.agentId, result.rowIndex, result.row)]),
          ],
        }))
      }
      if (row.role === 'tool') globalSeq++
    }
  }

  for (const agent of agents) {
    if (agent.spawnToolId === undefined) continue
    const first = firstRecordByAgent.get(agent.agentId)
    if (first === undefined) continue
    relations.push({
      type: 'spawned',
      from: agent.spawnToolId,
      to: first,
      fidelity: 'derived',
      sourceEventIds: [agent.spawnToolId, agent.agentId],
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
  for (const agent of agents) {
    for (const row of agent.rows) {
      const name = row.role === 'assistant' && array(row.tool_calls).length > 0
        ? 'assistant/tool_calls'
        : row.role ?? 'unknown'
      eventTypeCounts[name] = (eventTypeCounts[name] ?? 0) + 1
    }
  }
  const totalRows = agents.reduce((total, agent) => total + agent.rows.length, 0)
  const endTime = input.createdAt + Math.max(0, globalSeq - 1)
  const projectedEvents = projectedSourceEventIds(records)
  const rowConsumed = (agent: AgentState, rowIndex: number): boolean => {
    const prefix = `${agent.agentId}:${rowIndex}`
    return [...projectedEvents].some(id => id === prefix || id.startsWith(`${prefix}:`))
  }
  const coverage = projectionCoverage(eventTypeCounts, totalRows, (type) => {
    if (type === 'user' || type === 'assistant'
      || type === 'assistant/tool_calls' || type === 'tool') {
      return {
        disposition: 'record',
        consumed: agents.reduce((total, agent) =>
          total + agent.rows.filter((row, rowIndex) => {
            const rowType = row.role === 'assistant' && array(row.tool_calls).length > 0
              ? 'assistant/tool_calls'
              : row.role ?? 'unknown'
            return rowType === type && rowConsumed(agent, rowIndex)
          }).length, 0),
      }
    }
    return {
      disposition: 'unsupported',
      reason: 'row role is not supported by the Doubao Work projector',
    }
  })
  return {
    header: {
      source: 'doubao-work',
      format: 'doubao-work-agent-trajectory-jsonl',
      id: input.sessionId,
      createdAt: input.createdAt,
    },
    records,
    turns: [...turns.values()],
    lanes: [
      { id: 'input', label: '输入' },
      { id: 'model', label: '模型' },
      { id: 'tools', label: '工具' },
    ],
    startTime: input.createdAt,
    endTime,
    eventCount: totalRows,
    eventTypeCounts,
    unknownEventTypes: Object.keys(eventTypeCounts)
      .filter(type => ![
        'user',
        'assistant',
        'assistant/tool_calls',
        'tool',
      ].includes(type))
      .sort(),
    ...coverage,
    relations,
    turnEnds: Object.fromEntries([...turns.values()].flatMap(turn =>
      turn.endTime === null ? [] : [[turn.number, {
        time: turn.endTime,
        reason: turn.status,
      }]])),
  }
}
