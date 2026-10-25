import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DiagnosisEvidenceStore } from '../server/diagnosis/evidence-store'
import { queryDiagnosisEvidence } from '../server/diagnosis/evidence-query'
import { capabilities, sessionKey } from '../server/sources/types'
import type { SessionDetail } from '../src/types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

function detail(): SessionDetail {
  return {
    summary: {
      id: sessionKey('codex', 'evidence-session'),
      source: 'codex',
      sourceSessionId: 'evidence-session',
      format: 'test',
      capabilities: capabilities('messages', 'tools'),
      cwd: '/workspace',
      title: 'Evidence session',
      createdAt: 1_000,
      updatedAt: 3_000,
      size: 2,
    },
    projection: {
      header: {
        source: 'codex',
        format: 'test',
        id: 'evidence-session',
        createdAt: 1_000,
      },
      records: [
        {
          id: 'user-1',
          source: 'codex',
          sourceEventIds: ['source-user-1'],
          fidelity: 'exact',
          seq: 1,
          turn: 1,
          step: 0,
          kind: 'user',
          title: '用户',
          summary: '检查实现',
          input: '检查实现；token=secret-value',
          startTime: 1_000,
          endTime: 1_000,
          status: 'complete',
          depth: 0,
          raw: [{ authorization: 'Bearer private-token' }],
          searchText: 'private internal search text',
        },
        {
          id: 'tool-1',
          source: 'codex',
          sourceEventIds: ['source-tool-1'],
          fidelity: 'exact',
          seq: 2,
          turn: 1,
          step: 1,
          kind: 'tool',
          title: 'exec_command',
          summary: '测试通过',
          input: { cmd: 'npm test' },
          output: '1 test passed',
          startTime: 2_000,
          endTime: 3_000,
          status: 'complete',
          depth: 0,
          searchText: 'npm test passed',
        },
      ],
      turns: [{
        id: 'turn-1',
        number: 1,
        startTime: 1_000,
        endTime: 3_000,
        status: 'complete',
      }],
      lanes: [],
      startTime: 1_000,
      endTime: 3_000,
      eventCount: 2,
      eventTypeCounts: { user: 1, tool: 1 },
      unknownEventTypes: [],
      turnEnds: { 1: { time: 3_000, reason: 'complete' } },
    },
  }
}

describe('diagnosis evidence', () => {
  it('freezes redacted evidence and exposes only bounded read views', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-evidence-'))
    roots.push(root)
    const store = new DiagnosisEvidenceStore(path.join(root, 'snapshots'))

    const snapshot = await store.create(
      { source: 'codex', sessionId: 'evidence-session' },
      'fingerprint-v1',
      detail(),
    )

    const file = JSON.parse(await fs.readFile(snapshot.file, 'utf8')) as {
      detail: { projection: { records: Array<Record<string, unknown>> } }
    }
    expect(file.detail.projection.records[0]).not.toHaveProperty('raw')
    expect(file.detail.projection.records[0]).not.toHaveProperty('searchText')
    expect(JSON.stringify(file)).not.toContain('secret-value')
    expect(JSON.stringify(file)).not.toContain('private-token')

    const overview = await queryDiagnosisEvidence({
      root: store.directory,
      snapshotId: snapshot.snapshotId,
      view: 'overview',
    }) as {
      target: { sessionId: string }
      session: { recordCount: number }
    }
    expect(overview.target.sessionId).toBe('evidence-session')
    expect(overview.session.recordCount).toBe(2)

    const records = await queryDiagnosisEvidence({
      root: store.directory,
      snapshotId: snapshot.snapshotId,
      view: 'records',
      query: '测试通过',
      limit: 1,
    }) as {
      total: number
      records: Array<Record<string, unknown>>
    }
    expect(records.total).toBe(1)
    expect(records.records[0]).toMatchObject({
      id: 'tool-1',
      turn: 1,
      step: 1,
      status: 'complete',
    })
    expect(records.records[0]).not.toHaveProperty('output')

    const record = await queryDiagnosisEvidence({
      root: store.directory,
      snapshotId: snapshot.snapshotId,
      view: 'record',
      recordId: 'tool-1',
    }) as { record: Record<string, unknown> }
    expect(record.record.output).toBe('1 test passed')

    const bounded = await queryDiagnosisEvidence({
      root: store.directory,
      snapshotId: snapshot.snapshotId,
      view: 'record',
      recordId: 'tool-1',
      maxBytes: 4,
    }) as {
      record: { output: { truncated: boolean; originalBytes: number; preview: string } }
    }
    expect(bounded.record.output).toEqual({
      truncated: true,
      originalBytes: 13,
      preview: '1 te',
    })
  })

  it('rejects traversal and mismatched snapshot identifiers', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-evidence-'))
    roots.push(root)

    await expect(queryDiagnosisEvidence({
      root,
      snapshotId: '../outside',
      view: 'overview',
    })).rejects.toThrow('invalid snapshot id')
  })
})
