import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  AnnotationCaseListItem,
  AnnotationActor,
  AnnotationCaseWorkspace,
  AnnotationDatasetSummary,
  AnnotationRecordDetail,
  AnnotationRecordSummary,
  AnnotationReviewer,
  AnnotationSaveRequest,
  AnnotationSaveResult,
  AnnotationWorkspaceOverview,
  PrepareEvaluationDatasetRequest,
  PrepareEvaluationDatasetResult,
  EvaluationRunDetails,
  EvaluationRunRequest,
  EvaluationRunResult,
  EvaluationWorkflowStatus,
} from '../../src/annotation-types'
import {
  annotationCaseComplete,
  annotationChainComplete,
  annotationCriterionComplete,
} from '../../src/annotation-types'
import type {
  AnnotationAgreementReport,
  EvaluationAdjudication,
  EvaluationCaseDirection,
  EvaluationSplit,
  EvaluationRun,
  EvaluationRunDiff,
  EvaluationDataset,
  EvaluationCandidateManifest,
  HumanCaseAnnotation,
  HumanEvaluationAnnotations,
} from '../../src/evaluation-types'
import type { SessionDetail, TrajectoryRecord } from '../../src/types'
import { jsonWeight, WeightedLruCache } from '../lru'
import { runFileTransaction, writePrivateJson } from '../file-transaction'
import { defaultCasebookFile, EvaluationCasebookStore } from './casebook'
import { createEvaluationDataset } from './identity'
import { compareEvaluationRuns, runEvaluationDataset } from './runner'
import {
  annotationContentHash,
  loadCandidateCase,
  loadCandidateManifest,
  loadAdjudicatedDataset,
  parseAdjudication,
  parseCalibrationPrivacyAudit,
  parseHumanAnnotations,
  prepareCalibrationCandidates,
  validateCaseAnnotation,
  type CalibrationSource,
} from './calibration'

const DIRECTORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,80}$/
const DATASET_ID = /^[a-z0-9][a-z0-9._-]{2,80}$/
const DATASET_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/
const CASE_ID = /^[a-z0-9][a-z0-9._-]{2,100}$/
const RUN_ID = /^[A-Za-z0-9_-]{20,80}$/
const RECORD_VALUE_BYTES = 256 * 1024

type RunIdentityMap = Map<
  EvaluationSplit | 'all',
  { datasetHash: string; goldHash: string }
>

function reviewerFile(reviewer: AnnotationReviewer): string {
  return reviewer === 'reviewer-a' ? 'reviewer-a.json' : 'reviewer-b.json'
}

function actorFile(actor: AnnotationActor): string {
  return actor === 'adjudicator' ? 'adjudication.json' : reviewerFile(actor)
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

function runDetails(
  run: EvaluationRun,
  split: EvaluationRunDetails['run']['split'],
): EvaluationRunDetails['run'] {
  return {
    runId: run.runId,
    createdAt: run.createdAt,
    split,
    assertionAgreement: run.aggregate.assertionAgreement,
    exactAgreement: run.aggregate.exactAgreement,
    evaluatorError: run.aggregate.evaluatorError,
    cases: run.cases.map(result => ({
      caseId: result.caseId,
      assertionsPassed: result.assertionsPassed,
      assertionsTotal: result.assertionsTotal,
      exact: result.exact,
      error: result.error,
      criteria: result.results.map(criterion => ({
        criterionId: criterion.criterionId,
        verdict: criterion.verdict,
        attribution: criterion.attribution,
        evidenceRecordIds: criterion.evidenceRecordIds,
      })),
      mismatches: result.mismatches,
    })),
  }
}

function diffDetails(
  diff: EvaluationRunDiff,
): NonNullable<EvaluationRunResult['diff']> {
  const caseDirections: Array<{
    caseId: string
    direction: EvaluationCaseDirection
  }> = []
  for (const [direction, ids] of [
    ['improved', diff.improvedCaseIds],
    ['regressed', diff.regressedCaseIds],
    ['mixed', diff.mixedCaseIds],
    ['unchanged', diff.unchangedCaseIds],
    ['inconclusive', diff.inconclusiveCaseIds],
  ] as const) {
    caseDirections.push(...ids.map(caseId => ({ caseId, direction })))
  }
  return {
    baselineRunId: diff.baselineRunId,
    candidateRunId: diff.candidateRunId,
    comparable: diff.comparable,
    gateDecision: diff.gateDecision,
    gateReasons: diff.gateReasons,
    improved: diff.improvedCaseIds.length,
    regressed: diff.regressedCaseIds.length,
    mixed: diff.mixedCaseIds.length,
    inconclusive: diff.inconclusiveCaseIds.length,
    caseDirections,
    changedCriteria: diff.changedCriteria,
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
  const sources = {
    dsh: 0,
    codex: 0,
    zcode: 0,
    claude: 0,
    'doubao-work': 0,
    workbuddy: 0,
    qoder: 0,
    opencode: 0,
  }
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
    requestedCases: manifest.preparation.requested,
    skippedCases: manifest.preparation.skipped,
    allowPartial: manifest.preparation.allowPartial,
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
export class AnnotationInputError extends Error {}
export class AnnotationNotFoundError extends Error {}

export class AnnotationWorkspaceStore {
  private readonly writes = new Map<string, Promise<void>>()
  private readonly preparations = new Map<
    string,
    {
      signature: string
      promise: Promise<PrepareEvaluationDatasetResult>
    }
  >()
  private readonly details = new WeightedLruCache<string, SessionDetail>({
    maxEntries: 8,
    maxWeight: 96 * 1024 * 1024,
    weight: jsonWeight,
  })
  private readonly runIdentities = new Map<string, {
    revision: string
    values: RunIdentityMap
  }>()
  private readonly casebook: EvaluationCasebookStore

  constructor(
    private readonly root: string,
    private readonly evaluationsRoot = path.join(path.dirname(root), 'evaluations'),
    private readonly calibrationSource?: CalibrationSource,
  ) {
    this.casebook = new EvaluationCasebookStore(
      defaultCasebookFile(path.dirname(this.evaluationsRoot)),
    )
  }

  private async optionalJson(file: string): Promise<unknown | undefined> {
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink()) return undefined
      return JSON.parse(await fs.readFile(file, 'utf8')) as unknown
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async assertAdjudicationReady(dataset: LoadedDataset): Promise<void> {
    const [reviewerA, reviewerB, agreementValue] = await Promise.all([
      this.actor(dataset, 'reviewer-a'),
      this.actor(dataset, 'reviewer-b'),
      this.optionalJson(path.join(dataset.directory, 'agreement.json')),
    ])
    const progressA = progress(reviewerA.annotations)
    const progressB = progress(reviewerB.annotations)
    if (progressA.complete !== progressA.total || progressB.complete !== progressB.total) {
      throw new AnnotationConflictError(
        'both reviewers must complete every case before adjudication',
      )
    }
    const agreement = agreementValue as Partial<AnnotationAgreementReport> | undefined
    if (agreement?.datasetHash !== dataset.manifest.contentHash
      || agreement.reviewerAHash !== annotationContentHash(reviewerA.annotations)
      || agreement.reviewerBHash !== annotationContentHash(reviewerB.annotations)) {
      throw new AnnotationConflictError(
        'an agreement report bound to the current reviewer files is required before adjudication',
      )
    }
  }

  private async writeActorAnnotations(
    actor: AnnotationActor,
    file: string,
    annotations: HumanEvaluationAnnotations,
  ): Promise<void> {
    if (actor !== 'adjudicator') {
      await writePrivateJson(file, annotations)
      return
    }
    const adjudication: EvaluationAdjudication = {
      schemaVersion: 1,
      kind: 'evaluation-adjudication',
      datasetId: annotations.datasetId,
      datasetVersion: annotations.datasetVersion,
      datasetHash: annotations.datasetHash,
      adjudicatorId: annotations.reviewerId,
      createdAt: annotations.createdAt,
      cases: annotations.cases,
    }
    await writePrivateJson(file, adjudication)
  }

  private async currentRunIdentities(
    dataset: LoadedDataset,
    adjudicationValue: unknown,
  ): Promise<RunIdentityMap> {
    const identityRevision = revision(JSON.stringify({
      manifestHash: dataset.manifest.contentHash,
      adjudication: adjudicationValue,
    }))
    const cached = this.runIdentities.get(dataset.directoryId)
    if (cached?.revision === identityRevision) return cached.values
    const loaded = await loadAdjudicatedDataset(
      dataset.directory,
      path.join(dataset.directory, 'adjudication.json'),
    )
    const values: RunIdentityMap = new Map([[
      'all',
      { datasetHash: loaded.datasetHash, goldHash: loaded.goldHash },
    ]])
    for (const split of ['calibration', 'regression', 'independent'] as const) {
      const cases = loaded.cases.filter(testCase => testCase.split === split)
      if (cases.length === 0) continue
      const selected = createEvaluationDataset({
        schemaVersion: loaded.schemaVersion,
        id: loaded.id,
        version: loaded.version,
        description: loaded.description,
        goldCompleteness: loaded.goldCompleteness,
        candidateManifestHash: loaded.candidateManifestHash,
        cases,
      })
      values.set(split, {
        datasetHash: selected.datasetHash,
        goldHash: selected.goldHash,
      })
    }
    this.runIdentities.set(dataset.directoryId, {
      revision: identityRevision,
      values,
    })
    return values
  }

  async workflowStatus(directoryId: string): Promise<EvaluationWorkflowStatus> {
    const dataset = await this.dataset(directoryId)
    const [reviewerA, reviewerB, agreementValue, adjudicationValue] = await Promise.all([
      this.actor(dataset, 'reviewer-a'),
      this.actor(dataset, 'reviewer-b'),
      this.optionalJson(path.join(dataset.directory, 'agreement.json')),
      this.optionalJson(path.join(dataset.directory, 'adjudication.json')),
    ])
    const progressA = progress(reviewerA.annotations)
    const progressB = progress(reviewerB.annotations)
    const reviewersComplete = progressA.complete === progressA.total
      && progressB.complete === progressB.total
    const agreement = agreementValue as AnnotationAgreementReport | undefined
    const matchingAgreement = agreement?.datasetHash === dataset.manifest.contentHash
      && agreement.reviewerAHash === annotationContentHash(reviewerA.annotations)
      && agreement.reviewerBHash === annotationContentHash(reviewerB.annotations)
      ? agreement
      : undefined
    let adjudication: EvaluationWorkflowStatus['adjudication'] = {
      exists: adjudicationValue !== undefined,
      complete: false,
    }
    let currentRunIdentities: RunIdentityMap = new Map()
    if (adjudicationValue !== undefined) {
      try {
        parseAdjudication(adjudicationValue, dataset.manifest)
        currentRunIdentities = await this.currentRunIdentities(
          dataset,
          adjudicationValue,
        )
        adjudication = { exists: true, complete: true }
      } catch (error) {
        adjudication = {
          exists: true,
          complete: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
    const entries = await fs.readdir(this.evaluationsRoot, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
    const runs: EvaluationWorkflowStatus['runs'] = []
    const diffs: EvaluationWorkflowStatus['diffs'] = []
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue
      const file = path.join(this.evaluationsRoot, entry.name)
      const value = await this.optionalJson(file)
      if (entry.name.endsWith('.diff.json')) {
        const diff = value as Partial<EvaluationRunDiff> | undefined
        if (diff?.gateDecision === undefined
          || diff.candidateManifestHash !== dataset.manifest.contentHash
          || ![...currentRunIdentities.values()].some(identity =>
            diff.datasetHash === identity.datasetHash
            && diff.goldHash === identity.goldHash)
          || typeof diff.baselineRunId !== 'string'
          || !RUN_ID.test(diff.baselineRunId)
          || typeof diff.candidateRunId !== 'string'
          || !RUN_ID.test(diff.candidateRunId)) continue
        diffs.push({
          file: entry.name,
          baselineRunId: diff.baselineRunId,
          candidateRunId: diff.candidateRunId,
          comparable: diff.comparable === true,
          gateDecision: diff.gateDecision,
          improved: diff.improvedCaseIds?.length ?? 0,
          regressed: diff.regressedCaseIds?.length ?? 0,
          mixed: diff.mixedCaseIds?.length ?? 0,
          inconclusive: diff.inconclusiveCaseIds?.length ?? 0,
        })
        continue
      }
      const run = value as Partial<EvaluationRun> | undefined
      const split = entry.name.includes('-calibration-')
        ? 'calibration'
        : entry.name.includes('-regression-')
          ? 'regression'
          : entry.name.includes('-independent-') ? 'independent' : 'all'
      const currentIdentity = currentRunIdentities.get(split)
      if (run?.schemaVersion !== 2
        || run.candidateManifestHash !== dataset.manifest.contentHash
        || currentIdentity === undefined
        || run.datasetHash !== currentIdentity.datasetHash
        || run.goldHash !== currentIdentity.goldHash
        || run.aggregate === undefined
        || typeof run.runId !== 'string'
        || !RUN_ID.test(run.runId)
        || typeof run.createdAt !== 'string'
        || typeof run.evaluatorId !== 'string'
        || typeof run.evaluatorBuildHash !== 'string') continue
      runs.push({
        file: entry.name,
        runId: run.runId,
        createdAt: run.createdAt,
        evaluatorId: run.evaluatorId,
        evaluatorBuildHash: run.evaluatorBuildHash,
        split,
        assertionAgreement: run.aggregate.assertionAgreement,
        exactAgreement: run.aggregate.exactAgreement,
        evaluatorError: run.aggregate.evaluatorError,
      })
    }
    runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const latest = runs[0]
    const latestValue = latest === undefined
      ? undefined
      : await this.optionalJson(path.join(this.evaluationsRoot, latest.file)) as EvaluationRun
    const casebook = await this.casebook.read()
    const datasetCasebook = casebook.entries.filter(entry =>
      entry.candidateManifestHash === dataset.manifest.contentHash
      && [...currentRunIdentities.values()].some(identity =>
        entry.datasetHash === identity.datasetHash
        && entry.goldHash === identity.goldHash))
    return {
      datasetHash: dataset.manifest.contentHash,
      reviewersComplete,
      agreement: matchingAgreement === undefined
        ? undefined
        : {
            completeCasesA: matchingAgreement.completeCasesA,
            completeCasesB: matchingAgreement.completeCasesB,
            totalCases: matchingAgreement.totalCases,
            criterionExactAgreement: matchingAgreement.criterionExactAgreement,
            criterionKappa: matchingAgreement.criterionKappa,
            requirementDetectionAgreement: matchingAgreement.requirementDetectionAgreement,
            requirementStateAgreement: matchingAgreement.requirementStateAgreement,
            chainExactAgreement: matchingAgreement.chainExactAgreement,
            chainKappa: matchingAgreement.chainKappa,
            disagreements: matchingAgreement.disagreements.length,
          },
      adjudication,
      runs,
      diffs,
      latestRun: latestValue === undefined
        ? undefined
        : {
            runId: latestValue.runId,
            createdAt: latestValue.createdAt,
            evaluatorId: latestValue.evaluatorId,
            evaluatorBuildHash: latestValue.evaluatorBuildHash,
            evaluatorCalibrationStatus: latestValue.evaluatorCalibrationStatus,
            evaluatorGateLevel: latestValue.evaluatorGateLevel,
          },
      casebook: {
        total: datasetCasebook.length,
        open: datasetCasebook.filter(entry => entry.status === 'open').length,
        resolved: datasetCasebook.filter(entry => entry.status === 'resolved').length,
        accepted: datasetCasebook.filter(entry =>
          entry.decision?.value === 'accepted').length,
        retested: datasetCasebook.filter(entry => entry.retests.length > 0).length,
      },
    }
  }

  async evaluationRunDetails(
    directoryId: string,
    runId: string,
  ): Promise<EvaluationRunDetails> {
    if (!RUN_ID.test(runId)) {
      throw new AnnotationInputError('invalid evaluation run id')
    }
    const status = await this.workflowStatus(directoryId)
    const runRef = status.runs.find(candidate => candidate.runId === runId)
    if (runRef === undefined) {
      throw new AnnotationNotFoundError('evaluation run not found')
    }
    const run = await this.optionalJson(
      path.join(this.evaluationsRoot, runRef.file),
    ) as EvaluationRun | undefined
    if (run?.schemaVersion !== 2 || run.runId !== runId) {
      throw new AnnotationNotFoundError('evaluation run not found')
    }
    const diffs: EvaluationRunDetails['diffs'] = []
    for (const diffRef of status.diffs) {
      if (diffRef.candidateRunId !== runId) continue
      const value = await this.optionalJson(
        path.join(this.evaluationsRoot, diffRef.file),
      ) as EvaluationRunDiff | undefined
      if (value?.candidateRunId !== runId) continue
      diffs.push(diffDetails(value))
    }
    return {
      run: runDetails(run, runRef.split ?? 'all'),
      diffs,
    }
  }

  async runEvaluation(
    directoryId: string,
    request: EvaluationRunRequest,
  ): Promise<EvaluationRunResult> {
    const dataset = await this.dataset(directoryId)
    await this.assertAdjudicationReady(dataset)
    if (request.split !== 'calibration'
      && request.split !== 'regression'
      && request.split !== 'independent') {
      throw new AnnotationInputError('invalid evaluation split')
    }
    if (request.split === 'independent' && request.confirmIndependent !== true) {
      throw new AnnotationConflictError(
        'independent evaluation requires explicit confirmation',
      )
    }
    const adjudicationFile = path.join(dataset.directory, 'adjudication.json')
    let loaded: EvaluationDataset
    try {
      loaded = await loadAdjudicatedDataset(dataset.directory, adjudicationFile)
    } catch (error) {
      throw new AnnotationConflictError(
        `complete adjudication is required: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    const selected = createEvaluationDataset({
      schemaVersion: loaded.schemaVersion,
      id: loaded.id,
      version: loaded.version,
      description: loaded.description,
      goldCompleteness: loaded.goldCompleteness,
      candidateManifestHash: loaded.candidateManifestHash,
      cases: loaded.cases.filter(testCase => testCase.split === request.split),
    })
    if (selected.cases.length === 0) {
      throw new AnnotationInputError(`dataset has no ${request.split} cases`)
    }
    let baseline: EvaluationRun | undefined
    if (request.baselineRunId !== undefined) {
      if (!RUN_ID.test(request.baselineRunId)) {
        throw new AnnotationInputError('invalid baseline evaluation run id')
      }
      const status = await this.workflowStatus(directoryId)
      const baselineRef = status.runs.find(candidate =>
        candidate.runId === request.baselineRunId)
      if (baselineRef === undefined) {
        throw new AnnotationNotFoundError('baseline evaluation run not found')
      }
      if (baselineRef.split !== request.split) {
        throw new AnnotationConflictError(
          `baseline split ${baselineRef.split ?? 'unknown'} does not match ${request.split}`,
        )
      }
      baseline = await this.optionalJson(
        path.join(this.evaluationsRoot, baselineRef.file),
      ) as EvaluationRun
    }
    const run = runEvaluationDataset(selected)
    await fs.mkdir(this.evaluationsRoot, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await fs.chmod(this.evaluationsRoot, 0o700)
    const baseName = [
      selected.id,
      selected.version,
      request.split,
      run.runId,
    ].join('-')
    const diff = baseline === undefined
      ? undefined
      : compareEvaluationRuns(baseline, run)
    await Promise.all([
      writePrivateJson(path.join(this.evaluationsRoot, `${baseName}.json`), run),
      ...(diff === undefined
        ? []
        : [writePrivateJson(
            path.join(
              this.evaluationsRoot,
              `${baseName}-vs-${diff.baselineRunId}.diff.json`,
            ),
            diff,
          )]),
    ])
    await this.casebook.syncRun(run)
    return {
      run: runDetails(run, request.split),
      diff: diff === undefined
        ? undefined
        : diffDetails(diff),
    }
  }

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
    if (!DIRECTORY_ID.test(directoryId)) {
      throw new AnnotationInputError('invalid annotation dataset id')
    }
    const root = path.resolve(this.root)
    const directory = path.resolve(root, directoryId)
    if (!directory.startsWith(`${root}${path.sep}`)) {
      throw new AnnotationInputError('invalid annotation dataset path')
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
    const [manifest, auditValue] = await Promise.all([
      loadCandidateManifest(directory),
      fs.readFile(auditFile, 'utf8').then(value => JSON.parse(value) as unknown),
    ])
    parseCalibrationPrivacyAudit(auditValue, manifest)
    return {
      directory,
      directoryId,
      manifest,
      privacyAuditPassed: true,
    }
  }

  private async actor(
    dataset: LoadedDataset,
    actor: AnnotationActor,
  ): Promise<LoadedReviewer> {
    const file = path.join(dataset.directory, actorFile(actor))
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('annotation reviewer file must be a real file')
    }
    const contents = await fs.readFile(file, 'utf8')
    const value = JSON.parse(contents) as unknown
    let annotations: HumanEvaluationAnnotations
    if (actor === 'adjudicator') {
      const source = value as Partial<EvaluationAdjudication>
      annotations = parseHumanAnnotations({
        schemaVersion: 1,
        kind: 'evaluation-annotations',
        datasetId: source.datasetId,
        datasetVersion: source.datasetVersion,
        datasetHash: source.datasetHash,
        reviewerId: source.adjudicatorId,
        createdAt: source.createdAt,
        cases: source.cases,
      }, dataset.manifest, { complete: false })
    } else {
      annotations = parseHumanAnnotations(value, dataset.manifest, { complete: false })
    }
    return {
      annotations,
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

  async prepareDataset(
    request: PrepareEvaluationDatasetRequest,
  ): Promise<PrepareEvaluationDatasetResult> {
    if (!DIRECTORY_ID.test(request.directoryId)) {
      throw new AnnotationInputError('invalid evaluation dataset directory id')
    }
    if (!DATASET_ID.test(request.datasetId)) {
      throw new AnnotationInputError('invalid evaluation dataset id')
    }
    if (!DATASET_VERSION.test(request.datasetVersion)) {
      throw new AnnotationInputError('invalid evaluation dataset version')
    }
    if (!Number.isInteger(request.count) || request.count < 3 || request.count > 120) {
      throw new AnnotationInputError('evaluation dataset count must be from 3 to 120')
    }
    if (typeof request.allowPartial !== 'boolean') {
      throw new AnnotationInputError('invalid partial dataset policy')
    }
    if (this.calibrationSource === undefined) {
      throw new AnnotationConflictError('evaluation dataset preparation is unavailable')
    }
    const signature = JSON.stringify({
      datasetId: request.datasetId,
      datasetVersion: request.datasetVersion,
      count: request.count,
      allowPartial: request.allowPartial,
    })
    const existing = this.preparations.get(request.directoryId)
    if (existing !== undefined) {
      if (existing.signature !== signature) {
        throw new AnnotationConflictError(
          `evaluation dataset preparation already running: ${request.directoryId}`,
        )
      }
      return existing.promise
    }
    const preparation = this.prepareDatasetOnce(request)
    this.preparations.set(request.directoryId, {
      signature,
      promise: preparation,
    })
    try {
      return await preparation
    } finally {
      if (this.preparations.get(request.directoryId)?.promise === preparation) {
        this.preparations.delete(request.directoryId)
      }
    }
  }

  private async prepareDatasetOnce(
    request: PrepareEvaluationDatasetRequest,
  ): Promise<PrepareEvaluationDatasetResult> {
    const root = path.resolve(this.root)
    const directory = path.resolve(root, request.directoryId)
    if (!directory.startsWith(`${root}${path.sep}`)) {
      throw new AnnotationInputError('invalid evaluation dataset directory path')
    }
    try {
      const stat = await fs.lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new AnnotationConflictError(
          `evaluation dataset path already exists: ${request.directoryId}`,
        )
      }
      const failedAudit = path.join(directory, 'PRIVACY-AUDIT-FAILED.json')
      const failedStat = await fs.lstat(failedAudit).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined
          throw error
        },
      )
      if (failedStat?.isFile() === true && !failedStat.isSymbolicLink()) {
        await fs.mkdir(root, { recursive: true, mode: 0o700 })
        await fs.rename(directory, path.join(
          root,
          `.quarantine-${request.directoryId}-${Date.now()}-${randomUUID()}`,
        ))
      } else {
        throw new AnnotationConflictError(
          `evaluation dataset directory already exists: ${request.directoryId}`,
        )
      }
    } catch (error) {
      if (error instanceof AnnotationConflictError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    const preparationDirectory = path.join(
      root,
      `.${request.directoryId}-${randomUUID()}.preparing`,
    )
    let prepared
    try {
      prepared = await prepareCalibrationCandidates(
        this.calibrationSource!,
        preparationDirectory,
        {
          count: request.count,
          allowPartial: request.allowPartial,
          datasetId: request.datasetId,
          datasetVersion: request.datasetVersion,
        },
      )
      await fs.rename(preparationDirectory, directory)
    } catch (error) {
      try {
        const entries = await fs.readdir(preparationDirectory)
        if (entries.length === 0) {
          await fs.rm(preparationDirectory, { recursive: true, force: true })
        } else {
          await fs.rename(preparationDirectory, path.join(
            root,
            `.quarantine-${request.directoryId}-${Date.now()}-${randomUUID()}`,
          ))
        }
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError
      }
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('not enough stable source sessions')
        || message.startsWith('calibration directory is not empty')
        || message.startsWith('calibration privacy audit failed')) {
        throw new AnnotationConflictError(message)
      }
      throw error
    }
    return {
      dataset: datasetSummary(
        request.directoryId,
        prepared.manifest,
        true,
      ),
      skipped: prepared.skipped.length,
    }
  }

  async overview(
    directoryId: string,
    reviewer: AnnotationReviewer,
  ): Promise<AnnotationWorkspaceOverview> {
    const dataset = await this.dataset(directoryId)
    const selected = await this.actor(dataset, reviewer)
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

  async adjudicationOverview(directoryId: string): Promise<AnnotationWorkspaceOverview> {
    const dataset = await this.dataset(directoryId)
    await this.assertAdjudicationReady(dataset)
    const selected = await this.actor(dataset, 'adjudicator')
    return {
      dataset: datasetSummary(
        directoryId,
        dataset.manifest,
        dataset.privacyAuditPassed,
      ),
      reviewer: 'adjudicator',
      revision: selected.revision,
      progress: progress(selected.annotations),
      cases: selected.annotations.cases.map(annotation =>
        caseListItem(dataset.manifest, annotation)),
    }
  }

  async case(
    directoryId: string,
    reviewer: AnnotationActor,
    caseId: string,
  ): Promise<AnnotationCaseWorkspace> {
    if (!CASE_ID.test(caseId)) throw new AnnotationInputError('invalid annotation case id')
    const dataset = await this.dataset(directoryId)
    if (reviewer === 'adjudicator') await this.assertAdjudicationReady(dataset)
    const candidate = dataset.manifest.cases.find(item => item.id === caseId)
    if (candidate === undefined) throw new AnnotationNotFoundError('annotation case not found')
    const [selected, detail] = await Promise.all([
      this.actor(dataset, reviewer),
      this.detail(dataset, candidate),
    ])
    const annotation = selected.annotations.cases.find(item => item.caseId === caseId)
    if (annotation === undefined) throw new AnnotationNotFoundError('annotation case not found')
    const userRecords = detail.projection.records.filter(record =>
      record.kind === 'user' || record.kind === 'steering')
    const comparison = reviewer === 'adjudicator'
      ? await this.adjudicationComparison(dataset, caseId)
      : undefined
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
      comparison,
    }
  }

  private async adjudicationComparison(
    dataset: LoadedDataset,
    caseId: string,
  ): Promise<NonNullable<AnnotationCaseWorkspace['comparison']>> {
    const [left, right] = await Promise.all([
      this.actor(dataset, 'reviewer-a'),
      this.actor(dataset, 'reviewer-b'),
    ])
    const leftCase = left.annotations.cases.find(testCase => testCase.caseId === caseId)
    const rightCase = right.annotations.cases.find(testCase => testCase.caseId === caseId)
    if (leftCase === undefined || rightCase === undefined) {
      throw new AnnotationNotFoundError('annotation case not found')
    }
    const leftCriteria = new Map(leftCase.criteria.map(item => [item.criterionId, item]))
    const rightCriteria = new Map(rightCase.criteria.map(item => [item.criterionId, item]))
    const leftRequirements = new Map(leftCase.requirements.map(item => [item.id, item]))
    const rightRequirements = new Map(rightCase.requirements.map(item => [item.id, item]))
    return {
      criteria: [...new Set([
        ...leftCriteria.keys(),
        ...rightCriteria.keys(),
      ])].map((criterionId) => {
        const leftCriterion = leftCriteria.get(criterionId)
        const rightCriterion = rightCriteria.get(criterionId)
        return {
          criterionId,
          reviewerA: leftCriterion === undefined
            ? undefined
            : {
                verdict: leftCriterion.verdict,
                attribution: leftCriterion.attribution,
                evidenceRecordIds: leftCriterion.evidenceRecordIds,
              },
          reviewerB: rightCriterion === undefined
            ? undefined
            : {
                verdict: rightCriterion.verdict,
                attribution: rightCriterion.attribution,
                evidenceRecordIds: rightCriterion.evidenceRecordIds,
              },
        }
      }),
      requirements: [...new Set([
        ...leftRequirements.keys(),
        ...rightRequirements.keys(),
      ])].map(id => ({
        id,
        reviewerA: leftRequirements.get(id) === undefined
          ? undefined
          : {
              text: leftRequirements.get(id)!.text,
              required: leftRequirements.get(id)!.required,
              state: leftRequirements.get(id)!.state,
              evidenceRecordIds: leftRequirements.get(id)!.evidenceRecordIds,
            },
        reviewerB: rightRequirements.get(id) === undefined
          ? undefined
          : {
              text: rightRequirements.get(id)!.text,
              required: rightRequirements.get(id)!.required,
              state: rightRequirements.get(id)!.state,
              evidenceRecordIds: rightRequirements.get(id)!.evidenceRecordIds,
            },
      })),
      chain: {
        reviewerA: {
          continuity: leftCase.chain.continuity,
          evidenceRecordIds: leftCase.chain.evidenceRecordIds,
        },
        reviewerB: {
          continuity: rightCase.chain.continuity,
          evidenceRecordIds: rightCase.chain.evidenceRecordIds,
        },
      },
    }
  }

  async record(
    directoryId: string,
    caseId: string,
    recordId: string,
  ): Promise<AnnotationRecordDetail> {
    if (!CASE_ID.test(caseId) || !/^record-\d{3,}$/.test(recordId)) {
      throw new AnnotationInputError('invalid annotation record id')
    }
    const dataset = await this.dataset(directoryId)
    const candidate = dataset.manifest.cases.find(item => item.id === caseId)
    if (candidate === undefined) throw new AnnotationNotFoundError('annotation case not found')
    const detail = await this.detail(dataset, candidate)
    const record = detail.projection.records.find(item => item.id === recordId)
    if (record === undefined) throw new AnnotationNotFoundError('annotation record not found')
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
    reviewer: AnnotationActor,
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
      const actorPath = path.join(dataset.directory, actorFile(reviewer))
      return await runFileTransaction(actorPath, async () => {
        if (reviewer === 'adjudicator') await this.assertAdjudicationReady(dataset)
        if (request.datasetHash !== dataset.manifest.contentHash) {
          throw new AnnotationConflictError('annotation dataset changed; reload before saving')
        }
        const candidate = dataset.manifest.cases.find(item => item.id === caseId)
        if (candidate === undefined) {
          throw new AnnotationNotFoundError('annotation case not found')
        }
        const [selected, detail] = await Promise.all([
          this.actor(dataset, reviewer),
          this.detail(dataset, candidate),
        ])
        if (request.revision !== selected.revision) {
          throw new AnnotationConflictError(
            'annotation file changed in another window; reload before saving',
          )
        }
        let annotation: HumanCaseAnnotation
        try {
          annotation = validateCaseAnnotation(
            request.annotation,
            candidate,
            detail,
          )
        } catch (error) {
          throw new AnnotationInputError(
            error instanceof Error ? error.message : String(error),
          )
        }
        if (annotation.caseId !== caseId) {
          throw new AnnotationInputError('annotation case mismatch')
        }
        const next: HumanEvaluationAnnotations = {
          ...selected.annotations,
          cases: selected.annotations.cases.map(item =>
            item.caseId === caseId ? annotation : item),
        }
        await this.writeActorAnnotations(reviewer, selected.file, next)
        const savedContents = await fs.readFile(selected.file, 'utf8')
        return {
          revision: revision(savedContents),
          progress: progress(next),
          case: caseListItem(dataset.manifest, annotation),
        }
      })
    } finally {
      resolveWrite()
      if (this.writes.get(key) === tail) this.writes.delete(key)
    }
  }
}
