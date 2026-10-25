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
  schemaVersion: 1
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
  required: boolean
  state: RequirementState
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
  factsSchemaVersion: 1
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

export interface GoldCriterionExpectation {
  criterionId: string
  verdict: EvaluationVerdict
  attribution?: EvaluationAttribution
  evidenceRecordIds?: string[]
}

export interface GoldEvaluationCase {
  id: string
  split: EvaluationSplit
  description: string
  target: EvaluationTargetRef
  expected: GoldCriterionExpectation[]
  expectedRequirements?: Array<{
    id: string
    state: RequirementState
  }>
  expectedChainContinuity?: ChainContinuity
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
  exact: boolean
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
  cases: FrozenEvaluationCase[]
}

export interface EvaluationCandidateRef {
  id: string
  split: EvaluationSplit
  description: string
  target: EvaluationTargetRef
  file: string
  sha256: string
  sourceStatus?: import('./types').SourceStatus
  traits: string[]
}

export interface EvaluationCandidateManifest {
  schemaVersion: 1
  kind: 'evaluation-candidates'
  id: string
  version: string
  contentHash: string
  createdAt: string
  description: string
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

export interface AnnotationAgreementReport {
  datasetId: string
  datasetVersion: string
  datasetHash: string
  reviewerA: string
  reviewerB: string
  completeCasesA: number
  completeCasesB: number
  totalCases: number
  criterionExactAgreement?: number
  criterionKappa?: number
  chainExactAgreement?: number
  disagreements: AnnotationDisagreement[]
}

export interface EvaluationRun {
  schemaVersion: 1
  runId: string
  createdAt: string
  datasetId: string
  datasetVersion: string
  evaluatorId: string
  evaluatorVersion: string
  factsSchemaVersion: number
  cases: EvaluationCaseResult[]
  aggregate: EvaluationAggregate & {
    cases: number
    exactCases: number
    exactAgreement: number
    falsePositives: number
    falseNegatives: number
    precision?: number
    recall?: number
    durationMs: number
  }
}

export interface EvaluationRunDiff {
  comparable: boolean
  reasons: string[]
  improvedCaseIds: string[]
  regressedCaseIds: string[]
  unchangedCaseIds: string[]
  changedCriteria: Array<{
    caseId: string
    criterionId: string
    baseline?: EvaluationVerdict
    candidate?: EvaluationVerdict
  }>
}
