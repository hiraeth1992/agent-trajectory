import { Worker, type WorkerOptions } from 'node:worker_threads'
import type {
  SessionEvent,
  SessionHeader,
  TrajectoryProjection,
} from '../src/types'
import type { CodexEnvelope } from './projectors/codex'
import type { ZcodeProjectionInput } from './projectors/zcode'
import { workerLocation } from './worker-location'

type WorkerFactory = (filename: URL, options: WorkerOptions) => Worker

interface ProjectionReply {
  requestId: number
  ok: boolean
  projection?: TrajectoryProjection
  needsSnapshot?: boolean
  error?: {
    name: string
    message: string
    stack?: string
  }
}

interface PendingProjection {
  resolve(value: ProjectionReply): void
  reject(error: Error): void
}

interface ProjectionMessage {
  source: 'dsh' | 'codex' | 'zcode'
  key: string
  mode: 'snapshot' | 'append'
  header?: SessionHeader
  events?: SessionEvent[]
  envelopes?: CodexEnvelope[]
  zcode?: ZcodeProjectionInput
}

export class ProjectionWorkerClient {
  private worker?: Worker
  private requestId = 0
  private readonly pending = new Map<number, PendingProjection>()
  private closed = false

  constructor(
    private readonly workerFactory: WorkerFactory = (filename, options) =>
      new Worker(filename, options),
  ) {}

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

  private async withSnapshotFallback(
    message: ProjectionMessage,
    snapshot: ProjectionMessage,
  ): Promise<TrajectoryProjection> {
    let reply = await this.send(message)
    if (reply.needsSnapshot === true) reply = await this.send(snapshot)
    return this.requireProjection(reply)
  }

  private requireProjection(reply: ProjectionReply): TrajectoryProjection {
    if (reply.projection === undefined) throw new Error('projection worker returned no projection')
    return reply.projection
  }

  private send(message: ProjectionMessage): Promise<ProjectionReply> {
    if (this.closed) return Promise.reject(new Error('projection worker is closed'))
    const worker = this.ensureWorker()
    const requestId = ++this.requestId
    return new Promise((resolve, reject) => {
      worker.ref()
      this.pending.set(requestId, { resolve, reject })
      try {
        worker.postMessage({ requestId, ...message })
      } catch (caught) {
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
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

export const projectionWorker = new ProjectionWorkerClient()
