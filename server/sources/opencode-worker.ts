import { createHash } from 'node:crypto'
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import type {
  OpenCodeMessageRow,
  OpenCodeProjectionInput,
  OpenCodeSessionRow,
} from '../projectors/opencode'

const REQUIRED_COLUMNS = {
  session: [
    'id',
    'parent_id',
    'directory',
    'title',
    'version',
    'model',
    'cost',
    'tokens_input',
    'tokens_output',
    'tokens_reasoning',
    'tokens_cache_read',
    'tokens_cache_write',
    'time_created',
    'time_updated',
  ],
  session_message: [
    'id',
    'session_id',
    'type',
    'seq',
    'time_created',
    'time_updated',
    'data',
  ],
} as const

type SqlValue = null | number | bigint | string | Uint8Array
type SqlRow = Record<string, SqlValue>

interface WorkerRequest {
  requestId: number
  operation: 'probe' | 'list' | 'fingerprint' | 'load'
  sessionId?: string
}

interface WorkerConfiguration {
  database: string
}

function rows(
  statement: ReturnType<DatabaseSync['prepare']>,
  ...values: string[]
): SqlRow[] {
  return statement.all(...values) as SqlRow[]
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

function json(value: SqlValue, label: string): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error(`invalid OpenCode ${label}: expected JSON text`)
  const parsed = JSON.parse(value) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`invalid OpenCode ${label}: expected object`)
  }
  return parsed as Record<string, unknown>
}

function inspectSchema(db: DatabaseSync): string {
  const tables = new Set(rows(db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'`,
  )).map(row => text(row.name)))
  const descriptor: Record<string, string[]> = {}
  const missing: string[] = []
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    if (!tables.has(table)) {
      descriptor[table] = []
      missing.push(table)
      continue
    }
    const columns = rows(db.prepare(`PRAGMA table_info("${table}")`))
      .map(row => text(row.name))
      .sort()
    descriptor[table] = columns
    const available = new Set(columns)
    missing.push(...required
      .filter(column => !available.has(column))
      .map(column => `${table}.${column}`))
  }
  const fingerprint = `opencode:sqlite:sha256:${
    createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')
  }`
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`unsupported OpenCode database schema: missing ${missing.join(', ')}`),
      { protocolFingerprint: fingerprint },
    )
  }
  return fingerprint
}

function sessionRow(row: SqlRow): OpenCodeSessionRow {
  return {
    id: text(row.id),
    parent_id: nullableText(row.parent_id),
    directory: text(row.directory),
    title: text(row.title),
    version: text(row.version),
    model: row.model === null ? undefined : json(row.model, 'session model'),
    cost: numeric(row.cost),
    tokens_input: numeric(row.tokens_input),
    tokens_output: numeric(row.tokens_output),
    tokens_reasoning: numeric(row.tokens_reasoning),
    tokens_cache_read: numeric(row.tokens_cache_read),
    tokens_cache_write: numeric(row.tokens_cache_write),
    time_created: numeric(row.time_created),
    time_updated: numeric(row.time_updated),
  }
}

function messageRow(row: SqlRow): OpenCodeMessageRow {
  return {
    id: text(row.id),
    type: text(row.type),
    seq: numeric(row.seq),
    time_created: numeric(row.time_created),
    time_updated: numeric(row.time_updated),
    data: json(row.data, 'message'),
  }
}

function selectedSession(db: DatabaseSync, sessionId: string): OpenCodeSessionRow | undefined {
  const selected = rows(db.prepare(
    `SELECT id, parent_id, directory, title, version, model, cost,
       tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
       tokens_cache_write, time_created, time_updated
     FROM session WHERE id = ?`,
  ), sessionId)[0]
  return selected === undefined ? undefined : sessionRow(selected)
}

function selectedMessages(db: DatabaseSync, sessionId: string): OpenCodeMessageRow[] {
  return rows(db.prepare(
    `SELECT id, type, seq, time_created, time_updated, data
     FROM session_message
     WHERE session_id = ?
     ORDER BY seq, time_created, id`,
  ), sessionId).map(messageRow)
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
        `SELECT s.id, s.parent_id, s.directory, s.title, s.version, s.model, s.cost,
           s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read,
           s.tokens_cache_write, s.time_created, s.time_updated,
           (SELECT COUNT(*) FROM session_message m WHERE m.session_id = s.id)
             AS message_count
         FROM session s
         ORDER BY s.time_updated DESC`,
      )).map(row => ({
        session: sessionRow(row),
        messageCount: numeric(row.message_count),
      }))
    }
    if (request.sessionId === undefined) throw new Error('missing OpenCode session id')
    const session = selectedSession(db, request.sessionId)
    if (session === undefined) {
      throw Object.assign(
        new Error('OpenCode session disappeared while reading'),
        { code: 'ENOENT' },
      )
    }
    const messages = selectedMessages(db, request.sessionId)
    if (request.operation === 'fingerprint') {
      return createHash('sha256')
        .update(JSON.stringify({ session, messages }))
        .digest('hex')
    }
    return { session, messages } satisfies OpenCodeProjectionInput
  } finally {
    db.close()
  }
}

if (parentPort === null) throw new Error('OpenCode SQLite worker requires a parent port')

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
