import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectionWorkerClient } from '../../server/projection-worker-client'
import { QoderSource } from '../../server/sources/qoder'

const roots: string[] = []
const workers: ProjectionWorkerClient[] = []

afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.close()))
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-qoder-'))
  roots.push(root)
  const projectsRoot = path.join(root, 'projects')
  const workspace = path.join(projectsRoot, 'workspace-demo')
  const sessionFile = path.join(workspace, 'qoder-session-1.jsonl')
  const sessionDir = path.join(workspace, 'qoder-session-1')
  const subagents = path.join(sessionDir, 'subagents')
  await fs.mkdir(subagents, { recursive: true })
  await Promise.all([
    fs.copyFile(path.resolve('tests/fixtures/qoder-main-session.jsonl'), sessionFile),
    fs.copyFile(
      path.resolve('tests/fixtures/qoder-subagent-session.jsonl'),
      path.join(subagents, 'agent-1.jsonl'),
    ),
    fs.writeFile(path.join(subagents, 'agent-1.meta.json'), JSON.stringify({
      agentType: 'Explore',
      description: 'Synthetic explorer',
      invocationName: 'Explore',
      toolUseId: 'task-1',
    })),
    fs.writeFile(path.join(sessionDir, 'state.json'), JSON.stringify({
      sessionId: 'qoder-session-1',
      revision: 7,
      createdAt: '2025-10-09T08:53:20.000Z',
      updatedAt: '2025-10-09T08:53:20.500Z',
      items: {},
      data: {},
    })),
  ])
  const mainRows = await fs.readFile(sessionFile, 'utf8')
  await fs.writeFile(
    sessionFile,
    mainRows.replaceAll('fixture_sensitive_key', 'authorization'),
  )
  return { projectsRoot, sessionFile }
}

describe('Qoder source', () => {
  it('loads messages, thinking, tools, usage, and subagent lineage', async () => {
    const paths = await fixture()
    const projectionWorker = new ProjectionWorkerClient()
    workers.push(projectionWorker)
    const source = new QoderSource({ ...paths, projectionWorker })

    expect(await source.probe()).toMatchObject({
      source: 'qoder',
      availability: 'available',
      capabilities: {
        messages: true,
        tools: true,
        nestedTools: true,
        timing: true,
        usage: true,
        live: true,
        lineage: true,
      },
      protocol: {
        detected: 'qoder-jsonl-v1',
      },
    })

    const [ref] = await source.list()
    expect(ref?.summary).toMatchObject({
      source: 'qoder',
      sourceSessionId: 'qoder-session-1',
      title: 'Inspect the entry point',
      cwd: '/workspace/demo',
      rawVersion: '0.4.11',
      eventCount: 11,
    })

    const detail = await source.load(ref!)
    expect(detail.projection.header).toMatchObject({
      source: 'qoder',
      id: 'qoder-session-1',
      cwd: '/workspace/demo',
      model: 'qoder-test',
      rawVersion: '0.4.11',
    })
    expect(detail.projection.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'main:message:user-1',
        kind: 'user',
        input: [{ type: 'text', text: 'Inspect the entry point' }],
      }),
      expect.objectContaining({
        id: 'main:reasoning:assistant-1:0',
        kind: 'model',
        output: [{ type: 'reasoning', text: 'I should inspect the file' }],
      }),
      expect.objectContaining({
        id: 'main:tool:call-1',
        kind: 'tool',
        title: 'Read',
        status: 'complete',
        input: {
          file_path: '/workspace/demo/src/main.ts',
          authorization: '<redacted>',
        },
        output: 'export const main = true',
      }),
      expect.objectContaining({
        id: 'agent-1:tool:sub-call-1',
        kind: 'subtool',
        parentCallId: 'task-1',
        depth: 1,
      }),
    ]))
    expect(detail.projection.usage).toMatchObject({
      inputTokens: 27,
      outputTokens: 15,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      totalTokens: 45,
    })
    expect(detail.projection.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'spawned',
        from: 'main:tool:task-1',
        to: 'agent-1:message:sub-user-1',
        fidelity: 'exact',
      }),
    ]))
    expect(detail.projection.unknownEventTypes).toContain('future-event')
    expect(JSON.stringify(detail)).not.toContain('fixture-secret')
    const audit = await source.audit(ref!)
    expect(audit).toMatchObject({
      completeness: 'complete',
      reconstruction: {
        sessionId: 'qoder-session-1',
        main: expect.any(Array),
        subagents: [{
          id: 'agent-1',
          meta: {
            agentType: 'Explore',
            toolUseId: 'task-1',
          },
          rows: expect.any(Array),
        }],
      },
    })
    expect(audit.events).toHaveLength(11)

    const before = await source.fingerprint(ref!)
    await fs.appendFile(paths.sessionFile, [
      '',
      '{"type":"future-event","sessionId":"qoder-session-1","timestamp":1760000000600}',
      '',
    ].join('\n'))
    expect(await source.fingerprint(ref!)).not.toBe(before)
    expect((await source.load(ref!)).summary.eventCount).toBe(12)
  })
})
