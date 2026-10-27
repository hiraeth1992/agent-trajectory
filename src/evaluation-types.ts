import type {
  SourceAvailability,
  SourceCapabilities,
  SourceId,
} from './types'
import type {
  AnalysisConfidence,
  AnalysisEvaluation,
} from './trajectory-analysis'

export type EvaluationVerdict =
  | 'pass'
  | 'fail'
  | 'warning'
  | 'not_applicable'
  | 'insufficient_evidence'
  | 'evaluator_error'
  | 'out_of_scope'

export type EvaluationAttribution =
  | 'agent'
  | 'source'
  | 'evaluator'
  | 'environment'
  | 'not_applicable'

export type EvaluationContextScope =
  | 'session'
  | 'turn'
  | 'step'
  | 'span'
  | 'tool-call'

export interface EvaluationTargetRef {
  source: SourceId
  sourceSessionId: string
  mode: 'live' | 'frozen'
  fingerprint: string
  snapshotId?: string
}

export type LocalTrajectoryCriterionId = AnalysisEvaluation['id']

export interface FactsQualityIssue {
  id: string
  category:
    | 'capability'
    | 'completeness'
    | 'coverage'
    | 'liveness'
    | 'pairing'
    | 'protocol'
    | 'trace'
    | 'truncation'
  severity: 'warning' | 'blocking'
  summary: string
  evidenceRecordIds: string[]
  affectedCriterionIds: LocalTrajectoryCriterionId[]
}

export interface FactsQualityReport {
  schemaVersion: 4
  coveragePolicyVersion: number
  source: SourceId
  sourceCapabilities: SourceCapabilities
  sourceProtocol?: {
    availability: SourceAvailability
    detected?: string
    supported?: string[]
    reason?: string
  }
  target: EvaluationTargetRef
  contextScope: EvaluationContextScope
  stats: {
    records: number
    turns: number
    runningRecords: number
    truncatedRecords: number
    toolRecords: number
    toolRecordsMissingInput: number
    toolRecordsMissingOutput: number
    brokenParentSpans: number
    unknownEventTypes: number
    coverageTotal: number
    coverageConsumed: number
    coverageGap: number
  }
  ready: boolean
  issues: FactsQualityIssue[]
  blockedCriterionIds: LocalTrajectoryCriterionId[]
}

export interface EvaluationResult {
  evaluatorId: string
  evaluatorVersion: string
  criterionId: string
  verdict: EvaluationVerdict
  confidence: AnalysisConfidence
  evidenceRecordIds: string[]
  counterEvidenceRecordIds: string[]
  evidenceBoundary: string
  attribution: EvaluationAttribution
  blockedBy: string[]
  denominatorEligible: boolean
  label: string
  summary: string
}

export type RequirementState =
  | 'misunderstood'
  | 'understood_unimplemented'
  | 'implemented'
  | 'superseded'
  | 'insufficient_evidence'
  | 'out_of_scope'

export interface RequirementResult {
  id: string
  text: string
  kind: 'deliverable' | 'constraint' | 'acceptance' | 'prohibition'
  introducedTurn: number
  sourceRecordId?: string
  required: boolean
  state: RequirementState
  supersededBy?: string
  dependsOn: string[]
  evidenceRecordIds: string[]
  reason: string
}

export type ChainContinuity =
  | 'normal'
  | 'incorrect'
  | 'missing'
  | 'insufficient_evidence'
  | 'not_applicable'

export interface ChainTransition {
  fromTurn: number
  toTurn: number
  continuity: Exclude<ChainContinuity, 'not_applicable'>
  requirementIds: string[]
  carryover: {
    input: Exclude<ChainContinuity, 'not_applicable'>
    action: Exclude<ChainContinuity, 'not_applicable'>
    result: Exclude<ChainContinuity, 'not_applicable'>
  }
  evidenceRecordIds: string[]
  reason: string
}

export interface ChainResult {
  continuity: ChainContinuity
  failedTransition?: {
    fromTurn: number
    toTurn: number
  }
  transitions: ChainTransition[]
  evidenceRecordIds: string[]
  reason: string
}

export interface TrajectoryEvaluation {
  schemaVersion: 1
  evaluatorId: 'local-trajectory'
  evaluatorVersion: '1'
  factsSchemaVersion: 4
  target: EvaluationTargetRef
  factsHash: string
  factsQuality: FactsQualityReport
  requirements: RequirementResult[]
  chain: ChainResult
  results: EvaluationResult[]
}

export interface EvaluationAggregate {
  total: number
  denominatorEligible: number
  pass: number
  fail: number
  warning: number
  notApplicable: number
  insufficientEvidence: number
  evaluatorError: number
  outOfScope: number
}

export type EvaluationSplit = 'calibration' | 'regression' | 'independent'
export type EvaluationGoldCompleteness = 'partial-contract' | 'full-gold'

export interface GoldCriterionExpectation {
  criterionId: string
  verdict: EvaluationVerdict
  attribution?: EvaluationAttribution
  evidenceRecordIds?: string[]
  required?: boolean
}

export interface GoldRequirementExpectation {
  id: string
  text?: string
  required?: boolean
  state: RequirementState
  evidenceRecordIds?: string[]
}

export interface GoldChainExpectation {
  continuity: ChainContinuity
  failedTransition?: {
    fromTurn: number
    toTurn: number
  }
  evidenceRecordIds?: string[]
}

export interface GoldEvaluationCase {
  id: string
  split: EvaluationSplit
  description: string
  target: EvaluationTargetRef
  expected: GoldCriterionExpectation[]
  expectedRequirements?: GoldRequirementExpectation[]
  expectedChain?: GoldChainExpectation
}

export interface EvaluationAssertionResult {
  subject: string
  expected: string
  actual?: string
  passed: boolean
  required: boolean
}

export interface EvaluationCaseResult {
  caseId: string
  split: GoldEvaluationCase['split']
  target: EvaluationTargetRef
  factsHash: string
  durationMs: number
  results: EvaluationResult[]
  requirements: RequirementResult[]
  chain: ChainResult
  assertions: EvaluationAssertionResult[]
  assertionsPassed: number
  assertionsTotal: number
  exact?: boolean
  mismatches: Array<{
    criterionId: string
    expected: string
    actual?: string
  }>
  error?: string
}

export interface FrozenEvaluationCase extends GoldEvaluationCase {
  detail: import('./types').SessionDetail
  sourceStatus?: import('./types').SourceStatus
}

export interface EvaluationDataset {
  schemaVersion: 1
  id: string
  version: string
  description: string
  goldCompleteness: EvaluationGoldCompleteness
  datasetHash: string
  goldHash: string
  candidateManifestHash?: string
  cases: FrozenEvaluationCase[]
}

export interface EvaluationCandidateRef {
  id: string
  split: EvaluationSplit
  groupHash: string
  description: string
  target: EvaluationTargetRef
  file: string
  sha256: string
  sourceStatus?: import('./types').SourceStatus
  traits: string[]
}

export interface EvaluationCandidateManifest {
  schemaVersion: 2
  kind: 'evaluation-candidates'
  id: string
  version: string
  contentHash: string
  createdAt: string
  description: string
  preparation: {
    requested: number
    produced: number
    skipped: number
    allowPartial: boolean
    candidatePoolHash: string
    candidateMultiplier: number
    samplingPolicyVersion: number
    seed: string
    groupPolicy: 'source-parent-workspace' | 'source-lineage-workspace'
    splitPolicy: 'group-aware-50-20-30'
    independentAccess: 'restricted'
  }
  cases: EvaluationCandidateRef[]
}

export interface HumanCriterionAnnotation {
  criterionId: LocalTrajectoryCriterionId
  verdict?: EvaluationVerdict
  attribution?: EvaluationAttribution
  evidenceRecordIds: string[]
  notes: string
}

export interface HumanRequirementAnnotation {
  id: string
  text: string
  required: boolean
  state?: RequirementState
  evidenceRecordIds: string[]
  notes: string
}

export interface HumanChainAnnotation {
  continuity?: ChainContinuity
  failedTransition?: {
    fromTurn: number
    toTurn: number
  }
  evidenceRecordIds: string[]
  notes: string
}

export interface HumanCaseAnnotation {
  caseId: string
  criteria: HumanCriterionAnnotation[]
  requirements: HumanRequirementAnnotation[]
  chain: HumanChainAnnotation
  notes: string
}

export interface HumanEvaluationAnnotations {
  schemaVersion: 1
  kind: 'evaluation-annotations'
  datasetId: string
  datasetVersion: string
  datasetHash: string
  reviewerId: string
  createdAt: string
  cases: HumanCaseAnnotation[]
}

export interface EvaluationAdjudication {
  schemaVersion: 1
  kind: 'evaluation-adjudication'
  datasetId: string
  datasetVersion: string
  datasetHash: string
  adjudicatorId: string
  createdAt: string
  cases: HumanCaseAnnotation[]
}

export interface AnnotationDisagreement {
  caseId: string
  subject: string
  reviewerA?: string
  reviewerB?: string
}

export interface MetricConfidenceInterval {
  confidence: 0.95
  lower: number
  upper: number
  samples: number
}

export interface AnnotationAgreementReport {
  datasetId: string
  datasetVersion: string
  datasetHash: string
  reviewerA: string
  reviewerB: string
  reviewerAHash: string
  reviewerBHash: string
  completeCasesA: number
  completeCasesB: number
  totalCases: number
  criterionExactAgreement?: number
  criterionKappa?: number
  criterionExactAgreementCi?: MetricConfidenceInterval
  criterionKappaCi?: MetricConfidenceInterval
  criterionAgreement: Record<string, {
    sampleSize: number
    verdictAgreement?: number
    verdictKappa?: number
    verdictAgreementCi?: MetricConfidenceInterval
    verdictKappaCi?: MetricConfidenceInterval
    attributionAgreement?: number
    attributionKappa?: number
    attributionAgreementCi?: MetricConfidenceInterval
    attributionKappaCi?: MetricConfidenceInterval
    verdictMarginals: {
      reviewerA: Record<string, number>
      reviewerB: Record<string, number>
    }
  }>
  requirementDetectionAgreement?: number
  requirementStateAgreement?: number
  requirementDetectionAgreementCi?: MetricConfidenceInterval
  requirementStateAgreementCi?: MetricConfidenceInterval
  chainExactAgreement?: number
  chainKappa?: number
  chainExactAgreementCi?: MetricConfidenceInterval
  chainKappaCi?: MetricConfidenceInterval
  chainMarginals: {
    reviewerA: Record<string, number>
    reviewerB: Record<string, number>
  }
  disagreements: AnnotationDisagreement[]
}

export interface EvaluationConfusionMetrics {
  eligible: number
  truePositives: number
  trueNegatives: number
  falsePositives: number
  falseNegatives: number
  abstentions: number
  errors: number
  excluded: number
  precision?: number
  recall?: number
}

export interface EvaluationRun {
  schemaVersion: 2
  runId: string
  createdAt: string
  datasetId: string
  datasetVersion: string
  datasetHash: string
  goldHash: string
  candidateManifestHash?: string
  goldCompleteness: EvaluationGoldCompleteness
  evaluatorId: string
  evaluatorVersion: string
  evaluatorBuildHash: string
  contractHash: string
  contextPolicyHash: string
  evaluatorDependencies: string[]
  evaluatorCalibrationStatus:
    | 'synthetic-calibrated'
    | 'uncalibrated'
    | 'human-authoritative'
  evaluatorGateLevel: 'required' | 'advisory' | 'input-only'
  factsSchemaVersion: number
  cases: EvaluationCaseResult[]
  aggregate: EvaluationAggregate & {
    cases: number
    assertionsPassed: number
    assertionsTotal: number
    assertionAgreement: number
    exactEligibleCases: number
    exactCases: number
    exactAgreement?: number
    confusionEligible: number
    truePositives: number
    trueNegatives: number
    falsePositives: number
    falseNegatives: number
    abstentions: number
    confusionErrors: number
    confusionExcluded: number
    precision?: number
    recall?: number
    perCriterion: Record<string, EvaluationConfusionMetrics>
    durationMs: number
  }
}

export type EvaluationCaseDirection =
  | 'improved'
  | 'regressed'
  | 'mixed'
  | 'unchanged'
  | 'inconclusive'

export interface EvaluationRunDiff {
  comparable: boolean
  reasons: string[]
  datasetHash: string
  goldHash: string
  candidateManifestHash?: string
  baselineRunId: string
  candidateRunId: string
  gateDecision: 'pass' | 'fail' | 'inconclusive'
  gateReasons: string[]
  improvedCaseIds: string[]
  regressedCaseIds: string[]
  mixedCaseIds: string[]
  unchangedCaseIds: string[]
  inconclusiveCaseIds: string[]
  changedCriteria: Array<{
    caseId: string
    criterionId: string
    baseline?: EvaluationVerdict
    candidate?: EvaluationVerdict
    direction: EvaluationCaseDirection
  }>
}

export interface ProcessEvaluationRun {
  schemaVersion: 1
  kind: 'process-evaluation-run'
  runId: string
  createdAt: string
  snapshotId: string
  evaluatorId: string
  evaluatorVersion: string
  evaluatorBuildHash: string
  contractHash: string
  contextPolicyHash: string
  evaluatorDependencies: string[]
  evaluatorCalibrationStatus:
    | 'synthetic-calibrated'
    | 'uncalibrated'
    | 'human-authoritative'
  evaluatorGateLevel: 'required' | 'advisory' | 'input-only'
  accessLedgerHash: string
  results: EvaluationResult[]
  aggregate: EvaluationAggregate
}

export type BadcaseDecision = 'accepted' | 'rejected' | 'deferred'
export type BadcaseRetestOutcome = 'fixed' | 'not-fixed' | 'inconclusive'

export interface BadcaseEntry {
  id: string
  datasetId: string
  datasetVersion: string
  datasetHash: string
  goldHash: string
  candidateManifestHash?: string
  caseId: string
  subject: string
  status: 'open' | 'resolved'
  firstSeenRunId: string
  lastSeenRunId: string
  observations: number
  firstSeenAt: string
  lastSeenAt: string
  evaluatorError: boolean
  decision?: {
    value: BadcaseDecision
    decidedAt: string
    note?: string
  }
  retests: Array<{
    runId: string
    testedAt: string
    outcome: BadcaseRetestOutcome
  }>
}

export interface BadcaseCasebook {
  schemaVersion: 1
  kind: 'evaluation-badcase-casebook'
  updatedAt: string
  entries: BadcaseEntry[]
}
