import { createHash } from 'node:crypto'
import { workerData, parentPort } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

const REQUIRED_TABLES = [
  'message',
  'model_usage',
  'part',
  'session',
  'tool_usage',
  'turn_usage',
] as const

const REQUIRED_COLUMNS: Record<(typeof REQUIRED_TABLES)[number], readonly string[]> = {
  session: [
    'id',
    'directory',
    'title',
    'version',
    'time_created',
    'time_updated',
    'last_outcome',
    'time_deleted',
  ],
  message: ['id', 'session_id', 'sequence', 'time_created', 'time_updated', 'data'],
  part: ['id', 'message_id', 'session_id', 'sequence', 'time_created', 'time_updated', 'data'],
  model_usage: [
    'id',
    'session_id',
    'turn_id',
    'assistant_message_id',
    'status',
    'provider_id',
    'model_id',
    'started_at',
    'first_token_at',
    'completed_at',
    'duration_ms',
    'time_to_first_token_ms',
    'input_tokens',
    'output_tokens',
    'reasoning_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'computed_total_tokens',
    'retry_count',
    'error_type',
    'error_code',
    'error_message',
  ],
  tool_usage: [
    'id',
    'session_id',
    'turn_id',
    'tool_call_id',
    'tool_name',
    'status',
    'started_at',
    'first_output_at',
    'completed_at',
    'duration_ms',
    'time_to_first_output_ms',
    'exit_code',
    'output_bytes',
    'truncated',
    'retry_count',
    'error_type',
    'error_code',
    'error_message',
  ],
  turn_usage: [
    'session_id',
    'turn_id',
    'user_message_id',
    'status',
    'started_at',
    'completed_at',
    'duration_ms',
    'time_to_first_token_ms',
    'input_tokens',
    'output_tokens',
    'reasoning_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'computed_total_tokens',
    'error_type',
    'error_code',
  ],
}

interface ZcodeFeatureSupport {
  trace: boolean
  lineage: boolean
  policy: boolean
  tasks: boolean
}

interface SchemaInfo {
  columns: ReadonlyMap<string, ReadonlySet<string>>
  features: ZcodeFeatureSupport
  fingerprint: string
}

type SqlRow = Record<string, null | number | bigint | string | Uint8Array>

interface WorkerRequest {
  requestId: number
  operation: 'probe' | 'list' | 'fingerprint' | 'load'
  sessionId?: string
  messageUpdatedAt?: number
  partUpdatedAt?: number
}

interface WorkerConfiguration {
  database: string
}

function numeric(value: SqlRow[string]): number {
  return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : 0
}

function nullableNumber(value: SqlRow[string]): number | null {
  return value === null ? null : numeric(value)
}

function text(value: SqlRow[string]): string {
  return typeof value === 'string' ? value : ''
}

function nullableText(value: SqlRow[string]): string | null {
  return value === null ? null : text(value)
}

function json(value: SqlRow[string], label: string): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error(`invalid ZCode ${label}: expected JSON text`)
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch (error) {
    throw new Error(`invalid ZCode ${label}: ${(error as Error).message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`invalid ZCode ${label}: expected object`)
  }
  return parsed as Record<string, unknown>
}

function rows(
  statement: ReturnType<DatabaseSync['prepare']>,
  ...values: Array<string | number>
): SqlRow[] {
  return statement.all(...values) as SqlRow[]
}

function hasColumns(
  columns: ReadonlyMap<string, ReadonlySet<string>>,
  table: string,
  required: readonly string[],
): boolean {
  const available = columns.get(table)
  return available !== undefined && required.every(column => available.has(column))
}

function schemaFingerprint(
  columns: ReadonlyMap<string, ReadonlySet<string>>,
): string {
  const descriptor = [...columns]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([table, tableColumns]) => [
      table,
      [...tableColumns].sort((left, right) => left.localeCompare(right)),
    ])
  return `zcode:sqlite:sha256:${
    createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')
  }`
}

function inspectSchema(db: DatabaseSync): SchemaInfo {
  const found = new Set(rows(db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'`,
  )).map(row => text(row.name)))
  const inspectedTables = new Set<string>([
    ...REQUIRED_TABLES,
    'session_target',
    'todo',
  ])
  const columns = new Map<string, ReadonlySet<string>>()
  for (const table of inspectedTables) {
    if (!found.has(table)) continue
    columns.set(table, new Set(rows(db.prepare(`PRAGMA table_info("${table}")`))
      .map(row => text(row.name))))
  }
  const missing: string[] = REQUIRED_TABLES.filter(table => !found.has(table))
  for (const table of REQUIRED_TABLES) {
    if (!found.has(table)) continue
    const tableColumns = columns.get(table) ?? new Set()
    missing.push(...REQUIRED_COLUMNS[table]
      .filter(column => !tableColumns.has(column))
      .map(column => `${table}.${column}`))
  }
  const fingerprint = schemaFingerprint(columns)
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`unsupported ZCode database schema: missing ${missing.join(', ')}`),
      {
        protocolFingerprint: fingerprint,
        protocolMissing: missing,
      },
    )
  }
  return {
    columns,
    fingerprint,
    features: {
      trace: hasColumns(columns, 'session', ['trace_id'])
        && hasColumns(columns, 'model_usage', [
          'logical_request_id',
          'attempt_index',
          'trace_id',
          'span_id',
          'query_source',
        ])
        && hasColumns(columns, 'tool_usage', ['trace_id'])
        && hasColumns(columns, 'turn_usage', [
          'trace_id',
          'model_request_count',
          'model_retry_count',
          'tool_call_count',
          'tool_error_count',
        ]),
      lineage: hasColumns(columns, 'session', ['parent_id']),
      policy: hasColumns(columns, 'tool_usage', [
        'side_effect_scope',
        'read_only',
        'destructive',
        'approval_status',
      ]),
      tasks: hasColumns(columns, 'session_target', [
        'session_id',
        'target_id',
        'objective',
        'status',
        'token_budget',
        'tokens_used',
        'time_used_seconds',
        'time_updated',
      ]) && hasColumns(columns, 'todo', [
        'session_id',
        'content',
        'status',
        'priority',
        'position',
        'time_updated',
      ]),
    },
  }
}

function optionalColumn(
  schema: SchemaInfo,
  table: string,
  column: string,
): string {
  return schema.columns.get(table)?.has(column) === true
    ? column
    : `NULL AS ${column}`
}

function featureColumn(
  schema: SchemaInfo,
  feature: keyof ZcodeFeatureSupport,
  table: string,
  column: string,
): string {
  return schema.features[feature]
    ? optionalColumn(schema, table, column)
    : `NULL AS ${column}`
}

function projectedFactsFingerprint(
  db: DatabaseSync,
  schema: SchemaInfo,
  sessionId: string,
): string {
  const hash = createHash('sha256')
  const append = (label: string, facts: SqlRow[]) => {
    hash.update(label)
    hash.update(JSON.stringify(facts, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value))
  }
  append('session', rows(db.prepare(
    `SELECT id, directory, title, version, time_created, time_updated, last_outcome,
       ${featureColumn(schema, 'lineage', 'session', 'parent_id')},
       ${featureColumn(schema, 'trace', 'session', 'trace_id')}
     FROM session WHERE id = ? AND time_deleted IS NULL`,
  ), sessionId))
  append('messages', rows(db.prepare(
    `SELECT id, sequence, time_created, time_updated, data
     FROM message WHERE session_id = ? ORDER BY sequence, time_created, id`,
  ), sessionId))
  append('parts', rows(db.prepare(
    `SELECT id, message_id, sequence, time_created, time_updated, data
     FROM part WHERE session_id = ? ORDER BY sequence, time_created, id`,
  ), sessionId))
  append('model-usage', rows(db.prepare(
    `SELECT id, turn_id, assistant_message_id, status, provider_id, model_id,
       started_at, first_token_at, completed_at, duration_ms, time_to_first_token_ms,
       input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens,
       cache_read_input_tokens, computed_total_tokens, retry_count,
       error_type, error_code, error_message,
       ${featureColumn(schema, 'trace', 'model_usage', 'logical_request_id')},
       ${featureColumn(schema, 'trace', 'model_usage', 'attempt_index')},
       ${featureColumn(schema, 'trace', 'model_usage', 'trace_id')},
       ${featureColumn(schema, 'trace', 'model_usage', 'span_id')},
       ${featureColumn(schema, 'trace', 'model_usage', 'query_source')}
     FROM model_usage WHERE session_id = ? ORDER BY id`,
  ), sessionId))
  append('tool-usage', rows(db.prepare(
    `SELECT id, turn_id, tool_call_id, tool_name, status, started_at, first_output_at,
       completed_at, duration_ms, time_to_first_output_ms, exit_code, output_bytes,
       truncated, retry_count, error_type, error_code, error_message,
       ${featureColumn(schema, 'trace', 'tool_usage', 'trace_id')},
       ${featureColumn(schema, 'policy', 'tool_usage', 'side_effect_scope')},
       ${featureColumn(schema, 'policy', 'tool_usage', 'read_only')},
       ${featureColumn(schema, 'policy', 'tool_usage', 'destructive')},
       ${featureColumn(schema, 'policy', 'tool_usage', 'approval_status')}
     FROM tool_usage WHERE session_id = ? ORDER BY id`,
  ), sessionId))
  append('turn-usage', rows(db.prepare(
    `SELECT turn_id, user_message_id, status, started_at, completed_at, duration_ms,
       time_to_first_token_ms, input_tokens, output_tokens, reasoning_tokens,
       cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens,
       error_type, error_code,
       ${featureColumn(schema, 'trace', 'turn_usage', 'trace_id')},
       ${featureColumn(schema, 'trace', 'turn_usage', 'model_request_count')},
       ${featureColumn(schema, 'trace', 'turn_usage', 'model_retry_count')},
       ${featureColumn(schema, 'trace', 'turn_usage', 'tool_call_count')},
       ${featureColumn(schema, 'trace', 'turn_usage', 'tool_error_count')}
     FROM turn_usage WHERE session_id = ? ORDER BY turn_id`,
  ), sessionId))
  if (schema.features.tasks) {
    append('target', rows(db.prepare(
      `SELECT target_id, objective, status, token_budget, tokens_used,
         time_used_seconds, time_updated
       FROM session_target WHERE session_id = ? ORDER BY target_id`,
    ), sessionId))
    append('todos', rows(db.prepare(
      `SELECT content, status, priority, position, time_updated
       FROM todo WHERE session_id = ? ORDER BY position`,
    ), sessionId))
  }
  return hash.digest('hex')
}

function projectedRowsFingerprint(
  db: DatabaseSync,
  sessionId: string,
): string {
  const messages = rows(db.prepare(
    `SELECT id, sequence, time_created, time_updated, data
     FROM message WHERE session_id = ? ORDER BY sequence, time_created, id`,
  ), sessionId).map(messageRow)
  const parts = rows(db.prepare(
    `SELECT id, message_id, sequence, time_created, time_updated, data
     FROM part WHERE session_id = ? ORDER BY sequence, time_created, id`,
  ), sessionId).map(partRow)
  return createHash('sha256')
    .update(JSON.stringify({ messages, parts }))
    .digest('hex')
}

function sessionRow(row: SqlRow) {
  return {
    id: text(row.id),
    directory: text(row.directory),
    title: text(row.title),
    version: text(row.version),
    time_created: numeric(row.time_created),
    time_updated: numeric(row.time_updated),
    last_outcome: nullableText(row.last_outcome),
    parent_id: nullableText(row.parent_id),
    trace_id: nullableText(row.trace_id),
  }
}

function messageRow(row: SqlRow) {
  return {
    id: text(row.id),
    sequence: nullableNumber(row.sequence),
    time_created: numeric(row.time_created),
    time_updated: numeric(row.time_updated),
    data: json(row.data, 'message'),
  }
}

function partRow(row: SqlRow) {
  return {
    id: text(row.id),
    message_id: text(row.message_id),
    sequence: nullableNumber(row.sequence),
    time_created: numeric(row.time_created),
    time_updated: numeric(row.time_updated),
    data: json(row.data, 'part'),
  }
}

function modelUsageRow(row: SqlRow) {
  return {
    id: text(row.id),
    turn_id: nullableText(row.turn_id),
    assistant_message_id: nullableText(row.assistant_message_id),
    status: text(row.status),
    provider_id: text(row.provider_id),
    model_id: text(row.model_id),
    started_at: numeric(row.started_at),
    first_token_at: nullableNumber(row.first_token_at),
    completed_at: nullableNumber(row.completed_at),
    duration_ms: nullableNumber(row.duration_ms),
    time_to_first_token_ms: nullableNumber(row.time_to_first_token_ms),
    input_tokens: numeric(row.input_tokens),
    output_tokens: numeric(row.output_tokens),
    reasoning_tokens: numeric(row.reasoning_tokens),
    cache_creation_input_tokens: numeric(row.cache_creation_input_tokens),
    cache_read_input_tokens: numeric(row.cache_read_input_tokens),
    computed_total_tokens: numeric(row.computed_total_tokens),
    retry_count: numeric(row.retry_count),
    error_type: nullableText(row.error_type),
    error_code: nullableText(row.error_code),
    error_message: nullableText(row.error_message),
    logical_request_id: nullableText(row.logical_request_id),
    attempt_index: nullableNumber(row.attempt_index),
    trace_id: nullableText(row.trace_id),
    span_id: nullableText(row.span_id),
    query_source: nullableText(row.query_source),
  }
}

function toolUsageRow(row: SqlRow) {
  return {
    id: text(row.id),
    turn_id: nullableText(row.turn_id),
    tool_call_id: text(row.tool_call_id),
    tool_name: text(row.tool_name),
    status: text(row.status),
    started_at: numeric(row.started_at),
    first_output_at: nullableNumber(row.first_output_at),
    completed_at: nullableNumber(row.completed_at),
    duration_ms: nullableNumber(row.duration_ms),
    time_to_first_output_ms: nullableNumber(row.time_to_first_output_ms),
    exit_code: nullableNumber(row.exit_code),
    output_bytes: numeric(row.output_bytes),
    truncated: numeric(row.truncated),
    retry_count: numeric(row.retry_count),
    error_type: nullableText(row.error_type),
    error_code: nullableText(row.error_code),
    error_message: nullableText(row.error_message),
    trace_id: nullableText(row.trace_id),
    side_effect_scope: nullableText(row.side_effect_scope),
    read_only: nullableNumber(row.read_only),
    destructive: nullableNumber(row.destructive),
    approval_status: nullableText(row.approval_status),
  }
}

function turnUsageRow(row: SqlRow) {
  return {
    turn_id: text(row.turn_id),
    user_message_id: nullableText(row.user_message_id),
    status: text(row.status),
    started_at: numeric(row.started_at),
    completed_at: nullableNumber(row.completed_at),
    duration_ms: nullableNumber(row.duration_ms),
    time_to_first_token_ms: nullableNumber(row.time_to_first_token_ms),
    input_tokens: numeric(row.input_tokens),
    output_tokens: numeric(row.output_tokens),
    reasoning_tokens: numeric(row.reasoning_tokens),
    cache_creation_input_tokens: numeric(row.cache_creation_input_tokens),
    cache_read_input_tokens: numeric(row.cache_read_input_tokens),
    computed_total_tokens: numeric(row.computed_total_tokens),
    error_type: nullableText(row.error_type),
    error_code: nullableText(row.error_code),
    trace_id: nullableText(row.trace_id),
    model_request_count: nullableNumber(row.model_request_count),
    model_retry_count: nullableNumber(row.model_retry_count),
    tool_call_count: nullableNumber(row.tool_call_count),
    tool_error_count: nullableNumber(row.tool_error_count),
  }
}

function query(database: string, request: WorkerRequest): unknown {
  const db = new DatabaseSync(database, {
    readOnly: true,
    enableForeignKeyConstraints: false,
    timeout: 1_000,
  })
  try {
    const schema = inspectSchema(db)
    if (request.operation === 'probe') {
      return {
        features: schema.features,
        schemaFingerprint: schema.fingerprint,
      }
    }
    if (request.operation === 'list') {
      return {
        features: schema.features,
        sessions: rows(db.prepare(
        `SELECT id, directory, title, version, time_created, time_updated, last_outcome,
           ${featureColumn(schema, 'lineage', 'session', 'parent_id')},
           ${featureColumn(schema, 'trace', 'session', 'trace_id')}
         FROM session
         WHERE time_deleted IS NULL
         ORDER BY time_updated DESC`,
        )).map(sessionRow),
      }
    }
    if (request.sessionId === undefined) throw new Error('missing ZCode session id')
    if (request.operation === 'fingerprint') {
      const fingerprint = rows(db.prepare(
        `SELECT
           s.time_updated AS session_updated,
           ${featureColumn(schema, 'lineage', 'session', 'parent_id')},
           ${featureColumn(schema, 'trace', 'session', 'trace_id')},
           (SELECT COUNT(*) FROM message WHERE session_id = s.id) AS message_count,
           (SELECT COALESCE(MAX(time_updated), 0) FROM message WHERE session_id = s.id)
             AS message_updated,
           (SELECT COUNT(*) FROM part WHERE session_id = s.id) AS part_count,
           (SELECT COALESCE(MAX(time_updated), 0) FROM part WHERE session_id = s.id)
             AS part_updated,
           (SELECT COUNT(*) FROM model_usage WHERE session_id = s.id) AS model_count,
           (SELECT COALESCE(MAX(completed_at), 0) FROM model_usage WHERE session_id = s.id)
             AS model_completed,
           (SELECT COUNT(*) FROM tool_usage WHERE session_id = s.id) AS tool_count,
           (SELECT COALESCE(MAX(completed_at), 0) FROM tool_usage WHERE session_id = s.id)
             AS tool_completed,
           (SELECT COUNT(*) FROM turn_usage WHERE session_id = s.id) AS turn_count,
           (SELECT COALESCE(MAX(completed_at), 0) FROM turn_usage WHERE session_id = s.id)
             AS turn_completed
         FROM session s
         WHERE s.id = ? AND s.time_deleted IS NULL`,
      ), request.sessionId)[0]
      if (fingerprint === undefined) {
        throw Object.assign(new Error('ZCode session disappeared while fingerprinting'), {
          code: 'ENOENT',
        })
      }
      return [
        fingerprint.session_updated,
        fingerprint.parent_id,
        fingerprint.trace_id,
        fingerprint.message_count,
        fingerprint.message_updated,
        fingerprint.part_count,
        fingerprint.part_updated,
        fingerprint.model_count,
        fingerprint.model_completed,
        fingerprint.tool_count,
        fingerprint.tool_completed,
        fingerprint.turn_count,
        fingerprint.turn_completed,
        projectedFactsFingerprint(db, schema, request.sessionId),
      ].map(value => value === null ? '' : String(value)).join(':')
    }
    const session = rows(db.prepare(
      `SELECT id, directory, title, version, time_created, time_updated, last_outcome,
         ${featureColumn(schema, 'lineage', 'session', 'parent_id')},
         ${featureColumn(schema, 'trace', 'session', 'trace_id')}
       FROM session WHERE id = ? AND time_deleted IS NULL`,
    ), request.sessionId)[0]
    if (session === undefined) return undefined
    const messageWatermark = request.messageUpdatedAt
    const partWatermark = request.partUpdatedAt
    return {
      session: sessionRow(session),
      messageCount: numeric(rows(db.prepare(
        'SELECT COUNT(*) AS count FROM message WHERE session_id = ?',
      ), request.sessionId)[0]?.count ?? 0),
      partCount: numeric(rows(db.prepare(
        'SELECT COUNT(*) AS count FROM part WHERE session_id = ?',
      ), request.sessionId)[0]?.count ?? 0),
      rowFingerprint: projectedRowsFingerprint(db, request.sessionId),
      messages: rows(db.prepare(
        `SELECT id, sequence, time_created, time_updated, data
         FROM message WHERE session_id = ?
         ${messageWatermark === undefined ? '' : 'AND time_updated >= ?'}
         ORDER BY sequence, time_created, id`,
      ), request.sessionId, ...(
        messageWatermark === undefined ? [] : [messageWatermark]
      )).map(messageRow),
      parts: rows(db.prepare(
        `SELECT id, message_id, sequence, time_created, time_updated, data
         FROM part WHERE session_id = ?
         ${partWatermark === undefined ? '' : 'AND time_updated >= ?'}
         ORDER BY sequence, time_created, id`,
      ), request.sessionId, ...(
        partWatermark === undefined ? [] : [partWatermark]
      )).map(partRow),
      modelUsage: rows(db.prepare(
        `SELECT id, turn_id, assistant_message_id, status, provider_id, model_id,
           started_at, first_token_at, completed_at, duration_ms, time_to_first_token_ms,
           input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens,
           cache_read_input_tokens, computed_total_tokens, retry_count,
           error_type, error_code, error_message,
           ${featureColumn(schema, 'trace', 'model_usage', 'logical_request_id')},
           ${featureColumn(schema, 'trace', 'model_usage', 'attempt_index')},
           ${featureColumn(schema, 'trace', 'model_usage', 'trace_id')},
           ${featureColumn(schema, 'trace', 'model_usage', 'span_id')},
           ${featureColumn(schema, 'trace', 'model_usage', 'query_source')}
         FROM model_usage WHERE session_id = ? ORDER BY started_at, id`,
      ), request.sessionId).map(modelUsageRow),
      toolUsage: rows(db.prepare(
        `SELECT id, turn_id, tool_call_id, tool_name, status, started_at, first_output_at,
           completed_at, duration_ms, time_to_first_output_ms, exit_code, output_bytes,
           truncated, retry_count, error_type, error_code, error_message,
           ${featureColumn(schema, 'trace', 'tool_usage', 'trace_id')},
           ${featureColumn(schema, 'policy', 'tool_usage', 'side_effect_scope')},
           ${featureColumn(schema, 'policy', 'tool_usage', 'read_only')},
           ${featureColumn(schema, 'policy', 'tool_usage', 'destructive')},
           ${featureColumn(schema, 'policy', 'tool_usage', 'approval_status')}
         FROM tool_usage WHERE session_id = ? ORDER BY started_at, id`,
      ), request.sessionId).map(toolUsageRow),
      turnUsage: rows(db.prepare(
        `SELECT turn_id, user_message_id, status, started_at, completed_at, duration_ms,
           time_to_first_token_ms, input_tokens, output_tokens, reasoning_tokens,
           cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens,
           error_type, error_code,
           ${featureColumn(schema, 'trace', 'turn_usage', 'trace_id')},
           ${featureColumn(schema, 'trace', 'turn_usage', 'model_request_count')},
           ${featureColumn(schema, 'trace', 'turn_usage', 'model_retry_count')},
           ${featureColumn(schema, 'trace', 'turn_usage', 'tool_call_count')},
           ${featureColumn(schema, 'trace', 'turn_usage', 'tool_error_count')}
         FROM turn_usage WHERE session_id = ? ORDER BY started_at, turn_id`,
      ), request.sessionId).map(turnUsageRow),
      features: schema.features,
      target: schema.features.tasks
        ? rows(db.prepare(
          `SELECT target_id, objective, status, token_budget, tokens_used,
             time_used_seconds, time_updated
           FROM session_target WHERE session_id = ?`,
        ), request.sessionId).map(row => ({
          target_id: text(row.target_id),
          objective: text(row.objective),
          status: text(row.status),
          token_budget: nullableNumber(row.token_budget),
          tokens_used: numeric(row.tokens_used),
          time_used_seconds: numeric(row.time_used_seconds),
          time_updated: numeric(row.time_updated),
        }))[0]
        : undefined,
      todos: schema.features.tasks
        ? rows(db.prepare(
          `SELECT content, status, priority, position, time_updated
           FROM todo WHERE session_id = ? ORDER BY position`,
        ), request.sessionId).map(row => ({
          content: text(row.content),
          status: text(row.status),
          priority: text(row.priority),
          position: numeric(row.position),
          time_updated: numeric(row.time_updated),
        }))
        : [],
    }
  } finally {
    db.close()
  }
}

const { database } = workerData as WorkerConfiguration
const port = parentPort

if (port === null) throw new Error('ZCode SQLite worker requires a parent port')

port.on('message', (request: WorkerRequest) => {
  try {
    port.postMessage({
      requestId: request.requestId,
      ok: true,
      result: query(database, request),
    })
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught))
    port.postMessage({
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
        protocolMissing: (error as Error & {
          protocolMissing?: string[]
        }).protocolMissing,
      },
    })
  }
})
