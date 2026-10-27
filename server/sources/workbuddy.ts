import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { Worker, type WorkerOptions } from 'node:worker_threads'
import { readJsonlRows } from '../parsers/jsonl'
import { mapConcurrent, walkFiles } from './file-index'
import type {
  WorkBuddyProjectionInput,
  WorkBuddyRow,
  WorkBuddySessionRow,
} from '../projectors/workbuddy'
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
  type SourceListResult,
  type SessionSource,
  type SourceSessionRef,
} from './types'

const WORKBUDDY_CAPABILITIES = capabilities(
  'messages',
  'tools',
  'timing',
  'usage',
  'live',
  'attachments',
  'trace',
  'lineage',
)

export const workbuddyHome = path.resolve(
  process.env.WORKBUDDY_HOME ?? path.join(homedir(), '.workbuddy'),
)

type WorkerFactory = (filename: URL, options: WorkerOptions) => Worker
type SqliteOperation = 'probe' | 'list' | 'fingerprint'

export interface WorkBuddySourceOptions {
  database?: string
  projectsDir?: string
  workerFactory?: WorkerFactory
  projectionWorker?: ProjectionWorkerClient
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
  timer: NodeJS.Timeout
}

const SQLITE_MAX_PENDING = 64
const SQLITE_REQUEST_TIMEOUT_MS = 30_000

class WorkBuddySqliteClient {
  private worker?: Worker
  private requestId = 0
  private readonly pending = new Map<number, PendingQuery>()
  private closed = false

  constructor(
    private readonly database: string,
    private readonly workerFactory: WorkerFactory,
  ) {}

  query<T>(operation: SqliteOperation, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('WorkBuddy SQLite worker is closed'))
    if (this.pending.size >= SQLITE_MAX_PENDING) {
      return Promise.reject(new Error(
        `WorkBuddy SQLite worker queue is full (${SQLITE_MAX_PENDING})`,
      ))
    }
    const worker = this.ensureWorker()
    const requestId = ++this.requestId
    return new Promise<T>((resolve, reject) => {
      worker.ref()
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId)
        if (pending === undefined) return
        this.pending.delete(requestId)
        if (this.pending.size === 0) worker.unref()
        pending.reject(new Error(
          `WorkBuddy SQLite request timed out after ${SQLITE_REQUEST_TIMEOUT_MS} ms`,
        ))
      }, SQLITE_REQUEST_TIMEOUT_MS)
      timer.unref()
      this.pending.set(requestId, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      })
      try {
        worker.postMessage({ requestId, operation, sessionId })
      } catch (caught) {
        clearTimeout(timer)
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
    this.rejectPending(new Error('WorkBuddy SQLite worker closed'))
    if (worker !== undefined) await worker.terminate()
  }

  private ensureWorker(): Worker {
    if (this.worker !== undefined) return this.worker
    const worker = this.workerFactory(workerLocation(
      'AGENT_TRAJECTORY_WORKBUDDY_WORKER',
      new URL('./workbuddy-worker.ts', import.meta.url),
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
      clearTimeout(pending.timer)
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
        this.rejectPending(new Error(`WorkBuddy SQLite worker exited (${code})`))
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

interface DiscoveredFile {
  file: string
  sessionId: string
  stat: Awaited<ReturnType<typeof fs.stat>>
}

async function walk(directory: string, output: string[]): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) await walk(absolute, output)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(absolute)
  }))
}

async function discoverFiles(projectsDir: string): Promise<Map<string, DiscoveredFile>> {
  const walked = await walkFiles(
    projectsDir,
    (_file, name) => name.endsWith('.jsonl'),
  )
  if (walked.failures.length > 0) {
    throw new Error(walked.failures.map(failure => failure.reason).join('; '))
  }
  const settled = await mapConcurrent(walked.files, 16, async file => {
    const sessionId = path.basename(file, '.jsonl')
    return [sessionId, { file, sessionId, stat: await fs.stat(file) }] as const
  })
  const failed = settled.find(result => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  return new Map(settled.map(result =>
    (result as PromiseFulfilledResult<
      readonly [string, DiscoveredFile]
    >).value))
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

function titleFor(session: WorkBuddySessionRow): string {
  return session.customTitle?.trim()
    || session.title?.trim()
    || `WorkBuddy · ${session.id.slice(0, 12)}`
}

function assertRef(
  ref: SourceSessionRef,
  projectsDir: string,
): string {
  if (ref.source !== 'workbuddy' || ref.sourceSessionId === '') {
    throw new Error('invalid WorkBuddy session reference')
  }
  const file = path.resolve(ref.locator)
  if (!file.startsWith(`${projectsDir}${path.sep}`)
    || path.basename(file) !== `${ref.sourceSessionId}.jsonl`) {
    throw new Error('invalid WorkBuddy session locator')
  }
  return file
}

function missingSessionError(): NodeJS.ErrnoException {
  return Object.assign(new Error('WorkBuddy session disappeared while loading'), {
    code: 'ENOENT',
  })
}

export class WorkBuddySource implements SessionSource {
  readonly id = 'workbuddy' as const
  private readonly database: string
  private readonly projectsDir: string
  private readonly sqlite: WorkBuddySqliteClient
  private readonly projectionWorker: ProjectionWorkerClient

  constructor(options: WorkBuddySourceOptions = {}) {
    const home = path.dirname(options.database ?? path.join(workbuddyHome, 'workbuddy.db'))
    this.database = path.resolve(options.database ?? path.join(home, 'workbuddy.db'))
    this.projectsDir = path.resolve(options.projectsDir ?? path.join(home, 'projects'))
    this.sqlite = new WorkBuddySqliteClient(
      this.database,
      options.workerFactory ?? ((filename, workerOptions) =>
        new Worker(filename, workerOptions)),
    )
    this.projectionWorker = options.projectionWorker ?? defaultProjectionWorker
  }

  async probe(): Promise<SourceStatus> {
    try {
      await Promise.all([
        fs.access(this.database),
        fs.access(this.projectsDir),
      ])
      const probe = await this.sqlite.query<{ schemaFingerprint: string }>('probe')
      return {
        source: this.id,
        availability: 'available',
        ...sourceMetadata(this.id),
        sessionCount: 0,
        capabilities: WORKBUDDY_CAPABILITIES,
        protocol: {
          detected: 'workbuddy-sqlite-jsonl-v1',
          supported: ['workbuddy-sqlite-jsonl-v1'],
          fingerprint: probe.schemaFingerprint,
        },
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const protocolFingerprint = (error as Error & {
        protocolFingerprint?: string
      }).protocolFingerprint
      return {
        source: this.id,
        availability: 'blocked',
        ...sourceMetadata(this.id),
        sessionCount: 0,
        capabilities: WORKBUDDY_CAPABILITIES,
        reason: code === 'ENOENT'
          ? 'sessions_storage_missing'
          : 'unsupported_workbuddy_schema',
        detail: code === 'ENOENT'
          ? '未找到 ~/.workbuddy/workbuddy.db 或 projects'
          : error instanceof Error ? error.message : String(error),
        ...(protocolFingerprint === undefined
          ? {}
          : {
              protocol: {
                detected: 'workbuddy-sqlite-unknown',
                supported: ['workbuddy-sqlite-jsonl-v1'],
                fingerprint: protocolFingerprint,
              },
            }),
      }
    }
  }

  async list(): Promise<readonly SourceSessionRef[]> {
    return (await this.listDetailed()).refs
  }

  async listDetailed(): Promise<SourceListResult> {
    const [sessions, discovered, dbSize] = await Promise.all([
      this.sqlite.query<WorkBuddySessionRow[]>('list'),
      discoverFiles(this.projectsDir),
      databaseSize(this.database),
    ])
    const failures = sessions.flatMap(session =>
      discovered.has(session.id)
        ? []
        : [{
            locator: session.id,
            reason: 'session row has no matching project JSONL file',
          }])
    const refs = sessions.flatMap(session => {
      const found = discovered.get(session.id)
      if (found === undefined) return []
      const summary: SessionSummary = {
          id: sessionKey(this.id, session.id),
          source: this.id,
          sourceSessionId: session.id,
          format: 'workbuddy-session-jsonl',
          capabilities: WORKBUDDY_CAPABILITIES,
          cwd: session.cwd,
          title: titleFor(session),
          createdAt: session.createdAt,
          updatedAt: Math.max(session.updatedAt, session.lastActivityAt),
          size: dbSize + Number(found.stat.size),
      }
      return [{
        source: this.id,
        sourceSessionId: session.id,
        locator: found.file,
        summary,
      } satisfies SourceSessionRef]
    })
    refs.sort((left, right) =>
      right.summary.updatedAt - left.summary.updatedAt)
    return {
      refs,
      diagnostics: {
        scanned: sessions.length,
        loaded: refs.length,
        failed: failures.length,
        failures,
      },
    }
  }

  async fingerprint(ref: SourceSessionRef): Promise<string> {
    const file = assertRef(ref, this.projectsDir)
    const [database, stat] = await Promise.all([
      this.sqlite.query<string>('fingerprint', ref.sourceSessionId),
      fs.stat(file),
    ])
    return `${database}:${stat.mtimeMs}:${stat.size}`
  }

  async audit(ref: SourceSessionRef) {
    const file = assertRef(ref, this.projectsDir)
    const [sessions, rows] = await Promise.all([
      this.sqlite.query<WorkBuddySessionRow[]>('list'),
      readJsonlRows<WorkBuddyRow>(file),
    ])
    const session = sessions.find(candidate => candidate.id === ref.sourceSessionId)
    if (session === undefined) throw missingSessionError()
    const events = rows.map(row => row.value)
    return completeAudit(events, {
      session,
      rows: events,
    } satisfies WorkBuddyProjectionInput)
  }

  async load(ref: SourceSessionRef): Promise<SessionDetail> {
    const file = assertRef(ref, this.projectsDir)
    const [sessions, rows, stat] = await Promise.all([
      this.sqlite.query<WorkBuddySessionRow[]>('list'),
      readJsonlRows<WorkBuddyRow>(file),
      fs.stat(file),
    ])
    const session = sessions.find(candidate =>
      candidate.id === ref.sourceSessionId)
    if (session === undefined) throw missingSessionError()
    const values = rows.map(row => row.value)
    const input: WorkBuddyProjectionInput = { session, rows: values }
    const projection = await this.projectionWorker.projectWorkBuddy(
      `workbuddy-source:${session.id}`,
      input,
    )
    return {
      summary: {
        ...ref.summary,
        cwd: session.cwd,
        title: titleFor(session),
        createdAt: session.createdAt,
        updatedAt: Math.max(
          session.updatedAt,
          session.lastActivityAt,
          projection.endTime,
        ),
        size: await databaseSize(this.database) + Number(stat.size),
        eventCount: values.length,
      },
      projection,
    }
  }

  close(): Promise<void> {
    return this.sqlite.close()
  }
}
