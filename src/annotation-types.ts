import type {
  AnnotationAgreementReport,
  ChainContinuity,
  EvaluationCaseDirection,
  EvaluationRun,
  EvaluationRunDiff,
  EvaluationAttribution,
  EvaluationSplit,
  EvaluationVerdict,
  HumanCriterionAnnotation,
  HumanCaseAnnotation,
  HumanChainAnnotation,
  HumanRequirementAnnotation,
  LocalTrajectoryCriterionId,
  RequirementState,
} from './evaluation-types'
import type {
  RecordKind,
  RecordStatus,
  SourceId,
  TokenUsage,
} from './types'

export type AnnotationReviewer = 'reviewer-a' | 'reviewer-b'
export type AnnotationActor = AnnotationReviewer | 'adjudicator'

export interface AnnotationDatasetSummary {
  directoryId: string
  datasetId: string
  datasetVersion: string
  datasetHash: string
  description: string
  cases: number
  requestedCases: number
  skippedCases: number
  allowPartial: boolean
  sources: Record<SourceId, number>
  splits: Record<EvaluationSplit, number>
  privacyAuditPassed: boolean
}

export interface PrepareEvaluationDatasetRequest {
  directoryId: string
  datasetId: string
  datasetVersion: string
  count: number
  allowPartial: boolean
}

export interface PrepareEvaluationDatasetResult {
  dataset: AnnotationDatasetSummary
  skipped: number
}

export interface AnnotationProgress {
  complete: number
  total: number
}

export interface AnnotationCaseListItem {
  id: string
  source: SourceId
  split: EvaluationSplit
  traits: string[]
  complete: boolean
  criteriaComplete: number
  criteriaTotal: number
  requirementCount: number
  chainComplete: boolean
}

export interface AnnotationWorkspaceOverview {
  dataset: AnnotationDatasetSummary
  reviewer: AnnotationActor
  revision: string
  progress: AnnotationProgress
  cases: AnnotationCaseListItem[]
}

export interface EvaluationWorkflowStatus {
  datasetHash: string
  reviewersComplete: boolean
  agreement?: Pick<
    AnnotationAgreementReport,
    | 'completeCasesA'
    | 'completeCasesB'
    | 'totalCases'
    | 'criterionExactAgreement'
    | 'criterionKappa'
    | 'requirementDetectionAgreement'
    | 'requirementStateAgreement'
    | 'chainExactAgreement'
    | 'chainKappa'
  > & {
    disagreements: number
  }
  adjudication: {
    exists: boolean
    complete: boolean
    error?: string
  }
  runs: Array<{
    file: string
    runId: string
    createdAt: string
    evaluatorId: string
    evaluatorBuildHash: string
    split?: EvaluationSplit | 'all'
    assertionAgreement: number
    exactAgreement?: number
    evaluatorError: number
  }>
  diffs: Array<{
    file: string
    baselineRunId: string
    candidateRunId: string
    comparable: boolean
    gateDecision: EvaluationRunDiff['gateDecision']
    improved: number
    regressed: number
    mixed: number
    inconclusive: number
  }>
  latestRun?: Pick<
    EvaluationRun,
    | 'runId'
    | 'createdAt'
    | 'evaluatorId'
    | 'evaluatorBuildHash'
    | 'evaluatorCalibrationStatus'
    | 'evaluatorGateLevel'
  >
  casebook: {
    total: number
    open: number
    resolved: number
    accepted: number
    retested: number
  }
}

export interface EvaluationRunRequest {
  split: EvaluationSplit
  baselineRunId?: string
  confirmIndependent?: boolean
}

export interface EvaluationRunResult {
  run: {
    runId: string
    createdAt: string
    split: EvaluationSplit | 'all'
    assertionAgreement: number
    exactAgreement?: number
    evaluatorError: number
    cases: Array<{
      caseId: string
      assertionsPassed: number
      assertionsTotal: number
      exact?: boolean
      error?: string
      criteria: Array<{
        criterionId: string
        verdict: EvaluationVerdict
        attribution: EvaluationAttribution
        evidenceRecordIds: string[]
      }>
      mismatches: Array<{
        criterionId: string
        expected: string
        actual?: string
      }>
    }>
  }
  diff?: {
    baselineRunId: string
    candidateRunId: string
    comparable: boolean
    gateDecision: 'pass' | 'fail' | 'inconclusive'
    gateReasons: string[]
    improved: number
    regressed: number
    mixed: number
    inconclusive: number
    caseDirections: Array<{
      caseId: string
      direction: EvaluationCaseDirection
    }>
    changedCriteria: EvaluationRunDiff['changedCriteria']
  }
}

export interface EvaluationRunDetails {
  run: EvaluationRunResult['run']
  diffs: Array<NonNullable<EvaluationRunResult['diff']>>
}

export interface AnnotationRecordSummary {
  id: string
  turn: number
  step: number
  kind: RecordKind
  title: string
  summary: string
  status: RecordStatus
  startTime: number
  endTime: number | null
  hasInput: boolean
  hasOutput: boolean
  hasError: boolean
  usage?: TokenUsage
}

export interface AnnotationRequirementSuggestion {
  id: string
  text: string
  recordId: string
  turn: number
}

export interface AnnotationCaseWorkspace {
  datasetHash: string
  reviewer: AnnotationActor
  revision: string
  candidate: {
    id: string
    source: SourceId
    split: EvaluationSplit
    traits: string[]
    description: string
  }
  annotation: HumanCaseAnnotation
  records: AnnotationRecordSummary[]
  requirementSuggestions: AnnotationRequirementSuggestion[]
  userTurns: number[]
  comparison?: {
    criteria: Array<{
      criterionId: LocalTrajectoryCriterionId
      reviewerA?: {
        verdict?: EvaluationVerdict
        attribution?: EvaluationAttribution
        evidenceRecordIds: string[]
      }
      reviewerB?: {
        verdict?: EvaluationVerdict
        attribution?: EvaluationAttribution
        evidenceRecordIds: string[]
      }
    }>
    requirements: Array<{
      id: string
      reviewerA?: {
        text: string
        required: boolean
        state?: RequirementState
        evidenceRecordIds: string[]
      }
      reviewerB?: {
        text: string
        required: boolean
        state?: RequirementState
        evidenceRecordIds: string[]
      }
    }>
    chain: {
      reviewerA?: {
        continuity?: ChainContinuity
        evidenceRecordIds: string[]
      }
      reviewerB?: {
        continuity?: ChainContinuity
        evidenceRecordIds: string[]
      }
    }
  }
}

export interface AnnotationRecordDetail extends AnnotationRecordSummary {
  input?: unknown
  output?: unknown
  error?: {
    name?: string
    code?: string
    reason?: string
  }
  retry?: {
    count: number
    maxRetries?: number
    delayMs?: number
    message?: string
    code?: string
  }
  metrics?: {
    ttftMs?: number
    decodeMs?: number
    throughput?: number
  }
}

export interface AnnotationSaveRequest {
  datasetHash: string
  revision: string
  annotation: HumanCaseAnnotation
}

export interface AnnotationSaveResult {
  revision: string
  progress: AnnotationProgress
  case: AnnotationCaseListItem
}

export const ANNOTATION_CRITERIA: Array<{
  id: LocalTrajectoryCriterionId
  label: string
  description: string
}> = [
  { id: 'outcome', label: '最终结果', description: '要求是否完成，是否有验证证据' },
  { id: 'reliability', label: '路径稳定性', description: '失败、中断、重试和执行波折' },
  { id: 'recovery', label: '异常恢复', description: '异常后是否定位、调整并恢复' },
  { id: 'efficiency', label: '资源效率', description: '耗时、Token、工具调用和重复成本' },
  { id: 'observability', label: '可观测性', description: '原因、耗时、Token 和工具结果是否充分' },
]

export const ANNOTATION_VERDICTS: Array<{
  value: EvaluationVerdict
  label: string
}> = [
  { value: 'pass', label: '通过' },
  { value: 'fail', label: '失败' },
  { value: 'warning', label: '警告' },
  { value: 'not_applicable', label: '不适用' },
  { value: 'insufficient_evidence', label: '证据不足' },
  { value: 'evaluator_error', label: '评测器错误' },
  { value: 'out_of_scope', label: '超出范围' },
]

export const ANNOTATION_ATTRIBUTIONS: Array<{
  value: EvaluationAttribution
  label: string
}> = [
  { value: 'agent', label: 'Agent' },
  { value: 'source', label: '来源证据' },
  { value: 'evaluator', label: '评测器' },
  { value: 'environment', label: '运行环境' },
  { value: 'not_applicable', label: '不适用' },
]

export const ANNOTATION_REQUIREMENT_STATES: Array<{
  value: RequirementState
  label: string
}> = [
  { value: 'implemented', label: '已完成' },
  { value: 'understood_unimplemented', label: '已理解但未完成' },
  { value: 'misunderstood', label: '要求被误解' },
  { value: 'superseded', label: '已被后续要求替代' },
  { value: 'insufficient_evidence', label: '证据不足' },
  { value: 'out_of_scope', label: '超出范围' },
]

export const ANNOTATION_CHAIN_STATES: Array<{
  value: ChainContinuity
  label: string
}> = [
  { value: 'normal', label: '正确承接' },
  { value: 'incorrect', label: '错误承接' },
  { value: 'missing', label: '遗漏前序信息' },
  { value: 'insufficient_evidence', label: '证据不足' },
  { value: 'not_applicable', label: '单轮，不适用' },
]

export function annotationCriterionComplete(
  criterion: HumanCriterionAnnotation,
): boolean {
  if (criterion.verdict === undefined || criterion.attribution === undefined) return false
  return criterion.verdict !== 'pass'
    && criterion.verdict !== 'fail'
    && criterion.verdict !== 'warning'
    || criterion.evidenceRecordIds.length > 0
}

export function annotationRequirementComplete(
  requirement: HumanRequirementAnnotation,
): boolean {
  return requirement.state !== undefined
    && requirement.text.trim() !== ''
    && requirement.evidenceRecordIds.length > 0
}

export function annotationChainComplete(
  chain: HumanChainAnnotation,
): boolean {
  if (chain.continuity === undefined) return false
  return chain.continuity === 'insufficient_evidence'
    || chain.evidenceRecordIds.length > 0
}

export function annotationCaseComplete(
  annotation: HumanCaseAnnotation,
): boolean {
  return annotation.criteria.every(annotationCriterionComplete)
    && annotation.requirements.length > 0
    && annotation.requirements.every(annotationRequirementComplete)
    && annotationChainComplete(annotation.chain)
}
