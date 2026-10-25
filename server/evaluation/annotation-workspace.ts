import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  AnnotationCaseListItem,
  AnnotationCaseWorkspace,
  AnnotationDatasetSummary,
  AnnotationRecordDetail,
  AnnotationRecordSummary,
  AnnotationReviewer,
  AnnotationSaveRequest,
  AnnotationSaveResult,
  AnnotationWorkspaceOverview,
} from '../../src/annotation-types'
import {
  annotationCaseComplete,
  annotationChainComplete,
  annotationCriterionComplete,
} from '../../src/annotation-types'
import type {
  EvaluationCandidateManifest,
  HumanCaseAnnotation,
  HumanEvaluationAnnotations,
} from '../../src/evaluation-types'
import type { SessionDetail, TrajectoryRecord } from '../../src/types'
import { jsonWeight, WeightedLruCache } from '../lru'
import { writePrivateJson } from '../summary/file-transaction'
import {
  type CalibrationPrivacyAudit,
  loadCandidateCase,
  loadCandidateManifest,
  parseHumanAnnotations,
  validateCaseAnnotation,
} from './calibration'

const DIRECTORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,80}$/
const CASE_ID = /^[a-z0-9][a-z0-9._-]{2,100}$/
const RECORD_VALUE_BYTES = 256 * 1024

function reviewerFile(reviewer: AnnotationReviewer): string {
  return reviewer === 'reviewer-a' ? 'reviewer-a.json' : 'reviewer-b.json'
}

function revision(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

function recordText(record: TrajectoryRecord): string {
  if (typeof record.input === 'string') return record.input
  if (Array.isArray(record.input)) {
    const text = record.input.flatMap((entry) => {
      if (entry === null || typeof entry !== 'object') return []
      const value = (entry as Record<string, unknown>).text
      return typeof value === 'string' ? [value] : []
    }).join('\n').trim()
    if (text !== '') return text
  }
  return record.summary
}

function compact(value: string, limit = 260): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit - 1)}…`
}

function recordSummary(record: TrajectoryRecord): AnnotationRecordSummary {
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
    hasInput: record.input !== undefined,
    hasOutput: record.output !== undefined,
    hasError: record.error !== undefined,
    usage: record.usage,
  }
}

function boundedValue(value: unknown): unknown {
  if (value === undefined) return undefined
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  if (serialized === undefined) return value
  const bytes = Buffer.from(serialized)
  if (bytes.length <= RECORD_VALUE_BYTES) return value
  return {
    truncated: true,
    originalBytes: bytes.length,
    preview: new TextDecoder().decode(bytes.subarray(0, RECORD_VALUE_BYTES)),
  }
}

function caseListItem(
  manifest: EvaluationCandidateManifest,
  annotation: HumanCaseAnnotation,
): AnnotationCaseListItem {
  const candidate = manifest.cases.find(item => item.id === annotation.caseId)
  if (candidate === undefined) throw new Error(`candidate not found: ${annotation.caseId}`)
  return {
    id: candidate.id,
    source: candidate.target.source,
    split: candidate.split,
    traits: candidate.traits,
    complete: annotationCaseComplete(annotation),
    criteriaComplete: annotation.criteria.filter(criterion =>
      annotationCriterionComplete(criterion)).length,
    criteriaTotal: annotation.criteria.length,
    requirementCount: annotation.requirements.length,
    chainComplete: annotationChainComplete(annotation.chain),
  }
}

function progress(
  annotations: HumanEvaluationAnnotations,
): AnnotationWorkspaceOverview['progress'] {
  return {
    complete: annotations.cases.filter(annotationCaseComplete).length,
    total: annotations.cases.length,
  }
}

function datasetSummary(
  directoryId: string,
  manifest: EvaluationCandidateManifest,
  privacyAuditPassed: boolean,
): AnnotationDatasetSummary {
  const sources = { dsh: 0, codex: 0, zcode: 0 }
  const splits = { calibration: 0, regression: 0, independent: 0 }
  for (const candidate of manifest.cases) {
    sources[candidate.target.source]++
    splits[candidate.split]++
  }
  return {
    directoryId,
    datasetId: manifest.id,
    datasetVersion: manifest.version,
    datasetHash: manifest.contentHash,
    description: manifest.description,
    cases: manifest.cases.length,
    sources,
    splits,
    privacyAuditPassed,
  }
}

interface LoadedReviewer {
  annotations: HumanEvaluationAnnotations
  contents: string
  file: string
  revision: string
}

interface LoadedDataset {
  directory: string
  directoryId: string
  manifest: EvaluationCandidateManifest
  privacyAuditPassed: boolean
}

export class AnnotationConflictError extends Error {}

export class AnnotationWorkspaceStore {
  private readonly writes = new Map<string, Promise<void>>()
  private readonly details = new WeightedLruCache<string, SessionDetail>({
    maxEntries: 8,
    maxWeight: 96 * 1024 * 1024,
    weight: jsonWeight,
  })

  constructor(private readonly root: string) {}

  private async detail(
    dataset: LoadedDataset,
    candidate: EvaluationCandidateManifest['cases'][number],
  ): Promise<SessionDetail> {
    const key = `${dataset.directory}:${candidate.id}:${candidate.sha256}`
    const cached = this.details.get(key)
    if (cached !== undefined) return cached
    const detail = await loadCandidateCase(dataset.directory, candidate)
    this.details.set(key, detail)
    return detail
  }

  private async dataset(directoryId: string): Promise<LoadedDataset> {
    if (!DIRECTORY_ID.test(directoryId)) throw new Error('invalid annotation dataset id')
    const root = path.resolve(this.root)
    const directory = path.resolve(root, directoryId)
    if (!directory.startsWith(`${root}${path.sep}`)) {
      throw new Error('invalid annotation dataset path')
    }
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('annotation dataset must be a real directory')
    }
    const auditFile = path.join(directory, 'privacy-audit.json')
    const auditStat = await fs.lstat(auditFile)
    if (!auditStat.isFile() || auditStat.isSymbolicLink()) {
      throw new Error('annotation privacy audit must be a real file')
    }
    const [manifest, audit] = await Promise.all([
      loadCandidateManifest(directory),
      fs.readFile(auditFile, 'utf8').then(value =>
        JSON.parse(value) as CalibrationPrivacyAudit),
    ])
    if (audit.passed !== true
      || audit.cases !== manifest.cases.length
      || audit.hashesVerified !== manifest.cases.length
      || audit.forbiddenRecordFields !== 0
      || audit.homePathShapes !== 0
      || audit.credentialShapes !== 0
      || audit.identityMismatches !== 0) {
      throw new Error('annotation dataset privacy audit failed')
    }
    return {
      directory,
      directoryId,
      manifest,
      privacyAuditPassed: true,
    }
  }

  private async reviewer(
    dataset: LoadedDataset,
    reviewer: AnnotationReviewer,
  ): Promise<LoadedReviewer> {
    const file = path.join(dataset.directory, reviewerFile(reviewer))
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('annotation reviewer file must be a real file')
    }
    const contents = await fs.readFile(file, 'utf8')
    return {
      annotations: parseHumanAnnotations(
        JSON.parse(contents) as unknown,
        dataset.manifest,
        { complete: false },
      ),
      contents,
      file,
      revision: revision(contents),
    }
  }

  async listDatasets(): Promise<AnnotationDatasetSummary[]> {
    const entries = await fs.readdir(this.root, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
    const settled = await Promise.allSettled(entries
      .filter(entry =>
        entry.isDirectory()
        && !entry.isSymbolicLink()
        && DIRECTORY_ID.test(entry.name))
      .map(async (entry) => {
        const dataset = await this.dataset(entry.name)
        return datasetSummary(
          entry.name,
          dataset.manifest,
          dataset.privacyAuditPassed,
        )
      }))
    return settled.flatMap(result =>
      result.status === 'fulfilled' ? [result.value] : [])
  }

  async overview(
    directoryId: string,
    reviewer: AnnotationReviewer,
  ): Promise<AnnotationWorkspaceOverview> {
    const dataset = await this.dataset(directoryId)
    const selected = await this.reviewer(dataset, reviewer)
    return {
      dataset: datasetSummary(
        directoryId,
        dataset.manifest,
        dataset.privacyAuditPassed,
      ),
      reviewer,
      revision: selected.revision,
      progress: progress(selected.annotations),
      cases: selected.annotations.cases.map(annotation =>
        caseListItem(dataset.manifest, annotation)),
    }
  }

  async case(
    directoryId: string,
    reviewer: AnnotationReviewer,
    caseId: string,
  ): Promise<AnnotationCaseWorkspace> {
    if (!CASE_ID.test(caseId)) throw new Error('invalid annotation case id')
    const dataset = await this.dataset(directoryId)
    const candidate = dataset.manifest.cases.find(item => item.id === caseId)
    if (candidate === undefined) throw new Error('annotation case not found')
    const [selected, detail] = await Promise.all([
      this.reviewer(dataset, reviewer),
      this.detail(dataset, candidate),
    ])
    const annotation = selected.annotations.cases.find(item => item.caseId === caseId)
    if (annotation === undefined) throw new Error('annotation case not found')
    const userRecords = detail.projection.records.filter(record =>
      record.kind === 'user' || record.kind === 'steering')
    return {
      datasetHash: dataset.manifest.contentHash,
      reviewer,
      revision: selected.revision,
      candidate: {
        id: candidate.id,
        source: candidate.target.source,
        split: candidate.split,
        traits: candidate.traits,
        description: candidate.description,
      },
      annotation,
      records: detail.projection.records.map(recordSummary),
      requirementSuggestions: userRecords.map((record, index) => ({
        id: `requirement-${String(index + 1).padStart(3, '0')}`,
        text: compact(recordText(record)),
        recordId: record.id,
        turn: record.turn,
      })),
      userTurns: [...new Set(userRecords.map(record => record.turn))].sort((a, b) => a - b),
    }
  }

  async record(
    directoryId: string,
    caseId: string,
    recordId: string,
  ): Promise<AnnotationRecordDetail> {
    if (!CASE_ID.test(caseId) || !/^record-\d{3,}$/.test(recordId)) {
      throw new Error('invalid annotation record id')
    }
    const dataset = await this.dataset(directoryId)
    const candidate = dataset.manifest.cases.find(item => item.id === caseId)
    if (candidate === undefined) throw new Error('annotation case not found')
    const detail = await this.detail(dataset, candidate)
    const record = detail.projection.records.find(item => item.id === recordId)
    if (record === undefined) throw new Error('annotation record not found')
    return {
      ...recordSummary(record),
      input: boundedValue(record.input),
      output: boundedValue(record.output),
      error: record.error,
      retry: record.retry,
      metrics: record.metrics,
    }
  }

  async saveCase(
    directoryId: string,
    reviewer: AnnotationReviewer,
    caseId: string,
    request: AnnotationSaveRequest,
  ): Promise<AnnotationSaveResult> {
    const key = `${directoryId}:${reviewer}`
    const previous = this.writes.get(key) ?? Promise.resolve()
    let resolveWrite!: () => void
    const current = new Promise<void>(resolve => {
      resolveWrite = resolve
    })
    const tail = previous.then(() => current)
    this.writes.set(key, tail)
    await previous
    try {
      const dataset = await this.dataset(directoryId)
      if (request.datasetHash !== dataset.manifest.contentHash) {
        throw new AnnotationConflictError('annotation dataset changed; reload before saving')
      }
      const candidate = dataset.manifest.cases.find(item => item.id === caseId)
      if (candidate === undefined) throw new Error('annotation case not found')
      const [selected, detail] = await Promise.all([
        this.reviewer(dataset, reviewer),
        this.detail(dataset, candidate),
      ])
      if (request.revision !== selected.revision) {
        throw new AnnotationConflictError(
          'annotation file changed in another window; reload before saving',
        )
      }
      const annotation = validateCaseAnnotation(
        request.annotation,
        candidate,
        detail,
      )
      if (annotation.caseId !== caseId) throw new Error('annotation case mismatch')
      const next: HumanEvaluationAnnotations = {
        ...selected.annotations,
        cases: selected.annotations.cases.map(item =>
          item.caseId === caseId ? annotation : item),
      }
      await writePrivateJson(selected.file, next)
      const savedContents = await fs.readFile(selected.file, 'utf8')
      return {
        revision: revision(savedContents),
        progress: progress(next),
        case: caseListItem(dataset.manifest, annotation),
      }
    } finally {
      resolveWrite()
      if (this.writes.get(key) === tail) this.writes.delete(key)
    }
  }
}
