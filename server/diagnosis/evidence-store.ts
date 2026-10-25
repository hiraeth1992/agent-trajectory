import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  TrajectoryDiagnosisTarget,
} from '../../src/diagnosis-types'
import { TRAJECTORY_DIAGNOSIS_PROTOCOL } from '../../src/diagnosis-types'
import { redactSensitive } from '../../src/projector-utils'
import { analyzeTrajectory } from '../../src/trajectory-analysis'
import type {
  SessionDetail,
  TransportSessionDetail,
} from '../../src/types'
import { writePrivateJson } from '../summary/file-transaction'

const SNAPSHOT_SCHEMA_VERSION = 1
const SNAPSHOT_FILE = /^[A-Za-z0-9_-]{20,80}\.json$/
const DEFAULT_MAX_SNAPSHOTS = 24
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024

export interface DiagnosisEvidenceSnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION
  snapshotId: string
  createdAt: string
  protocol: typeof TRAJECTORY_DIAGNOSIS_PROTOCOL
  target: TrajectoryDiagnosisTarget
  sourceFingerprint: string
  detail: TransportSessionDetail
  analysis: ReturnType<typeof analyzeTrajectory>
}

export interface DiagnosisEvidenceSnapshotRef {
  snapshotId: string
  file: string
  sourceFingerprint: string
}

interface DiagnosisEvidenceStoreOptions {
  maxBytes?: number
  maxSnapshots?: number
}

function transportDetail(detail: SessionDetail): TransportSessionDetail {
  return redactSensitive({
    ...detail,
    projection: {
      ...detail.projection,
      records: detail.projection.records.map((record) => {
        const {
          raw: _raw,
          searchText: _searchText,
          ...transport
        } = record
        return transport
      }),
    },
  }) as TransportSessionDetail
}

function snapshotId(target: TrajectoryDiagnosisTarget, fingerprint: string): string {
  const digest = createHash('sha256')
    .update(`${target.source}\0${target.sessionId}\0${fingerprint}\0${randomUUID()}`)
    .digest('base64url')
  return digest.slice(0, 32)
}

export class DiagnosisEvidenceStore {
  private readonly maxBytes: number
  private readonly maxSnapshots: number

  constructor(
    private readonly root: string,
    options: DiagnosisEvidenceStoreOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.maxSnapshots = options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS
  }

  get directory(): string {
    return path.resolve(this.root)
  }

  async create(
    target: TrajectoryDiagnosisTarget,
    sourceFingerprint: string,
    detail: SessionDetail,
  ): Promise<DiagnosisEvidenceSnapshotRef> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await fs.chmod(this.root, 0o700)
    const id = snapshotId(target, sourceFingerprint)
    const file = path.join(this.root, `${id}.json`)
    const snapshot: DiagnosisEvidenceSnapshot = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      snapshotId: id,
      createdAt: new Date().toISOString(),
      protocol: TRAJECTORY_DIAGNOSIS_PROTOCOL,
      target,
      sourceFingerprint,
      detail: transportDetail(detail),
      analysis: redactSensitive(
        analyzeTrajectory(detail),
      ) as ReturnType<typeof analyzeTrajectory>,
    }
    await writePrivateJson(file, snapshot)
    await this.prune(id)
    return { snapshotId: id, file, sourceFingerprint }
  }

  private async prune(currentId: string): Promise<void> {
    const entries = await fs.readdir(this.root, { withFileTypes: true })
    const files = await Promise.all(entries
      .filter(entry => entry.isFile() && SNAPSHOT_FILE.test(entry.name))
      .map(async (entry) => {
        const file = path.join(this.root, entry.name)
        const stat = await fs.stat(file)
        return { file, id: entry.name.slice(0, -5), mtimeMs: stat.mtimeMs, size: stat.size }
      }))
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    let retainedBytes = 0
    const removals: Promise<void>[] = []
    for (const [index, file] of files.entries()) {
      retainedBytes += file.size
      if (file.id === currentId) continue
      if (index >= this.maxSnapshots || retainedBytes > this.maxBytes) {
        removals.push(fs.rm(file.file, { force: true }))
      }
    }
    await Promise.all(removals)
  }
}
