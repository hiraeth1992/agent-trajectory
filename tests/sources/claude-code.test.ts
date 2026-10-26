import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeCodeSource } from '../../server/sources/claude-code'

const roots: string[] = []
const fixture = path.resolve('tests/fixtures/claude-code-session.jsonl')

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

describe('Claude Code source', () => {
  it('lists and loads messages, tools, usage, model, and event lineage', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-claude-'))
    roots.push(root)
    const project = path.join(root, '-workspace-demo')
    await fs.mkdir(project, { recursive: true })
    const sessionFile = path.join(project, 'claude-session-1.jsonl')
    await fs.copyFile(fixture, sessionFile)
    const source = new ClaudeCodeSource({ projectsRoot: root })

    const status = await source.probe()
    expect(status).toMatchObject({
      source: 'claude',
      availability: 'available',
      capabilities: {
        messages: true,
        tools: true,
        timing: true,
        usage: true,
        live: true,
        lineage: true,
      },
    })

    const [ref] = await source.list()
    expect(ref?.summary).toMatchObject({
      source: 'claude',
      sourceSessionId: 'claude-session-1',
      cwd: '/workspace/demo',
      title: 'Inspect the project',
      eventCount: 4,
    })
    const before = await source.fingerprint(ref!)
    const detail = await source.load(ref!)

    expect(detail.projection.header).toMatchObject({
      source: 'claude',
      id: 'claude-session-1',
      cwd: '/workspace/demo',
      model: 'claude-test',
      rawVersion: '2.1.0',
    })
    expect(detail.projection.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'message:user-1',
        kind: 'user',
        input: [{ type: 'text', text: 'Inspect the project' }],
      }),
      expect.objectContaining({
        id: 'message:assistant-1',
        kind: 'assistant',
        model: 'claude-test',
      }),
      expect.objectContaining({
        id: 'tool:tool-1',
        kind: 'tool',
        title: 'Read',
        callId: 'tool-1',
        status: 'complete',
        input: { file_path: '/workspace/demo/README.md' },
        output: 'Project documentation',
      }),
      expect.objectContaining({
        id: 'message:assistant-2',
        kind: 'assistant',
        model: 'claude-test',
      }),
    ]))
    expect(detail.projection.usage).toEqual({
      inputTokens: 32,
      outputTokens: 12,
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
      totalTokens: 54,
    })
    expect(detail.projection.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'parent-span',
        from: 'message:user-1',
        to: 'message:assistant-1',
      }),
    ]))
    const audit = await source.audit(ref!)
    expect(audit).toMatchObject({
      completeness: 'complete',
      events: expect.any(Array),
      reconstruction: {
        envelopes: expect.any(Array),
      },
    })
    expect(audit.events).toHaveLength(4)

    await fs.appendFile(sessionFile, `${JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      sessionId: 'claude-session-1',
      timestamp: '2026-01-01T00:00:04.000Z',
    })}\n`)
    expect(await source.fingerprint(ref!)).not.toBe(before)
  })
})
