import { Worker, type WorkerOptions } from 'node:worker_threads'
import type {
  SessionEvent,
  SessionHeader,
  SourceId,
  TrajectoryProjection,
} from '../src/types'
import type { CodexEnvelope } from './projectors/codex'
import type { ClaudeCodeEnvelope } from './projectors/claude-code'
import type { DoubaoWorkProjectionInput } from './projectors/doubao-work'
import type { OpenCodeProjectionInput } from './projectors/opencode'
import type { QoderProjectionInput } from './projectors/qoder'
import type { WorkBuddyProjectionInput } from './projectors/workbuddy'
import type { ZcodeProjectionInput } from './projectors/zcode'
import { workerLocation } from './worker-location'

type WorkerFactory = (filename: URL, options: WorkerOptions) => Worker

interface ProjectionReply {
  requestId: number
  ok: boolean
  workerStartedAt?: number
  workerCompletedAt?: number
  projection?: TrajectoryProjection
  needsSnapshot?: boolean
  workerMetrics?: {
    stateEntries: number
    stateBytes: number
  }
  error?: {
    name: string
    message: string
    stack?: string
  }
}

interface PendingProjection {
  resolve(value: ProjectionReply): void
  reject(error: Error): void
  enqueuedAt: number
  sentAt: number
  timer: NodeJS.Timeout
}

interface ProjectionMessage {
  source: SourceId
  key: string
  mode: 'snapshot' | 'append'
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

interface ProjectionWorkerClientOptions {
  maxPending?: number
  requestTimeoutMs?: number
}

const DEFAULT_MAX_PENDING = 64
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export class ProjectionWorkerClient {
  private worker?: Worker
  private requestId = 0
  private readonly pending = new Map<number, PendingProjection>()
  private closed = false
  private readonly durations: number[] = []
  private readonly ipcOverheads: number[] = []
  private readonly queueWaits: number[] = []
  private readonly workerDurations: number[] = []
  private requests = 0
  private snapshots = 0
  private appends = 0
  private snapshotFallbacks = 0
  private payloadBytes = 0
  private maxPending = 0
  private workerStateEntries = 0
  private workerStateBytes = 0

  private readonly workerFactory: WorkerFactory
  private readonly maxPendingRequests: number
  private readonly requestTimeoutMs: number

  constructor(
    workerFactory: WorkerFactory = (filename, options) =>
      new Worker(filename, options),
    options: ProjectionWorkerClientOptions = {},
  ) {
    this.workerFactory = workerFactory
    this.maxPendingRequests = options.maxPending ?? DEFAULT_MAX_PENDING
    this.requestTimeoutMs = options.requestTimeoutMs
      ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  async projectDsh(
    key: string,
    header: SessionHeader,
    allEvents: SessionEvent[],
    appendedEvents?: SessionEvent[],
  ): Promise<TrajectoryProjection> {
    const message: ProjectionMessage = appendedEvents === undefined
      ? { source: 'dsh', key, mode: 'snapshot', header, events: allEvents }
      : { source: 'dsh', key, mode: 'append', header, events: appendedEvents }
    return this.withSnapshotFallback(message, {
      source: 'dsh',
      key,
      mode: 'snapshot',
      header,
      events: allEvents,
    })
  }

  async projectCodex(
    key: string,
    allEnvelopes: CodexEnvelope[],
    appendedEnvelopes?: CodexEnvelope[],
  ): Promise<TrajectoryProjection> {
    const message: ProjectionMessage = appendedEnvelopes === undefined
      ? { source: 'codex', key, mode: 'snapshot', envelopes: allEnvelopes }
      : { source: 'codex', key, mode: 'append', envelopes: appendedEnvelopes }
    return this.withSnapshotFallback(message, {
      source: 'codex',
      key,
      mode: 'snapshot',
      envelopes: allEnvelopes,
    })
  }

  async projectClaudeCode(
    key: string,
    envelopes: ClaudeCodeEnvelope[],
  ): Promise<TrajectoryProjection> {
    return this.requireProjection(await this.send({
      source: 'claude',
      key,
      mode: 'snapshot',
      claudeEnvelopes: envelopes,
    }))
  }

  async projectDoubaoWork(
    key: string,
    input: DoubaoWorkProjectionInput,
  ): Promise<TrajectoryProjection> {
    return this.requireProjection(await this.send({
      source: 'doubao-work',
      key,
      mode: 'snapshot',
      doubaoWork: input,
    }))
  }

  async projectWorkBuddy(
    key: string,
    input: WorkBuddyProjectionInput,
  ): Promise<TrajectoryProjection> {
    return this.requireProjection(await this.send({
      source: 'workbuddy',
      key,
      mode: 'snapshot',
      workbuddy: input,
    }))
  }

  async projectQoder(
    key: string,
    input: QoderProjectionInput,
  ): Promise<TrajectoryProjection> {
    return this.requireProjection(await this.send({
      source: 'qoder',
      key,
      mode: 'snapshot',
      qoder: input,
    }))
  }

  async projectOpenCode(
    key: string,
    input: OpenCodeProjectionInput,
  ): Promise<TrajectoryProjection> {
    return this.requireProjection(await this.send({
      source: 'opencode',
      key,
      mode: 'snapshot',
      opencode: input,
    }))
  }

  async projectZcode(
    key: string,
    input: ZcodeProjectionInput,
  ): Promise<TrajectoryProjection> {
    return this.requireProjection(await this.send({
      source: 'zcode',
      key,
      mode: 'snapshot',
      zcode: input,
    }))
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const worker = this.worker
    this.worker = undefined
    this.rejectPending(new Error('projection worker closed'))
    if (worker !== undefined) await worker.terminate()
  }

  metrics() {
    const percentile = (values: number[], quantile: number): number | undefined => {
      if (values.length === 0) return undefined
      const sorted = [...values].sort((left, right) => left - right)
      return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))]
    }
    return {
      requests: this.requests,
      snapshots: this.snapshots,
      appends: this.appends,
      snapshotFallbacks: this.snapshotFallbacks,
      payloadBytes: this.payloadBytes,
      pending: this.pending.size,
      maxPending: this.maxPending,
      roundTripMs: {
        p50: percentile(this.durations, 0.5),
        p95: percentile(this.durations, 0.95),
      },
      queueWaitMs: {
        p50: percentile(this.queueWaits, 0.5),
        p95: percentile(this.queueWaits, 0.95),
      },
      workerExecutionMs: {
        p50: percentile(this.workerDurations, 0.5),
        p95: percentile(this.workerDurations, 0.95),
      },
      ipcOverheadMs: {
        p50: percentile(this.ipcOverheads, 0.5),
        p95: percentile(this.ipcOverheads, 0.95),
      },
      workerStateEntries: this.workerStateEntries,
      workerStateBytes: this.workerStateBytes,
      processRssBytes: process.memoryUsage().rss,
    }
  }

  private async withSnapshotFallback(
    message: ProjectionMessage,
    snapshot: ProjectionMessage,
  ): Promise<TrajectoryProjection> {
    let reply = await this.send(message)
    if (reply.needsSnapshot === true) {
      this.snapshotFallbacks++
      reply = await this.send(snapshot)
    }
    return this.requireProjection(reply)
  }

  private requireProjection(reply: ProjectionReply): TrajectoryProjection {
    if (reply.projection === undefined) throw new Error('projection worker returned no projection')
    return reply.projection
  }

  private send(message: ProjectionMessage): Promise<ProjectionReply> {
    if (this.closed) return Promise.reject(new Error('projection worker is closed'))
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(new Error(
        `projection worker queue is full (${this.maxPendingRequests})`,
      ))
    }
    const worker = this.ensureWorker()
    const requestId = ++this.requestId
    const enqueuedAt = performance.now()
    const payloadBytes = Buffer.byteLength(JSON.stringify(message))
    const sentAt = Date.now()
    return new Promise((resolve, reject) => {
      worker.ref()
      this.requests++
      if (message.mode === 'append') this.appends++
      else this.snapshots++
      this.payloadBytes += payloadBytes
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId)
        if (pending === undefined) return
        this.pending.delete(requestId)
        if (this.pending.size === 0) worker.unref()
        pending.reject(new Error(
          `projection worker request timed out after ${this.requestTimeoutMs} ms`,
        ))
      }, this.requestTimeoutMs)
      timer.unref()
      this.pending.set(requestId, {
        resolve,
        reject,
        enqueuedAt,
        sentAt,
        timer,
      })
      this.maxPending = Math.max(this.maxPending, this.pending.size)
      try {
        worker.postMessage({ requestId, sentAt, ...message })
      } catch (caught) {
        const pending = this.pending.get(requestId)
        if (pending !== undefined) clearTimeout(pending.timer)
        this.pending.delete(requestId)
        if (this.pending.size === 0) worker.unref()
        reject(caught instanceof Error ? caught : new Error(String(caught)))
      }
    })
  }

  private ensureWorker(): Worker {
    if (this.worker !== undefined) return this.worker
    const worker = this.workerFactory(workerLocation(
      'AGENT_TRAJECTORY_PROJECTION_WORKER',
      new URL('./projection-worker-bootstrap.mjs', import.meta.url),
    ), {
      execArgv: [
        ...process.execArgv.filter(argument =>
          argument !== '--disable-warning=ExperimentalWarning'),
        '--disable-warning=ExperimentalWarning',
      ],
    })
    worker.unref()
    worker.on('message', (reply: ProjectionReply) => {
      const pending = this.pending.get(reply.requestId)
      if (pending === undefined) return
      this.pending.delete(reply.requestId)
      clearTimeout(pending.timer)
      const completedAt = performance.now()
      const roundTrip = completedAt - pending.enqueuedAt
      const queueWait = Math.max(
        0,
        (reply.workerStartedAt ?? pending.sentAt) - pending.sentAt,
      )
      const workerDuration = reply.workerStartedAt !== undefined
        && reply.workerCompletedAt !== undefined
        ? Math.max(
          0,
          reply.workerCompletedAt - reply.workerStartedAt,
        )
        : undefined
      this.durations.push(roundTrip)
      this.queueWaits.push(queueWait)
      if (workerDuration !== undefined) {
        this.workerDurations.push(workerDuration)
        this.ipcOverheads.push(Math.max(0, roundTrip - queueWait - workerDuration))
      }
      if (this.durations.length > 256) this.durations.shift()
      if (this.queueWaits.length > 256) this.queueWaits.shift()
      if (this.workerDurations.length > 256) this.workerDurations.shift()
      if (this.ipcOverheads.length > 256) this.ipcOverheads.shift()
      this.workerStateEntries = reply.workerMetrics?.stateEntries
        ?? this.workerStateEntries
      this.workerStateBytes = reply.workerMetrics?.stateBytes
        ?? this.workerStateBytes
      if (this.pending.size === 0) worker.unref()
      if (reply.ok) {
        pending.resolve(reply)
      } else {
        pending.reject(Object.assign(new Error(reply.error?.message ?? 'projection failed'), {
          name: reply.error?.name,
          stack: reply.error?.stack,
        }))
      }
    })
    worker.once('error', (error) => {
      if (this.worker !== worker) return
      this.worker = undefined
      this.rejectPending(error)
    })
    worker.once('exit', (code) => {
      if (this.worker !== worker) return
      this.worker = undefined
      if (!this.closed) {
        this.rejectPending(new Error(`projection worker exited (${code})`))
      }
    })
    this.worker = worker
    return worker
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

// Compatibility default for sources constructed directly by callers. Production registries
// inject and own a dedicated worker so their lifetimes remain independent.
export const projectionWorker = new ProjectionWorkerClient()
