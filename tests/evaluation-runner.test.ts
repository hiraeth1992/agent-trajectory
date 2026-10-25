import { describe, expect, it } from 'vitest'
import { MINIMAL_GOLD_DATASET } from '../server/evaluation/gold-dataset'
import {
  compareEvaluationRuns,
  evaluationRunMarkdown,
  runEvaluationDataset,
} from '../server/evaluation/runner'
import type { EvaluationRun } from '../src/evaluation-types'

describe('local evaluation runner', () => {
  it('runs the 12-case split Gold dataset with stable exact results', () => {
    const first = runEvaluationDataset(MINIMAL_GOLD_DATASET, {
      createdAt: '2026-10-25T00:00:00.000Z',
    })
    const second = runEvaluationDataset(MINIMAL_GOLD_DATASET, {
      createdAt: '2026-10-26T00:00:00.000Z',
    })

    expect(MINIMAL_GOLD_DATASET.cases).toHaveLength(12)
    expect(new Set(MINIMAL_GOLD_DATASET.cases.map(item => item.target.source)))
      .toEqual(new Set(['dsh', 'codex', 'zcode']))
    expect(MINIMAL_GOLD_DATASET.cases.filter(item => item.split === 'calibration'))
      .toHaveLength(6)
    expect(MINIMAL_GOLD_DATASET.cases.filter(item => item.split === 'regression'))
      .toHaveLength(6)
    expect(first.aggregate).toMatchObject({
      cases: 12,
      exactCases: 12,
      exactAgreement: 1,
      falsePositives: 0,
      falseNegatives: 0,
      evaluatorError: 0,
    })
    expect(first.cases.every(item => item.error === undefined)).toBe(true)
    expect(second.runId).toBe(first.runId)
    expect(second.cases.map(item => ({
      caseId: item.caseId,
      factsHash: item.factsHash,
      results: item.results,
      requirements: item.requirements,
      chain: item.chain,
      exact: item.exact,
    }))).toEqual(first.cases.map(item => ({
      caseId: item.caseId,
      factsHash: item.factsHash,
      results: item.results,
      requirements: item.requirements,
      chain: item.chain,
      exact: item.exact,
    })))
  })

  it('renders a human-readable report without a synthetic score', () => {
    const run = runEvaluationDataset(MINIMAL_GOLD_DATASET, {
      createdAt: '2026-10-25T00:00:00.000Z',
    })
    const report = evaluationRunMarkdown(run)

    expect(report).toContain('# EvaluationRun')
    expect(report).toContain('Exact agreement: 12/12 (100.0%)')
    expect(report).toContain('FP / FN: 0 / 0')
    expect(report).toContain('Eligible denominator:')
    expect(report).toContain('| zcode-verified-success | calibration | yes | 0 |')
    expect(report).not.toMatch(/总分|score/i)
  })

  it('rejects incomparable baselines and locates comparable regressions', () => {
    const baseline = runEvaluationDataset(MINIMAL_GOLD_DATASET, {
      createdAt: '2026-10-25T00:00:00.000Z',
    })
    const incompatible: EvaluationRun = {
      ...structuredClone(baseline),
      datasetVersion: '2',
    }
    expect(compareEvaluationRuns(baseline, incompatible)).toMatchObject({
      comparable: false,
      reasons: ['dataset version differs'],
    })

    const candidate = structuredClone(baseline)
    candidate.cases[0]!.exact = false
    candidate.cases[0]!.mismatches.push({
      criterionId: 'outcome',
      expected: 'pass',
      actual: 'warning',
    })
    candidate.cases[0]!.results.find(result =>
      result.criterionId === 'outcome')!.verdict = 'warning'

    expect(compareEvaluationRuns(baseline, candidate)).toMatchObject({
      comparable: true,
      improvedCaseIds: [],
      regressedCaseIds: ['zcode-verified-success'],
      changedCriteria: [{
        caseId: 'zcode-verified-success',
        criterionId: 'outcome',
        baseline: 'pass',
        candidate: 'warning',
      }],
    })
  })
})
