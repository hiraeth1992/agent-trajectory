import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DiagnosisEvidenceSnapshot } from './evidence-store'

const SNAPSHOT_ID = /^[A-Za-z0-9_-]{20,80}$/
const MAX_LIMIT = 50
const DEFAULT_RECORD_VALUE_BYTES = 64 * 1024
const MAX_RECORD_VALUE_BYTES = 256 * 1024

export type DiagnosisEvidenceView = 'findings' | 'overview' | 'record' | 'records'

export interface DiagnosisEvidenceQuery {
  root: string
  snapshotId: string
  view: DiagnosisEvidenceView
  recordId?: string
  turn?: number
  kind?: string
  status?: string
  query?: string
  offset?: number
  limit?: number
  maxBytes?: number
}

async function readSnapshot(root: string, snapshotId: string): Promise<DiagnosisEvidenceSnapshot> {
  if (!SNAPSHOT_ID.test(snapshotId)) throw new Error('invalid snapshot id')
  const directory = path.resolve(root)
  const file = path.resolve(directory, `${snapshotId}.json`)
  if (!file.startsWith(`${directory}${path.sep}`)) throw new Error('invalid snapshot path')
  const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as DiagnosisEvidenceSnapshot
  if (parsed.schemaVersion !== 1 || parsed.snapshotId !== snapshotId) {
    throw new Error('unsupported or mismatched diagnosis snapshot')
  }
  return parsed
}

function recordText(record: DiagnosisEvidenceSnapshot['detail']['projection']['records'][number]): string {
  return [
    record.title,
    record.summary,
    JSON.stringify(record.input),
    JSON.stringify(record.output),
    JSON.stringify(record.error),
  ].filter(Boolean).join(' ').toLowerCase()
}

function compactRecord(
  record: DiagnosisEvidenceSnapshot['detail']['projection']['records'][number],
) {
  return {
    id: record.id,
    turn: record.turn,
    step: record.step,
    kind: record.kind,
    title: record.title,
    summary: record.summary,
    status: record.status,
    startTime: record.startTime,
    endTime: record.endTime,
    fidelity: record.fidelity,
    sourceEventIds: record.sourceEventIds,
  }
}

function boundedValue(value: unknown, maxBytes: number): unknown {
  if (value === undefined) return undefined
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  if (serialized === undefined) return value
  const bytes = Buffer.from(serialized)
  if (bytes.length <= maxBytes) return value
  return {
    truncated: true,
    originalBytes: bytes.length,
    preview: new TextDecoder().decode(bytes.subarray(0, maxBytes)),
  }
}

export async function queryDiagnosisEvidence(query: DiagnosisEvidenceQuery): Promise<unknown> {
  const snapshot = await readSnapshot(query.root, query.snapshotId)
  if (query.view === 'overview') {
    return {
      schemaVersion: snapshot.schemaVersion,
      snapshotId: snapshot.snapshotId,
      createdAt: snapshot.createdAt,
      protocol: snapshot.protocol,
      target: snapshot.target,
      sourceFingerprint: snapshot.sourceFingerprint,
      session: {
        title: snapshot.detail.summary.title,
        cwd: snapshot.detail.summary.cwd,
        createdAt: snapshot.detail.summary.createdAt,
        updatedAt: snapshot.detail.summary.updatedAt,
        model: snapshot.detail.projection.header.model,
        provider: snapshot.detail.projection.header.provider,
        recordCount: snapshot.detail.projection.records.length,
        turnCount: snapshot.detail.projection.turns.length,
      },
      objective: {
        label: snapshot.analysis.objectiveLabel,
        statement: snapshot.analysis.objective,
      },
      outcome: snapshot.analysis.outcome,
      stats: snapshot.analysis.stats,
      evaluations: snapshot.analysis.evaluations,
    }
  }
  if (query.view === 'findings') {
    return {
      snapshotId: snapshot.snapshotId,
      corrections: snapshot.analysis.corrections,
      optimizations: snapshot.analysis.optimizations ?? [],
    }
  }
  if (query.view === 'record') {
    if (query.recordId === undefined) throw new Error('record view requires --record-id')
    const record = snapshot.detail.projection.records.find(item => item.id === query.recordId)
    if (record === undefined) throw new Error('record not found')
    const maxBytes = Math.min(
      MAX_RECORD_VALUE_BYTES,
      Math.max(1, query.maxBytes ?? DEFAULT_RECORD_VALUE_BYTES),
    )
    return {
      snapshotId: snapshot.snapshotId,
      record: {
        ...record,
        input: boundedValue(record.input, maxBytes),
        output: boundedValue(record.output, maxBytes),
      },
    }
  }
  const offset = Math.max(0, query.offset ?? 0)
  const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? 20))
  const needle = query.query?.trim().toLowerCase()
  const records = snapshot.detail.projection.records.filter(record =>
    (query.turn === undefined || record.turn === query.turn)
    && (query.kind === undefined || record.kind === query.kind)
    && (query.status === undefined || record.status === query.status)
    && (needle === undefined || needle === '' || recordText(record).includes(needle)))
  return {
    snapshotId: snapshot.snapshotId,
    total: records.length,
    offset,
    limit,
    records: records.slice(offset, offset + limit).map(compactRecord),
  }
}
