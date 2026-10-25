import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import {
  projectZcodeTrajectory,
  type ZcodeProjectionInput,
} from '../../server/projectors/zcode'
import { SourceRegistry } from '../../server/sources/registry'
import { ZcodeSource } from '../../server/sources/zcode'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

function fixture(): ZcodeProjectionInput {
  return {
    session: {
      id: 'session-zcode-1',
      directory: '/tmp/project',
      title: 'ZCode session',
      version: '0.17.0',
      time_created: 1_000,
      time_updated: 2_000,
      last_outcome: 'completed',
    },
    messages: [
      {
        id: 'user-1',
        sequence: 0,
        time_created: 1_000,
        time_updated: 1_000,
        data: {
          role: 'user',
          time: { created: 1_000 },
          semantics: { transcriptVisibility: 'visible' },
        },
      },
      {
        id: 'context-1',
        sequence: 1,
        time_created: 1_010,
        time_updated: 1_010,
        data: {
          role: 'user',
          source: 'runtime_reminder',
          synthetic: true,
          visibility: 'model-only',
          semantics: { transcriptVisibility: 'hidden' },
        },
      },
      {
        id: 'assistant-1',
        sequence: 2,
        time_created: 1_100,
        time_updated: 1_900,
        data: {
          role: 'assistant',
          modelId: 'test-model',
          providerId: 'test-provider',
          time: { created: 1_100, completed: 1_900 },
        },
      },
    ],
    parts: [
      {
        id: 'part-user',
        message_id: 'user-1',
        sequence: 0,
        time_created: 1_000,
        time_updated: 1_000,
        data: { type: 'text', text: 'build it', time: { start: 1_000, end: 1_000 } },
      },
      {
        id: 'part-context',
        message_id: 'context-1',
        sequence: 0,
        time_created: 1_010,
        time_updated: 1_010,
        data: { type: 'text', text: 'runtime context' },
      },
      {
        id: 'part-reasoning',
        message_id: 'assistant-1',
        sequence: 1,
        time_created: 1_100,
        time_updated: 1_300,
        data: { type: 'reasoning', text: 'inspect first', time: { start: 1_100, end: 1_300 } },
      },
      {
        id: 'part-tool',
        message_id: 'assistant-1',
        sequence: 2,
        time_created: 1_300,
        time_updated: 1_500,
        data: {
          type: 'tool',
          callID: 'call-1',
          tool: 'Bash',
          state: {
            status: 'completed',
            input: '{"command":"pwd","authorization":"secret"}',
            output: '/tmp/project',
            time: { start: 1_300, end: 1_500 },
          },
        },
      },
      {
        id: 'part-text',
        message_id: 'assistant-1',
        sequence: 3,
        time_created: 1_500,
        time_updated: 1_900,
        data: { type: 'text', text: 'done', time: { start: 1_500, end: 1_900 } },
      },
    ],
    modelUsage: [{
      id: 'model-1',
      turn_id: 'turn-1',
      assistant_message_id: 'assistant-1',
      status: 'completed',
      provider_id: 'test-provider',
      model_id: 'test-model',
      started_at: 1_100,
      first_token_at: 1_200,
      completed_at: 1_900,
      duration_ms: 800,
      time_to_first_token_ms: 100,
      input_tokens: 20,
      output_tokens: 7,
      reasoning_tokens: 3,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 5,
      computed_total_tokens: 30,
      retry_count: 0,
      error_type: null,
      error_code: null,
      error_message: null,
    }],
    toolUsage: [{
      id: 'tool-1',
      turn_id: 'turn-1',
      tool_call_id: 'call-1',
      tool_name: 'Bash',
      status: 'completed',
      started_at: 1_300,
      first_output_at: 1_350,
      completed_at: 1_500,
      duration_ms: 200,
      time_to_first_output_ms: 50,
      exit_code: 0,
      output_bytes: 12,
      truncated: 0,
      retry_count: 0,
      error_type: null,
      error_code: null,
      error_message: null,
    }],
    turnUsage: [{
      turn_id: 'turn-1',
      user_message_id: 'user-1',
      status: 'completed',
      started_at: 1_000,
      completed_at: 1_900,
      duration_ms: 900,
      time_to_first_token_ms: 200,
      input_tokens: 20,
      output_tokens: 7,
      reasoning_tokens: 3,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 5,
      computed_total_tokens: 30,
      error_type: null,
      error_code: null,
    }],
  }
}

describe('ZCode projector', () => {
  it('projects visible and runtime messages, model timing, tools, and usage', () => {
    const projection = projectZcodeTrajectory(fixture())
    expect(projection.header).toMatchObject({
      source: 'zcode',
      id: 'session-zcode-1',
      model: 'test-model',
      provider: 'test-provider',
    })
    expect(projection.records.find(record => record.id === 'message:user-1')).toMatchObject({
      kind: 'user',
      turn: 1,
      summary: 'build it',
    })
    expect(projection.records.find(record => record.id === 'message:context-1')).toMatchObject({
      kind: 'context',
      title: 'runtime_reminder',
    })
    expect(projection.records.find(record => record.id === 'message:assistant-1')).toMatchObject({
      kind: 'assistant',
      status: 'complete',
      metrics: { ttftMs: 100, decodeMs: 700, throughput: 10 },
      usage: {
        inputTokens: 20,
        outputTokens: 7,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
        reasoningTokens: 3,
        totalTokens: 30,
      },
    })
    const tool = projection.records.find(record => record.id === 'tool:part-tool')
    expect(tool).toMatchObject({
      kind: 'tool',
      callId: 'call-1',
      title: 'Bash',
      startTime: 1_300,
      endTime: 1_500,
      input: { command: 'pwd', authorization: '<redacted>' },
      output: '/tmp/project',
    })
    expect(JSON.stringify(tool?.raw)).not.toContain('secret')
    expect(projection.usage).toMatchObject({ totalTokens: 30 })
    expect(projection.turns).toEqual([{
      id: 'turn-1',
      number: 1,
      startTime: 1_000,
      endTime: 1_900,
      status: 'complete',
      usage: {
        inputTokens: 20,
        outputTokens: 7,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
        reasoningTokens: 3,
        totalTokens: 30,
      },
      metrics: { ttftMs: 200 },
      model: 'test-model',
    }])
    expect(projection.eventCount).toBe(11)
  })

  it('keeps in-progress assistant and tool records open', () => {
    const input = fixture()
    input.session.time_updated = 1_500
    input.messages[2]!.time_updated = 1_500
    input.messages[2]!.data.time = { created: 1_100 }
    input.parts[3]!.time_updated = 1_500
    input.parts[3]!.data.state = {
      status: 'running',
      input: '{"command":"pwd"}',
      time: { start: 1_300 },
    }
    input.modelUsage[0]!.status = 'running'
    input.modelUsage[0]!.completed_at = null
    input.modelUsage[0]!.duration_ms = null
    input.toolUsage[0]!.status = 'running'
    input.toolUsage[0]!.completed_at = null
    input.toolUsage[0]!.duration_ms = null
    input.turnUsage[0]!.status = 'running'
    input.turnUsage[0]!.completed_at = null
    input.turnUsage[0]!.duration_ms = null

    const projection = projectZcodeTrajectory(input)
    expect(projection.records.find(record => record.id === 'message:assistant-1')).toMatchObject({
      status: 'running',
      endTime: null,
    })
    expect(projection.records.find(record => record.id === 'tool:part-tool')).toMatchObject({
      status: 'running',
      endTime: null,
    })
    expect(projection.turns[0]).toMatchObject({
      id: 'turn-1',
      status: 'running',
      endTime: null,
    })
  })

  it('uses the persisted finish state when timing alone cannot prove completion', () => {
    const input = fixture()
    input.modelUsage = []
    input.turnUsage = []
    input.messages[2]!.time_updated = input.messages[2]!.time_created
    input.messages[2]!.data.time = { created: input.messages[2]!.time_created }
    input.messages[2]!.data.finish = 'completed'

    const projection = projectZcodeTrajectory(input)

    expect(projection.records.find(record => record.id === 'message:assistant-1'))
      .toMatchObject({
        status: 'complete',
        endTime: input.messages[2]!.time_created,
      })
  })

  it('uses the latest model and provider for the session header', () => {
    const input = fixture()
    input.modelUsage = [
      input.modelUsage[0]!,
      {
        ...input.modelUsage[0]!,
        id: 'model-latest',
        assistant_message_id: null,
        model_id: 'latest-model',
        provider_id: 'latest-provider',
        started_at: 2_000,
        completed_at: 2_100,
      },
    ]

    expect(projectZcodeTrajectory(input).header).toMatchObject({
      model: 'latest-model',
      provider: 'latest-provider',
    })
  })

  it('recognizes timeline metadata without projecting a visible record', () => {
    const input = fixture()
    input.parts = [...input.parts, {
      id: 'part-timeline',
      message_id: 'assistant-1',
      sequence: 4,
      time_created: 1_900,
      time_updated: 1_900,
      data: {
        type: 'timeline',
        timing: {
          start: 1_100,
          firstToken: 1_200,
          end: 1_900,
        },
      },
    }]

    const projection = projectZcodeTrajectory(input)

    expect(projection.eventTypeCounts['part/timeline']).toBe(1)
    expect(projection.unknownEventTypes).toEqual([])
    expect(projection.records).toHaveLength(4)
  })
})

function createDatabase(file: string, input: ZcodeProjectionInput): void {
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, directory TEXT, title TEXT, version TEXT,
      time_created INTEGER, time_updated INTEGER, last_outcome TEXT, time_deleted INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, sequence INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT
    );
    CREATE TABLE model_usage (
      id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, assistant_message_id TEXT,
      status TEXT, provider_id TEXT, model_id TEXT, started_at INTEGER,
      first_token_at INTEGER, completed_at INTEGER, duration_ms INTEGER,
      time_to_first_token_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, cache_creation_input_tokens INTEGER,
      cache_read_input_tokens INTEGER, computed_total_tokens INTEGER, retry_count INTEGER,
      error_type TEXT, error_code TEXT, error_message TEXT
    );
    CREATE TABLE tool_usage (
      id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, tool_call_id TEXT,
      tool_name TEXT, status TEXT, started_at INTEGER, first_output_at INTEGER,
      completed_at INTEGER, duration_ms INTEGER, time_to_first_output_ms INTEGER,
      exit_code INTEGER, output_bytes INTEGER, truncated INTEGER, retry_count INTEGER,
      error_type TEXT, error_code TEXT, error_message TEXT
    );
    CREATE TABLE turn_usage (
      session_id TEXT, turn_id TEXT, user_message_id TEXT, status TEXT,
      started_at INTEGER, completed_at INTEGER, duration_ms INTEGER,
      time_to_first_token_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, cache_creation_input_tokens INTEGER,
      cache_read_input_tokens INTEGER, computed_total_tokens INTEGER,
      error_type TEXT, error_code TEXT
    );
  `)
  const insertSession = db.prepare(
    `INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
  insertSession.run(
    input.session.id,
    input.session.directory,
    input.session.title,
    input.session.version,
    input.session.time_created,
    input.session.time_updated,
    input.session.last_outcome ?? null,
  )
  const insertMessage = db.prepare(
    `INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)`,
  )
  input.messages.forEach(row => insertMessage.run(
    row.id,
    input.session.id,
    row.sequence,
    row.time_created,
    row.time_updated,
    JSON.stringify(row.data),
  ))
  const insertPart = db.prepare(
    `INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  input.parts.forEach(row => insertPart.run(
    row.id,
    row.message_id,
    input.session.id,
    row.sequence,
    row.time_created,
    row.time_updated,
    JSON.stringify(row.data),
  ))
  const model = input.modelUsage[0]!
  db.prepare(`INSERT INTO model_usage VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )`).run(
    model.id, input.session.id, model.turn_id, model.assistant_message_id,
    model.status, model.provider_id, model.model_id, model.started_at,
    model.first_token_at, model.completed_at, model.duration_ms,
    model.time_to_first_token_ms, model.input_tokens, model.output_tokens,
    model.reasoning_tokens, model.cache_creation_input_tokens,
    model.cache_read_input_tokens, model.computed_total_tokens, model.retry_count,
    model.error_type, model.error_code, model.error_message,
  )
  const tool = input.toolUsage[0]!
  db.prepare(`INSERT INTO tool_usage VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )`).run(
    tool.id, input.session.id, tool.turn_id, tool.tool_call_id, tool.tool_name,
    tool.status, tool.started_at, tool.first_output_at, tool.completed_at,
    tool.duration_ms, tool.time_to_first_output_ms, tool.exit_code,
    tool.output_bytes, tool.truncated, tool.retry_count,
    tool.error_type, tool.error_code, tool.error_message,
  )
  const turn = input.turnUsage[0]!
  db.prepare(`INSERT INTO turn_usage VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )`).run(
    input.session.id, turn.turn_id, turn.user_message_id, turn.status,
    turn.started_at, turn.completed_at, turn.duration_ms,
    turn.time_to_first_token_ms, turn.input_tokens, turn.output_tokens,
    turn.reasoning_tokens, turn.cache_creation_input_tokens,
    turn.cache_read_input_tokens, turn.computed_total_tokens,
    turn.error_type, turn.error_code,
  )
  db.close()
}

function addAdvancedSchema(file: string): void {
  const db = new DatabaseSync(file)
  db.exec(`
    ALTER TABLE session ADD COLUMN parent_id TEXT;
    ALTER TABLE session ADD COLUMN trace_id TEXT;
    ALTER TABLE model_usage ADD COLUMN logical_request_id TEXT;
    ALTER TABLE model_usage ADD COLUMN attempt_index INTEGER;
    ALTER TABLE model_usage ADD COLUMN trace_id TEXT;
    ALTER TABLE model_usage ADD COLUMN span_id TEXT;
    ALTER TABLE model_usage ADD COLUMN query_source TEXT;
    ALTER TABLE tool_usage ADD COLUMN trace_id TEXT;
    ALTER TABLE tool_usage ADD COLUMN side_effect_scope TEXT;
    ALTER TABLE tool_usage ADD COLUMN read_only INTEGER;
    ALTER TABLE tool_usage ADD COLUMN destructive INTEGER;
    ALTER TABLE tool_usage ADD COLUMN approval_status TEXT;
    ALTER TABLE turn_usage ADD COLUMN trace_id TEXT;
    ALTER TABLE turn_usage ADD COLUMN model_request_count INTEGER;
    ALTER TABLE turn_usage ADD COLUMN model_retry_count INTEGER;
    ALTER TABLE turn_usage ADD COLUMN tool_call_count INTEGER;
    ALTER TABLE turn_usage ADD COLUMN tool_error_count INTEGER;
    CREATE TABLE session_target (
      session_id TEXT PRIMARY KEY, target_id TEXT, objective TEXT, status TEXT,
      token_budget INTEGER, tokens_used INTEGER, time_used_seconds INTEGER,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE todo (
      session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER,
      time_created INTEGER, time_updated INTEGER,
      PRIMARY KEY(session_id, position)
    );
    UPDATE session
      SET parent_id = 'parent-session', trace_id = 'trace-1'
      WHERE id = 'session-zcode-1';
    UPDATE model_usage
      SET logical_request_id = 'request-1', attempt_index = 2,
          trace_id = 'trace-1', span_id = 'span-model-1', query_source = 'agent'
      WHERE id = 'model-1';
    UPDATE tool_usage
      SET trace_id = 'trace-1', side_effect_scope = 'workspace',
          read_only = 0, destructive = 1, approval_status = 'approved'
      WHERE id = 'tool-1';
    UPDATE turn_usage
      SET trace_id = 'trace-1', model_request_count = 1, model_retry_count = 2,
          tool_call_count = 1, tool_error_count = 0
      WHERE turn_id = 'turn-1';
    INSERT INTO session_target VALUES (
      'session-zcode-1', 'target-1', 'Ship the trajectory improvements',
      'active', 10000, 2400, 42, 1000, 2000
    );
    INSERT INTO todo VALUES (
      'session-zcode-1', 'Implement schema capabilities',
      'in_progress', 'high', 0, 1000, 2000
    );
  `)
  db.close()
}

describe('ZCode SQLite source', () => {
  it('changes the fingerprint when projected row content changes without a watermark update', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-zcode-content-'))
    temporaryRoots.push(root)
    const database = path.join(root, 'db.sqlite')
    createDatabase(database, fixture())
    const source = new ZcodeSource({ database })
    const [ref] = await source.list()
    const before = await source.fingerprint(ref!)

    const writer = new DatabaseSync(database)
    writer.prepare('UPDATE part SET data = ? WHERE id = ?').run(
      JSON.stringify({
        type: 'text',
        text: 'content changed without advancing time_updated',
      }),
      'part-user',
    )
    writer.close()

    expect(await source.fingerprint(ref!)).not.toBe(before)
    await source.close()
  })

  it('reloads projected content changed without a watermark update', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-zcode-rewrite-'))
    temporaryRoots.push(root)
    const database = path.join(root, 'db.sqlite')
    createDatabase(database, fixture())
    const source = new ZcodeSource({ database })
    const registry = new SourceRegistry([source])
    const initial = await registry.load('zcode', 'session-zcode-1')
    expect(initial?.projection.records.find(record => record.id === 'message:user-1')?.summary)
      .toBe('build it')

    const writer = new DatabaseSync(database)
    writer.prepare('UPDATE part SET data = ? WHERE id = ?').run(
      JSON.stringify({
        type: 'text',
        text: 'content changed without advancing time_updated',
      }),
      'part-user',
    )
    writer.close()

    const updated = await registry.load('zcode', 'session-zcode-1')
    expect(updated?.projection.records.find(record => record.id === 'message:user-1')?.summary)
      .toBe('content changed without advancing time_updated')
    await registry.close()
  })

  it('changes only the fingerprint of the session that was updated', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-zcode-fingerprint-'))
    temporaryRoots.push(root)
    const database = path.join(root, 'db.sqlite')
    createDatabase(database, fixture())
    const writer = new DatabaseSync(database)
    writer.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, NULL)').run(
      'session-zcode-2',
      '/tmp/second',
      'Second session',
      '0.17.0',
      1_000,
      2_000,
      'completed',
    )
    writer.close()
    const source = new ZcodeSource({ database })
    const refs = await source.list()
    const first = refs.find(ref => ref.sourceSessionId === 'session-zcode-1')!
    const second = refs.find(ref => ref.sourceSessionId === 'session-zcode-2')!
    const firstBefore = await source.fingerprint(first)
    const secondBefore = await source.fingerprint(second)

    const update = new DatabaseSync(database)
    update.prepare('UPDATE session SET time_updated = ? WHERE id = ?')
      .run(3_000, 'session-zcode-1')
    update.close()

    expect(await source.fingerprint(first)).not.toBe(firstBefore)
    expect(await source.fingerprint(second)).toBe(secondBefore)
    await source.close()
  })

  it('maps a session deleted after listing to a missing registry result', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-zcode-deleted-'))
    temporaryRoots.push(root)
    const database = path.join(root, 'db.sqlite')
    createDatabase(database, fixture())
    const source = new ZcodeSource({ database })
    const registry = new SourceRegistry([source])

    expect(await registry.listSessions('zcode')).toHaveLength(1)
    const writer = new DatabaseSync(database)
    writer.prepare('UPDATE session SET time_deleted = ? WHERE id = ?')
      .run(3_000, 'session-zcode-1')
    writer.close()

    await expect(registry.load('zcode', 'session-zcode-1')).resolves.toBeUndefined()
    await source.close()
  })

  it('reuses one SQLite worker across source operations', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-zcode-worker-'))
    temporaryRoots.push(root)
    const database = path.join(root, 'db.sqlite')
    createDatabase(database, fixture())
    let workerCreations = 0
    const source = new ZcodeSource({
      database,
      workerFactory: (filename, options) => {
        workerCreations++
        return new Worker(filename, options)
      },
    })

    expect(await source.probe()).toMatchObject({
      availability: 'degraded',
      reason: 'optional_zcode_features_unavailable',
    })
    const [ref] = await source.list()
    await source.load(ref!)

    expect(workerCreations).toBe(1)
    await source.close()
  })

  it('rebuilds an evicted session without reusing its old row watermarks', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-zcode-lru-'))
    temporaryRoots.push(root)
    const database = path.join(root, 'db.sqlite')
    createDatabase(database, fixture())
    const writer = new DatabaseSync(database)
    writer.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, NULL)').run(
      'session-zcode-2',
      '/tmp/second',
      'Second session',
      '0.17.0',
      1_000,
      2_000,
      'completed',
    )
    writer.close()
    const source = new ZcodeSource({ database, cacheEntries: 1 })
    const refs = await source.list()
    const first = refs.find(ref => ref.sourceSessionId === 'session-zcode-1')!
    const second = refs.find(ref => ref.sourceSessionId === 'session-zcode-2')!

    expect((await source.load(first)).projection.records
      .find(record => record.id === 'message:user-1')?.summary).toBe('build it')
    await source.load(second)

    const replacement = new DatabaseSync(database)
    replacement.prepare('UPDATE part SET data = ? WHERE id = ?').run(
      JSON.stringify({ type: 'text', text: 'rebuilt after eviction', time: { start: 1_000 } }),
      'part-user',
    )
    replacement.prepare('UPDATE session SET time_updated = ? WHERE id = ?')
      .run(3_000, 'session-zcode-1')
    replacement.close()

    expect((await source.load(first)).projection.records
      .find(record => record.id === 'message:user-1')?.summary)
      .toBe('rebuilt after eviction')
  })

  it('reads the supported schema through an opaque session reference', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-zcode-'))
    temporaryRoots.push(root)
    const database = path.join(root, 'db.sqlite')
    createDatabase(database, fixture())
    const source = new ZcodeSource({ database })

    expect(await source.probe()).toMatchObject({
      source: 'zcode',
      availability: 'degraded',
      reason: 'optional_zcode_features_unavailable',
      protocol: {
        detected: 'zcode-sqlite-core-v1',
        supported: ['zcode-sqlite-core-v1'],
        fingerprint: expect.stringMatching(/^zcode:sqlite:sha256:[a-f0-9]{64}$/),
      },
      capabilities: {
        messages: true,
        trace: false,
        lineage: false,
        policy: false,
        tasks: false,
      },
    })
    const refs = await source.list()
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({
      sourceSessionId: 'session-zcode-1',
      locator: 'session-zcode-1',
    })
    const detail = await source.load(refs[0]!)
    expect(detail.summary).toMatchObject({
      source: 'zcode',
      title: 'ZCode session',
      eventCount: 11,
    })
    expect(detail.projection.records).toHaveLength(4)
    expect(detail.projection.records.find(record => record.id === 'tool:part-tool')?.policy)
      .toBeUndefined()
  })

  it('does not expose partial optional schema features', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-zcode-partial-'))
    temporaryRoots.push(root)
    const database = path.join(root, 'db.sqlite')
    createDatabase(database, fixture())
    const writer = new DatabaseSync(database)
    writer.exec('ALTER TABLE tool_usage ADD COLUMN side_effect_scope TEXT')
    writer.prepare('UPDATE tool_usage SET side_effect_scope = ? WHERE id = ?')
      .run('workspace', 'tool-1')
    writer.close()
    const source = new ZcodeSource({ database })

    expect(await source.probe()).toMatchObject({
      availability: 'degraded',
      capabilities: { policy: false },
    })
    const [ref] = await source.list()
    const detail = await source.load(ref!)

    expect(detail.projection.records.find(record => record.id === 'tool:part-tool')?.policy)
      .toBeUndefined()
    await source.close()
  })

  it('enables optional trace, lineage, policy, and task facts when the schema supports them', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-zcode-advanced-'))
    temporaryRoots.push(root)
    const database = path.join(root, 'db.sqlite')
    createDatabase(database, fixture())
    addAdvancedSchema(database)
    const source = new ZcodeSource({ database })

    expect(await source.probe()).toMatchObject({
      source: 'zcode',
      availability: 'available',
      capabilities: {
        trace: true,
        lineage: true,
        policy: true,
        tasks: true,
      },
    })
    const [ref] = await source.list()
    expect(ref?.summary.capabilities).toMatchObject({
      trace: true,
      lineage: true,
      policy: true,
      tasks: true,
    })

    const detail = await source.load(ref!)
    expect(detail.projection.header).toMatchObject({
      parentSessionId: 'parent-session',
      traceId: 'trace-1',
    })
    expect(detail.projection.records.find(record => record.id === 'message:assistant-1'))
      .toMatchObject({
        traceId: 'trace-1',
        spanId: 'span-model-1',
      })
    expect(detail.projection.records.find(record => record.id === 'tool:part-tool'))
      .toMatchObject({
        traceId: 'trace-1',
        policy: {
          sideEffectScope: 'workspace',
          readOnly: false,
          destructive: true,
          approvalStatus: 'approved',
        },
      })
    expect(detail.projection.turns[0]).toMatchObject({
      traceId: 'trace-1',
      reliability: {
        modelRequests: 1,
        modelRetries: 2,
        toolCalls: 1,
        toolErrors: 0,
      },
    })
    expect(detail.projection.taskState).toEqual({
      target: {
        id: 'target-1',
        objective: 'Ship the trajectory improvements',
        status: 'active',
        tokenBudget: 10000,
        tokensUsed: 2400,
        timeUsedSeconds: 42,
        updatedAt: 2000,
      },
      todos: [{
        content: 'Implement schema capabilities',
        status: 'in_progress',
        priority: 'high',
        position: 0,
        updatedAt: 2000,
      }],
    })
    await source.close()
  })

  it('preserves task state across incremental loads', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-zcode-tasks-'))
    temporaryRoots.push(root)
    const database = path.join(root, 'db.sqlite')
    createDatabase(database, fixture())
    addAdvancedSchema(database)
    const source = new ZcodeSource({ database })
    const [ref] = await source.list()

    const initial = await source.load(ref!)
    const incremental = await source.load(ref!)

    expect(incremental.projection.taskState).toEqual(initial.projection.taskState)
    await source.close()
  })

  it('fingerprints in-place changes to every optional projected fact', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-zcode-optional-fingerprint-'))
    temporaryRoots.push(root)
    const database = path.join(root, 'db.sqlite')
    createDatabase(database, fixture())
    addAdvancedSchema(database)
    const source = new ZcodeSource({ database })
    const [ref] = await source.list()
    let previous = await source.fingerprint(ref!)

    const updates = [
      `UPDATE model_usage SET trace_id = 'trace-model-2', span_id = 'span-model-2'
       WHERE id = 'model-1'`,
      `UPDATE tool_usage SET trace_id = 'trace-tool-2', approval_status = 'denied'
       WHERE id = 'tool-1'`,
      `UPDATE turn_usage SET trace_id = 'trace-turn-2', model_retry_count = 3
       WHERE turn_id = 'turn-1'`,
      `UPDATE session_target SET objective = 'Ship verified trajectory improvements'
       WHERE session_id = 'session-zcode-1'`,
      `UPDATE todo SET content = 'Verify schema capabilities'
       WHERE session_id = 'session-zcode-1' AND position = 0`,
    ]
    for (const sql of updates) {
      const writer = new DatabaseSync(database)
      writer.exec(sql)
      writer.close()
      const next = await source.fingerprint(ref!)
      expect(next).not.toBe(previous)
      previous = next
    }

    await source.close()
  })

  it('fingerprints in-place corrections to projected usage facts', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-zcode-usage-fingerprint-'))
    temporaryRoots.push(root)
    const database = path.join(root, 'db.sqlite')
    createDatabase(database, fixture())
    const source = new ZcodeSource({ database })
    const [ref] = await source.list()
    let previous = await source.fingerprint(ref!)

    const updates = [
      `UPDATE model_usage SET output_tokens = 8, computed_total_tokens = 31
       WHERE id = 'model-1'`,
      `UPDATE tool_usage SET status = 'failed', error_code = 'EXIT_1'
       WHERE id = 'tool-1'`,
      `UPDATE turn_usage SET output_tokens = 8, computed_total_tokens = 31
       WHERE turn_id = 'turn-1'`,
    ]
    for (const sql of updates) {
      const writer = new DatabaseSync(database)
      writer.exec(sql)
      writer.close()
      const next = await source.fingerprint(ref!)
      expect(next).not.toBe(previous)
      previous = next
    }

    await source.close()
  })

  it('returns control while a SQLite read waits for a database lock', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-zcode-'))
    temporaryRoots.push(root)
    const database = path.join(root, 'db.sqlite')
    createDatabase(database, fixture())
    const source = new ZcodeSource({ database })
    const [ref] = await source.list()
    const writer = new DatabaseSync(database, { timeout: 2_000 })
    writer.exec('BEGIN EXCLUSIVE')

    const startedAt = performance.now()
    const pending = source.load(ref!)
    const callDuration = performance.now() - startedAt
    writer.exec('ROLLBACK')
    writer.close()

    await pending.catch(() => undefined)
    expect(callDuration).toBeLessThan(100)
  })

  it('merges updated and newly appended message rows from a WAL database', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-zcode-'))
    temporaryRoots.push(root)
    const database = path.join(root, 'db.sqlite')
    createDatabase(database, fixture())
    const source = new ZcodeSource({ database })
    const [ref] = await source.list()
    const initial = await source.load(ref!)
    expect(initial.projection.records.find(record => record.id === 'message:user-1')?.summary)
      .toBe('build it')

    const writer = new DatabaseSync(database)
    writer.exec('PRAGMA journal_mode = WAL')
    writer.prepare(
      'UPDATE part SET time_updated = ?, data = ? WHERE id = ?',
    ).run(
      2_100,
      JSON.stringify({ type: 'text', text: 'build it safely', time: { start: 1_000, end: 2_100 } }),
      'part-user',
    )
    writer.prepare(
      'UPDATE message SET time_updated = ? WHERE id = ?',
    ).run(2_100, 'user-1')
    writer.prepare(
      'INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'context-2',
      'session-zcode-1',
      3,
      2_200,
      2_200,
      JSON.stringify({
        role: 'user',
        source: 'runtime_reminder',
        synthetic: true,
        visibility: 'model-only',
      }),
    )
    writer.prepare(
      'INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'part-context-2',
      'context-2',
      'session-zcode-1',
      0,
      2_200,
      2_200,
      JSON.stringify({ type: 'text', text: 'new runtime context' }),
    )
    writer.prepare(
      'UPDATE session SET time_updated = ? WHERE id = ?',
    ).run(2_200, 'session-zcode-1')
    writer.close()

    expect(await source.fingerprint(ref!)).toContain(':')
    const updated = await source.load(ref!)
    expect(updated.projection.records.find(record => record.id === 'message:user-1')?.summary)
      .toBe('build it safely')
    expect(updated.projection.records.find(record => record.id === 'message:context-2')?.summary)
      .toBe('new runtime context')
    expect(updated.projection.eventCount).toBe(13)
  })

  it('falls back to a full snapshot when cached rows are deleted', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-zcode-'))
    temporaryRoots.push(root)
    const database = path.join(root, 'db.sqlite')
    createDatabase(database, fixture())
    const source = new ZcodeSource({ database })
    const [ref] = await source.list()
    expect((await source.load(ref!)).projection.records
      .some(record => record.id === 'message:context-1')).toBe(true)

    const writer = new DatabaseSync(database)
    writer.prepare('DELETE FROM part WHERE id = ?').run('part-context')
    writer.prepare('DELETE FROM message WHERE id = ?').run('context-1')
    writer.prepare('UPDATE session SET time_updated = ? WHERE id = ?')
      .run(2_100, 'session-zcode-1')
    writer.close()

    const updated = await source.load(ref!)
    expect(updated.projection.records
      .some(record => record.id === 'message:context-1')).toBe(false)
    expect(updated.projection.eventCount).toBe(9)
  })

  it('blocks a database that has the required tables but misses a required column', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-zcode-'))
    temporaryRoots.push(root)
    const database = path.join(root, 'db.sqlite')
    createDatabase(database, fixture())
    const db = new DatabaseSync(database)
    db.exec(`
      ALTER TABLE part RENAME TO part_original;
      CREATE TABLE part (
        id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, sequence INTEGER,
        time_created INTEGER, time_updated INTEGER
      );
      DROP TABLE part_original;
    `)
    db.close()

    expect(await new ZcodeSource({ database }).probe()).toMatchObject({
      availability: 'blocked',
      reason: 'unsupported_zcode_schema',
      detail: expect.stringContaining('part.data'),
      protocol: {
        detected: 'zcode-sqlite-unknown',
        supported: ['zcode-sqlite-core-v1'],
        fingerprint: expect.stringMatching(/^zcode:sqlite:sha256:[a-f0-9]{64}$/),
      },
    })
  })

  it('accepts additive schema columns for forward compatibility', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-zcode-'))
    temporaryRoots.push(root)
    const database = path.join(root, 'db.sqlite')
    createDatabase(database, fixture())
    const db = new DatabaseSync(database)
    db.exec('ALTER TABLE part ADD COLUMN future_metadata TEXT')
    db.close()

    expect(await new ZcodeSource({ database }).probe()).toMatchObject({
      availability: 'degraded',
      reason: 'optional_zcode_features_unavailable',
    })
  })
})
