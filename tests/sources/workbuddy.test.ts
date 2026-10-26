import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectionWorkerClient } from '../../server/projection-worker-client'
import { WorkBuddySource } from '../../server/sources/workbuddy'

const roots: string[] = []
const sources: WorkBuddySource[] = []
const projectionWorkers: ProjectionWorkerClient[] = []

afterEach(async () => {
  await Promise.all(sources.splice(0).map(source => source.close()))
  await Promise.all(projectionWorkers.splice(0).map(worker => worker.close()))
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  database: string
  projectsDir: string
  sessionFile: string
}> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-workbuddy-'))
  roots.push(root)
  const database = path.join(root, 'workbuddy.db')
  const projectsDir = path.join(root, 'projects')
  const sessionDirectory = path.join(projectsDir, 'workspace-demo')
  const sessionFile = path.join(sessionDirectory, 'workbuddy-session-1.jsonl')
  await fs.mkdir(sessionDirectory, { recursive: true })
  await fs.copyFile(
    path.resolve('tests/fixtures/workbuddy-session.jsonl'),
    sessionFile,
  )
  const sessionRows = await fs.readFile(sessionFile, 'utf8')
  await fs.writeFile(
    sessionFile,
    sessionRows.replace(
      '\\"fixture_sensitive_key\\":\\"fixture-sensitive-value\\"',
      '\\"authorization\\":\\"fixture-secret\\"',
    ),
  )
  const db = new DatabaseSync(database)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      title TEXT,
      custom_title TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      deleted_at INTEGER,
      model TEXT,
      permission_mode TEXT,
      mode TEXT
    );
    INSERT INTO sessions (
      id, cwd, title, custom_title, status, created_at, updated_at,
      last_activity_at, deleted_at, model, permission_mode, mode
    ) VALUES (
      'workbuddy-session-1', '/workspace/demo', 'Generated title',
      'Synthetic WorkBuddy', 'completed', 1760000000000, 1760000000600,
      1760000000600, NULL, 'workbuddy-test', 'default', 'agent'
    );
  `)
  db.close()
  return { database, projectsDir, sessionFile }
}

describe('WorkBuddy source', () => {
  it('loads messages, reasoning, tools, usage, trace, and lineage from a session', async () => {
    const paths = await fixture()
    const projectionWorker = new ProjectionWorkerClient()
    projectionWorkers.push(projectionWorker)
    const source = new WorkBuddySource({ ...paths, projectionWorker })
    sources.push(source)

    expect(await source.probe()).toMatchObject({
      source: 'workbuddy',
      availability: 'available',
      capabilities: {
        messages: true,
        tools: true,
        timing: true,
        usage: true,
        live: true,
        trace: true,
        lineage: true,
      },
      protocol: {
        detected: 'workbuddy-sqlite-jsonl-v1',
        fingerprint: expect.stringMatching(/^workbuddy:sqlite:sha256:[a-f0-9]{64}$/),
      },
    })

    const [ref] = await source.list()
    expect(ref?.summary).toMatchObject({
      source: 'workbuddy',
      sourceSessionId: 'workbuddy-session-1',
      title: 'Synthetic WorkBuddy',
      cwd: '/workspace/demo',
      createdAt: 1760000000000,
      updatedAt: 1760000000600,
    })
    expect(ref?.summary.eventCount).toBeUndefined()

    const detail = await source.load(ref!)
    expect(detail.projection.header).toMatchObject({
      source: 'workbuddy',
      id: 'workbuddy-session-1',
      cwd: '/workspace/demo',
      model: 'workbuddy-test',
      traceId: 'trace-1',
    })
    expect(detail.projection.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'message:user-1',
        kind: 'user',
        input: [{ type: 'text', text: 'Inspect the entry point' }],
        turn: 1,
      }),
      expect.objectContaining({
        id: 'reasoning:reasoning-1',
        kind: 'model',
        output: [{ type: 'reasoning', text: 'I should read the main file' }],
        traceId: 'trace-1',
        model: 'workbuddy-test',
      }),
      expect.objectContaining({
        id: 'tool:call-1',
        kind: 'tool',
        title: 'Read',
        status: 'complete',
        startTime: 1760000000300,
        endTime: 1760000000400,
        input: {
          file_path: '/workspace/demo/src/main.ts',
          authorization: '<redacted>',
        },
        output: {
          content: [{ type: 'output_text', text: 'export const main = true' }],
        },
        traceId: 'trace-1',
      }),
      expect.objectContaining({
        id: 'message:assistant-1',
        kind: 'assistant',
        output: [{ type: 'text', text: 'The entry point is ready.' }],
        model: 'workbuddy-test',
        usage: {
          inputTokens: 18,
          outputTokens: 5,
          totalTokens: 23,
        },
      }),
    ]))
    expect(detail.projection.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'parent-span',
        from: 'message:user-1',
        to: 'reasoning:reasoning-1',
        fidelity: 'exact',
      }),
    ]))
    expect(detail.projection.usage).toMatchObject({ totalTokens: 23 })
    expect(detail.projection.unknownEventTypes).toContain('future-event')
    const audit = await source.audit(ref!)
    expect(audit).toMatchObject({
      completeness: 'complete',
      reconstruction: {
        session: {
          id: 'workbuddy-session-1',
          model: 'workbuddy-test',
        },
        rows: expect.any(Array),
      },
    })
    expect(audit.events).toHaveLength(9)

    const before = await source.fingerprint(ref!)
    await fs.appendFile(
      paths.sessionFile,
      '{"type":"future-event","id":"future-2","sessionId":"workbuddy-session-1","timestamp":1760000000800}\n',
    )
    expect(await source.fingerprint(ref!)).not.toBe(before)
    expect((await source.load(ref!)).summary.eventCount).toBe(10)
  })
})
