import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DiagnosisEvidenceStore } from '../server/diagnosis/evidence-store'
import { parseDiagnosisEvidenceArguments } from '../server/diagnosis/evidence-cli'
import {
  diagnosisAccessLedgerHash,
  readDiagnosisEvidenceAccesses,
} from '../server/diagnosis/access-ledger'
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
  it('parses process-check reports without weakening evidence views', () => {
    expect(parseDiagnosisEvidenceArguments([
      '--root',
      '/private/evidence',
      'process-check',
      'snapshot-12345678901234567890',
      '--report',
      '/private/report.md',
    ])).toMatchObject({
      root: '/private/evidence',
      view: 'process-check',
      snapshotId: 'snapshot-12345678901234567890',
      report: '/private/report.md',
    })
  })

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

    const accesses = await readDiagnosisEvidenceAccesses(
      store.directory,
      snapshot.snapshotId,
    )
    expect(accesses.map(access => ({
      snapshotId: access.snapshotId,
      view: access.view,
      recordId: access.recordId,
    }))).toEqual([
      { snapshotId: snapshot.snapshotId, view: 'overview', recordId: undefined },
      { snapshotId: snapshot.snapshotId, view: 'records', recordId: undefined },
      { snapshotId: snapshot.snapshotId, view: 'record', recordId: 'tool-1' },
      { snapshotId: snapshot.snapshotId, view: 'record', recordId: 'tool-1' },
    ])
    expect(diagnosisAccessLedgerHash(accesses)).toMatch(/^[a-f0-9]{64}$/)
    const serializedLedger = JSON.stringify(accesses)
    expect(serializedLedger).not.toContain('测试通过')
    expect(serializedLedger).not.toContain('1 test passed')
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

  it('does not prune snapshots returned by concurrent creation requests', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-evidence-'))
    roots.push(root)
    const store = new DiagnosisEvidenceStore(path.join(root, 'snapshots'), {
      maxSnapshots: 2,
      maxBytes: 100 * 1024 * 1024,
    })

    const snapshots = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      store.create(
        { source: 'codex', sessionId: 'evidence-session' },
        `fingerprint-${index}`,
        detail(),
      )))

    expect(await Promise.all(snapshots.map(snapshot =>
      fs.access(snapshot.file).then(() => true, () => false))))
      .toEqual(Array.from({ length: 8 }, () => true))
  })
})
