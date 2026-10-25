import { createHash } from 'node:crypto'
import type {
  EvaluationCaseResult,
  EvaluationDataset,
  EvaluationResult,
  EvaluationRun,
  EvaluationRunDiff,
  EvaluationVerdict,
  GoldCriterionExpectation,
} from '../../src/evaluation-types'
import { analyzeTrajectory } from '../../src/trajectory-analysis'
import {
  aggregateEvaluationResults,
  EVALUATION_FACTS_SCHEMA_VERSION,
  evaluateTrajectory,
  LOCAL_TRAJECTORY_EVALUATOR_ID,
  LOCAL_TRAJECTORY_EVALUATOR_VERSION,
} from '../../src/trajectory-evaluation'

export interface EvaluationRunOptions {
  createdAt?: string
}

function evaluatorError(
  criterionId: string,
  error: unknown,
): EvaluationResult {
  return {
    evaluatorId: LOCAL_TRAJECTORY_EVALUATOR_ID,
    evaluatorVersion: LOCAL_TRAJECTORY_EVALUATOR_VERSION,
    criterionId,
    verdict: 'evaluator_error',
    confidence: 'high',
    evidenceRecordIds: [],
    counterEvidenceRecordIds: [],
    evidenceBoundary: error instanceof Error ? error.message : String(error),
    attribution: 'evaluator',
    blockedBy: [],
    denominatorEligible: false,
    label: 'Evaluator 执行失败',
    summary: '本次结果是评测器错误，不计入 Agent 质量分母。',
  }
}

function compareCriterion(
  expected: GoldCriterionExpectation,
  results: readonly EvaluationResult[],
): EvaluationCaseResult['mismatches'][number] | undefined {
  const actual = results.find(result => result.criterionId === expected.criterionId)
  if (actual?.verdict !== expected.verdict
    || expected.attribution !== undefined && actual.attribution !== expected.attribution
    || expected.evidenceRecordIds !== undefined
      && expected.evidenceRecordIds.some(id => !actual?.evidenceRecordIds.includes(id))) {
    return {
      criterionId: expected.criterionId,
      expected: [
        expected.verdict,
        expected.attribution,
        expected.evidenceRecordIds?.join(','),
      ].filter(Boolean).join('|'),
      actual: actual === undefined
        ? undefined
        : [
            actual.verdict,
            actual.attribution,
            actual.evidenceRecordIds.join(','),
          ].filter(Boolean).join('|'),
    }
  }
  return undefined
}

function issueVerdict(verdict: EvaluationVerdict | undefined): boolean {
  return verdict === 'fail' || verdict === 'warning'
}

function runId(
  dataset: EvaluationDataset,
  cases: readonly EvaluationCaseResult[],
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      datasetId: dataset.id,
      datasetVersion: dataset.version,
      evaluatorId: LOCAL_TRAJECTORY_EVALUATOR_ID,
      evaluatorVersion: LOCAL_TRAJECTORY_EVALUATOR_VERSION,
      factsSchemaVersion: EVALUATION_FACTS_SCHEMA_VERSION,
      cases: cases.map(item => ({
        caseId: item.caseId,
        factsHash: item.factsHash,
        results: item.results.map(result => [
          result.criterionId,
          result.verdict,
          result.attribution,
          result.evidenceRecordIds,
        ]),
        requirements: item.requirements.map(requirement => [
          requirement.id,
          requirement.state,
        ]),
        chain: item.chain.continuity,
      })),
    }))
    .digest('base64url')
    .slice(0, 24)
}

export function runEvaluationDataset(
  dataset: EvaluationDataset,
  options: EvaluationRunOptions = {},
): EvaluationRun {
  const cases: EvaluationCaseResult[] = dataset.cases.map(testCase => {
    const started = performance.now()
    try {
      const analysis = analyzeTrajectory(testCase.detail)
      const evaluation = evaluateTrajectory(testCase.detail, analysis, {
        target: testCase.target,
        sourceStatus: testCase.sourceStatus,
      })
      const mismatches = testCase.expected
        .map(expected => compareCriterion(expected, evaluation.results))
        .filter((value): value is NonNullable<typeof value> => value !== undefined)
      for (const expected of testCase.expectedRequirements ?? []) {
        const actual = evaluation.requirements.find(item => item.id === expected.id)
        if (actual?.state !== expected.state) {
          mismatches.push({
            criterionId: `requirement:${expected.id}`,
            expected: expected.state,
            actual: actual?.state,
          })
        }
      }
      if (testCase.expectedChainContinuity !== undefined
        && evaluation.chain.continuity !== testCase.expectedChainContinuity) {
        mismatches.push({
          criterionId: 'chain:continuity',
          expected: testCase.expectedChainContinuity,
          actual: evaluation.chain.continuity,
        })
      }
      return {
        caseId: testCase.id,
        split: testCase.split,
        target: testCase.target,
        factsHash: evaluation.factsHash,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        results: evaluation.results,
        requirements: evaluation.requirements,
        chain: evaluation.chain,
        exact: mismatches.length === 0,
        mismatches,
      }
    } catch (error) {
      return {
        caseId: testCase.id,
        split: testCase.split,
        target: testCase.target,
        factsHash: '',
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        results: [evaluatorError('evaluation-run', error)],
        requirements: [],
        chain: {
          continuity: 'insufficient_evidence',
          transitions: [],
          evidenceRecordIds: [],
          reason: 'Evaluator 执行失败。',
        },
        exact: false,
        mismatches: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
  const allResults = cases.flatMap(item => item.results)
  const resultAggregate = aggregateEvaluationResults(allResults)
  let truePositives = 0
  let falsePositives = 0
  let falseNegatives = 0
  for (const testCase of dataset.cases) {
    const actual = cases.find(item => item.caseId === testCase.id)
    for (const expected of testCase.expected) {
      const actualVerdict = actual?.results.find(
        result => result.criterionId === expected.criterionId,
      )?.verdict
      const expectedIssue = issueVerdict(expected.verdict)
      const actualIssue = issueVerdict(actualVerdict)
      if (expectedIssue && actualIssue) truePositives++
      else if (!expectedIssue && actualIssue) falsePositives++
      else if (expectedIssue && !actualIssue) falseNegatives++
    }
  }
  const durationMs = cases.reduce((total, item) => total + item.durationMs, 0)
  return {
    schemaVersion: 1,
    runId: runId(dataset, cases),
    createdAt: options.createdAt ?? new Date().toISOString(),
    datasetId: dataset.id,
    datasetVersion: dataset.version,
    evaluatorId: LOCAL_TRAJECTORY_EVALUATOR_ID,
    evaluatorVersion: LOCAL_TRAJECTORY_EVALUATOR_VERSION,
    factsSchemaVersion: EVALUATION_FACTS_SCHEMA_VERSION,
    cases,
    aggregate: {
      ...resultAggregate,
      cases: cases.length,
      exactCases: cases.filter(item => item.exact).length,
      exactAgreement: cases.length === 0
        ? 1
        : cases.filter(item => item.exact).length / cases.length,
      falsePositives,
      falseNegatives,
      precision: truePositives + falsePositives === 0
        ? undefined
        : truePositives / (truePositives + falsePositives),
      recall: truePositives + falseNegatives === 0
        ? undefined
        : truePositives / (truePositives + falseNegatives),
      durationMs,
    },
  }
}

function percent(value: number | undefined): string {
  return value === undefined ? 'N/A' : `${(value * 100).toFixed(1)}%`
}

export function evaluationRunMarkdown(run: EvaluationRun): string {
  const lines = [
    `# EvaluationRun ${run.runId}`,
    '',
    `- Dataset: \`${run.datasetId}@${run.datasetVersion}\``,
    `- Evaluator: \`${run.evaluatorId}@${run.evaluatorVersion}\``,
    `- Facts schema: \`${run.factsSchemaVersion}\``,
    `- Created: ${run.createdAt}`,
    '',
    '## Summary',
    '',
    `- Exact agreement: ${run.aggregate.exactCases}/${run.aggregate.cases} (${percent(
      run.aggregate.exactAgreement,
    )})`,
    `- Precision / Recall: ${percent(run.aggregate.precision)} / ${percent(
      run.aggregate.recall,
    )}`,
    `- FP / FN: ${run.aggregate.falsePositives} / ${run.aggregate.falseNegatives}`,
    `- Eligible denominator: ${run.aggregate.denominatorEligible}/${run.aggregate.total}`,
    `- N/A / insufficient / evaluator error: ${run.aggregate.notApplicable} / ${
      run.aggregate.insufficientEvidence
    } / ${run.aggregate.evaluatorError}`,
    `- Evaluator duration: ${run.aggregate.durationMs} ms`,
    '',
    '## Cases',
    '',
    '| Case | Split | Exact | Mismatches | Duration |',
    '| --- | --- | ---: | ---: | ---: |',
    ...run.cases.map(item =>
      `| ${item.caseId} | ${item.split} | ${item.exact ? 'yes' : 'no'} | ${
        item.mismatches.length
      } | ${item.durationMs} ms |`),
  ]
  const mismatches = run.cases.filter(item =>
    item.mismatches.length > 0 || item.error !== undefined)
  if (mismatches.length > 0) {
    lines.push('', '## Mismatches', '')
    for (const item of mismatches) {
      lines.push(`### ${item.caseId}`, '')
      if (item.error !== undefined) lines.push(`- Evaluator error: ${item.error}`)
      for (const mismatch of item.mismatches) {
        lines.push(
          `- \`${mismatch.criterionId}\`: expected \`${mismatch.expected}\`, actual \`${
            mismatch.actual ?? 'missing'
          }\``,
        )
      }
      lines.push('')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

export function compareEvaluationRuns(
  baseline: EvaluationRun,
  candidate: EvaluationRun,
): EvaluationRunDiff {
  const reasons: string[] = []
  if (baseline.datasetId !== candidate.datasetId) reasons.push('dataset id differs')
  if (baseline.datasetVersion !== candidate.datasetVersion) reasons.push('dataset version differs')
  if (baseline.evaluatorId !== candidate.evaluatorId) reasons.push('evaluator id differs')
  if (baseline.evaluatorVersion !== candidate.evaluatorVersion) {
    reasons.push('evaluator version differs')
  }
  if (baseline.factsSchemaVersion !== candidate.factsSchemaVersion) {
    reasons.push('facts schema version differs')
  }
  const baselineByCase = new Map(baseline.cases.map(item => [item.caseId, item]))
  const candidateByCase = new Map(candidate.cases.map(item => [item.caseId, item]))
  if (baselineByCase.size !== candidateByCase.size
    || [...baselineByCase].some(([id, item]) =>
      candidateByCase.get(id)?.target.fingerprint !== item.target.fingerprint)) {
    reasons.push('case targets or fingerprints differ')
  }
  if (reasons.length > 0) {
    return {
      comparable: false,
      reasons,
      improvedCaseIds: [],
      regressedCaseIds: [],
      unchangedCaseIds: [],
      changedCriteria: [],
    }
  }
  const improvedCaseIds: string[] = []
  const regressedCaseIds: string[] = []
  const unchangedCaseIds: string[] = []
  const changedCriteria: EvaluationRunDiff['changedCriteria'] = []
  for (const [caseId, before] of baselineByCase) {
    const after = candidateByCase.get(caseId)!
    if (after.mismatches.length < before.mismatches.length) improvedCaseIds.push(caseId)
    else if (after.mismatches.length > before.mismatches.length) regressedCaseIds.push(caseId)
    else unchangedCaseIds.push(caseId)
    const beforeResults = new Map(before.results.map(item => [item.criterionId, item.verdict]))
    const afterResults = new Map(after.results.map(item => [item.criterionId, item.verdict]))
    for (const criterionId of new Set([...beforeResults.keys(), ...afterResults.keys()])) {
      const baselineVerdict = beforeResults.get(criterionId)
      const candidateVerdict = afterResults.get(criterionId)
      if (baselineVerdict !== candidateVerdict) {
        changedCriteria.push({
          caseId,
          criterionId,
          baseline: baselineVerdict,
          candidate: candidateVerdict,
        })
      }
    }
  }
  return {
    comparable: true,
    reasons: [],
    improvedCaseIds,
    regressedCaseIds,
    unchangedCaseIds,
    changedCriteria,
  }
}
