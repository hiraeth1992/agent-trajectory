import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  DiagnosisEvidenceAccess,
  DiagnosisEvidenceView,
} from '../evaluation/process-check'

const SNAPSHOT_ID = /^[A-Za-z0-9_-]{20,80}$/
const RECORD_ID = /^[A-Za-z0-9_.:-]{1,200}$/

export interface DiagnosisEvidenceAccessRecord extends DiagnosisEvidenceAccess {
  schemaVersion: 1
  kind: 'diagnosis-evidence-access'
  accessedAt: string
  recordId?: string
}

function ledgerFile(root: string, snapshotId: string): string {
  if (!SNAPSHOT_ID.test(snapshotId)) throw new Error('invalid snapshot id')
  return path.join(path.resolve(root), `${snapshotId}.access.jsonl`)
}

export async function appendDiagnosisEvidenceAccess(
  root: string,
  value: {
    snapshotId: string
    view: DiagnosisEvidenceView
    recordId?: string
    accessedAt?: string
  },
): Promise<void> {
  if (value.recordId !== undefined && !RECORD_ID.test(value.recordId)) {
    throw new Error('invalid diagnosis record id')
  }
  const file = ledgerFile(root, value.snapshotId)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await fs.chmod(path.dirname(file), 0o700)
  const record: DiagnosisEvidenceAccessRecord = {
    schemaVersion: 1,
    kind: 'diagnosis-evidence-access',
    snapshotId: value.snapshotId,
    view: value.view,
    accessedAt: value.accessedAt ?? new Date().toISOString(),
    ...(value.recordId === undefined ? {} : { recordId: value.recordId }),
  }
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') await fs.chmod(file, 0o600)
}

export async function readDiagnosisEvidenceAccesses(
  root: string,
  snapshotId: string,
): Promise<DiagnosisEvidenceAccessRecord[]> {
  const file = ledgerFile(root, snapshotId)
  let contents: string
  try {
    contents = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return contents.split(/\r?\n/).filter(line => line.trim() !== '').map((line, index) => {
    const value = JSON.parse(line) as Partial<DiagnosisEvidenceAccessRecord>
    if (value.schemaVersion !== 1
      || value.kind !== 'diagnosis-evidence-access'
      || value.snapshotId !== snapshotId
      || !['overview', 'findings', 'records', 'record'].includes(value.view ?? '')
      || typeof value.accessedAt !== 'string') {
      throw new Error(`invalid diagnosis access ledger row ${index + 1}`)
    }
    return value as DiagnosisEvidenceAccessRecord
  })
}

export function diagnosisAccessLedgerHash(
  records: readonly DiagnosisEvidenceAccessRecord[],
): string {
  return createHash('sha256').update(JSON.stringify(records)).digest('hex')
}
