import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DoubaoWorkSource } from '../../server/sources/doubao-work'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

describe('Doubao Work source', () => {
  it('aggregates agents, tool pairs, and spawn lineage without claiming exact timing', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-doubao-'))
    roots.push(root)
    const session = path.join(root, '38440000000000001')
    const master = path.join(session, 'agents', 'm_master0001', 'system')
    const subagent = path.join(session, 'agents', 's_research1', 'system')
    await Promise.all([
      fs.mkdir(master, { recursive: true }),
      fs.mkdir(subagent, { recursive: true }),
    ])
    await Promise.all([
      fs.copyFile(
        path.resolve('tests/fixtures/doubao-work-master.jsonl'),
        path.join(master, 'trajectory.jsonl'),
      ),
      fs.copyFile(
        path.resolve('tests/fixtures/doubao-work-subagent.jsonl'),
        path.join(subagent, 'trajectory.jsonl'),
      ),
    ])
    const source = new DoubaoWorkSource({ sessionsRoot: root })

    expect(await source.probe()).toMatchObject({
      source: 'doubao-work',
      availability: 'degraded',
      capabilities: {
        messages: true,
        tools: true,
        timing: false,
        usage: false,
        live: true,
        lineage: true,
      },
      reason: 'event_metrics_unavailable',
    })

    const [ref] = await source.list()
    expect(ref?.summary).toMatchObject({
      source: 'doubao-work',
      sourceSessionId: '38440000000000001',
      title: 'Research the codebase',
      eventCount: 10,
    })
    expect(ref?.locators).toHaveLength(2)

    const detail = await source.load(ref!)
    expect(detail.projection.header).toMatchObject({
      source: 'doubao-work',
      id: '38440000000000001',
    })
    expect(detail.projection.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'message:m_master0001:0',
        kind: 'user',
        input: [{ type: 'text', text: 'Research the codebase' }],
        depth: 0,
        fidelity: 'derived',
      }),
      expect.objectContaining({
        id: 'tool:m_master0001:call-read',
        kind: 'tool',
        title: 'Read',
        status: 'complete',
        input: { file_path: '/workspace/src/main.ts' },
        output: 'export const main = true',
        depth: 0,
      }),
      expect.objectContaining({
        id: 'tool:s_research1:call-search',
        kind: 'tool',
        title: 'Grep',
        status: 'complete',
        depth: 1,
        parentSpanId: 'agent:m_master0001',
      }),
      expect.objectContaining({
        id: 'message:s_research1:0',
        kind: 'assistant',
        depth: 1,
        spanId: 'agent:s_research1',
        parentSpanId: 'agent:m_master0001',
      }),
    ]))
    expect(detail.projection.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'spawned',
        from: 'tool:m_master0001:call-create',
        to: 'message:s_research1:0',
        fidelity: 'derived',
      }),
    ]))
    expect(detail.projection.usage).toBeUndefined()
    const audit = await source.audit(ref!)
    expect(audit).toMatchObject({
      completeness: 'complete',
      reconstruction: {
        sessionId: '38440000000000001',
        agents: [
          { agentId: 'm_master0001', rows: expect.any(Array) },
          { agentId: 's_research1', rows: expect.any(Array) },
        ],
      },
    })
    expect(audit.events).toHaveLength(10)

    const before = await source.fingerprint(ref!)
    await fs.appendFile(
      path.join(subagent, 'trajectory.jsonl'),
      '{"role":"assistant","content":"Follow-up"}\n',
    )
    expect(await source.fingerprint(ref!)).not.toBe(before)
  })

  it('discovers agent trajectories added after the session was listed', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-doubao-live-'))
    roots.push(root)
    const session = path.join(root, '38440000000000002')
    const master = path.join(session, 'agents', 'm_master0002', 'system')
    await fs.mkdir(master, { recursive: true })
    await fs.copyFile(
      path.resolve('tests/fixtures/doubao-work-master.jsonl'),
      path.join(master, 'trajectory.jsonl'),
    )
    const source = new DoubaoWorkSource({ sessionsRoot: root })
    const [ref] = await source.list()
    const before = await source.fingerprint(ref!)

    const subagent = path.join(session, 'agents', 's_research1', 'system')
    await fs.mkdir(subagent, { recursive: true })
    await fs.copyFile(
      path.resolve('tests/fixtures/doubao-work-subagent.jsonl'),
      path.join(subagent, 'trajectory.jsonl'),
    )

    expect(await source.fingerprint(ref!)).not.toBe(before)
    expect((await source.audit(ref!)).events).toHaveLength(10)
    expect((await source.load(ref!)).projection.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'message:s_research1:0' }),
      ]),
    )
  })
})
