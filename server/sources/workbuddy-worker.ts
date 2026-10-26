import { createHash } from 'node:crypto'
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

const REQUIRED_COLUMNS = [
  'id',
  'cwd',
  'title',
  'custom_title',
  'status',
  'created_at',
  'updated_at',
  'last_activity_at',
  'deleted_at',
  'model',
  'permission_mode',
  'mode',
] as const

type SqlValue = null | number | bigint | string | Uint8Array
type SqlRow = Record<string, SqlValue>

interface WorkerRequest {
  requestId: number
  operation: 'probe' | 'list' | 'fingerprint'
  sessionId?: string
}

interface WorkerConfiguration {
  database: string
}

function text(value: SqlValue): string {
  return typeof value === 'string' ? value : ''
}

function nullableText(value: SqlValue): string | null {
  return value === null ? null : text(value)
}

function numeric(value: SqlValue): number {
  return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : 0
}

function rows(
  statement: ReturnType<DatabaseSync['prepare']>,
  ...values: string[]
): SqlRow[] {
  return statement.all(...values) as SqlRow[]
}

function inspectSchema(db: DatabaseSync): string {
  const tables = rows(db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
  )).map(row => text(row.name))
  const columns = tables.includes('sessions')
    ? rows(db.prepare('PRAGMA table_info("sessions")')).map(row => text(row.name))
    : []
  const descriptor = { sessions: [...columns].sort() }
  const fingerprint = `workbuddy:sqlite:sha256:${
    createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')
  }`
  const available = new Set(columns)
  const missing = [
    ...(tables.includes('sessions') ? [] : ['sessions']),
    ...REQUIRED_COLUMNS
      .filter(column => !available.has(column))
      .map(column => `sessions.${column}`),
  ]
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`unsupported WorkBuddy database schema: missing ${missing.join(', ')}`),
      { protocolFingerprint: fingerprint },
    )
  }
  return fingerprint
}

function sessionRow(row: SqlRow) {
  return {
    id: text(row.id),
    cwd: text(row.cwd),
    title: nullableText(row.title),
    customTitle: nullableText(row.custom_title),
    status: text(row.status),
    createdAt: numeric(row.created_at),
    updatedAt: numeric(row.updated_at),
    lastActivityAt: numeric(row.last_activity_at),
    model: nullableText(row.model),
    permissionMode: nullableText(row.permission_mode),
    mode: nullableText(row.mode),
  }
}

function query(database: string, request: WorkerRequest): unknown {
  const db = new DatabaseSync(database, {
    readOnly: true,
    enableForeignKeyConstraints: false,
    timeout: 1_000,
  })
  try {
    const schemaFingerprint = inspectSchema(db)
    if (request.operation === 'probe') return { schemaFingerprint }
    if (request.operation === 'list') {
      return rows(db.prepare(
        `SELECT id, cwd, title, custom_title, status, created_at, updated_at,
           last_activity_at, model, permission_mode, mode
         FROM sessions
         WHERE deleted_at IS NULL
         ORDER BY last_activity_at DESC, updated_at DESC`,
      )).map(sessionRow)
    }
    if (request.sessionId === undefined) throw new Error('missing WorkBuddy session id')
    const selected = rows(db.prepare(
      `SELECT id, cwd, title, custom_title, status, created_at, updated_at,
         last_activity_at, model, permission_mode, mode
       FROM sessions
       WHERE id = ? AND deleted_at IS NULL`,
    ), request.sessionId)[0]
    if (selected === undefined) {
      throw Object.assign(
        new Error('WorkBuddy session disappeared while fingerprinting'),
        { code: 'ENOENT' },
      )
    }
    return createHash('sha256')
      .update(JSON.stringify(sessionRow(selected)))
      .digest('hex')
  } finally {
    db.close()
  }
}

if (parentPort === null) throw new Error('WorkBuddy SQLite worker requires a parent port')

const { database } = workerData as WorkerConfiguration
parentPort.on('message', (request: WorkerRequest) => {
  try {
    parentPort?.postMessage({
      requestId: request.requestId,
      ok: true,
      result: query(database, request),
    })
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught))
    parentPort?.postMessage({
      requestId: request.requestId,
      ok: false,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code: (error as NodeJS.ErrnoException).code,
        protocolFingerprint: (error as Error & {
          protocolFingerprint?: string
        }).protocolFingerprint,
      },
    })
  }
})
