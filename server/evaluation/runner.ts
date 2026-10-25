import { createHash } from 'node:crypto'
import type {
  EvaluationAssertionResult,
  EvaluationCaseResult,
  EvaluationConfusionMetrics,
  EvaluationDataset,
  EvaluationResult,
  EvaluationRun,
  EvaluationRunDiff,
  EvaluationVerdict,
  GoldChainExpectation,
  GoldCriterionExpectation,
  GoldRequirementExpectation,
} from '../../src/evaluation-types'
import { analyzeTrajectory } from '../../src/trajectory-analysis'
import {
  aggregateEvaluationResults,
  EVALUATION_FACTS_SCHEMA_VERSION,
  evaluateTrajectory,
  LOCAL_TRAJECTORY_EVALUATOR_ID,
  LOCAL_TRAJECTORY_EVALUATOR_VERSION,
} from '../../src/trajectory-evaluation'
import {
  assertEvaluationDatasetIdentity,
} from './identity'
import { LOCAL_TRAJECTORY_EVALUATOR } from './registry'

export interface EvaluationRunOptions {
  createdAt?: string
  evaluatorBuildHash?: string
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

function expectedCriterionValue(expected: GoldCriterionExpectation): string {
  return [
    expected.verdict,
    expected.attribution,
    expected.evidenceRecordIds?.join(','),
  ].filter(Boolean).join('|')
}

function actualCriterionValue(actual: EvaluationResult | undefined): string | undefined {
  return actual === undefined
    ? undefined
    : [
        actual.verdict,
        actual.attribution,
        actual.evidenceRecordIds.join(','),
      ].filter(Boolean).join('|')
}

function criterionAssertion(
  expected: GoldCriterionExpectation,
  results: readonly EvaluationResult[],
): EvaluationAssertionResult {
  const actual = results.find(result => result.criterionId === expected.criterionId)
  const passed = actual?.verdict === expected.verdict
    && !(expected.attribution !== undefined && actual.attribution !== expected.attribution)
    && !(expected.evidenceRecordIds !== undefined
      && expected.evidenceRecordIds.some(id => !actual.evidenceRecordIds.includes(id)))
  return {
    subject: expected.criterionId,
    expected: expectedCriterionValue(expected),
    actual: actualCriterionValue(actual),
    passed,
    required: expected.required !== false,
  }
}

function requirementAssertion(
  expected: GoldRequirementExpectation,
  requirements: EvaluationCaseResult['requirements'],
): EvaluationAssertionResult {
  const actual = requirements.find(item => item.id === expected.id)
  const passed = actual?.state === expected.state
    && !(expected.text !== undefined && actual.text !== expected.text)
    && !(expected.required !== undefined && actual.required !== expected.required)
    && !(expected.evidenceRecordIds !== undefined
      && expected.evidenceRecordIds.some(id => !actual.evidenceRecordIds.includes(id)))
  return {
    subject: `requirement:${expected.id}`,
    expected: [
      expected.state,
      expected.required,
      expected.text,
      expected.evidenceRecordIds?.join(','),
    ].filter(value => value !== undefined).join('|'),
    actual: actual === undefined
      ? undefined
      : [
          actual.state,
          actual.required,
          actual.text,
          actual.evidenceRecordIds.join(','),
        ].join('|'),
    passed,
    required: expected.required !== false,
  }
}

function chainAssertion(
  expected: GoldChainExpectation,
  chain: EvaluationCaseResult['chain'],
): EvaluationAssertionResult {
  const expectedTransition = expected.failedTransition === undefined
    ? undefined
    : `${expected.failedTransition.fromTurn}->${expected.failedTransition.toTurn}`
  const actualTransition = chain.failedTransition === undefined
    ? undefined
    : `${chain.failedTransition.fromTurn}->${chain.failedTransition.toTurn}`
  const passed = chain.continuity === expected.continuity
    && actualTransition === expectedTransition
    && !(expected.evidenceRecordIds !== undefined
      && expected.evidenceRecordIds.some(id => !chain.evidenceRecordIds.includes(id)))
  return {
    subject: 'chain',
    expected: [
      expected.continuity,
      expectedTransition,
      expected.evidenceRecordIds?.join(','),
    ].filter(Boolean).join('|'),
    actual: [
      chain.continuity,
      actualTransition,
      chain.evidenceRecordIds.join(','),
    ].filter(Boolean).join('|'),
    passed,
    required: true,
  }
}

function assertionMismatch(
  assertion: EvaluationAssertionResult,
): EvaluationCaseResult['mismatches'][number] | undefined {
  if (assertion.passed) return undefined
  return {
    criterionId: assertion.subject,
    expected: assertion.expected,
    actual: assertion.actual,
  }
}

type IssueClass = 'positive' | 'negative' | 'abstain' | 'error'

function issueClass(verdict: EvaluationVerdict | undefined): IssueClass {
  if (verdict === 'fail' || verdict === 'warning') return 'positive'
  if (verdict === 'pass') return 'negative'
  if (verdict === 'evaluator_error' || verdict === undefined) return 'error'
  return 'abstain'
}

function emptyConfusion(): EvaluationConfusionMetrics {
  return {
    eligible: 0,
    truePositives: 0,
    trueNegatives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    abstentions: 0,
    errors: 0,
    excluded: 0,
  }
}

function finalizeConfusion(
  metrics: EvaluationConfusionMetrics,
): EvaluationConfusionMetrics {
  return {
    ...metrics,
    precision: metrics.truePositives + metrics.falsePositives === 0
      ? undefined
      : metrics.truePositives / (metrics.truePositives + metrics.falsePositives),
    recall: metrics.truePositives + metrics.falseNegatives === 0
      ? undefined
      : metrics.truePositives / (metrics.truePositives + metrics.falseNegatives),
  }
}

function addConfusion(
  metrics: EvaluationConfusionMetrics,
  expected: EvaluationVerdict,
  actual: EvaluationVerdict | undefined,
): void {
  const expectedClass = issueClass(expected)
  const actualClass = issueClass(actual)
  if (expectedClass === 'abstain' || expectedClass === 'error') {
    metrics.excluded++
    return
  }
  if (actualClass === 'abstain') {
    metrics.abstentions++
    return
  }
  if (actualClass === 'error') {
    metrics.errors++
    return
  }
  metrics.eligible++
  if (expectedClass === 'positive' && actualClass === 'positive') metrics.truePositives++
  else if (expectedClass === 'negative' && actualClass === 'negative') metrics.trueNegatives++
  else if (expectedClass === 'negative' && actualClass === 'positive') metrics.falsePositives++
  else metrics.falseNegatives++
}

function runId(
  dataset: EvaluationDataset,
  cases: readonly EvaluationCaseResult[],
  evaluatorBuildHash: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      datasetHash: dataset.datasetHash,
      goldHash: dataset.goldHash,
      candidateManifestHash: dataset.candidateManifestHash,
      evaluatorId: LOCAL_TRAJECTORY_EVALUATOR_ID,
      evaluatorVersion: LOCAL_TRAJECTORY_EVALUATOR_VERSION,
      evaluatorBuildHash,
      contractHash: LOCAL_TRAJECTORY_EVALUATOR.contractHash,
      contextPolicyHash: LOCAL_TRAJECTORY_EVALUATOR.contextPolicyHash,
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
          requirement.text,
          requirement.required,
          requirement.state,
          requirement.evidenceRecordIds,
        ]),
        chain: item.chain,
        assertions: item.assertions,
        error: item.error,
      })),
    }))
    .digest('base64url')
    .slice(0, 24)
}

export function runEvaluationDataset(
  dataset: EvaluationDataset,
  options: EvaluationRunOptions = {},
): EvaluationRun {
  assertEvaluationDatasetIdentity(dataset)
  const cases: EvaluationCaseResult[] = dataset.cases.map(testCase => {
    const started = performance.now()
    try {
      const analysis = analyzeTrajectory(testCase.detail)
      const evaluation = evaluateTrajectory(testCase.detail, analysis, {
        target: testCase.target,
        sourceStatus: testCase.sourceStatus,
      })
      const assertions = [
        ...testCase.expected.map(expected =>
          criterionAssertion(expected, evaluation.results)),
        ...(testCase.expectedRequirements ?? []).map(expected =>
          requirementAssertion(expected, evaluation.requirements)),
        ...(testCase.expectedChain === undefined
          ? []
          : [chainAssertion(testCase.expectedChain, evaluation.chain)]),
      ]
      const mismatches = assertions
        .map(assertionMismatch)
        .filter((value): value is NonNullable<typeof value> => value !== undefined)
      const assertionsPassed = assertions.filter(assertion => assertion.passed).length
      return {
        caseId: testCase.id,
        split: testCase.split,
        target: testCase.target,
        factsHash: evaluation.factsHash,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        results: evaluation.results,
        requirements: evaluation.requirements,
        chain: evaluation.chain,
        assertions,
        assertionsPassed,
        assertionsTotal: assertions.length,
        exact: dataset.goldCompleteness === 'full-gold'
          ? assertionsPassed === assertions.length
          : undefined,
        mismatches,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const assertions: EvaluationAssertionResult[] = [{
        subject: 'evaluation-run',
        expected: 'completed',
        actual: 'evaluator_error',
        passed: false,
        required: true,
      }]
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
        assertions,
        assertionsPassed: 0,
        assertionsTotal: 1,
        exact: dataset.goldCompleteness === 'full-gold' ? false : undefined,
        mismatches: assertions.map(assertion => ({
          criterionId: assertion.subject,
          expected: assertion.expected,
          actual: assertion.actual,
        })),
        error: message,
      }
    }
  })
  const allResults = cases.flatMap(item => item.results)
  const resultAggregate = aggregateEvaluationResults(allResults)
  const confusion = emptyConfusion()
  const perCriterion = new Map<string, EvaluationConfusionMetrics>()
  for (const testCase of dataset.cases) {
    const actual = cases.find(item => item.caseId === testCase.id)
    for (const expected of testCase.expected) {
      const actualVerdict = actual?.results.find(
        result => result.criterionId === expected.criterionId,
      )?.verdict
      addConfusion(confusion, expected.verdict, actualVerdict)
      const selected = perCriterion.get(expected.criterionId) ?? emptyConfusion()
      addConfusion(selected, expected.verdict, actualVerdict)
      perCriterion.set(expected.criterionId, selected)
    }
  }
  const finalizedConfusion = finalizeConfusion(confusion)
  const assertionsPassed = cases.reduce((total, item) => total + item.assertionsPassed, 0)
  const assertionsTotal = cases.reduce((total, item) => total + item.assertionsTotal, 0)
  const exactEligibleCases = cases.filter(item => item.exact !== undefined).length
  const exactCases = cases.filter(item => item.exact === true).length
  const durationMs = cases.reduce((total, item) => total + item.durationMs, 0)
  const evaluatorBuildHash = options.evaluatorBuildHash
    ?? LOCAL_TRAJECTORY_EVALUATOR.buildHash
  return {
    schemaVersion: 2,
    runId: runId(dataset, cases, evaluatorBuildHash),
    createdAt: options.createdAt ?? new Date().toISOString(),
    datasetId: dataset.id,
    datasetVersion: dataset.version,
    datasetHash: dataset.datasetHash,
    goldHash: dataset.goldHash,
    candidateManifestHash: dataset.candidateManifestHash,
    goldCompleteness: dataset.goldCompleteness,
    evaluatorId: LOCAL_TRAJECTORY_EVALUATOR_ID,
    evaluatorVersion: LOCAL_TRAJECTORY_EVALUATOR_VERSION,
    evaluatorBuildHash,
    contractHash: LOCAL_TRAJECTORY_EVALUATOR.contractHash,
    contextPolicyHash: LOCAL_TRAJECTORY_EVALUATOR.contextPolicyHash,
    evaluatorDependencies: [...LOCAL_TRAJECTORY_EVALUATOR.dependencies],
    evaluatorCalibrationStatus: LOCAL_TRAJECTORY_EVALUATOR.calibrationStatus,
    evaluatorGateLevel: LOCAL_TRAJECTORY_EVALUATOR.gateLevel,
    factsSchemaVersion: EVALUATION_FACTS_SCHEMA_VERSION,
    cases,
    aggregate: {
      ...resultAggregate,
      cases: cases.length,
      assertionsPassed,
      assertionsTotal,
      assertionAgreement: assertionsTotal === 0 ? 1 : assertionsPassed / assertionsTotal,
      exactEligibleCases,
      exactCases,
      exactAgreement: exactEligibleCases === 0
        ? undefined
        : exactCases / exactEligibleCases,
      confusionEligible: finalizedConfusion.eligible,
      truePositives: finalizedConfusion.truePositives,
      trueNegatives: finalizedConfusion.trueNegatives,
      falsePositives: finalizedConfusion.falsePositives,
      falseNegatives: finalizedConfusion.falseNegatives,
      abstentions: finalizedConfusion.abstentions,
      confusionErrors: finalizedConfusion.errors,
      confusionExcluded: finalizedConfusion.excluded,
      precision: finalizedConfusion.precision,
      recall: finalizedConfusion.recall,
      perCriterion: Object.fromEntries([...perCriterion].map(([criterionId, metrics]) => [
        criterionId,
        finalizeConfusion(metrics),
      ])),
      durationMs,
    },
  }
}

function percent(value: number | undefined): string {
  return value === undefined ? 'N/A' : `${(value * 100).toFixed(1)}%`
}

export function evaluationRunMarkdown(run: EvaluationRun): string {
  const exactSummary = run.aggregate.exactAgreement === undefined
    ? 'N/A (partial contract)'
    : `${run.aggregate.exactCases}/${run.aggregate.exactEligibleCases} (${
      percent(run.aggregate.exactAgreement)
    })`
  const lines = [
    `# EvaluationRun ${run.runId}`,
    '',
    `- Dataset: \`${run.datasetId}@${run.datasetVersion}\``,
    `- Dataset hash: \`${run.datasetHash}\``,
    `- Gold hash: \`${run.goldHash}\``,
    `- Gold completeness: \`${run.goldCompleteness}\``,
    `- Evaluator: \`${run.evaluatorId}@${run.evaluatorVersion}\``,
    `- Evaluator build: \`${run.evaluatorBuildHash}\``,
    `- Calibration / gate: \`${run.evaluatorCalibrationStatus}\` / \`${
      run.evaluatorGateLevel
    }\``,
    `- Dependencies: ${run.evaluatorDependencies.map(value => `\`${value}\``).join(', ')}`,
    `- Contract / context: \`${run.contractHash}\` / \`${run.contextPolicyHash}\``,
    `- Facts schema: \`${run.factsSchemaVersion}\``,
    `- Created: ${run.createdAt}`,
    '',
    '## Summary',
    '',
    `- Assertion agreement: ${run.aggregate.assertionsPassed}/${
      run.aggregate.assertionsTotal
    } (${percent(run.aggregate.assertionAgreement)})`,
    `- Full-Gold exact agreement: ${exactSummary}`,
    `- Precision / Recall: ${percent(run.aggregate.precision)} / ${percent(
      run.aggregate.recall,
    )}`,
    `- Eligible / TP / TN / FP / FN: ${run.aggregate.confusionEligible} / ${
      run.aggregate.truePositives
    } / ${run.aggregate.trueNegatives} / ${run.aggregate.falsePositives} / ${
      run.aggregate.falseNegatives
    }`,
    `- Confusion abstain / error / excluded: ${run.aggregate.abstentions} / ${
      run.aggregate.confusionErrors
    } / ${run.aggregate.confusionExcluded}`,
    `- Eligible denominator: ${run.aggregate.denominatorEligible}/${run.aggregate.total}`,
    `- N/A / insufficient / evaluator error: ${run.aggregate.notApplicable} / ${
      run.aggregate.insufficientEvidence
    } / ${run.aggregate.evaluatorError}`,
    `- Evaluator duration: ${run.aggregate.durationMs} ms`,
    '',
    '## Cases',
    '',
    '| Case | Split | Assertions | Full exact | Mismatches | Duration |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
    ...run.cases.map(item =>
      `| ${item.caseId} | ${item.split} | ${item.assertionsPassed}/${
        item.assertionsTotal
      } | ${item.exact === undefined ? 'N/A' : item.exact ? 'yes' : 'no'} | ${
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

function verdictDistance(
  expected: EvaluationVerdict | undefined,
  actual: EvaluationVerdict | undefined,
): number | undefined {
  if (expected === undefined || actual === undefined) return undefined
  if (actual === 'evaluator_error') return 5
  if (actual === expected) return 0
  const expectedClass = issueClass(expected)
  const actualClass = issueClass(actual)
  if (actualClass === 'abstain') return 4
  if (expectedClass === 'abstain' || expectedClass === 'error') {
    return actualClass === expectedClass ? 1 : 3
  }
  if (expectedClass !== actualClass) return 3
  if (expected === 'pass') return actual === 'warning' ? 1 : 2
  return 1
}

function changedVerdictDirection(
  expected: EvaluationVerdict | undefined,
  baseline: EvaluationVerdict | undefined,
  candidate: EvaluationVerdict | undefined,
): EvaluationRunDiff['changedCriteria'][number]['direction'] {
  const before = verdictDistance(expected, baseline)
  const after = verdictDistance(expected, candidate)
  if (before === undefined || after === undefined) return 'inconclusive'
  if (after < before) return 'improved'
  if (after > before) return 'regressed'
  return issueClass(candidate) === 'abstain' ? 'inconclusive' : 'unchanged'
}

function criterionExpectedVerdicts(
  testCase: EvaluationCaseResult,
): Map<string, EvaluationVerdict> {
  return new Map(testCase.assertions.flatMap((assertion) => {
    if (assertion.subject.startsWith('requirement:') || assertion.subject === 'chain') return []
    const verdict = assertion.expected.split('|')[0] as EvaluationVerdict | undefined
    return verdict === undefined ? [] : [[assertion.subject, verdict] as const]
  }))
}

function assertionDirections(
  before: EvaluationCaseResult,
  after: EvaluationCaseResult,
): Array<'improved' | 'regressed'> {
  const beforeBySubject = new Map(before.assertions.map(assertion => [
    assertion.subject,
    assertion,
  ]))
  const afterBySubject = new Map(after.assertions.map(assertion => [
    assertion.subject,
    assertion,
  ]))
  const directions: Array<'improved' | 'regressed'> = []
  for (const subject of new Set([...beforeBySubject.keys(), ...afterBySubject.keys()])) {
    const left = beforeBySubject.get(subject)
    const right = afterBySubject.get(subject)
    if (left?.required === false && right?.required === false) continue
    if (left?.passed === false && right?.passed === true) directions.push('improved')
    else if (left?.passed === true && right?.passed === false) directions.push('regressed')
  }
  return directions
}

export function compareEvaluationRuns(
  baseline: EvaluationRun,
  candidate: EvaluationRun,
): EvaluationRunDiff {
  const reasons: string[] = []
  if (baseline.schemaVersion !== 2 || candidate.schemaVersion !== 2) {
    reasons.push('run schema version is not supported')
  }
  if (baseline.datasetId !== candidate.datasetId) reasons.push('dataset id differs')
  if (baseline.datasetVersion !== candidate.datasetVersion) reasons.push('dataset version differs')
  if (baseline.datasetHash !== candidate.datasetHash) reasons.push('dataset hash differs')
  if (baseline.goldHash !== candidate.goldHash) reasons.push('Gold hash differs')
  if (baseline.goldCompleteness !== candidate.goldCompleteness) {
    reasons.push('Gold completeness differs')
  }
  if (baseline.evaluatorId !== candidate.evaluatorId) reasons.push('evaluator id differs')
  if (baseline.contractHash !== candidate.contractHash) reasons.push('contract hash differs')
  if (baseline.contextPolicyHash !== candidate.contextPolicyHash) {
    reasons.push('context policy hash differs')
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
      datasetHash: candidate.datasetHash,
      goldHash: candidate.goldHash,
      candidateManifestHash: candidate.candidateManifestHash,
      baselineRunId: baseline.runId,
      candidateRunId: candidate.runId,
      gateDecision: 'inconclusive',
      gateReasons: reasons,
      improvedCaseIds: [],
      regressedCaseIds: [],
      mixedCaseIds: [],
      unchangedCaseIds: [],
      inconclusiveCaseIds: [],
      changedCriteria: [],
    }
  }
  const improvedCaseIds: string[] = []
  const regressedCaseIds: string[] = []
  const mixedCaseIds: string[] = []
  const unchangedCaseIds: string[] = []
  const inconclusiveCaseIds: string[] = []
  const changedCriteria: EvaluationRunDiff['changedCriteria'] = []
  for (const [caseId, before] of baselineByCase) {
    const after = candidateByCase.get(caseId)!
    const directions = assertionDirections(before, after)
    if (before.error === undefined && after.error !== undefined) directions.push('regressed')
    else if (before.error !== undefined && after.error === undefined) directions.push('improved')
    const beforeResults = new Map(before.results.map(item => [item.criterionId, item.verdict]))
    const afterResults = new Map(after.results.map(item => [item.criterionId, item.verdict]))
    const expected = criterionExpectedVerdicts(before)
    let hasInconclusiveCriterion = false
    for (const criterionId of new Set([...beforeResults.keys(), ...afterResults.keys()])) {
      const baselineVerdict = beforeResults.get(criterionId)
      const candidateVerdict = afterResults.get(criterionId)
      if (baselineVerdict !== candidateVerdict) {
        const direction = changedVerdictDirection(
          expected.get(criterionId),
          baselineVerdict,
          candidateVerdict,
        )
        if (direction === 'improved' || direction === 'regressed') {
          directions.push(direction)
        } else if (direction === 'inconclusive') {
          hasInconclusiveCriterion = true
        }
        changedCriteria.push({
          caseId,
          criterionId,
          baseline: baselineVerdict,
          candidate: candidateVerdict,
          direction,
        })
      }
    }
    const improved = directions.includes('improved')
    const regressed = directions.includes('regressed')
    if (improved && regressed) mixedCaseIds.push(caseId)
    else if (regressed) regressedCaseIds.push(caseId)
    else if (improved) improvedCaseIds.push(caseId)
    else if (hasInconclusiveCriterion) inconclusiveCaseIds.push(caseId)
    else unchangedCaseIds.push(caseId)
  }
  const failReasons = [
    ...regressedCaseIds.map(caseId => `case regressed: ${caseId}`),
    ...mixedCaseIds.map(caseId => `case has mixed changes: ${caseId}`),
    ...(candidate.aggregate.falsePositives > baseline.aggregate.falsePositives
      ? ['false positive count increased']
      : []),
    ...(candidate.aggregate.falseNegatives > baseline.aggregate.falseNegatives
      ? ['false negative count increased']
      : []),
    ...(candidate.aggregate.confusionErrors > baseline.aggregate.confusionErrors
      ? ['evaluator error count increased']
      : []),
  ]
  const inconclusiveReasons = [
    ...(inconclusiveCaseIds.length > 0
      ? [`${inconclusiveCaseIds.length} case(s) changed inconclusively`]
      : []),
    ...(candidate.aggregate.abstentions > baseline.aggregate.abstentions
      ? ['abstention count increased']
      : []),
  ]
  const gateReasons = [...failReasons, ...inconclusiveReasons]
  const gateDecision = failReasons.length > 0
    ? 'fail'
    : inconclusiveReasons.length > 0
      ? 'inconclusive'
      : 'pass'
  return {
    comparable: true,
    reasons: [],
    datasetHash: candidate.datasetHash,
    goldHash: candidate.goldHash,
    candidateManifestHash: candidate.candidateManifestHash,
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    gateDecision,
    gateReasons,
    improvedCaseIds,
    regressedCaseIds,
    mixedCaseIds,
    unchangedCaseIds,
    inconclusiveCaseIds,
    changedCriteria,
  }
}
