import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { Worker, type WorkerOptions } from 'node:worker_threads'
import {
  type ZcodeFeatureSupport,
  type ZcodeProjectionInput,
  type ZcodeSessionRow,
} from '../projectors/zcode'
import { jsonWeight, WeightedLruCache } from '../lru'
import {
  ProjectionWorkerClient,
  projectionWorker as defaultProjectionWorker,
} from '../projection-worker-client'
import type { SessionDetail, SessionSummary, SourceStatus } from '../../src/types'
import {
  capabilities,
  completeAudit,
  sessionKey,
  sourceMetadata,
  type SessionSource,
  type SourceSessionRef,
} from './types'
import { workerLocation } from '../worker-location'

const ZCODE_BASE_CAPABILITIES = capabilities('messages', 'tools', 'timing', 'usage', 'live')
let zcodeSourceInstances = 0

export const zcodeDatabase = path.resolve(
  process.env.ZCODE_DB ?? path.join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'),
)

type WorkerFactory = (filename: URL, options: WorkerOptions) => Worker

export interface ZcodeSourceOptions {
  database?: string
  cacheEntries?: number
  cacheBytes?: number
  workerFactory?: WorkerFactory
  projectionWorker?: ProjectionWorkerClient
}

type SqliteOperation = 'probe' | 'list' | 'fingerprint' | 'load'

interface ZcodeWatermarks {
  messageUpdatedAt?: number
  partUpdatedAt?: number
}

interface ZcodeCacheEntry {
  input: ZcodeProjectionInput
  messageUpdatedAt?: number
  partUpdatedAt?: number
}

interface ZcodeLoadResult extends ZcodeProjectionInput {
  messageCount: number
  partCount: number
  rowFingerprint: string
  features: ZcodeFeatureSupport
}

interface ZcodeListResult {
  features: ZcodeFeatureSupport
  sessions: ZcodeSessionRow[]
}

interface ZcodeProbeResult {
  features: ZcodeFeatureSupport
  schemaFingerprint: string
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
    protocolMissing?: string[]
  }
}

type WorkerReply<T> = WorkerSuccess<T> | WorkerFailure

interface PendingQuery {
  resolve(value: unknown): void
  reject(error: Error): void
}

class SqliteWorkerClient {
  private worker?: Worker
  private requestId = 0
  private readonly pending = new Map<number, PendingQuery>()
  private closed = false

  constructor(
    private readonly database: string,
    private readonly workerFactory: WorkerFactory,
  ) {}

  get pendingCount(): number {
    return this.pending.size
  }

  query<T>(
    operation: SqliteOperation,
    sessionId?: string,
    watermarks: ZcodeWatermarks = {},
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('ZCode SQLite worker is closed'))
    const worker = this.ensureWorker()
    const requestId = ++this.requestId
    return new Promise<T>((resolve, reject) => {
      worker.ref()
      this.pending.set(requestId, {
        resolve: value => resolve(value as T),
        reject,
      })
      try {
        worker.postMessage({ requestId, operation, sessionId, ...watermarks })
      } catch (error) {
        this.pending.delete(requestId)
        if (this.pending.size === 0) worker.unref()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const worker = this.worker
    this.worker = undefined
    this.rejectPending(new Error('ZCode SQLite worker closed'))
    if (worker !== undefined) await worker.terminate()
  }

  private ensureWorker(): Worker {
    if (this.worker !== undefined) return this.worker
    const worker = this.workerFactory(workerLocation(
      'AGENT_TRAJECTORY_ZCODE_WORKER',
      new URL('./zcode-worker.ts', import.meta.url),
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
          protocolMissing: message.error.protocolMissing,
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
        this.rejectPending(new Error(`ZCode SQLite worker exited (${code})`))
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
  const sizes = await Promise.all([database, `${database}-wal`, `${database}-shm`].map(async (file) => {
    try {
      return (await fs.stat(file)).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
  }))
  return sizes.reduce((total, size) => total + size, 0)
}

function watermark(rows: readonly { time_updated: number }[]): number | undefined {
  return rows.reduce<number | undefined>(
    (latest, row) => latest === undefined ? row.time_updated : Math.max(latest, row.time_updated),
    undefined,
  )
}

function mergeRows<T extends { id: string }>(current: readonly T[], changed: readonly T[]): T[] {
  const byId = new Map(current.map(row => [row.id, row]))
  changed.forEach(row => byId.set(row.id, row))
  return [...byId.values()]
}

function projectedRowsFingerprint(
  messages: ZcodeProjectionInput['messages'],
  parts: ZcodeProjectionInput['parts'],
): string {
  const byOrder = <T extends {
    id: string
    sequence: number | null
    time_created: number | null
  }>(left: T, right: T) =>
    (left.sequence ?? 0) - (right.sequence ?? 0)
    || (left.time_created ?? 0) - (right.time_created ?? 0)
    || left.id.localeCompare(right.id)
  return createHash('sha256').update(JSON.stringify({
    messages: [...messages].sort(byOrder),
    parts: [...parts].sort(byOrder),
  })).digest('hex')
}

function projectionInput(result: ZcodeLoadResult): ZcodeProjectionInput {
  return {
    session: result.session,
    messages: result.messages,
    parts: result.parts,
    modelUsage: result.modelUsage,
    toolUsage: result.toolUsage,
    turnUsage: result.turnUsage,
    target: result.target,
    todos: result.todos,
  }
}

function zcodeCapabilities(features?: ZcodeFeatureSupport) {
  return {
    ...ZCODE_BASE_CAPABILITIES,
    trace: features?.trace ?? false,
    lineage: features?.lineage ?? false,
    policy: features?.policy ?? false,
    tasks: features?.tasks ?? false,
  }
}

function missingFeatures(features: ZcodeFeatureSupport): string[] {
  return (Object.entries(features) as Array<[keyof ZcodeFeatureSupport, boolean]>)
    .filter(([, supported]) => !supported)
    .map(([feature]) => feature)
}

function missingSessionError(): NodeJS.ErrnoException {
  return Object.assign(new Error('ZCode session disappeared while loading'), {
    code: 'ENOENT',
  })
}

export class ZcodeSource implements SessionSource {
  readonly id = 'zcode' as const
  private readonly database: string
  private readonly cache: WeightedLruCache<string, ZcodeCacheEntry>
  private readonly sqlite: SqliteWorkerClient
  private readonly projectionWorker: ProjectionWorkerClient
  private readonly projectionNamespace = `zcode-source:${++zcodeSourceInstances}`
  private features?: ZcodeFeatureSupport

  constructor(options: ZcodeSourceOptions = {}) {
    this.database = path.resolve(options.database ?? zcodeDatabase)
    this.sqlite = new SqliteWorkerClient(
      this.database,
      options.workerFactory ?? ((filename, workerOptions) =>
        new Worker(filename, workerOptions)),
    )
    this.projectionWorker = options.projectionWorker ?? defaultProjectionWorker
    this.cache = new WeightedLruCache<string, ZcodeCacheEntry>({
      maxEntries: options.cacheEntries ?? 8,
      maxWeight: options.cacheBytes ?? 96 * 1024 * 1024,
      weight: entry => jsonWeight(entry.input),
    })
  }

  metrics() {
    return {
      cache: this.cache.metrics(),
      pendingWorkerRequests: this.sqlite.pendingCount,
    }
  }

  async probe(): Promise<SourceStatus> {
    try {
      await fs.access(this.database)
      const probe = await this.sqlite.query<ZcodeProbeResult>('probe')
      const features = probe.features
      this.features = features
      const missing = missingFeatures(features)
      return {
        source: this.id,
        availability: missing.length === 0 ? 'available' : 'degraded',
        ...sourceMetadata(this.id),
        sessionCount: 0,
        capabilities: zcodeCapabilities(features),
        protocol: {
          detected: 'zcode-sqlite-core-v1',
          supported: ['zcode-sqlite-core-v1'],
          fingerprint: probe.schemaFingerprint,
        },
        ...(missing.length === 0
          ? {}
          : {
              reason: 'optional_zcode_features_unavailable',
              detail: `可读取核心轨迹；当前数据库未提供可选能力：${missing.join(', ')}`,
            }),
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
        capabilities: zcodeCapabilities(this.features),
        reason: missing ? 'sessions_database_missing' : 'unsupported_zcode_schema',
        detail: missing
          ? '未找到 ~/.zcode/cli/db/db.sqlite'
          : error instanceof Error ? error.message : String(error),
        ...(protocolFingerprint === undefined
          ? {}
          : {
              protocol: {
                detected: 'zcode-sqlite-unknown',
                supported: ['zcode-sqlite-core-v1'],
                fingerprint: protocolFingerprint,
              },
            }),
      }
    }
  }

  async list(): Promise<readonly SourceSessionRef[]> {
    const [size, result] = await Promise.all([
      databaseSize(this.database),
      this.sqlite.query<ZcodeListResult>('list'),
    ])
    this.features = result.features
    const sourceCapabilities = zcodeCapabilities(result.features)
    return result.sessions.map((session): SourceSessionRef => {
      if (session.id === '') throw new Error('invalid ZCode session id')
      const summary: SessionSummary = {
        id: sessionKey(this.id, session.id),
        source: this.id,
        sourceSessionId: session.id,
        format: 'zcode-session-sqlite',
        capabilities: sourceCapabilities,
        cwd: session.directory,
        title: session.title.trim() || `ZCode · ${session.id.slice(0, 12)}`,
        createdAt: session.time_created,
        updatedAt: session.time_updated,
        size,
        rawVersion: session.version,
      }
      return {
        source: this.id,
        sourceSessionId: session.id,
        locator: session.id,
        summary,
      }
    })
  }

  async fingerprint(ref: SourceSessionRef): Promise<string> {
    return this.sqlite.query<string>('fingerprint', this.assertRef(ref))
  }

  async audit(ref: SourceSessionRef) {
    const sessionId = this.assertRef(ref)
    const result = await this.sqlite.query<ZcodeLoadResult | undefined>(
      'load',
      sessionId,
    )
    if (result === undefined) throw missingSessionError()
    const events = [
      { type: 'session', data: result.session },
      ...result.messages.map(data => ({ type: 'message', data })),
      ...result.parts.map(data => ({ type: 'part', data })),
      ...result.modelUsage.map(data => ({ type: 'model_usage', data })),
      ...result.toolUsage.map(data => ({ type: 'tool_usage', data })),
      ...result.turnUsage.map(data => ({ type: 'turn_usage', data })),
      ...(result.target === undefined
        ? []
        : [{ type: 'session_target', data: result.target }]),
      ...(result.todos ?? []).map(data => ({ type: 'todo', data })),
    ]
    return completeAudit(events, projectionInput(result))
  }

  async load(ref: SourceSessionRef): Promise<SessionDetail> {
    const sessionId = this.assertRef(ref)
    const cached = this.cache.get(sessionId)
    let changed = await this.sqlite.query<ZcodeLoadResult | undefined>(
      'load',
      sessionId,
      {
        messageUpdatedAt: cached?.messageUpdatedAt,
        partUpdatedAt: cached?.partUpdatedAt,
      },
    )
    if (changed === undefined) throw missingSessionError()
    let cacheInvalid = cached !== undefined && (
      changed.session.time_created !== cached.input.session.time_created
      || changed.session.version !== cached.input.session.version
      || changed.session.time_updated < cached.input.session.time_updated
    )
    let merged = cached === undefined || cacheInvalid
      ? projectionInput(changed)
      : {
          session: changed.session,
          messages: mergeRows(cached.input.messages, changed.messages),
          parts: mergeRows(cached.input.parts, changed.parts),
          modelUsage: changed.modelUsage,
          toolUsage: changed.toolUsage,
          turnUsage: changed.turnUsage,
          target: changed.target,
          todos: changed.todos,
        }
    cacheInvalid ||= merged.messages.length !== changed.messageCount
      || merged.parts.length !== changed.partCount
      || projectedRowsFingerprint(merged.messages, merged.parts) !== changed.rowFingerprint
    if (cacheInvalid) {
      changed = await this.sqlite.query<ZcodeLoadResult | undefined>(
        'load',
        sessionId,
      )
      if (changed === undefined) throw missingSessionError()
      merged = projectionInput(changed)
    }
    const input = merged
    this.features = changed.features
    this.cache.set(sessionId, {
      input,
      messageUpdatedAt: watermark(input.messages),
      partUpdatedAt: watermark(input.parts),
    })
    const projection = await this.projectionWorker.projectZcode(
      `${this.projectionNamespace}:${sessionId}`,
      input,
    )
    const summary: SessionSummary = {
      ...ref.summary,
      capabilities: zcodeCapabilities(changed.features),
      cwd: input.session.directory,
      title: input.session.title.trim() || ref.summary.title,
      createdAt: input.session.time_created,
      updatedAt: input.session.time_updated,
      size: await databaseSize(this.database),
      rawVersion: input.session.version,
      eventCount: projection.eventCount,
    }
    return { summary, projection }
  }

  close(): Promise<void> {
    return this.sqlite.close()
  }

  private assertRef(ref: SourceSessionRef): string {
    if (ref.source !== this.id || ref.locator !== ref.sourceSessionId || ref.sourceSessionId === '') {
      throw new Error('invalid ZCode session reference')
    }
    return ref.sourceSessionId
  }
}
