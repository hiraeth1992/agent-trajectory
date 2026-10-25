import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AnnotationSaveRequest } from '../src/annotation-types'
import type {
  HumanCaseAnnotation,
  HumanEvaluationAnnotations,
} from '../src/evaluation-types'
import type {
  SessionDetail,
  SessionSummary,
  SourceId,
  SourceStatus,
  TrajectoryRecord,
} from '../src/types'
import {
  AnnotationConflictError,
  AnnotationInputError,
  AnnotationNotFoundError,
  AnnotationWorkspaceStore,
} from '../server/evaluation/annotation-workspace'
import {
  compareHumanAnnotations,
  createAdjudicationTemplate,
  createAnnotationTemplate,
  loadAdjudicatedDataset,
  prepareCalibrationCandidates,
  type CalibrationSource,
} from '../server/evaluation/calibration'
import { createEvaluationDataset } from '../server/evaluation/identity'
import { runEvaluationDataset } from '../server/evaluation/runner'
import { capabilities, sessionKey } from '../server/sources/types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

function record(
  source: SourceId,
  id: string,
  overrides: Partial<TrajectoryRecord> = {},
): TrajectoryRecord {
  return {
    id,
    source,
    sourceEventIds: [id],
    fidelity: 'exact',
    seq: 1,
    turn: 1,
    step: 1,
    kind: 'tool',
    title: 'exec_command',
    summary: '运行测试',
    startTime: 1_000,
    endTime: 2_000,
    status: 'complete',
    depth: 0,
    input: { cmd: 'npm test' },
    output: 'Tests 2 passed',
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    searchText: id,
    ...overrides,
  }
}

function detail(source: SourceId, sourceSessionId: string): SessionDetail {
  const summary: SessionSummary = {
    id: sessionKey(source, sourceSessionId),
    source,
    sourceSessionId,
    format: 'annotation-test',
    capabilities: capabilities('messages', 'tools', 'timing', 'usage'),
    cwd: '/workspace/private',
    title: `Private ${source}`,
    createdAt: 1_000,
    updatedAt: 3_000,
    size: 2,
  }
  return {
    summary,
    projection: {
      header: {
        source,
        format: summary.format,
        id: sourceSessionId,
        createdAt: 1_000,
      },
      records: [
        record(source, `${sourceSessionId}-user`, {
          seq: 1,
          step: 0,
          kind: 'user',
          title: '用户',
          summary: '修复并验证',
          input: [{ type: 'text', text: '修复并验证' }],
          output: undefined,
          usage: undefined,
        }),
        record(source, `${sourceSessionId}-tool`, { seq: 2 }),
      ],
      turns: [{
        id: 'turn-1',
        number: 1,
        startTime: 1_000,
        endTime: 2_000,
        status: 'complete',
      }],
      lanes: [],
      startTime: 1_000,
      endTime: 2_000,
      eventCount: 2,
      eventTypeCounts: {},
      unknownEventTypes: [],
      turnEnds: { 1: { time: 2_000, reason: 'complete' } },
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    },
  }
}

function status(source: SourceId): SourceStatus {
  return {
    source,
    availability: 'available',
    label: source.toUpperCase(),
    colorToken: source === 'dsh' ? 'blue' : source === 'codex' ? 'green' : 'amber',
    iconToken: source === 'dsh' ? 'agent' : source === 'codex' ? 'code' : 'terminal',
    sessionCount: 1,
    capabilities: capabilities('messages', 'tools', 'timing', 'usage'),
  }
}

function calibrationSource(): CalibrationSource {
  const details = new Map<SourceId, SessionDetail>([
    ['dsh', detail('dsh', 'dsh-private')],
    ['codex', detail('codex', 'codex-private')],
    ['zcode', detail('zcode', 'zcode-private')],
  ])
  return {
    listSources: async () => [...details.keys()].map(status),
    listSessions: async () => [...details.values()].map(item => item.summary),
    fingerprint: async (source, id) => `fingerprint:${source}:${id}`,
    load: async source => structuredClone(details.get(source)),
  }
}

function completeCase(annotation: HumanCaseAnnotation): HumanCaseAnnotation {
  return {
    ...structuredClone(annotation),
    criteria: annotation.criteria.map(criterion => ({
      ...criterion,
      verdict: criterion.criterionId === 'recovery' ? 'not_applicable' : 'pass',
      attribution: criterion.criterionId === 'recovery'
        ? 'not_applicable'
        : 'agent',
      evidenceRecordIds: ['record-002'],
      notes: '人工标注。',
    })),
    requirements: [{
      id: 'requirement-001',
      text: '修复并验证',
      required: true,
      state: 'implemented',
      evidenceRecordIds: ['record-001', 'record-002'],
      notes: '要求和验证证据齐全。',
    }],
    chain: {
      continuity: 'not_applicable',
      evidenceRecordIds: ['record-001'],
      notes: '只有一个用户轮次。',
    },
    notes: '完成。',
  }
}

describe('annotation workspace store', () => {
  it('isolates reviewers, lazy-loads record details, and saves with revision locking', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'annotation-workspace-'))
    roots.push(root)
    const calibrationRoot = path.join(root, 'calibration')
    const datasetRoot = path.join(calibrationRoot, 'private-v1')
    const prepared = await prepareCalibrationCandidates(
      calibrationSource(),
      datasetRoot,
      {
        count: 3,
        datasetId: 'private-workspace-test',
        datasetVersion: '1',
        createdAt: '2026-10-25T00:00:00.000Z',
      },
    )
    const reviewerB = JSON.parse(
      await fs.readFile(prepared.reviewerBTemplate, 'utf8'),
    ) as HumanEvaluationAnnotations
    reviewerB.cases[0]!.notes = 'REVIEWER_B_PRIVATE_MARKER'
    await fs.writeFile(prepared.reviewerBTemplate, JSON.stringify(reviewerB))

    const store = new AnnotationWorkspaceStore(calibrationRoot)
    expect(await store.listDatasets()).toEqual([
      expect.objectContaining({
        directoryId: 'private-v1',
        cases: 3,
        privacyAuditPassed: true,
      }),
    ])

    const overview = await store.overview('private-v1', 'reviewer-a')
    expect(overview.progress).toEqual({ complete: 0, total: 3 })
    expect(JSON.stringify(overview)).not.toContain('REVIEWER_B_PRIVATE_MARKER')

    const first = overview.cases[0]!
    const workspace = await store.case('private-v1', 'reviewer-a', first.id)
    expect(workspace.requirementSuggestions).toEqual([expect.objectContaining({
      id: 'requirement-001',
      recordId: 'record-001',
      text: '修复并验证',
    })])
    expect(workspace.records[1]).toMatchObject({
      id: 'record-002',
      hasInput: true,
      hasOutput: true,
    })
    expect(workspace.records[1]).not.toHaveProperty('input')
    expect(workspace.records[1]).not.toHaveProperty('output')
    expect(JSON.stringify(workspace)).not.toContain('REVIEWER_B_PRIVATE_MARKER')

    const fullRecord = await store.record(
      'private-v1',
      first.id,
      'record-002',
    )
    expect(fullRecord).toMatchObject({
      id: 'record-002',
      input: { cmd: 'npm test' },
      output: 'Tests 2 passed',
    })

    const annotation = completeCase(workspace.annotation)
    const request: AnnotationSaveRequest = {
      datasetHash: workspace.datasetHash,
      revision: workspace.revision,
      annotation,
    }
    const saved = await store.saveCase(
      'private-v1',
      'reviewer-a',
      first.id,
      request,
    )
    expect(saved).toMatchObject({
      progress: { complete: 1, total: 3 },
      case: { id: first.id, complete: true },
    })
    expect(saved.revision).not.toBe(workspace.revision)
    const storedA = JSON.parse(
      await fs.readFile(prepared.reviewerATemplate, 'utf8'),
    ) as HumanEvaluationAnnotations
    expect(storedA.cases[0]).toEqual(annotation)
    const storedBAfter = JSON.parse(
      await fs.readFile(prepared.reviewerBTemplate, 'utf8'),
    ) as HumanEvaluationAnnotations
    expect(storedBAfter.cases[0]!.notes).toBe('REVIEWER_B_PRIVATE_MARKER')

    await expect(store.saveCase(
      'private-v1',
      'reviewer-a',
      first.id,
      request,
    )).rejects.toBeInstanceOf(AnnotationConflictError)
  })

  it('rejects traversal, symlink datasets, and dangling evidence references', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'annotation-workspace-'))
    roots.push(root)
    const calibrationRoot = path.join(root, 'calibration')
    const datasetRoot = path.join(calibrationRoot, 'private-v1')
    await prepareCalibrationCandidates(calibrationSource(), datasetRoot, {
      count: 3,
      datasetId: 'private-workspace-test',
      datasetVersion: '1',
    })
    const store = new AnnotationWorkspaceStore(calibrationRoot)

    await expect(store.overview('../private-v1', 'reviewer-a'))
      .rejects.toThrow(/invalid annotation dataset id/)
    await fs.symlink(datasetRoot, path.join(calibrationRoot, 'linked-v1'))
    expect(await store.listDatasets()).toHaveLength(1)

    const overview = await store.overview('private-v1', 'reviewer-a')
    const selected = overview.cases[0]!
    const workspace = await store.case('private-v1', 'reviewer-a', selected.id)
    const invalid = completeCase(workspace.annotation)
    invalid.criteria[0]!.evidenceRecordIds = ['record-999']
    await expect(store.saveCase(
      'private-v1',
      'reviewer-a',
      selected.id,
      {
        datasetHash: workspace.datasetHash,
        revision: workspace.revision,
        annotation: invalid,
      },
    )).rejects.toThrow(/references missing records/)
  })

  it('rejects contradictory verdict attribution and invalid chain semantics', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'annotation-workspace-'))
    roots.push(root)
    const calibrationRoot = path.join(root, 'calibration')
    const datasetRoot = path.join(calibrationRoot, 'private-v1')
    await prepareCalibrationCandidates(calibrationSource(), datasetRoot, {
      count: 3,
      datasetId: 'private-workspace-semantics',
      datasetVersion: '1',
    })
    const store = new AnnotationWorkspaceStore(calibrationRoot)
    const overview = await store.overview('private-v1', 'reviewer-a')
    const selected = overview.cases[0]!
    const workspace = await store.case('private-v1', 'reviewer-a', selected.id)
    const request = (annotation: HumanCaseAnnotation): AnnotationSaveRequest => ({
      datasetHash: workspace.datasetHash,
      revision: workspace.revision,
      annotation,
    })

    const contradictory = completeCase(workspace.annotation)
    contradictory.criteria[0]!.verdict = 'evaluator_error'
    contradictory.criteria[0]!.attribution = 'agent'
    await expect(store.saveCase(
      'private-v1',
      'reviewer-a',
      selected.id,
      request(contradictory),
    )).rejects.toThrow(/evaluator_error must attribute evaluator/)

    const missingTransition = completeCase(workspace.annotation)
    missingTransition.chain.continuity = 'missing'
    await expect(store.saveCase(
      'private-v1',
      'reviewer-a',
      selected.id,
      request(missingTransition),
    )).rejects.toThrow(/requires failedTransition/)

    const nonexistentTurn = completeCase(workspace.annotation)
    nonexistentTurn.chain = {
      continuity: 'incorrect',
      failedTransition: { fromTurn: 1, toTurn: 2 },
      evidenceRecordIds: ['record-001'],
      notes: '第二轮并不存在。',
    }
    await expect(store.saveCase(
      'private-v1',
      'reviewer-a',
      selected.id,
      request(nonexistentTurn),
    )).rejects.toThrow(/invalid chain transition 1 -> 2/)

    const forbiddenTransition = completeCase(workspace.annotation)
    forbiddenTransition.chain.failedTransition = { fromTurn: 1, toTurn: 2 }
    await expect(store.saveCase(
      'private-v1',
      'reviewer-a',
      selected.id,
      request(forbiddenTransition),
    )).rejects.toThrow(/forbids failedTransition/)
  })

  it('refuses an audit that is not bound to the current manifest', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'annotation-workspace-'))
    roots.push(root)
    const calibrationRoot = path.join(root, 'calibration')
    const datasetRoot = path.join(calibrationRoot, 'private-v1')
    await prepareCalibrationCandidates(calibrationSource(), datasetRoot, {
      count: 3,
      datasetId: 'private-workspace-audit',
      datasetVersion: '1',
    })
    const auditFile = path.join(datasetRoot, 'privacy-audit.json')
    const audit = JSON.parse(await fs.readFile(auditFile, 'utf8')) as {
      manifestHash: string
    }
    audit.manifestHash = '0'.repeat(64)
    await fs.writeFile(auditFile, JSON.stringify(audit))

    const store = new AnnotationWorkspaceStore(calibrationRoot)
    expect(await store.listDatasets()).toEqual([])
    await expect(store.overview('private-v1', 'reviewer-a'))
      .rejects.toThrow(/privacy audit manifest hash mismatch/)
  })

  it('reports hash-bound agreement, adjudication, and evaluation runs', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'annotation-workspace-'))
    roots.push(root)
    const calibrationRoot = path.join(root, 'calibration')
    const evaluationsRoot = path.join(root, 'evaluations')
    const datasetRoot = path.join(calibrationRoot, 'private-v1')
    const prepared = await prepareCalibrationCandidates(
      calibrationSource(),
      datasetRoot,
      {
        count: 3,
        datasetId: 'private-workflow-status',
        datasetVersion: '1',
      },
    )
    const complete = (reviewerId: string) => {
      const annotations = createAnnotationTemplate(prepared.manifest, reviewerId)
      annotations.cases = annotations.cases.map(testCase =>
        completeCase(testCase))
      return annotations
    }
    const reviewerA = complete('reviewer-a')
    const reviewerB = complete('reviewer-b')
    await fs.writeFile(prepared.reviewerATemplate, JSON.stringify(reviewerA))
    await fs.writeFile(prepared.reviewerBTemplate, JSON.stringify(reviewerB))
    await fs.writeFile(
      path.join(datasetRoot, 'agreement.json'),
      JSON.stringify(compareHumanAnnotations(prepared.manifest, reviewerA, reviewerB)),
    )
    const adjudication = createAdjudicationTemplate(prepared.manifest, 'adjudicator')
    adjudication.cases = reviewerA.cases
    const adjudicationFile = path.join(datasetRoot, 'adjudication.json')
    await fs.writeFile(adjudicationFile, JSON.stringify(adjudication))
    const dataset = await loadAdjudicatedDataset(datasetRoot, adjudicationFile)
    const calibrationDataset = createEvaluationDataset({
      schemaVersion: dataset.schemaVersion,
      id: dataset.id,
      version: dataset.version,
      description: dataset.description,
      goldCompleteness: dataset.goldCompleteness,
      candidateManifestHash: dataset.candidateManifestHash,
      cases: dataset.cases.filter(testCase => testCase.split === 'calibration'),
    })
    const run = runEvaluationDataset(calibrationDataset, {
      createdAt: '2026-10-25T00:00:00.000Z',
    })
    await fs.mkdir(evaluationsRoot)
    await fs.writeFile(
      path.join(evaluationsRoot, 'private-workflow-status-1-calibration-run.json'),
      JSON.stringify(run),
    )
    await fs.writeFile(
      path.join(evaluationsRoot, 'unrelated.json'),
      JSON.stringify({ ...run, candidateManifestHash: '0'.repeat(64) }),
    )
    await fs.writeFile(
      path.join(evaluationsRoot, 'stale-gold.json'),
      JSON.stringify({ ...run, goldHash: '0'.repeat(64) }),
    )

    const status = await new AnnotationWorkspaceStore(
      calibrationRoot,
      evaluationsRoot,
    ).workflowStatus('private-v1')
    expect(status).toMatchObject({
      reviewersComplete: true,
      agreement: {
        completeCasesA: 3,
        completeCasesB: 3,
        totalCases: 3,
        disagreements: 0,
      },
      adjudication: { exists: true, complete: true },
      runs: [{
        file: 'private-workflow-status-1-calibration-run.json',
        runId: run.runId,
        split: 'calibration',
      }],
      latestRun: {
        runId: run.runId,
        evaluatorId: 'local-trajectory',
        evaluatorGateLevel: 'required',
      },
    })
    expect(status.runs).toHaveLength(1)

    const store = new AnnotationWorkspaceStore(calibrationRoot, evaluationsRoot)
    const adjudicationOverview = await store.adjudicationOverview('private-v1')
    expect(adjudicationOverview).toMatchObject({
      reviewer: 'adjudicator',
      progress: { complete: 3, total: 3 },
    })
    const selected = adjudicationOverview.cases[0]!
    const workspace = await store.case(
      'private-v1',
      'adjudicator',
      selected.id,
    )
    expect(workspace.comparison).toMatchObject({
      criteria: expect.arrayContaining([
        expect.objectContaining({
          criterionId: 'outcome',
          reviewerA: {
            verdict: 'pass',
            attribution: 'agent',
            evidenceRecordIds: ['record-002'],
          },
          reviewerB: {
            verdict: 'pass',
            attribution: 'agent',
            evidenceRecordIds: ['record-002'],
          },
        }),
      ]),
      chain: {
        reviewerA: {
          continuity: 'not_applicable',
          evidenceRecordIds: ['record-001'],
        },
        reviewerB: {
          continuity: 'not_applicable',
          evidenceRecordIds: ['record-001'],
        },
      },
    })
    const reviewerABefore = await fs.readFile(prepared.reviewerATemplate)
    const reviewerBBefore = await fs.readFile(prepared.reviewerBTemplate)
    const saved = await store.saveCase(
      'private-v1',
      'adjudicator',
      selected.id,
      {
        datasetHash: workspace.datasetHash,
        revision: workspace.revision,
        annotation: {
          ...workspace.annotation,
          notes: '裁决记录。',
        },
      },
    )
    expect(saved.revision).not.toBe(workspace.revision)
    expect(await fs.readFile(prepared.reviewerATemplate)).toEqual(reviewerABefore)
    expect(await fs.readFile(prepared.reviewerBTemplate)).toEqual(reviewerBBefore)
    expect(JSON.parse(await fs.readFile(adjudicationFile, 'utf8')))
      .toMatchObject({
        kind: 'evaluation-adjudication',
        cases: expect.arrayContaining([
          expect.objectContaining({ caseId: selected.id, notes: '裁决记录。' }),
        ]),
      })

    const firstRun = await store.runEvaluation('private-v1', {
      split: 'calibration',
    })
    expect(firstRun).toMatchObject({
      run: {
        split: 'calibration',
        runId: expect.any(String),
        exactAgreement: expect.any(Number),
        evaluatorError: 0,
      },
    })
    const compared = await store.runEvaluation('private-v1', {
      split: 'calibration',
      baselineRunId: firstRun.run.runId,
    })
    expect(compared.diff).toMatchObject({
      comparable: true,
      gateDecision: 'pass',
      improved: 0,
      regressed: 0,
      mixed: 0,
      inconclusive: 0,
    })
    const evaluationFiles = await fs.readdir(evaluationsRoot)
    expect(evaluationFiles.some(file => file.endsWith('.diff.json'))).toBe(true)
    expect(evaluationFiles.some(file =>
      file.includes(`-vs-${firstRun.run.runId}.diff.json`))).toBe(true)
    const details = await store.evaluationRunDetails(
      'private-v1',
      firstRun.run.runId,
    )
    expect(details).toMatchObject({
      run: {
        runId: firstRun.run.runId,
        split: 'calibration',
        cases: expect.arrayContaining([
          expect.objectContaining({
            assertionsTotal: expect.any(Number),
            criteria: expect.arrayContaining([
              expect.objectContaining({
                criterionId: 'outcome',
                verdict: expect.any(String),
                evidenceRecordIds: expect.any(Array),
              }),
            ]),
          }),
        ]),
      },
      diffs: [expect.objectContaining({
        baselineRunId: firstRun.run.runId,
        candidateRunId: firstRun.run.runId,
        gateDecision: 'pass',
        caseDirections: expect.any(Array),
        changedCriteria: [],
      })],
    })
    expect(JSON.stringify(details)).not.toContain('Tests passed')
    await expect(store.evaluationRunDetails('private-v1', 'bad/id'))
      .rejects.toBeInstanceOf(AnnotationInputError)
    await expect(store.evaluationRunDetails('private-v1', 'x'.repeat(24)))
      .rejects.toBeInstanceOf(AnnotationNotFoundError)
    await expect(store.runEvaluation('private-v1', {
      split: 'calibration',
      baselineRunId: '../not-a-run',
    })).rejects.toBeInstanceOf(AnnotationInputError)
    await expect(store.runEvaluation('private-v1', {
      split: 'independent',
      baselineRunId: firstRun.run.runId,
      confirmIndependent: true,
    })).rejects.toThrow(/baseline split calibration does not match independent/)

    await expect(store.runEvaluation('private-v1', {
      split: 'independent',
    })).rejects.toBeInstanceOf(AnnotationConflictError)

    const changedAdjudication = JSON.parse(
      await fs.readFile(adjudicationFile, 'utf8'),
    ) as {
      cases: HumanCaseAnnotation[]
    }
    const calibrationCaseId = calibrationDataset.cases[0]!.id
    const changedCase = changedAdjudication.cases.find(testCase =>
      testCase.caseId === calibrationCaseId)!
    changedCase.criteria[0]!.verdict = changedCase.criteria[0]!.verdict === 'pass'
      ? 'warning'
      : 'pass'
    await fs.writeFile(adjudicationFile, JSON.stringify(changedAdjudication))
    const changedGoldStatus = await store.workflowStatus('private-v1')
    expect(changedGoldStatus.adjudication).toEqual({ exists: true, complete: true })
    expect(changedGoldStatus.runs).toEqual([])
    expect(changedGoldStatus.diffs).toEqual([])
    expect(await fs.readdir(evaluationsRoot)).toEqual(
      expect.arrayContaining(evaluationFiles),
    )

    const changedReviewer = JSON.parse(
      await fs.readFile(prepared.reviewerATemplate, 'utf8'),
    ) as HumanEvaluationAnnotations
    changedReviewer.cases[0]!.notes = 'changed after agreement'
    await fs.writeFile(prepared.reviewerATemplate, JSON.stringify(changedReviewer))
    await expect(store.adjudicationOverview('private-v1'))
      .rejects.toThrow(/bound to the current reviewer files/)
  })

  it('gates adjudication until both reviewers and agreement are complete', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'annotation-workspace-'))
    roots.push(root)
    const calibrationRoot = path.join(root, 'calibration')
    const datasetRoot = path.join(calibrationRoot, 'private-v1')
    await prepareCalibrationCandidates(calibrationSource(), datasetRoot, {
      count: 3,
      datasetId: 'private-adjudication-gate',
      datasetVersion: '1',
    })
    const store = new AnnotationWorkspaceStore(calibrationRoot)

    await expect(store.adjudicationOverview('private-v1'))
      .rejects.toBeInstanceOf(AnnotationConflictError)
    await expect(store.case(
      'private-v1',
      'adjudicator',
      'missing-case',
    )).rejects.toBeInstanceOf(AnnotationConflictError)
  })
})
