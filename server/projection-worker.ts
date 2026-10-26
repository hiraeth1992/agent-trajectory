import { parentPort } from 'node:worker_threads'
import { projectTrajectory } from '../src/projector'
import {
  withProjectedRecordCache,
  type ProjectedRecordCache,
} from '../src/projector-utils'
import type {
  SessionEvent,
  SessionHeader,
  SourceId,
  TrajectoryProjection,
} from '../src/types'
import {
  projectCodexTrajectory,
  type CodexEnvelope,
} from './projectors/codex'
import {
  projectClaudeCodeTrajectory,
  type ClaudeCodeEnvelope,
} from './projectors/claude-code'
import {
  projectDoubaoWorkTrajectory,
  type DoubaoWorkProjectionInput,
} from './projectors/doubao-work'
import {
  projectOpenCodeTrajectory,
  type OpenCodeProjectionInput,
} from './projectors/opencode'
import {
  projectQoderTrajectory,
  type QoderProjectionInput,
} from './projectors/qoder'
import {
  projectWorkBuddyTrajectory,
  type WorkBuddyProjectionInput,
} from './projectors/workbuddy'
import {
  projectZcodeTrajectory,
  type ZcodeProjectionInput,
} from './projectors/zcode'

type ProjectionSource = SourceId
type ProjectionMode = 'snapshot' | 'append'

interface ProjectionRequest {
  requestId: number
  sentAt: number
  source: ProjectionSource
  key: string
  mode: ProjectionMode
  header?: SessionHeader
  events?: SessionEvent[]
  envelopes?: CodexEnvelope[]
  claudeEnvelopes?: ClaudeCodeEnvelope[]
  doubaoWork?: DoubaoWorkProjectionInput
  opencode?: OpenCodeProjectionInput
  qoder?: QoderProjectionInput
  workbuddy?: WorkBuddyProjectionInput
  zcode?: ZcodeProjectionInput
}

interface DshState {
  source: 'dsh'
  header: SessionHeader
  events: SessionEvent[]
  records: ProjectedRecordCache
}

interface CodexState {
  source: 'codex'
  envelopes: CodexEnvelope[]
  records: ProjectedRecordCache
}

type ProjectionState = DshState | CodexState

const STATE_MAX_ENTRIES = 16
const STATE_MAX_BYTES = 192 * 1024 * 1024
const states = new Map<string, { value: ProjectionState; bytes: number }>()
let stateBytes = 0

function stateWeight(state: ProjectionState): number {
  return Buffer.byteLength(JSON.stringify({
    ...state,
    records: [...state.records.values()],
  }))
}

function stateGet(key: string): ProjectionState | undefined {
  const entry = states.get(key)
  if (entry === undefined) return undefined
  states.delete(key)
  states.set(key, entry)
  return entry.value
}

function stateSet(key: string, value: ProjectionState): void {
  const previous = states.get(key)
  if (previous !== undefined) {
    states.delete(key)
    stateBytes -= previous.bytes
  }
  const bytes = stateWeight(value)
  states.set(key, { value, bytes })
  stateBytes += bytes
  while (states.size > STATE_MAX_ENTRIES || stateBytes > STATE_MAX_BYTES) {
    const oldest = states.keys().next().value as string | undefined
    if (oldest === undefined) break
    const removed = states.get(oldest)
    states.delete(oldest)
    stateBytes -= removed?.bytes ?? 0
  }
}

function dshProjection(request: ProjectionRequest): TrajectoryProjection | undefined {
  if (request.header === undefined || request.events === undefined) {
    throw new Error('invalid DSH projection request')
  }
  let state = stateGet(request.key)
  if (request.mode === 'append') {
    if (state?.source !== 'dsh'
      || state.header.id !== request.header.id
      || (request.events[0]?.seq ?? state.events.length) !== state.events.length) {
      return undefined
    }
    state.events.push(...request.events)
  } else {
    state = {
      source: 'dsh',
      header: request.header,
      events: [...request.events],
      records: new Map(),
    }
  }
  const projection = withProjectedRecordCache(state.records, () =>
    projectTrajectory(state.header, state.events))
  stateSet(request.key, state)
  return projection
}

function codexProjection(request: ProjectionRequest): TrajectoryProjection | undefined {
  if (request.envelopes === undefined) {
    throw new Error('invalid Codex projection request')
  }
  let state = stateGet(request.key)
  if (request.mode === 'append') {
    const firstOrdinal = request.envelopes[0]?.ordinal
    if (state?.source !== 'codex'
      || (firstOrdinal ?? state.envelopes.length) !== state.envelopes.length) {
      return undefined
    }
    state.envelopes.push(...request.envelopes)
  } else {
    state = {
      source: 'codex',
      envelopes: [...request.envelopes],
      records: new Map(),
    }
  }
  const projection = withProjectedRecordCache(state.records, () =>
    projectCodexTrajectory(state.envelopes))
  stateSet(request.key, state)
  return projection
}

function project(request: ProjectionRequest): TrajectoryProjection | undefined {
  if (request.source === 'dsh') return dshProjection(request)
  if (request.source === 'codex') return codexProjection(request)
  if (request.source === 'claude') {
    if (request.claudeEnvelopes === undefined) {
      throw new Error('invalid Claude Code projection request')
    }
    return projectClaudeCodeTrajectory(request.claudeEnvelopes)
  }
  if (request.source === 'doubao-work') {
    if (request.doubaoWork === undefined) {
      throw new Error('invalid Doubao Work projection request')
    }
    return projectDoubaoWorkTrajectory(request.doubaoWork)
  }
  if (request.source === 'workbuddy') {
    if (request.workbuddy === undefined) {
      throw new Error('invalid WorkBuddy projection request')
    }
    return projectWorkBuddyTrajectory(request.workbuddy)
  }
  if (request.source === 'qoder') {
    if (request.qoder === undefined) {
      throw new Error('invalid Qoder projection request')
    }
    return projectQoderTrajectory(request.qoder)
  }
  if (request.source === 'opencode') {
    if (request.opencode === undefined) {
      throw new Error('invalid OpenCode projection request')
    }
    return projectOpenCodeTrajectory(request.opencode)
  }
  if (request.zcode === undefined) throw new Error('invalid ZCode projection request')
  return projectZcodeTrajectory(request.zcode)
}

if (parentPort === null) throw new Error('projection worker requires a parent port')

parentPort.on('message', (request: ProjectionRequest) => {
  const workerStartedAt = Date.now()
  try {
    const projection = project(request)
    parentPort?.postMessage({
      requestId: request.requestId,
      ok: true,
      workerStartedAt,
      workerCompletedAt: Date.now(),
      workerMetrics: {
        stateEntries: states.size,
        stateBytes,
      },
      ...(projection === undefined ? { needsSnapshot: true } : { projection }),
    })
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught))
    parentPort?.postMessage({
      requestId: request.requestId,
      ok: false,
      workerStartedAt,
      workerCompletedAt: Date.now(),
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    })
  }
})
