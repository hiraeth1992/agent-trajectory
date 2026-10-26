import { describe, expect, it } from 'vitest'
import { SYNTHETIC_CONTRACT_DATASET } from '../server/evaluation/gold-dataset'
import { createEvaluationDataset } from '../server/evaluation/identity'
import {
  compareEvaluationRuns,
  evaluationRunMarkdown,
  runEvaluationDataset,
} from '../server/evaluation/runner'
import type {
  EvaluationDataset,
  EvaluationRun,
} from '../src/evaluation-types'

function rebuild(
  dataset: EvaluationDataset,
  mutate: (draft: EvaluationDataset) => void,
): EvaluationDataset {
  const draft = structuredClone(dataset)
  mutate(draft)
  const {
    datasetHash: _datasetHash,
    goldHash: _goldHash,
    ...hashable
  } = draft
  return createEvaluationDataset(hashable)
}

describe('local evaluation runner', () => {
  it('runs the synthetic contract dataset with stable assertion results', () => {
    const first = runEvaluationDataset(SYNTHETIC_CONTRACT_DATASET, {
      createdAt: '2026-10-25T00:00:00.000Z',
    })
    const second = runEvaluationDataset(SYNTHETIC_CONTRACT_DATASET, {
      createdAt: '2026-10-26T00:00:00.000Z',
    })

    expect(SYNTHETIC_CONTRACT_DATASET).toMatchObject({
      goldCompleteness: 'partial-contract',
      datasetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      goldHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(SYNTHETIC_CONTRACT_DATASET.cases).toHaveLength(12)
    expect(new Set(SYNTHETIC_CONTRACT_DATASET.cases.map(item => item.target.source)))
      .toEqual(new Set(['dsh', 'codex', 'zcode']))
    expect(SYNTHETIC_CONTRACT_DATASET.cases.filter(item => item.split === 'calibration'))
      .toHaveLength(6)
    expect(SYNTHETIC_CONTRACT_DATASET.cases.filter(item => item.split === 'regression'))
      .toHaveLength(6)
    expect(first.aggregate).toMatchObject({
      cases: 12,
      assertionsPassed: 31,
      assertionsTotal: 31,
      assertionAgreement: 1,
      exactEligibleCases: 0,
      exactCases: 0,
      exactAgreement: undefined,
      falsePositives: 0,
      falseNegatives: 0,
      evaluatorError: 0,
    })
    expect(first.cases.every(item =>
      item.error === undefined && item.exact === undefined)).toBe(true)
    expect(second.runId).toBe(first.runId)
    expect(second.cases.map(item => ({
      caseId: item.caseId,
      factsHash: item.factsHash,
      results: item.results,
      requirements: item.requirements,
      chain: item.chain,
      assertions: item.assertions,
    }))).toEqual(first.cases.map(item => ({
      caseId: item.caseId,
      factsHash: item.factsHash,
      results: item.results,
      requirements: item.requirements,
      chain: item.chain,
      assertions: item.assertions,
    })))
  })

  it('renders partial assertions without claiming full-Gold exact agreement', () => {
    const run = runEvaluationDataset(SYNTHETIC_CONTRACT_DATASET, {
      createdAt: '2026-10-25T00:00:00.000Z',
    })
    const report = evaluationRunMarkdown(run)

    expect(report).toContain('# EvaluationRun')
    expect(report).toContain('Assertion agreement: 31/31 (100.0%)')
    expect(report).toContain('Full-Gold exact agreement: N/A (partial contract)')
    expect(report).toContain('Dataset hash:')
    expect(report).toContain('Gold hash:')
    expect(report).toContain('| zcode-verified-success | calibration | 4/4 | N/A | 0 |')
    expect(report).not.toMatch(/总分|score/i)
  })

  it('binds run identity and comparability to dataset and Gold contents', () => {
    const baseline = runEvaluationDataset(SYNTHETIC_CONTRACT_DATASET, {
      createdAt: '2026-10-25T00:00:00.000Z',
    })
    const changedGold = rebuild(SYNTHETIC_CONTRACT_DATASET, (draft) => {
      draft.cases[0]!.expected[0]!.verdict = 'fail'
    })
    const changedRun = runEvaluationDataset(changedGold, {
      createdAt: '2026-10-25T00:00:00.000Z',
    })

    expect(changedGold.datasetHash).toBe(SYNTHETIC_CONTRACT_DATASET.datasetHash)
    expect(changedGold.goldHash).not.toBe(SYNTHETIC_CONTRACT_DATASET.goldHash)
    expect(changedRun.runId).not.toBe(baseline.runId)
    expect(compareEvaluationRuns(baseline, changedRun)).toMatchObject({
      comparable: false,
      gateDecision: 'inconclusive',
      reasons: ['Gold hash differs'],
    })

    const tampered = structuredClone(SYNTHETIC_CONTRACT_DATASET)
    tampered.cases[0]!.description = 'changed without rebuilding identity'
    expect(() => runEvaluationDataset(tampered)).toThrow(/content hash mismatch/)
  })

  it('keeps abstentions and evaluator errors out of FP/FN', () => {
    const abstaining = rebuild(SYNTHETIC_CONTRACT_DATASET, (draft) => {
      const live = draft.cases.find(item => item.id === 'dsh-live-session')!
      live.expected = [{ criterionId: 'outcome', verdict: 'fail' }]
    })
    const abstainingRun = runEvaluationDataset(abstaining)
    expect(abstainingRun.aggregate).toMatchObject({
      abstentions: 1,
      confusionErrors: 0,
      falseNegatives: 0,
    })

    const crashing = rebuild(SYNTHETIC_CONTRACT_DATASET, (draft) => {
      draft.cases = [draft.cases[0]!]
      draft.cases[0]!.expected = [{ criterionId: 'outcome', verdict: 'fail' }]
      ;(draft.cases[0]!.detail.projection as unknown as { records: unknown }).records = undefined
    })
    const crashingRun = runEvaluationDataset(crashing)
    expect(crashingRun.aggregate).toMatchObject({
      confusionErrors: 1,
      falseNegatives: 0,
      evaluatorError: 1,
    })
    expect(crashingRun.cases[0]).toMatchObject({
      assertionsPassed: 0,
      assertionsTotal: 1,
      error: expect.any(String),
      mismatches: [{ criterionId: 'evaluation-run' }],
    })
  })

  it('allows evaluator build experiments and gates directional regressions', () => {
    const baseline = runEvaluationDataset(SYNTHETIC_CONTRACT_DATASET, {
      evaluatorBuildHash: 'build-a',
    })
    const sameOutput = runEvaluationDataset(SYNTHETIC_CONTRACT_DATASET, {
      evaluatorBuildHash: 'build-b',
    })
    expect(compareEvaluationRuns(baseline, sameOutput)).toMatchObject({
      comparable: true,
      gateDecision: 'pass',
      improvedCaseIds: [],
      regressedCaseIds: [],
      mixedCaseIds: [],
      inconclusiveCaseIds: [],
      unchangedCaseIds: expect.arrayContaining(['zcode-verified-success']),
    })

    const candidate = structuredClone(sameOutput)
    const first = candidate.cases[0]!
    first.results.find(result => result.criterionId === 'outcome')!.verdict = 'fail'
    const assertion = first.assertions.find(item => item.subject === 'outcome')!
    assertion.actual = 'fail|agent|validation-1'
    assertion.passed = false
    first.assertionsPassed--
    first.mismatches.push({
      criterionId: 'outcome',
      expected: assertion.expected,
      actual: assertion.actual,
    })

    expect(compareEvaluationRuns(baseline, candidate)).toMatchObject({
      comparable: true,
      gateDecision: 'fail',
      regressedCaseIds: ['zcode-verified-success'],
      changedCriteria: [expect.objectContaining({
        caseId: 'zcode-verified-success',
        criterionId: 'outcome',
        baseline: 'pass',
        candidate: 'fail',
        direction: 'regressed',
      })],
    })
  })

  it('treats evaluator crashes as regressions even when mismatch counts do not grow', () => {
    const baseline = runEvaluationDataset(SYNTHETIC_CONTRACT_DATASET)
    const candidate = structuredClone(baseline)
    const first = candidate.cases[0]!
    first.error = 'boom'
    first.results = [{
      ...first.results[0]!,
      criterionId: 'evaluation-run',
      verdict: 'evaluator_error',
      attribution: 'evaluator',
    }]
    first.mismatches = []

    expect(compareEvaluationRuns(baseline, candidate)).toMatchObject({
      comparable: true,
      gateDecision: 'fail',
      regressedCaseIds: ['zcode-verified-success'],
    })
  })

  it('gates aggregate classification and coverage regressions', () => {
    const baseline = runEvaluationDataset(SYNTHETIC_CONTRACT_DATASET)
    const falsePositive = structuredClone(baseline)
    falsePositive.aggregate.falsePositives++
    expect(compareEvaluationRuns(baseline, falsePositive)).toMatchObject({
      gateDecision: 'fail',
      gateReasons: ['false positive count increased'],
    })

    const abstaining = structuredClone(baseline)
    abstaining.aggregate.abstentions++
    expect(compareEvaluationRuns(baseline, abstaining)).toMatchObject({
      gateDecision: 'inconclusive',
      gateReasons: ['abstention count increased'],
    })
  })

  it('rejects old or incompatible run protocols', () => {
    const baseline = runEvaluationDataset(SYNTHETIC_CONTRACT_DATASET)
    const incompatible = {
      ...structuredClone(baseline),
      schemaVersion: 1,
    } as unknown as EvaluationRun

    expect(compareEvaluationRuns(baseline, incompatible)).toMatchObject({
      comparable: false,
      gateDecision: 'inconclusive',
      reasons: ['run schema version is not supported'],
    })
  })
})
