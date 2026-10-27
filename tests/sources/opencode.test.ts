import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectionWorkerClient } from '../../server/projection-worker-client'
import { OpenCodeSource } from '../../server/sources/opencode'
import { projectOpenCodeTrajectory } from '../../server/projectors/opencode'

const roots: string[] = []
const sources: OpenCodeSource[] = []
const workers: ProjectionWorkerClient[] = []

afterEach(async () => {
  await Promise.all(sources.splice(0).map(source => source.close()))
  await Promise.all(workers.splice(0).map(worker => worker.close()))
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-opencode-'))
  roots.push(root)
  const database = path.join(root, 'opencode.db')
  const db = new DatabaseSync(database)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      path TEXT,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      metadata TEXT,
      cost REAL NOT NULL DEFAULT 0,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `)
  const insertSession = db.prepare(`
    INSERT INTO session (
      id, project_id, parent_id, slug, directory, title, version, cost,
      tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
      tokens_cache_write, model, time_created, time_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  insertSession.run(
    'ses_parent',
    'project-1',
    null,
    'parent',
    '/workspace/demo',
    'Parent session',
    '1.19.4',
    0,
    0,
    0,
    0,
    0,
    0,
    JSON.stringify({ id: 'test-model', providerID: 'test-provider' }),
    1760000000000,
    1760000000000,
  )
  insertSession.run(
    'ses_child',
    'project-1',
    'ses_parent',
    'child',
    '/workspace/demo',
    'Synthetic OpenCode',
    '1.19.4',
    0.02,
    20,
    7,
    3,
    5,
    2,
    JSON.stringify({ id: 'test-model', providerID: 'test-provider' }),
    1760000000100,
    1760000000800,
  )
  const insertMessage = db.prepare(`
    INSERT INTO session_message (
      id, session_id, type, seq, time_created, time_updated, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  insertMessage.run(
    'msg_user',
    'ses_child',
    'user',
    1,
    1760000000100,
    1760000000100,
    JSON.stringify({
      text: 'Inspect the entry point',
      files: [],
      agents: [],
      skills: [],
      metadata: { authorization: 'fixture-secret' },
      time: { created: 1760000000100 },
    }),
  )
  insertMessage.run(
    'msg_assistant',
    'ses_child',
    'assistant',
    2,
    1760000000200,
    1760000000700,
    JSON.stringify({
      agent: 'build',
      model: { id: 'test-model', providerID: 'test-provider' },
      content: [
        {
          type: 'reasoning',
          text: 'I should inspect the file',
          time: { created: 1760000000200, completed: 1760000000300 },
        },
        {
          type: 'tool',
          id: 'call-1',
          name: 'read',
          state: {
            status: 'completed',
            input: {
              filePath: '/workspace/demo/src/main.ts',
              authorization: 'fixture-secret',
            },
            content: [{ type: 'text', text: 'export const main = true' }],
          },
          time: {
            created: 1760000000300,
            ran: 1760000000350,
            completed: 1760000000500,
          },
        },
        { type: 'text', text: 'The entry point is ready.' },
      ],
      finish: 'stop',
      cost: 0.02,
      tokens: {
        input: 20,
        output: 7,
        reasoning: 3,
        cache: { read: 5, write: 2 },
      },
      metadata: {},
      time: {
        created: 1760000000200,
        streamed: 1760000000600,
        completed: 1760000000700,
      },
    }),
  )
  insertMessage.run(
    'msg_compaction',
    'ses_child',
    'compaction',
    3,
    1760000000750,
    1760000000750,
    JSON.stringify({
      status: 'completed',
      reason: 'auto',
      model: { id: 'test-model', providerID: 'test-provider' },
      summary: 'Compacted context',
      tokens: { input: 4, output: 2 },
      cost: 0.001,
      metadata: {},
      time: { created: 1760000000750 },
    }),
  )
  insertMessage.run(
    'msg_idle',
    'ses_child',
    'idle',
    4,
    1760000000800,
    1760000000800,
    JSON.stringify({
      outcome: 'succeeded',
      metadata: {},
      time: { created: 1760000000800 },
    }),
  )
  db.close()
  return database
}

describe('OpenCode source', () => {
  it('aggregates all model usage in a turn and keeps running tools live', () => {
    const session = {
      id: 'session-rollup',
      parent_id: null,
      directory: '/workspace',
      title: 'Rollup',
      version: '1',
      model: null,
      cost: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      time_created: 1_000,
      time_updated: 2_000,
    }
    const projection = projectOpenCodeTrajectory({
      session,
      messages: [{
        id: 'user-1',
        type: 'user',
        seq: 0,
        time_created: 1_000,
        time_updated: 1_000,
        data: { text: 'Run' },
      }, {
        id: 'assistant-1',
        type: 'assistant',
        seq: 1,
        time_created: 1_100,
        time_updated: 1_200,
        data: {
          content: [{ type: 'text', text: 'First' }],
          tokens: { input: 10, output: 2 },
        },
      }, {
        id: 'assistant-2',
        type: 'assistant',
        seq: 2,
        time_created: 1_300,
        time_updated: 1_400,
        data: {
          content: [{
            type: 'tool',
            id: 'call-1',
            name: 'bash',
            state: { status: 'running', input: { cmd: 'npm test' } },
          }],
          tokens: { input: 20, output: 3 },
        },
      }],
    })

    expect(projection.turns[0]).toMatchObject({
      status: 'running',
      usage: {
        inputTokens: 30,
        outputTokens: 5,
        totalTokens: 35,
      },
    })
  })

  it('loads official SQLite sessions, messages, tools, usage, and lineage', async () => {
    const database = await fixture()
    const projectionWorker = new ProjectionWorkerClient()
    workers.push(projectionWorker)
    const source = new OpenCodeSource({ database, projectionWorker })
    sources.push(source)

    expect(await source.probe()).toMatchObject({
      source: 'opencode',
      availability: 'available',
      capabilities: {
        messages: true,
        tools: true,
        timing: true,
        usage: true,
        live: true,
        lineage: true,
      },
      protocol: {
        detected: 'opencode-sqlite-v1',
        fingerprint: expect.stringMatching(/^opencode:sqlite:sha256:[a-f0-9]{64}$/),
      },
    })

    const refs = await source.list()
    const ref = refs.find(value => value.sourceSessionId === 'ses_child')
    expect(ref?.summary).toMatchObject({
      source: 'opencode',
      sourceSessionId: 'ses_child',
      title: 'Synthetic OpenCode',
      cwd: '/workspace/demo',
      rawVersion: '1.19.4',
      eventCount: 4,
    })

    const detail = await source.load(ref!)
    expect(detail.projection.header).toMatchObject({
      source: 'opencode',
      id: 'ses_child',
      parentSessionId: 'ses_parent',
      cwd: '/workspace/demo',
      model: 'test-model',
      provider: 'test-provider',
      rawVersion: '1.19.4',
    })
    expect(detail.projection.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'message:msg_user',
        kind: 'user',
        input: [{ type: 'text', text: 'Inspect the entry point' }],
      }),
      expect.objectContaining({
        id: 'reasoning:msg_assistant:0',
        kind: 'model',
        output: [{ type: 'reasoning', text: 'I should inspect the file' }],
      }),
      expect.objectContaining({
        id: 'tool:call-1',
        kind: 'tool',
        title: 'read',
        status: 'complete',
        startTime: 1760000000300,
        endTime: 1760000000500,
        input: {
          filePath: '/workspace/demo/src/main.ts',
          authorization: '<redacted>',
        },
        output: [{ type: 'text', text: 'export const main = true' }],
      }),
      expect.objectContaining({
        id: 'message:msg_assistant',
        kind: 'assistant',
        model: 'test-model',
        provider: 'test-provider',
        usage: {
          inputTokens: 20,
          outputTokens: 7,
          reasoningTokens: 3,
          cacheReadTokens: 5,
          cacheWriteTokens: 2,
          totalTokens: 37,
        },
      }),
      expect.objectContaining({
        id: 'compaction:msg_compaction',
        kind: 'compaction',
        status: 'complete',
      }),
    ]))
    expect(detail.projection.usage).toMatchObject({
      inputTokens: 24,
      outputTokens: 9,
      reasoningTokens: 3,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      totalTokens: 43,
    })
    expect(JSON.stringify(detail)).not.toContain('fixture-secret')
    const audit = await source.audit(ref!)
    expect(audit).toMatchObject({
      completeness: 'complete',
      reconstruction: {
        session: {
          id: 'ses_child',
          parent_id: 'ses_parent',
        },
        messages: expect.any(Array),
      },
    })
    expect(audit.events).toHaveLength(4)

    const before = await source.fingerprint(ref!)
    const db = new DatabaseSync(database)
    db.prepare('UPDATE session SET time_updated = ? WHERE id = ?')
      .run(1760000000900, 'ses_child')
    db.close()
    expect(await source.fingerprint(ref!)).not.toBe(before)
  })
})
