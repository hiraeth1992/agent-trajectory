import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { Worker, type WorkerOptions } from 'node:worker_threads'
import type {
  OpenCodeProjectionInput,
  OpenCodeSessionRow,
} from '../projectors/opencode'
import {
  ProjectionWorkerClient,
  projectionWorker as defaultProjectionWorker,
} from '../projection-worker-client'
import { workerLocation } from '../worker-location'
import type {
  SessionDetail,
  SessionSummary,
  SourceStatus,
} from '../../src/types'
import {
  capabilities,
  completeAudit,
  sessionKey,
  sourceMetadata,
  type SessionSource,
  type SourceSessionRef,
} from './types'

const OPENCODE_CAPABILITIES = capabilities(
  'messages',
  'tools',
  'timing',
  'usage',
  'live',
  'attachments',
  'lineage',
)

export const openCodeDatabase = path.resolve(
  process.env.OPENCODE_DB
    ?? path.join(homedir(), '.local', 'share', 'opencode', 'opencode.db'),
)

type WorkerFactory = (filename: URL, options: WorkerOptions) => Worker
type SqliteOperation = 'probe' | 'list' | 'fingerprint' | 'load'

export interface OpenCodeSourceOptions {
  database?: string
  workerFactory?: WorkerFactory
  projectionWorker?: ProjectionWorkerClient
}

interface ListItem {
  session: OpenCodeSessionRow
  messageCount: number
}

interface WorkerSuccess<T> {
  requestId: number
  ok: true
  result: T
}

interface WorkerFailure {
  requestId: number
  ok: false
  error: {
    name: string
    message: string
    stack?: string
    code?: string
    protocolFingerprint?: string
  }
}

type WorkerReply<T> = WorkerSuccess<T> | WorkerFailure

interface PendingQuery {
  resolve(value: unknown): void
  reject(error: Error): void
}

class OpenCodeSqliteClient {
  private worker?: Worker
  private requestId = 0
  private readonly pending = new Map<number, PendingQuery>()
  private closed = false

  constructor(
    private readonly database: string,
    private readonly workerFactory: WorkerFactory,
  ) {}

  query<T>(operation: SqliteOperation, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('OpenCode SQLite worker is closed'))
    const worker = this.ensureWorker()
    const requestId = ++this.requestId
    return new Promise<T>((resolve, reject) => {
      worker.ref()
      this.pending.set(requestId, {
        resolve: value => resolve(value as T),
        reject,
      })
      try {
        worker.postMessage({ requestId, operation, sessionId })
      } catch (caught) {
        this.pending.delete(requestId)
        if (this.pending.size === 0) worker.unref()
        reject(caught instanceof Error ? caught : new Error(String(caught)))
      }
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const worker = this.worker
    this.worker = undefined
    this.rejectPending(new Error('OpenCode SQLite worker closed'))
    if (worker !== undefined) await worker.terminate()
  }

  private ensureWorker(): Worker {
    if (this.worker !== undefined) return this.worker
    const worker = this.workerFactory(workerLocation(
      'AGENT_TRAJECTORY_OPENCODE_WORKER',
      new URL('./opencode-worker.ts', import.meta.url),
    ), {
      workerData: { database: this.database },
      execArgv: [
        ...process.execArgv.filter(argument =>
          argument !== '--disable-warning=ExperimentalWarning'),
        '--disable-warning=ExperimentalWarning',
      ],
    })
    worker.unref()
    worker.on('message', (message: WorkerReply<unknown>) => {
      const pending = this.pending.get(message.requestId)
      if (pending === undefined) return
      this.pending.delete(message.requestId)
      if (this.pending.size === 0) worker.unref()
      if (message.ok) {
        pending.resolve(message.result)
      } else {
        pending.reject(Object.assign(new Error(message.error.message), {
          name: message.error.name,
          stack: message.error.stack,
          code: message.error.code,
          protocolFingerprint: message.error.protocolFingerprint,
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
        this.rejectPending(new Error(`OpenCode SQLite worker exited (${code})`))
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

async function databaseSize(database: string): Promise<number> {
  const sizes = await Promise.all([database, `${database}-wal`, `${database}-shm`]
    .map(async file => {
      try {
        return Number((await fs.stat(file)).size)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
        throw error
      }
    }))
  return sizes.reduce((total, value) => total + value, 0)
}

function missingSessionError(): NodeJS.ErrnoException {
  return Object.assign(new Error('OpenCode session disappeared while loading'), {
    code: 'ENOENT',
  })
}

export class OpenCodeSource implements SessionSource {
  readonly id = 'opencode' as const
  private readonly database: string
  private readonly sqlite: OpenCodeSqliteClient
  private readonly projectionWorker: ProjectionWorkerClient

  constructor(options: OpenCodeSourceOptions = {}) {
    this.database = path.resolve(options.database ?? openCodeDatabase)
    this.sqlite = new OpenCodeSqliteClient(
      this.database,
      options.workerFactory ?? ((filename, workerOptions) =>
        new Worker(filename, workerOptions)),
    )
    this.projectionWorker = options.projectionWorker ?? defaultProjectionWorker
  }

  async probe(): Promise<SourceStatus> {
    try {
      await fs.access(this.database)
      const probe = await this.sqlite.query<{ schemaFingerprint: string }>('probe')
      return {
        source: this.id,
        availability: 'available',
        ...sourceMetadata(this.id),
        sessionCount: 0,
        capabilities: OPENCODE_CAPABILITIES,
        protocol: {
          detected: 'opencode-sqlite-v1',
          supported: ['opencode-sqlite-v1'],
          fingerprint: probe.schemaFingerprint,
        },
      }
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      const protocolFingerprint = (error as Error & {
        protocolFingerprint?: string
      }).protocolFingerprint
      return {
        source: this.id,
        availability: 'blocked',
        ...sourceMetadata(this.id),
        sessionCount: 0,
        capabilities: OPENCODE_CAPABILITIES,
        reason: missing ? 'sessions_database_missing' : 'unsupported_opencode_schema',
        detail: missing
          ? '未找到 ~/.local/share/opencode/opencode.db'
          : error instanceof Error ? error.message : String(error),
        ...(protocolFingerprint === undefined
          ? {}
          : {
              protocol: {
                detected: 'opencode-sqlite-unknown',
                supported: ['opencode-sqlite-v1'],
                fingerprint: protocolFingerprint,
              },
            }),
      }
    }
  }

  async list(): Promise<readonly SourceSessionRef[]> {
    const [items, size] = await Promise.all([
      this.sqlite.query<ListItem[]>('list'),
      databaseSize(this.database),
    ])
    return items.map(({ session, messageCount }): SourceSessionRef => ({
      source: this.id,
      sourceSessionId: session.id,
      locator: session.id,
      summary: {
        id: sessionKey(this.id, session.id),
        source: this.id,
        sourceSessionId: session.id,
        format: 'opencode-sqlite-v1',
        capabilities: OPENCODE_CAPABILITIES,
        cwd: session.directory,
        title: session.title.trim() || `OpenCode · ${session.id.slice(0, 12)}`,
        createdAt: session.time_created,
        updatedAt: session.time_updated,
        size,
        rawVersion: session.version,
        eventCount: messageCount,
      },
    }))
  }

  fingerprint(ref: SourceSessionRef): Promise<string> {
    return this.sqlite.query('fingerprint', this.assertRef(ref))
  }

  async audit(ref: SourceSessionRef) {
    const input = await this.sqlite.query<OpenCodeProjectionInput | undefined>(
      'load',
      this.assertRef(ref),
    )
    if (input === undefined) throw missingSessionError()
    return completeAudit(input.messages, input)
  }

  async load(ref: SourceSessionRef): Promise<SessionDetail> {
    const sessionId = this.assertRef(ref)
    const input = await this.sqlite.query<OpenCodeProjectionInput | undefined>(
      'load',
      sessionId,
    )
    if (input === undefined) throw missingSessionError()
    const projection = await this.projectionWorker.projectOpenCode(
      `opencode-source:${sessionId}`,
      input,
    )
    const summary: SessionSummary = {
      ...ref.summary,
      cwd: input.session.directory,
      title: input.session.title.trim() || ref.summary.title,
      createdAt: input.session.time_created,
      updatedAt: input.session.time_updated,
      size: await databaseSize(this.database),
      rawVersion: input.session.version,
      eventCount: input.messages.length,
    }
    return { summary, projection }
  }

  close(): Promise<void> {
    return this.sqlite.close()
  }

  private assertRef(ref: SourceSessionRef): string {
    if (ref.source !== this.id
      || ref.locator !== ref.sourceSessionId
      || ref.sourceSessionId === '') {
      throw new Error('invalid OpenCode session reference')
    }
    return ref.sourceSessionId
  }
}
